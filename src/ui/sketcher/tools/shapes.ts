// Geometry the drawing tools share: lines joined into a loop, a circle
// through three points, which way a line runs, how far the pointer turned.

import type { Constraint, LineEntity, SketchEntity, Vec2 } from "../../../doc/types";
import { add2, angleOf, cross2, dist2, dot2, len2, scale2, sub2 } from "../../../geom/vec";
import type { Click, IdMaker } from "./types";

/** Shorter than this (mm) is nothing: no line, no radius. */
export const EPS = 1e-9;

export function line(id: string, start: Vec2, end: Vec2, construction = false): LineEntity {
  return { id, type: "line", start, end, ...(construction ? { construction: true } : {}) };
}

/** Lines from each point to the next and the last back to the first, each corner joined by a coincident relation. */
export function closedLoop(ids: IdMaker, pts: Vec2[]): { lines: LineEntity[]; relations: Constraint[] } {
  const lines = pts.map((p) => line(ids("l"), p, p));
  lines.forEach((l, i) => (l.end = pts[(i + 1) % pts.length]));
  const relations: Constraint[] = lines.map((l, i) => ({ type: "coincident", points: [`${l.id}.end`, `${lines[(i + 1) % lines.length].id}.start`] }));
  return { lines, relations };
}

/** The ref of the loop corner at p ("l2.start"), or null when no corner is there. */
export function cornerAt(lines: LineEntity[], p: Vec2): string | null {
  const l = lines.find((x) => dist2(x.start, p) < EPS);
  return l ? `${l.id}.start` : null;
}

export const unit = (v: Vec2): Vec2 => {
  const n = len2(v) || 1;
  return [v[0] / n, v[1] / n];
};

/** A quarter turn anticlockwise. */
export const perp = (v: Vec2): Vec2 => [-v[1], v[0]];

/** The circle through three points, or null when they are in a line. */
export function circumcircle(a: Vec2, b: Vec2, c: Vec2): { center: Vec2; r: number } | null {
  const ab = sub2(b, a);
  const ac = sub2(c, a);
  const d = 2 * cross2(ab, ac);
  const scale = Math.max(len2(ab), len2(ac), 1e-12);
  if (Math.abs(d) < 1e-9 * scale * scale) return null;
  const ab2 = dot2(ab, ab);
  const ac2 = dot2(ac, ac);
  const center: Vec2 = [a[0] + (ac[1] * ab2 - ab[1] * ac2) / d, a[1] + (ab[0] * ac2 - ac[0] * ab2) / d];
  return { center, r: dist2(center, a) };
}

/**
 * Which way the line from a to b runs, as inferred: what the click inferred
 * (drawn nearly level, snapped level), or exactly level or plumb (both ends
 * landed on points that line up).
 */
export function orientOf(a: Vec2, b: Vec2, click?: Click): "horizontal" | "vertical" | null {
  if (click?.orient) return click.orient;
  if (Math.abs(b[1] - a[1]) < EPS) return "horizontal";
  if (Math.abs(b[0] - a[0]) < EPS) return "vertical";
  return null;
}

/** The relation for a line that runs level or plumb, as a list (empty when it does neither). */
export function oriented(id: string, a: Vec2, b: Vec2, click?: Click): Constraint[] {
  const o = orientOf(a, b, click);
  return o ? [{ type: o, entity: id }] : [];
}

/**
 * How far the pointer turned about a centre, signed (anticlockwise positive),
 * going from `from` along the trail: which way round an arc is being drawn.
 */
export function turning(center: Vec2, from: Vec2, trail: Vec2[] = []): number {
  let total = 0;
  let prev = from;
  for (const p of trail) {
    if (dist2(p, center) < EPS) continue;
    let d = angleOf(sub2(p, center)) - angleOf(sub2(prev, center));
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    total += d;
    prev = p;
  }
  return total;
}

/** The first place the pointer went that is more than `away` from p (the way it set off), else null. */
export function lead(p: Vec2, trail: Vec2[] = [], away = 0): Vec2 | null {
  return trail.find((q) => dist2(q, p) > Math.max(away, EPS)) ?? null;
}

/** A point at a signed distance along a direction. */
export const along = (p: Vec2, dir: Vec2, d: number): Vec2 => add2(p, scale2(dir, d));

/** Point entities never become construction; everything else does when Construction is on. */
export function asConstruction(entities: SketchEntity[]): SketchEntity[] {
  return entities.map((e) => (e.type === "point" || e.construction ? e : { ...e, construction: true }));
}
