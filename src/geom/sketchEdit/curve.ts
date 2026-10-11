// Sketch curves for the edit tools: a line, arc or circle as a parametric
// curve, where curves meet, and where a point lies along one. Trim, extend,
// split, fillet and offset all work in these terms. Pure 2D.
//
// Parameters: a line runs t = 0 at its start to 1 at its end; an arc runs
// u = 0 at its start to 1 at its end the way it turns (u beyond 1 is past its
// end, round the rest of its circle); a circle runs u = 0..1 anticlockwise
// from +x.

import type { SketchEntity, Vec2 } from "../../doc/types";
import { add2, angleOf, cross2, dist2, dot2, len2, polar, scale2, sub2, wrapAngle } from "../vec";

/** Positional tolerance (mm): points closer than this are the same point. */
export const TOL = 1e-6;

export type Curve =
  | { kind: "line"; a: Vec2; b: Vec2 }
  /** sweep > 0 turns anticlockwise; 0 < |sweep| < 2π. */
  | { kind: "arc"; c: Vec2; r: number; start: number; sweep: number }
  | { kind: "circle"; c: Vec2; r: number };

/** The curve of a line, arc or circle; null for anything else, or degenerate geometry. */
export function curveOf(e: SketchEntity): Curve | null {
  switch (e.type) {
    case "line":
      return dist2(e.start, e.end) > TOL ? { kind: "line", a: e.start, b: e.end } : null;
    case "circle":
      return e.radius > TOL ? { kind: "circle", c: e.center, r: e.radius } : null;
    case "arc": {
      const r = dist2(e.start, e.center);
      if (r <= TOL || dist2(e.start, e.end) <= TOL) return null;
      const a0 = angleOf(sub2(e.start, e.center));
      const a1 = angleOf(sub2(e.end, e.center));
      const sweep = e.clockwise ? -wrapAngle(a0 - a1) : wrapAngle(a1 - a0);
      return { kind: "arc", c: e.center, r, start: a0, sweep };
    }
    default:
      return null;
  }
}

/** The curves an entity is drawn with: a rectangle's four sides, a slot's sides and ends, a line, arc or circle itself. */
export function curvesOf(e: SketchEntity): Curve[] {
  if (e.type === "rect") {
    const [x0, x1, y0, y1] = [e.center[0] - e.w / 2, e.center[0] + e.w / 2, e.center[1] - e.h / 2, e.center[1] + e.h / 2];
    const p: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    return p.map((a, i) => ({ kind: "line" as const, a, b: p[(i + 1) % 4] }));
  }
  if (e.type === "slot") {
    const l = dist2(e.center1, e.center2);
    if (l <= TOL) return [];
    const u = scale2(sub2(e.center2, e.center1), 1 / l);
    const n: Vec2 = [-u[1], u[0]];
    const r = e.width / 2;
    const up = angleOf(n);
    return [
      { kind: "line", a: add2(e.center1, scale2(n, -r)), b: add2(e.center2, scale2(n, -r)) },
      { kind: "arc", c: e.center2, r, start: up + Math.PI, sweep: Math.PI },
      { kind: "line", a: add2(e.center2, scale2(n, r)), b: add2(e.center1, scale2(n, r)) },
      { kind: "arc", c: e.center1, r, start: up, sweep: Math.PI },
    ];
  }
  const c = curveOf(e);
  return c ? [c] : [];
}

/** The point at a parameter (extended past the ends for a line and an arc). */
export function pointAt(c: Curve, t: number): Vec2 {
  if (c.kind === "line") return add2(c.a, scale2(sub2(c.b, c.a), t));
  if (c.kind === "arc") return polar(c.c, c.r, c.start + c.sweep * t);
  return polar(c.c, c.r, 2 * Math.PI * t);
}

/**
 * Where p lies along the curve (p projected onto it): a line's t, unbounded;
 * an arc's u in [0, 2π/|sweep|) (over 1: round past its end); a circle's u in [0, 1).
 */
export function paramOf(c: Curve, p: Vec2): number {
  if (c.kind === "line") {
    const d = sub2(c.b, c.a);
    return dot2(sub2(p, c.a), d) / dot2(d, d);
  }
  const phi = angleOf(sub2(p, c.c));
  if (c.kind === "circle") return wrapAngle(phi) / (2 * Math.PI);
  const turned = c.sweep > 0 ? wrapAngle(phi - c.start) : wrapAngle(c.start - phi);
  // A hair before the start reads as the start, not as nearly all the way round.
  const full = (2 * Math.PI) / Math.abs(c.sweep);
  const u = turned / Math.abs(c.sweep);
  return full - u < TOL / (c.r * Math.abs(c.sweep)) ? u - full : u;
}

/** Is the parameter on the curve itself (not its extension)? */
export function within(c: Curve, t: number, tol = TOL): boolean {
  if (c.kind === "circle") return true;
  const eps = tol / lengthOf(c);
  return t >= -eps && t <= 1 + eps;
}

/** Length of a line or arc; a circle's circumference. */
export function lengthOf(c: Curve): number {
  if (c.kind === "line") return dist2(c.a, c.b);
  if (c.kind === "arc") return c.r * Math.abs(c.sweep);
  return 2 * Math.PI * c.r;
}

