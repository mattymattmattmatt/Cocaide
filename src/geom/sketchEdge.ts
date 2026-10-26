// An entity of one sketch seen from anywhere else in the model (DESIGN §2.9,
// the { sketch, entity, at? } reference): its 3D geometry as an edge would
// be described (so it projects into another sketch exactly as a model edge
// does, src/geom/projection.ts), and what it is as reference geometry: a line
// is an axis, a circle or an arc the axis through its centre square to its
// sketch (or its centre where a point is needed), a point a point; with `at`,
// that point of it. Pure: the rebuild resolves references with it, the
// sketcher draws, hits and snaps to other sketches' entities with it.

import type { EdgePoint, SketchEntity, Vec2, Vec3 } from "../doc/types";
import type { Datum, DatumKind } from "../features/datum";
import { arcSweep } from "./constraints";
import { to2D, to3D, type Frame } from "./frame";
import type { EdgeGeometry } from "./projection";
import { add3, dist2, normalize3, scale3, sub3 } from "./vec";

/** What can be referenced in another sketch, said once for every refusal. */
export const SKETCH_REFERENCEABLE = "another sketch's lines, circles, arcs and points can be referenced (rectangles, slots, ellipses and splines can't yet: explode a rectangle or slot into lines and arcs first)";

/**
 * The entity in 3D, as a model edge is described (the fields projection reads):
 * a line from its start to its end; a circle about its sketch's normal from
 * angle 0 (the sketch's x) all the way round; an arc from its start to its end,
 * its axis the normal (reversed for a clockwise arc, as OCCT runs circles
 * counter-clockwise about their axis). A string says why it can't be one.
 */
export function sketchEntityEdge(e: SketchEntity, frame: Frame): EdgeGeometry | string {
  switch (e.type) {
    case "line": {
      const start = to3D(frame, e.start);
      const end = to3D(frame, e.end);
      const length = dist2(e.start, e.end);
      if (length < 1e-9) return `line ${e.id} has no length`;
      return { kind: "line", start, end, mid: to3D(frame, mid2(e.start, e.end)), length, direction: normalize3(sub3(end, start)) };
    }
    case "circle": {
      const at = to3D(frame, [e.center[0] + e.radius, e.center[1]]);
      return { kind: "circle", start: at, end: at, mid: to3D(frame, [e.center[0] - e.radius, e.center[1]]), length: 2 * Math.PI * e.radius, radius: e.radius, center: to3D(frame, e.center), axis: [...frame.z] };
    }
    case "arc": {
      const r = dist2(e.start, e.center);
      const sweep = arcSweep(e);
      return {
        kind: "circle",
        start: to3D(frame, e.start),
        end: to3D(frame, e.end),
        mid: to3D(frame, arcPoint(e, 0.5)),
        length: r * sweep,
        radius: r,
        center: to3D(frame, e.center),
        axis: e.clockwise ? scale3(frame.z, -1) : [...frame.z],
      };
    }
    default:
      return `${e.id} is ${e.type === "ellipse" ? "an" : "a"} ${e.type}: ${SKETCH_REFERENCEABLE}`;
  }
}

/** A point of the entity in its sketch's 2D (its start, end, middle or centre; a sketch point's place), or why it hasn't that point. */
export function sketchEntityPoint2(e: SketchEntity, at: EdgePoint | undefined): Vec2 | string {
  const named = (what: string) => `${e.id} is ${e.type === "arc" ? "an" : "a"} ${e.type}: it has no ${what}`;
  switch (e.type) {
    case "point":
      return at === undefined ? e.at : `${e.id} is a point: leave "at" out`;
    case "line":
      if (at === "start") return e.start;
      if (at === "end") return e.end;
      if (at === "mid") return mid2(e.start, e.end);
      return at === "center" ? `${named("centre")}; use "mid" for its middle` : `${e.id} is a line: say which point of it ("at": "start", "end" or "mid")`;
    case "circle":
      if (at === undefined || at === "center") return e.center;
      return `${named(at === "mid" ? "middle" : at)} (a whole circle has no ends); use "center"`;
    case "arc":
      if (at === "start") return e.start;
      if (at === "end") return e.end;
      if (at === "mid") return arcPoint(e, 0.5);
      return e.center;
    default:
      return `${e.id} is ${e.type === "ellipse" ? "an" : "a"} ${e.type}: ${SKETCH_REFERENCEABLE}`;
  }
}

/**
 * The entity as reference geometry, in 3D, for a caller that needs `want`
 * ("any": what it is): a line is an axis from its start to its end; a circle
 * or an arc the axis through its centre along its sketch's normal, or its
 * centre where a point is needed; a point a point. With `at`, that point.
 * A string says why not ("a line is an axis, but a point is needed here ...").
 */
