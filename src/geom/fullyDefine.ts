// Fully Define Sketch, as CAD users expect it: the relations and dimensions
// that would leave the sketch fully defined, measured from the geometry as it
// is so applying them moves nothing. Relations first (what is already level,
// plumb or touching says so), then the sizes (lengths, diameters, radii,
// widths), then each key point's X and Y from the datum (the origin, or a
// point picked), baseline style. Each is kept only when it takes away
// freedom, so nothing over-defines. Pure: the sketcher previews the list and
// applies it as one step.

import type { Constraint, SketchEntity, Vec2 } from "../doc/types";
import { isConstant } from "./axes";
import { entityPoint, pointNames } from "./curves";
import { rankTracker } from "./solver";

export interface FullyDefineOptions {
  /** What X and Y are measured from: "origin" (the default), or a point of the sketch ("l1.start"). */
  datum?: string;
  /** Add relations where the geometry already has them (level, plumb, touching). Default on. */
  relations?: boolean;
  /** Add dimensions. Default on. */
  dimensions?: boolean;
}

export interface FullyDefineResult {
  /** What to add, in order. */
  add: Constraint[];
  /** Degrees of freedom left after adding them (0 unless something can't be dimensioned). */
  dof: number;
}

/** Closer than this, two points are one and a line is level. */
const TOL = 1e-6;
/** Values to a billionth of a mm: tidy, and close enough that applying them moves nothing. */
const tidy = (x: number) => Math.round(x * 1e9) / 1e9;

/** An entity's points that relations and dimensions take, in order. */
function pointsOf(e: SketchEntity): [string, Vec2][] {
  const p = (name: string, at: Vec2): [string, Vec2] => [`${e.id}.${name}`, at];
  switch (e.type) {
    case "line":
      return [p("start", e.start), p("end", e.end)];
    case "circle":
      return [p("center", e.center)];
    case "arc":
      return [p("center", e.center), p("start", e.start), p("end", e.end)];
    case "rect":
      return [p("center", e.center)];
    case "slot":
      return [p("center1", e.center1), p("center2", e.center2)];
    case "point":
      return [p("at", e.at)];
    case "ellipse":
    case "spline":
      // An ellipse's minor end is set by its radii, so it is no point to place.
      return pointNames(e)
        .filter((n) => n !== "minorEnd")
        .map((n) => p(n, entityPoint(e, n)!));
  }
}

const at = (ref: string, entities: SketchEntity[]): Vec2 | null => {
  if (ref === "origin") return [0, 0];
  const [id, name] = ref.split(".");
  const e = entities.find((x) => x.id === id);
  return e ? (entityPoint(e, name) ?? null) : null;
};

export function fullyDefine(entities: SketchEntity[], constraints: Constraint[], opts: FullyDefineOptions = {}): FullyDefineResult {
  const tracker = rankTracker(entities, constraints);
  const add: Constraint[] = [];
  const offer = (k: Constraint) => {
    if (tracker.dof() === 0) return;
    if (tracker.adds(k)) {
      tracker.add(k);
      add.push(k);
    }
  };
  const own = entities.filter((e) => !isConstant(e));

  if (opts.relations !== false) {
    // Lines already level or plumb.
    for (const e of own) {
      if (e.type !== "line") continue;
      const dx = Math.abs(e.end[0] - e.start[0]);
      const dy = Math.abs(e.end[1] - e.start[1]);
      const len = Math.hypot(dx, dy);
      if (dy <= TOL * Math.max(1, len)) offer({ type: "horizontal", entity: e.id });
      else if (dx <= TOL * Math.max(1, len)) offer({ type: "vertical", entity: e.id });
    }
    // Points already at the same place (ends that meet, a centre on the origin).
    const pts: [string, Vec2][] = [["origin", [0, 0]], ...entities.flatMap(pointsOf)];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const [a, p] = pts[i];
        const [b, q] = pts[j];
        if (a.split(".")[0] === b.split(".")[0]) continue;
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= TOL) offer({ type: "coincident", points: [a, b] });
      }
    }
  }

  if (opts.dimensions !== false) {
    // Sizes: a circle by its diameter, an arc by its radius, a line by its length, a rectangle by its sides.
    for (const e of own) {
      if (e.type === "circle") offer({ type: "diameter", entity: e.id, value: tidy(2 * e.radius) });
      if (e.type === "arc") offer({ type: "radius", entity: e.id, value: tidy(Math.hypot(e.start[0] - e.center[0], e.start[1] - e.center[1])) });
      // A level or plumb line by its length; a slanted one by where its ends are (their X and Y, below).
      if (e.type === "line" && (Math.abs(e.end[0] - e.start[0]) <= TOL || Math.abs(e.end[1] - e.start[1]) <= TOL)) {
        offer({ type: "distance", entity: e.id, value: tidy(Math.hypot(e.end[0] - e.start[0], e.end[1] - e.start[1])) });
      }
      if (e.type === "rect") {
        offer({ type: "distanceX", entity: e.id, value: tidy(e.w) });
        offer({ type: "distanceY", entity: e.id, value: tidy(e.h) });
      }
      if (e.type === "slot") offer({ type: "distance", entity: e.id, value: tidy(Math.hypot(e.center2[0] - e.center1[0], e.center2[1] - e.center1[1])) });
      if (e.type === "ellipse") {
        // Its two radii, as distances from the centre; a level or plumb major axis says so.
        const a = Math.hypot(e.major[0] - e.center[0], e.major[1] - e.center[1]);
        offer({ type: "distance", points: [`${e.id}.center`, `${e.id}.major`], value: tidy(a) });
        offer({ type: "distance", points: [`${e.id}.center`, `${e.id}.minorEnd`], value: tidy(e.minor) });
        if (Math.abs(e.major[1] - e.center[1]) <= TOL * Math.max(1, a)) offer({ type: "horizontal", entity: e.id });
        else if (Math.abs(e.major[0] - e.center[0]) <= TOL * Math.max(1, a)) offer({ type: "vertical", entity: e.id });
      }
    }
    // Where things are: each key point's X and Y from the datum; one level with or plumb above it says so instead of a 0.
    const datum = opts.datum && at(opts.datum, entities) ? opts.datum : "origin";
    const base = at(datum, entities)!;
    const place = (ref: string, p: Vec2, from: string, o: Vec2) => {
      const dx = tidy(Math.abs(p[0] - o[0]));
      const dy = tidy(Math.abs(p[1] - o[1]));
      offer(dx === 0 ? { type: "vertical", points: [from, ref] } : { type: "distanceX", points: [from, ref], value: dx });
      offer(dy === 0 ? { type: "horizontal", points: [from, ref] } : { type: "distanceY", points: [from, ref], value: dy });
    };
    // A datum point of the sketch is placed from the origin first.
    if (datum !== "origin") place(datum, base, "origin", [0, 0]);
    for (const e of own) for (const [ref, p] of pointsOf(e)) if (ref !== datum) place(ref, p, datum, base);
    // Lines that can still turn (an end fixed, the other on a circle): their angle to the X axis.
    for (const e of own) {
      if (e.type !== "line") continue;
      // The angle between its direction and +X, as the angle relation reads it: 0 to 180.
      const v = tidy(Math.abs((Math.atan2(e.end[1] - e.start[1], e.end[0] - e.start[0]) * 180) / Math.PI));
      if (v > 0 && v < 180) offer({ type: "angle", entities: [e.id, "X"], value: v });
    }
  }
  // What no dimension reaches (a slot's width): held where it is.
  if (tracker.dof() > 0) for (const e of own) offer({ type: "fix", entity: e.id });
  return { add, dof: tracker.dof() };
}