/** The unit direction the curve runs at parameter t. */
export function tangentAt(c: Curve, t: number): Vec2 {
  if (c.kind === "line") {
    const d = sub2(c.b, c.a);
    return scale2(d, 1 / len2(d));
  }
  const angle = c.kind === "arc" ? c.start + c.sweep * t : 2 * Math.PI * t;
  const s = c.kind === "arc" && c.sweep < 0 ? -1 : 1;
  return [-Math.sin(angle) * s, Math.cos(angle) * s];
}

/** Distance from p to the curve itself (not its extension). */
export function distanceTo(c: Curve, p: Vec2): number {
  if (c.kind === "line") {
    const t = Math.max(0, Math.min(1, paramOf(c, p)));
    return dist2(p, pointAt(c, t));
  }
  if (c.kind === "circle") return Math.abs(dist2(p, c.c) - c.r);
  const u = paramOf(c, p);
  if (u >= 0 && u <= 1) return Math.abs(dist2(p, c.c) - c.r);
  return Math.min(dist2(p, pointAt(c, 0)), dist2(p, pointAt(c, 1)));
}

/** The nearest point of the curve's carrier (the line extended, the whole circle) to p. */
export function footOn(c: Curve, p: Vec2): Vec2 {
  if (c.kind === "line") return pointAt(c, paramOf(c, p));
  const d = dist2(p, c.c);
  if (d < 1e-12) return add2(c.c, [c.r, 0]);
  return add2(c.c, scale2(sub2(p, c.c), c.r / d));
}

// ------------------------------------------------------------ meeting points

/**
 * Where two carriers meet: the lines extended, the circles whole. Two points
 * at most; none for parallel lines, concentric circles, or curves that lie
 * on one another.
 */
export function carrierMeet(A: Curve, B: Curve): Vec2[] {
  if (A.kind === "line" && B.kind === "line") return lineLine(A.a, A.b, B.a, B.b);
  if (A.kind === "line") return lineCircle(A.a, A.b, (B as { c: Vec2 }).c, (B as { r: number }).r);
  if (B.kind === "line") return lineCircle(B.a, B.b, A.c, A.r);
  return circleCircle(A.c, A.r, B.c, B.r);
}

/** Where the two curves themselves meet (each within its own extent). */
export function meet(A: Curve, B: Curve, tol = TOL): Vec2[] {
  return carrierMeet(A, B).filter((p) => within(A, paramOf(A, p), tol) && within(B, paramOf(B, p), tol) && distanceTo(A, p) <= 10 * tol && distanceTo(B, p) <= 10 * tol);
}

function lineLine(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2[] {
  const r = sub2(b, a);
  const s = sub2(d, c);
  const den = cross2(r, s);
  if (Math.abs(den) <= 1e-12 * len2(r) * len2(s)) return [];
  const t = cross2(sub2(c, a), s) / den;
  return [add2(a, scale2(r, t))];
}

function lineCircle(a: Vec2, b: Vec2, c: Vec2, r: number): Vec2[] {
  const d = sub2(b, a);
  const u = scale2(d, 1 / len2(d));
  const t0 = dot2(sub2(c, a), u);
  const f = add2(a, scale2(u, t0));
  const h = dist2(f, c);
  if (h > r + TOL) return [];
  if (Math.abs(h - r) <= TOL) return [f];
  const k = Math.sqrt(r * r - h * h);
  return [add2(f, scale2(u, -k)), add2(f, scale2(u, k))];
}

function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = dist2(c1, c2);
  if (d <= TOL) return [];
  if (d > r1 + r2 + TOL || d < Math.abs(r1 - r2) - TOL) return [];
  const along = (d * d + r1 * r1 - r2 * r2) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - along * along));
  const u = scale2(sub2(c2, c1), 1 / d);
  const base = add2(c1, scale2(u, along));
  const n: Vec2 = [-u[1], u[0]];
  return h <= TOL ? [base] : [add2(base, scale2(n, h)), sub2(base, scale2(n, h))];
}

/** Do the two curves lie on one another (collinear lines, the same circle)? */
export function sameCarrier(A: Curve, B: Curve): boolean {
  if (A.kind === "line" && B.kind === "line") {
    const d = sub2(A.b, A.a);
    const n = len2(d);
    return Math.abs(cross2(d, sub2(B.a, A.a))) / n <= TOL && Math.abs(cross2(d, sub2(B.b, A.a))) / n <= TOL;
  }
  if (A.kind === "line" || B.kind === "line") return false;
  return dist2(A.c, B.c) <= TOL && Math.abs(A.r - B.r) <= TOL;
}

/** An arc's curve as an arc entity's fields: from parameter u0 to u1 of the curve. */
export function arcPiece(c: Extract<Curve, { kind: "arc" | "circle" }>, u0: number, u1: number): { center: Vec2; start: Vec2; end: Vec2; clockwise?: boolean } {
  if (c.kind === "circle") return { center: c.c, start: pointAt(c, u0), end: pointAt(c, u1) };
  const out = { center: c.c, start: pointAt(c, u0), end: pointAt(c, u1) };
  return c.sweep < 0 ? { ...out, clockwise: true } : out;
}