export function sketchEntityDatum(e: SketchEntity, frame: Frame, at: EdgePoint | undefined, want: DatumKind | "any"): Datum | string {
  if (at !== undefined || e.type === "point") {
    const p = sketchEntityPoint2(e, at);
    return typeof p === "string" ? p : { kind: "point", at: to3D(frame, p) };
  }
  if (e.type === "line") {
    if (want === "point") return `${e.id} is a line: an axis, but a point is needed here; give "at": "start", "end" or "mid" for a point of it`;
    if (dist2(e.start, e.end) < 1e-9) return `line ${e.id} has no length, so it is no axis`;
    const start = to3D(frame, e.start);
    return { kind: "axis", origin: start, direction: normalize3(sub3(to3D(frame, e.end), start)) };
  }
  if (e.type === "circle" || e.type === "arc") {
    const center = to3D(frame, e.center);
    if (want === "point") return { kind: "point", at: center };
    return { kind: "axis", origin: center, direction: e.type === "arc" && e.clockwise ? scale3(frame.z, -1) : ([...frame.z] as Vec3) };
  }
  return `${e.id} is ${e.type === "ellipse" ? "an" : "a"} ${e.type}: ${SKETCH_REFERENCEABLE}`;
}

/**
 * A place along a line, an arc or a circle of a sketch, in 3D: the point `t`
 * of the way along it (0 its start, 1 its end; a circle from angle 0, the
 * sketch's x, counter-clockwise all the way round), or the point of it
 * nearest `near` (a point anywhere: measured square onto the sketch); and the
 * way it runs there (unit, from its start toward its end). What a plane
 * square to it, or a point on it, stands on, as a model edge's place does
 * (src/kernel/datum.ts edgePlace). A string says why it has none.
 */
export function sketchEntityPlace(e: SketchEntity, frame: Frame, where: { t: number } | { near: Vec3 }): { at: Vec3; tangent: Vec3; t: number } | string {
  const dir = (v: Vec2): Vec3 => normalize3(add3(scale3(frame.x, v[0]), scale3(frame.y, v[1])));
  if (e.type === "line") {
    const d: Vec2 = [e.end[0] - e.start[0], e.end[1] - e.start[1]];
    const l2 = d[0] * d[0] + d[1] * d[1];
    if (l2 < 1e-18) return `line ${e.id} has no length, so it has no direction to be square to`;
    let t: number;
    if ("t" in where) t = where.t;
    else {
      const q = to2D(frame, where.near);
      t = Math.min(1, Math.max(0, ((q[0] - e.start[0]) * d[0] + (q[1] - e.start[1]) * d[1]) / l2));
    }
    return { at: to3D(frame, [e.start[0] + d[0] * t, e.start[1] + d[1] * t]), tangent: dir(d), t };
  }
  if (e.type === "arc" || e.type === "circle") {
    const r = e.type === "arc" ? dist2(e.start, e.center) : e.radius;
    if (r < 1e-9) return `${e.id} has no radius`;
    const a0 = e.type === "arc" ? Math.atan2(e.start[1] - e.center[1], e.start[0] - e.center[0]) : 0;
    const sweep = e.type === "arc" ? arcSweep(e) : 2 * Math.PI;
    const sign = e.type === "arc" && e.clockwise ? -1 : 1;
    let t: number;
    if ("t" in where) t = where.t;
    else {
      const q = to2D(frame, where.near);
      // How far round from the start the point is, the way the arc runs; past its end, the nearer end.
      let a = sign * (Math.atan2(q[1] - e.center[1], q[0] - e.center[0]) - a0);
      a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      t = a <= sweep ? a / sweep : a - sweep < 2 * Math.PI - a ? 1 : 0;
    }
    const angle = a0 + sign * sweep * t;
    const at = to3D(frame, [e.center[0] + r * Math.cos(angle), e.center[1] + r * Math.sin(angle)]);
    return { at, tangent: dir([-sign * Math.sin(angle), sign * Math.cos(angle)]), t };
  }
  if (e.type === "point") return `${e.id} is a point: it has no length to go along; pick a line, an arc or a circle of the sketch`;
  return `${e.id} is ${e.type === "ellipse" ? "an" : "a"} ${e.type}: ${SKETCH_REFERENCEABLE}`;
}

/** The point `t` (0 its start, 1 its end) of the way along an arc. */
function arcPoint(a: Extract<SketchEntity, { type: "arc" }>, t: number): Vec2 {
  const r = dist2(a.start, a.center);
  const t0 = Math.atan2(a.start[1] - a.center[1], a.start[0] - a.center[0]);
  const angle = t0 + (a.clockwise ? -1 : 1) * arcSweep(a) * t;
  return [a.center[0] + r * Math.cos(angle), a.center[1] + r * Math.sin(angle)];
}

function mid2(a: Vec2, b: Vec2): Vec2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
