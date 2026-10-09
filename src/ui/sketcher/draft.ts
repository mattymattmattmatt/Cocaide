// Pure helpers for the sketcher: handles, hit testing, snapping, constraint
// suggestions, deletion. No React, so they are unit-tested directly.

import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import type { IconName } from "../icons";
import { point as pointOf } from "../../geom/constraints";
import { angleOf, dist2, sub2, wrapAngle } from "../../geom/vec";

export type SketchItem = { kind: "entity"; id: string } | { kind: "point"; ref: string };

export interface Handle {
  ref: string;
  point: Vec2;
  /** Point refs can carry constraints; corners and edges are drag-only. */
  constraint: boolean;
}

/** Points a user can grab on an entity. */
export function handlesOf(e: SketchEntity): Handle[] {
  const h = (name: string, point: Vec2, constraint = true): Handle => ({ ref: `${e.id}.${name}`, point, constraint });
  switch (e.type) {
    case "line":
      return [h("start", e.start), h("end", e.end)];
    case "circle":
      return [h("center", e.center)];
    case "arc":
      return [h("center", e.center), h("start", e.start), h("end", e.end)];
    case "rect": {
      const [cx, cy] = e.center;
      const corners: Vec2[] = [
        [cx - e.w / 2, cy - e.h / 2],
        [cx + e.w / 2, cy - e.h / 2],
        [cx + e.w / 2, cy + e.h / 2],
        [cx - e.w / 2, cy + e.h / 2],
      ];
      return [h("center", e.center), ...corners.map((p, i) => h(`corner${i}`, p, false))];
    }
    case "slot":
      return [h("center1", e.center1), h("center2", e.center2)];
    case "point":
      return [h("at", e.at)];
  }
}

