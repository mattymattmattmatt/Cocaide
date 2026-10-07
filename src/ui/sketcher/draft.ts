// Pure helpers for the sketcher: handles, hit testing, snapping, constraint
// suggestions, deletion. No React, so they are unit-tested directly.

import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
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
  /** Builds the constraint; `value` comes from the input when the constraint has one. */
  make(value: number): Constraint;
  /** Current measured value, so adding the constraint moves nothing until it is edited. */
  value?: number;
  testId: string;
}

/** Constraints that make sense for the current selection. */
export function suggestions(entities: SketchEntity[], items: SketchItem[]): Suggestion[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const ents = items.flatMap((i) => (i.kind === "entity" && byId.has(i.id) ? [byId.get(i.id)!] : []));
  const points = items.flatMap((i) => (i.kind === "point" ? [i.ref] : []));
  const out: Suggestion[] = [];
  const round = (x: number) => Math.round(x * 1e6) / 1e6;

  if (ents.length === 1 && points.length === 0) {
    const e = ents[0];
    if (e.type === "line") {
      out.push(
        { label: "Horizontal", make: () => ({ type: "horizontal", entity: e.id }), testId: "c-horizontal" },
        { label: "Vertical", make: () => ({ type: "vertical", entity: e.id }), testId: "c-vertical" },
        { label: "Length", value: round(dist2(e.start, e.end)), make: (v) => ({ type: "distance", entity: e.id, value: v }), testId: "c-length" },
      );
    }
    if (e.type === "rect") {
      out.push(
        { label: "Width", value: round(e.w), make: (v) => ({ type: "distanceX", entity: e.id, value: v }), testId: "c-width" },
        { label: "Height", value: round(e.h), make: (v) => ({ type: "distanceY", entity: e.id, value: v }), testId: "c-height" },
      );
    }
    if (e.type === "circle" || e.type === "arc") {
      const r = e.type === "circle" ? e.radius : dist2(e.start, e.center);
      out.push({ label: "Radius", value: round(r), make: (v) => ({ type: "radius", entity: e.id, value: v }), testId: "c-radius" });
    }
    if (e.type === "slot") {
      out.push({ label: "Centre distance", value: round(dist2(e.center1, e.center2)), make: (v) => ({ type: "distance", entity: e.id, value: v }), testId: "c-slot-length" });
    }
    if (e.type === "rect" || e.type === "circle" || e.type === "arc") {
      out.push({ label: "Centre on origin", make: () => ({ type: "coincident", points: [`${e.id}.center`, "origin"] }), testId: "c-center-origin" });
    }
  }
  if (ents.length === 2 && points.length === 0) {
    const [a, b] = ents;
    const round2 = (t: SketchEntity) => t.type === "circle" || t.type === "arc";
    if ((a.type === "line" && b.type === "line") || (round2(a) && round2(b))) {
      out.push({ label: "Equal", make: () => ({ type: "equal", entities: [a.id, b.id] }), testId: "c-equal" });
    }
  }
  if (ents.length === 0 && (points.length === 2 || points.length === 1)) {
    const pair: [string, string] = points.length === 2 ? [points[0], points[1]] : [points[0], "origin"];
    const p = pointOf(pair[0], byId);
    const q = pointOf(pair[1], byId);
    const to = points.length === 1 ? " to origin" : "";
    out.push(
      { label: points.length === 1 ? "Fix to origin" : "Coincident", make: () => ({ type: "coincident", points: pair }), testId: "c-coincident" },
      { label: `Horizontal distance${to}`, value: round(Math.abs(q[0] - p[0])), make: (v) => ({ type: "distanceX", points: pair, value: v }), testId: "c-distance-x" },
      { label: `Vertical distance${to}`, value: round(Math.abs(q[1] - p[1])), make: (v) => ({ type: "distanceY", points: pair, value: v }), testId: "c-distance-y" },
      { label: `Distance${to}`, value: round(dist2(p, q)), make: (v) => ({ type: "distance", points: pair, value: v }), testId: "c-distance" },
    );
  }
  return out;
}

/** A short human label for a constraint row. */
export function describeConstraint(k: Constraint): string {
  switch (k.type) {
    case "coincident":
      return `${k.points[0]} ≡ ${k.points[1]}`;
    case "horizontal":
    case "vertical":
      return `${k.entity} ${k.type}`;
    case "distance":
      return `${k.entity ? `${k.entity} length` : `${k.points![0]} ↔ ${k.points![1]}`}`;
    case "distanceX":
      return `${k.entity ? `${k.entity} width` : `${k.points![0]} ↔ ${k.points![1]} (x)`}`;
    case "distanceY":
      return `${k.entity ? `${k.entity} height` : `${k.points![0]} ↔ ${k.points![1]} (y)`}`;
    case "radius":
      return `${k.entity} radius`;
    case "equal":
      return `${k.entities[0]} = ${k.entities[1]}`;
  }
}

/** Builds entity parameters from the clicked points of a drawing tool. */
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
  }
}

/** How many clicks a tool needs. */
export const CLICKS: Record<SketchEntity["type"], number> = { line: 2, rect: 2, circle: 2, arc: 3, slot: 3 };
