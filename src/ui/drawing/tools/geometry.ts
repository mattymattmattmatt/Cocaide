// Sheet and view coordinates for the drawing tools (Phase Q wave Q2B): a
// point clicked on the sheet in a view's own millimetres (what a cutting
// line, a detail circle or a crop outline is stored in), and back; where a
// view lined up with its parent must sit; a cutting line run past the part.

import type { Vec2 } from "../../../doc/types";
import { unbreak, viewToSheet, type ComposedView } from "../../../drafting/compose";
import type { Box } from "../../../drafting/sheet";

/** A sheet point in the view's mm (its breaks put back): the inverse of viewToSheet. */
export function sheetToView(cv: Pick<ComposedView, "centre" | "origin" | "scale" | "breaks">, p: Vec2): Vec2 {
  const q: Vec2 = [cv.origin[0] + (p[0] - cv.centre[0]) / cv.scale, cv.origin[1] + (p[1] - cv.centre[1]) / cv.scale];
  if (!cv.breaks.length) return q;
  // unbreak is increasing along each axis: find the point it sends to q by halving.
  const out: Vec2 = [q[0], q[1]];
  for (const axis of [0, 1] as const) {
    if (!cv.breaks.some((b) => b.axis === axis)) continue;
    const span = cv.breaks.filter((b) => b.axis === axis).reduce((s, b) => s + (b.to - b.from), 0) + 1;
    let lo = q[axis] - span;
    let hi = q[axis] + span;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const probe: Vec2 = axis === 0 ? [mid, q[1]] : [q[0], mid];
      if (unbreak(cv.breaks, probe)[axis] < q[axis]) lo = mid;
      else hi = mid;
    }
    out[axis] = (lo + hi) / 2;
  }
  return out;
}

export { viewToSheet };

/**
 * Where a view lined up with its parent sits across: the coordinate (x for
 * a view above or below, y for one beside) that puts the same model point
 * at the same place in both, as the composer lines them up. Null when their
 * scales differ (a view at its own scale is not lined up).
 */
export function alignedCoordinate(child: Pick<ComposedView, "origin" | "scale">, parent: Pick<ComposedView, "centre" | "origin" | "scale">, side: Vec2): { axis: 0 | 1; value: number } | null {
  if (Math.abs(child.scale - parent.scale) > 1e-12) return null;
  const axis = side[0] !== 0 ? 1 : 0;
  return { axis, value: parent.centre[axis] + (child.origin[axis] - parent.origin[axis]) * child.scale };
}

/** The point on the sheet a lined-up view goes to for a pointer at p: p along its line, the parent's line across. */
export function alongLine(p: Vec2, side: Vec2, across: { axis: 0 | 1; value: number }): Vec2 {
  void side;
  return across.axis === 1 ? [p[0], across.value] : [across.value, p[1]];
}

/** A straight cutting line (view mm) run past the outline at both ends by `margin`, along its own direction. */
export function extendThrough(a: Vec2, b: Vec2, outline: Box, margin: number): [Vec2, Vec2] {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const l = Math.hypot(d[0], d[1]);
  if (l < 1e-9) return [a, b];
  const u: Vec2 = [d[0] / l, d[1] / l];
  // The outline's corners along the line: the furthest back and forward.
  const corners: Vec2[] = [outline.min, [outline.max[0], outline.min[1]], outline.max, [outline.min[0], outline.max[1]]];
  const ts = corners.map((c) => (c[0] - a[0]) * u[0] + (c[1] - a[1]) * u[1]);
  const t0 = Math.min(0, Math.min(...ts) - margin);
  const t1 = Math.max(l, Math.max(...ts) + margin);
  return [
    [a[0] + u[0] * t0, a[1] + u[1] * t0],
    [a[0] + u[0] * t1, a[1] + u[1] * t1],
  ];
}

/** A direction held to the sheet's across or down, whichever is nearer (Shift frees it). */
export function squareUp(from: Vec2, to: Vec2): Vec2 {
  return Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]) ? [to[0], from[1]] : [from[0], to[1]];
}

/** The point a step at right angles to the last segment reaches toward p (offset sections turn square). */
export function squareTurn(prev: Vec2, last: Vec2, p: Vec2): Vec2 {
  const d: Vec2 = [last[0] - prev[0], last[1] - prev[1]];
  const l = Math.hypot(d[0], d[1]) || 1;
  const n: Vec2 = [-d[1] / l, d[0] / l];
  const u: Vec2 = [d[0] / l, d[1] / l];
  const t = (p[0] - last[0]) * n[0] + (p[1] - last[1]) * n[1];
  const s = (p[0] - last[0]) * u[0] + (p[1] - last[1]) * u[1];
  // Across (a step) or on along the same way, whichever the pointer is nearer.
  return Math.abs(t) >= Math.abs(s) ? [last[0] + n[0] * t, last[1] + n[1] * t] : [last[0] + u[0] * s, last[1] + u[1] * s];
}

/** Rounded to a hundredth of a millimetre, as stored. */
export function r2(p: Vec2): Vec2 {
  return [Math.round(p[0] * 100) / 100 + 0, Math.round(p[1] * 100) / 100 + 0];
}

/** The eight sides of a view (and its corners): the one a point is toward from the view's centre. */
export function sideToward(centre: Vec2, p: Vec2): "left" | "right" | "up" | "down" | "upLeft" | "upRight" | "downLeft" | "downRight" {
  const a = (Math.atan2(p[1] - centre[1], p[0] - centre[0]) * 180) / Math.PI;
  const sector = Math.round(((a + 360) % 360) / 45) % 8;
  return (["right", "upRight", "up", "upLeft", "left", "downLeft", "down", "downRight"] as const)[sector];
}