/** Distance from p to an entity's drawn geometry. */
export function distanceTo(e: SketchEntity, p: Vec2): number {
  switch (e.type) {
    case "line":
      return segDist(p, e.start, e.end);
    case "circle":
      return Math.abs(dist2(p, e.center) - e.radius);
    case "arc": {
      const r = dist2(e.start, e.center);
      const a0 = angleOf(sub2(e.start, e.center));
      const a1 = angleOf(sub2(e.end, e.center));
      const sweep = e.clockwise ? wrapAngle(a0 - a1) : wrapAngle(a1 - a0);
      const t = e.clockwise ? wrapAngle(a0 - angleOf(sub2(p, e.center))) : wrapAngle(angleOf(sub2(p, e.center)) - a0);
      return t <= sweep ? Math.abs(dist2(p, e.center) - r) : Math.min(dist2(p, e.start), dist2(p, e.end));
    }
    case "rect": {
      const [cx, cy] = e.center;
      const c: Vec2[] = [
        [cx - e.w / 2, cy - e.h / 2],
        [cx + e.w / 2, cy - e.h / 2],
        [cx + e.w / 2, cy + e.h / 2],
        [cx - e.w / 2, cy + e.h / 2],
      ];
      return Math.min(...c.map((a, i) => segDist(p, a, c[(i + 1) % 4])));
    }
    case "slot": {
      const r = e.width / 2;
      return Math.abs(segDist(p, e.center1, e.center2) - r);
    }
    case "point":
      return dist2(p, e.at);
  }
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub2(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
  return dist2(p, [a[0] + t * ab[0], a[1] + t * ab[1]]);
}

/** The handle nearest p within tol, the origin included. */
export function hitHandle(entities: SketchEntity[], p: Vec2, tol: number, opts: { constraintOnly?: boolean; exclude?: string } = {}): Handle | null {
  let best: Handle | null = dist2(p, [0, 0]) <= tol ? { ref: "origin", point: [0, 0], constraint: true } : null;
  let bestD = best ? dist2(p, [0, 0]) : Infinity;
  for (const e of entities) {
    if (e.id === opts.exclude) continue;
    for (const h of handlesOf(e)) {
      if (opts.constraintOnly && !h.constraint) continue;
      const d = dist2(p, h.point);
      if (d <= tol && d < bestD) {
        best = h;
        bestD = d;
      }
    }
  }
  return best;
}

export function hitEntity(entities: SketchEntity[], p: Vec2, tol: number): SketchEntity | null {
  let best: SketchEntity | null = null;
  let bestD = tol;
  for (const e of entities) {
    const d = distanceTo(e, p);
    if (d <= bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

export { constraintEntities, nextEntityId, removeEntities, ENTITY_PREFIX as ID_PREFIX } from "../../doc/sketch";

export interface Suggestion {
  label: string;
  /** The relation's or dimension's icon, as on SOLIDWORKS's Add Relations list. */
  icon: IconName;
  /** Builds the constraint; `value` comes from the input when the constraint has one. */
  make(value: number): Constraint;
  /** Current measured value, so adding the constraint moves nothing until it is edited. A relation has none. */
  value?: number;
  /** "°" for an angle; lengths are mm. */
  unit?: "mm" | "°";
  testId: string;
}

type Line = Extract<SketchEntity, { type: "line" }>;
const isRound = (e: SketchEntity) => e.type === "circle" || e.type === "arc";
const radiusOf = (e: SketchEntity) => (e.type === "circle" ? e.radius : e.type === "arc" ? dist2(e.start, e.center) : 0);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** A line's unit direction. */
function unitOf(l: Line): Vec2 {
  const d = sub2(l.end, l.start);
  const n = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / n, d[1] / n];
}

/** A point's distance from a line, extended. */
function offsetFrom(l: Line, p: Vec2): number {
  const u = unitOf(l);
  return Math.abs(u[0] * (p[1] - l.start[1]) - u[1] * (p[0] - l.start[0]));
}

/** The angle between two lines' directions, degrees, 0 to 180. */
export function angleBetween(a: Line, b: Line): number {
  const u = unitOf(a);
  const v = unitOf(b);
  return (Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180) / Math.PI;
}

/**
 * What the current selection can be related or dimensioned by, as on
 * SOLIDWORKS's Add Relations list: relations first (no value), then the
 * dimensions, each valued at what it measures now so adding it moves nothing.
 */
export function suggestions(entities: SketchEntity[], itemsIn: SketchItem[]): Suggestion[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  // A sketch point picked as an entity (a box takes entities) is related as the point it is.
  const items = asPoints(itemsIn, byId);
  const ents = items.flatMap((i) => (i.kind === "entity" && byId.has(i.id) ? [byId.get(i.id)!] : []));
  const points = items.flatMap((i) => (i.kind === "point" ? [i.ref] : []));
  const ownerOf = (ref: string) => ref.split(".")[0];
  const out: Suggestion[] = [];
  const fix = (target: { entity: string } | { point: string }): Suggestion => ({ label: "Fix", icon: "fix", make: () => ({ type: "fix", ...target }), testId: "c-fix" });

  if (ents.length === 1 && points.length === 0) {
    const e = ents[0];
    if (e.type === "line") {
      out.push(
        { label: "Horizontal", icon: "horizontal", make: () => ({ type: "horizontal", entity: e.id }), testId: "c-horizontal" },
        { label: "Vertical", icon: "vertical", make: () => ({ type: "vertical", entity: e.id }), testId: "c-vertical" },
        fix({ entity: e.id }),
        { label: "Length", icon: "smartDimension", value: round6(dist2(e.start, e.end)), make: (v) => ({ type: "distance", entity: e.id, value: v }), testId: "c-length" },
      );
    }
    if (e.type === "rect") {
      out.push(
        { label: "Centre on origin", icon: "coincident", make: () => ({ type: "coincident", points: [`${e.id}.center`, "origin"] }), testId: "c-center-origin" },
        fix({ entity: e.id }),
        { label: "Width", icon: "smartDimension", value: round6(e.w), make: (v) => ({ type: "distanceX", entity: e.id, value: v }), testId: "c-width" },
        { label: "Height", icon: "smartDimension", value: round6(e.h), make: (v) => ({ type: "distanceY", entity: e.id, value: v }), testId: "c-height" },
      );
    }
    if (isRound(e)) {
      const r = radiusOf(e);
      const diameter: Suggestion = { label: "Diameter", icon: "diameter", value: round6(2 * r), make: (v) => ({ type: "diameter", entity: e.id, value: v }), testId: "c-diameter" };
      const radius: Suggestion = { label: "Radius", icon: "radius", value: round6(r), make: (v) => ({ type: "radius", entity: e.id, value: v }), testId: "c-radius" };
      out.push(
        { label: "Centre on origin", icon: "coincident", make: () => ({ type: "coincident", points: [`${e.id}.center`, "origin"] }), testId: "c-center-origin" },
        fix({ entity: e.id }),
        // SOLIDWORKS dimensions a circle by its diameter and an arc by its radius.
        ...(e.type === "circle" ? [diameter, radius] : [radius, diameter]),
      );
    }
    if (e.type === "slot") {
      out.push(
        fix({ entity: e.id }),
        { label: "Centre distance", icon: "smartDimension", value: round6(dist2(e.center1, e.center2)), make: (v) => ({ type: "distance", entity: e.id, value: v }), testId: "c-slot-length" },
      );
    }
  }

  if (ents.length === 2 && points.length === 0) {
    const [a, b] = ents;
    if (a.type === "line" && b.type === "line") {
      const pair: [string, string] = [a.id, b.id];
      const angle = angleBetween(a, b);
      const parallel = Math.min(angle, 180 - angle) < 1e-6;
      out.push(
        { label: "Parallel", icon: "parallel", make: () => ({ type: "parallel", entities: pair }), testId: "c-parallel" },
        { label: "Perpendicular", icon: "perpendicular", make: () => ({ type: "perpendicular", entities: pair }), testId: "c-perpendicular" },
        { label: "Collinear", icon: "collinear", make: () => ({ type: "collinear", entities: pair }), testId: "c-collinear" },
        { label: "Equal", icon: "equal", make: () => ({ type: "equal", entities: pair }), testId: "c-equal" },
      );
      if (parallel) {
        out.push({ label: "Distance between", icon: "smartDimension", value: round6(offsetFrom(a, b.start)), make: (v) => ({ type: "distance", point: `${b.id}.start`, line: a.id, value: v }), testId: "c-line-distance" });
      } else {
        out.push({ label: "Angle", icon: "angle", unit: "°", value: round6(angle), make: (v) => ({ type: "angle", entities: pair, value: v }), testId: "c-angle" });
      }
    } else if (a.type === "line" || b.type === "line") {
      const [line, other] = (a.type === "line" ? [a, b] : [b, a]) as [Line, SketchEntity];
      if (isRound(other)) {
        const c = (other as { center: Vec2 }).center;
        out.push(
          { label: "Tangent", icon: "tangent", make: () => ({ type: "tangent", entities: [a.id, b.id] }), testId: "c-tangent" },
          { label: "Centre to line", icon: "smartDimension", value: round6(offsetFrom(line, c)), make: (v) => ({ type: "distance", point: `${other.id}.center`, line: line.id, value: v }), testId: "c-line-distance" },
        );
      }
    } else if (isRound(a) && isRound(b)) {
      const pair: [string, string] = [a.id, b.id];
      const ca = (a as { center: Vec2 }).center;
      const cb = (b as { center: Vec2 }).center;
      out.push(
        { label: "Concentric", icon: "concentric", make: () => ({ type: "concentric", entities: pair }), testId: "c-concentric" },
        { label: "Tangent", icon: "tangent", make: () => ({ type: "tangent", entities: pair }), testId: "c-tangent" },
        { label: "Equal", icon: "equal", make: () => ({ type: "equal", entities: pair }), testId: "c-equal" },
        { label: "Centre distance", icon: "smartDimension", value: round6(dist2(ca, cb)), make: (v) => ({ type: "distance", points: [`${a.id}.center`, `${b.id}.center`], value: v }), testId: "c-distance" },
      );
    }
  }

  if (ents.length === 0 && (points.length === 2 || points.length === 1)) {
    const lone = points.length === 1;
    const pair: [string, string] = lone ? [points[0], "origin"] : [points[0], points[1]];
    const p = pointOf(pair[0], byId);
    const q = pointOf(pair[1], byId);
    const to = lone ? " to origin" : "";
    out.push(
      { label: lone ? "Coincident with origin" : "Coincident", icon: "coincident", make: () => ({ type: "coincident", points: pair }), testId: "c-coincident" },
      { label: `Horizontal${to}`, icon: "horizontal", make: () => ({ type: "horizontal", points: pair }), testId: "c-horizontal-points" },
      { label: `Vertical${to}`, icon: "vertical", make: () => ({ type: "vertical", points: pair }), testId: "c-vertical-points" },
    );
    if (lone && pair[0] !== "origin") out.push(fix({ point: pair[0] }));
    out.push(
      { label: `Horizontal distance${to}`, icon: "smartDimension", value: round6(Math.abs(q[0] - p[0])), make: (v) => ({ type: "distanceX", points: pair, value: v }), testId: "c-distance-x" },
      { label: `Vertical distance${to}`, icon: "smartDimension", value: round6(Math.abs(q[1] - p[1])), make: (v) => ({ type: "distanceY", points: pair, value: v }), testId: "c-distance-y" },
      { label: `Distance${to}`, icon: "smartDimension", value: round6(dist2(p, q)), make: (v) => ({ type: "distance", points: pair, value: v }), testId: "c-distance" },
    );
  }

  if (ents.length === 1 && points.length === 1 && ownerOf(points[0]) !== ents[0].id) {
    const [e] = ents;
    const ref = points[0];
    const p = pointOf(ref, byId);
    if (e.type === "line") {
      out.push(
        { label: "Coincident", icon: "pointOn", make: () => ({ type: "pointOn", point: ref, entity: e.id }), testId: "c-on" },
        { label: "Midpoint", icon: "midpoint", make: () => ({ type: "midpoint", point: ref, entity: e.id }), testId: "c-midpoint" },
        { label: "Distance to line", icon: "smartDimension", value: round6(offsetFrom(e, p)), make: (v) => ({ type: "distance", point: ref, line: e.id, value: v }), testId: "c-line-distance" },
      );
    } else if (isRound(e)) {
      out.push(
        { label: "Coincident", icon: "pointOn", make: () => ({ type: "pointOn", point: ref, entity: e.id }), testId: "c-on" },
        { label: "At its centre", icon: "concentric", make: () => ({ type: "coincident", points: [ref, `${e.id}.center`] }), testId: "c-at-center" },
        { label: "Distance to centre", icon: "smartDimension", value: round6(dist2(p, (e as { center: Vec2 }).center)), make: (v) => ({ type: "distance", points: [ref, `${e.id}.center`], value: v }), testId: "c-distance" },
      );
    } else if (e.type === "slot") {
      out.push({ label: "Midpoint", icon: "midpoint", make: () => ({ type: "midpoint", point: ref, entity: e.id }), testId: "c-midpoint" });
    }
  }

  if (ents.length === 1 && ents[0].type === "line" && points.length === 2 && points.every((r) => ownerOf(r) !== ents[0].id)) {
    const pair: [string, string] = [points[0], points[1]];
    out.push({ label: "Symmetric", icon: "symmetric", make: () => ({ type: "symmetric", points: pair, line: ents[0].id }), testId: "c-symmetric" });
  }
  return out;
}

/** Point entities among the items, as their points ("p1" becomes "p1.at"); everything else as it is. */
export function asPoints(items: SketchItem[], byId: Map<string, SketchEntity>): SketchItem[] {
  return items.map((i) => (i.kind === "entity" && byId.get(i.id)?.type === "point" ? { kind: "point", ref: `${i.id}.at` } : i));
}

/**
 * The entities the items stand for: the entities picked, and each sketch point
 * picked by its point (a point entity is picked by its dot), as deleting or
 * changing them wants.
 */
export function itemEntities(items: SketchItem[], entities: SketchEntity[]): string[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const ids = items.flatMap((i) => {
    if (i.kind === "entity") return [i.id];
    const [owner, name] = i.ref.split(".");
    return byId.get(owner)?.type === "point" && name === "at" ? [owner] : [];
  });
  return [...new Set(ids)];
}

/**
 * SOLIDWORKS's Smart Dimension: the dimension the picks call for. One line
 * is its length, a circle its diameter, an arc its radius, a rectangle its
 * width or height by the side clicked; two picks are the distance or angle
 * between them. Alternatives follow the first (two points: aligned,
 * horizontal, vertical). None when the picks can't be dimensioned.
 */
export function smartDimension(entities: SketchEntity[], picksIn: SketchItem[], at?: Vec2): Suggestion[] {
  const picks = asPoints(picksIn, new Map(entities.map((e) => [e.id, e])));
  const valued = suggestions(entities, picks).filter((s) => s.value !== undefined);
  if (picks.length === 1 && picks[0].kind === "entity") {
    const e = entities.find((x) => x.id === (picks[0] as { id: string }).id);
    if (e?.type === "rect" && at) {
      // The nearer side: top or bottom edge reads the width, left or right the height.
      const dx = Math.abs(Math.abs(at[0] - e.center[0]) - e.w / 2);
      const dy = Math.abs(Math.abs(at[1] - e.center[1]) - e.h / 2);
      const first = dy <= dx ? "c-width" : "c-height";
      return valued.sort((a, b) => (a.testId === first ? -1 : b.testId === first ? 1 : 0));
    }
    return valued.slice(0, 1);
  }
  if (picks.length === 2 && picks.every((p) => p.kind === "point")) {
    const order = ["c-distance", "c-distance-x", "c-distance-y"];
    return valued.filter((s) => order.includes(s.testId)).sort((a, b) => order.indexOf(a.testId) - order.indexOf(b.testId));
  }
  return valued.slice(0, 1);
}

/** What a point being placed snaps to, and the relation that keeps it there. */
export interface Inference {
  p: Vec2;
  /** A point it lands on: the new point is made coincident with it. */
  ref: string | null;
  /** A line's middle, or a line, circle or arc it lands on. */
  on?: { type: "midpoint" | "pointOn"; entity: string };
}

/**
 * SOLIDWORKS's sketch inferencing: an end, centre or the origin first, then
 * a line's midpoint, then anywhere on a line, circle or arc. Null when the
 * point lands on nothing (the grid takes it).
 */
export function inferPoint(entities: SketchEntity[], p: Vec2, tol: number, exclude?: string): Inference | null {
  const h = hitHandle(entities, p, tol, { constraintOnly: true, exclude });
  if (h) return { p: h.point, ref: h.ref };
  let best: Inference | null = null;
  let bestD = tol;
  for (const e of entities) {
    if (e.id === exclude) continue;
    if (e.type === "line") {
      const mid: Vec2 = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2];
      const d = dist2(p, mid);
      if (d <= bestD) {
        best = { p: mid, ref: null, on: { type: "midpoint", entity: e.id } };
        bestD = d;
      }
    }
  }
  if (best) return best;
  for (const e of entities) {
    if (e.id === exclude || (e.type !== "line" && !isRound(e))) continue;
    const d = distanceTo(e, p);
    if (d > bestD) continue;
    let q: Vec2;
    if (e.type === "line") {
      const u = unitOf(e);
      const t = (p[0] - e.start[0]) * u[0] + (p[1] - e.start[1]) * u[1];
      q = [e.start[0] + t * u[0], e.start[1] + t * u[1]];
    } else {
      const c = (e as { center: Vec2 }).center;
      const r = radiusOf(e);
      const d0 = dist2(p, c) || 1;
      q = [c[0] + ((p[0] - c[0]) * r) / d0, c[1] + ((p[1] - c[1]) * r) / d0];
    }
    best = { p: q, ref: null, on: { type: "pointOn", entity: e.id } };
    bestD = d;
  }
  return best;
}

/** A line drawn from `a` to near-level or near-plumb `b` (within tol) is snapped to it, and gets that relation. */
export function inferOrientation(a: Vec2, b: Vec2, tol: number): { p: Vec2; type: "horizontal" | "vertical" } | null {
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  if (dx < 1e-9 && dy < 1e-9) return null;
  if (dy <= tol && dx > tol) return { p: [b[0], a[1]], type: "horizontal" };
  if (dx <= tol && dy > tol) return { p: [a[0], b[1]], type: "vertical" };
  return null;
}

/** A short human label for a constraint row. */
export function describeConstraint(k: Constraint): string {
  switch (k.type) {
    case "coincident":
      return `${k.points[0]} ≡ ${k.points[1]}`;
    case "horizontal":
    case "vertical":
      return k.entity ? `${k.entity} ${k.type}` : `${k.points![0]}, ${k.points![1]} ${k.type}`;
    case "distance":
      return k.entity ? `${k.entity} length` : k.points ? `${k.points[0]} ↔ ${k.points[1]}` : `${k.point} ↔ ${k.line}`;
    case "distanceX":
      return `${k.entity ? `${k.entity} width` : `${k.points![0]} ↔ ${k.points![1]} (x)`}`;
    case "distanceY":
      return `${k.entity ? `${k.entity} height` : `${k.points![0]} ↔ ${k.points![1]} (y)`}`;
    case "radius":
      return `${k.entity} radius`;
    case "diameter":
      return `${k.entity} diameter`;
    case "angle":
      return `${k.entities[0]} ∠ ${k.entities[1]}`;
    case "equal":
      return `${k.entities[0]} = ${k.entities[1]}`;
    case "parallel":
      return `${k.entities[0]} ∥ ${k.entities[1]}`;
    case "perpendicular":
      return `${k.entities[0]} ⊥ ${k.entities[1]}`;
    case "collinear":
      return `${k.entities[0]}, ${k.entities[1]} collinear`;
    case "tangent":
      return `${k.entities[0]}, ${k.entities[1]} tangent`;
    case "concentric":
      return `${k.entities[0]}, ${k.entities[1]} concentric`;
    case "midpoint":
      return `${k.point} at the middle of ${k.entity}`;
    case "pointOn":
      return `${k.point} on ${k.entity}`;
    case "symmetric":
      return `${k.points[0]}, ${k.points[1]} symmetric about ${k.line}`;
    case "fix":
      return `${k.entity ?? k.point} fixed`;
  }
}

/** One entity from the clicked points, as the first drawing tools placed them (the registry in tools/ builds the rest). */
export function entityFromClicks(type: SketchEntity["type"], id: string, pts: Vec2[], construction: boolean): SketchEntity | null {
  const extra = construction ? { construction: true } : {};
  const [a, b, c] = pts;
  switch (type) {
    case "line":
      return a && b && dist2(a, b) > 1e-9 ? { id, type, start: a, end: b, ...extra } : null;
    case "rect": {
      if (!a || !b) return null;
      const w = Math.abs(b[0] - a[0]);
      const h = Math.abs(b[1] - a[1]);
      return w > 1e-9 && h > 1e-9 ? { id, type, center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], w, h, ...extra } : null;
    }
    case "circle": {
      if (!a || !b) return null;
      const r = dist2(a, b);
      return r > 1e-9 ? { id, type, center: a, radius: r, ...extra } : null;
    }
    case "arc": {
      if (!a || !b || !c) return null;
      const r = dist2(a, b);
      if (r < 1e-9) return null;
      // The end lands on the circle through the start, in the direction clicked.
      const ang = angleOf(sub2(c, a));
      const end: Vec2 = [a[0] + r * Math.cos(ang), a[1] + r * Math.sin(ang)];
      return dist2(end, b) > 1e-9 ? { id, type, center: a, start: b, end, ...extra } : null;
    }
    case "slot": {
      if (!a || !b || !c) return null;
      if (dist2(a, b) < 1e-9) return null;
      const width = 2 * segDist(c, a, b);
      return width > 1e-9 ? { id, type, center1: a, center2: b, width, ...extra } : null;
    }
    case "point":
      return a ? { id, type, at: a } : null;
  }
}

/** How many clicks each entity takes when placed on its own (the drawing tools are in tools/). */
export const CLICKS: Record<SketchEntity["type"], number> = { line: 2, rect: 2, circle: 2, arc: 3, slot: 3, point: 1 };
