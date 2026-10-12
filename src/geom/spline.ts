// Splines through points: the curve a sketch spline is.
//
// A cubic spline, twice continuously differentiable, through every point in
// order, parameterised by chord length (the parameter grows by the straight
// distance between neighbouring points, so it runs at about unit speed). The
// ends of an open spline are natural (no bending there) unless an end
// tangent direction is given; a closed spline is periodic. Each piece between
// two neighbouring points is a cubic Bezier, so the curve is exact: the kernel
// builds the same curve (a B-spline with these parameters and end
// derivatives), and areas, lengths and intersections here are of the curve
// itself, not of a polyline.
//
// Pure, no kernel.

import type { Vec2 } from "../doc/types";

/** One piece of a spline: a cubic Bezier from p[0] to p[3]. */
export type Bezier = [Vec2, Vec2, Vec2, Vec2];

export interface SplineCurve {
  /** The points it passes through, in order (a closed spline does not repeat the first). */
  points: Vec2[];
  closed: boolean;
  /** Parameter at each point (chord length from the first); a closed spline's last entry is its whole length round. */
  knots: number[];
  /** First derivative (d/dparameter) at each knot; a closed spline's last equals its first. */
  derivs: Vec2[];
  /** One Bezier per piece: points.length - 1 pieces, or points.length when closed. */
  spans: Bezier[];
}

/** Interpolating spline problems are told to the user: fewer than two points, or two in the same place. */
export class SplineError extends Error {}

/**
 * The spline through `points`. Open: natural ends unless `startTangent` /
 * `endTangent` (unit direction vectors, the way the curve runs) clamp them.
 * Closed: periodic (tangents ignored).
 */
export function interpolate(points: Vec2[], closed = false, startTangent?: Vec2 | null, endTangent?: Vec2 | null): SplineCurve {
  const n = points.length;
  if (n < 2) throw new SplineError("a spline needs at least two points");
  if (closed && n < 3) throw new SplineError("a closed spline needs at least three points");
  const pts = closed ? [...points, points[0]] : points;
  const knots = [0];
  for (let i = 1; i < pts.length; i++) {
    const h = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (h < 1e-9) throw new SplineError(`spline points ${i - 1} and ${i % n} are in the same place`);
    knots.push(knots[i - 1] + h);
  }
  const derivs = closed ? periodicDerivs(pts, knots) : openDerivs(pts, knots, startTangent ?? null, endTangent ?? null);
  const spans: Bezier[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const h = knots[i + 1] - knots[i];
    const p = pts[i];
    const q = pts[i + 1];
    spans.push([p, [p[0] + (h * derivs[i][0]) / 3, p[1] + (h * derivs[i][1]) / 3], [q[0] - (h * derivs[i + 1][0]) / 3, q[1] - (h * derivs[i + 1][1]) / 3], q]);
  }
  return { points, closed, knots, derivs, spans };
}

/**
 * C2 continuity at every inner point, per coordinate:
 * h[i] m[i-1] + 2(h[i-1] + h[i]) m[i] + h[i-1] m[i+1] = 3 (h[i] d[i-1] + h[i-1] d[i]),
 * with d the chord slopes; natural ends (2 m0 + m1 = 3 d0) or clamped ones (m0 given).
 */
function openDerivs(pts: Vec2[], t: number[], start: Vec2 | null, end: Vec2 | null): Vec2[] {
  const n = pts.length;
  const h = (i: number) => t[i + 1] - t[i];
  const slope = (i: number, k: 0 | 1) => (pts[i + 1][k] - pts[i][k]) / h(i);
  const out: Vec2[] = pts.map(() => [0, 0]);
  for (const k of [0, 1] as const) {
    const a = new Float64Array(n); // below the diagonal
    const b = new Float64Array(n); // diagonal
    const c = new Float64Array(n); // above
    const r = new Float64Array(n);
    if (start) (b[0] = 1), (r[0] = start[k]);
    else (b[0] = 2), (c[0] = 1), (r[0] = 3 * slope(0, k));
    for (let i = 1; i < n - 1; i++) {
      a[i] = h(i);
      b[i] = 2 * (h(i - 1) + h(i));
      c[i] = h(i - 1);
      r[i] = 3 * (h(i) * slope(i - 1, k) + h(i - 1) * slope(i, k));
    }
    if (end) (b[n - 1] = 1), (r[n - 1] = end[k]);
    else (a[n - 1] = 1), (b[n - 1] = 2), (r[n - 1] = 3 * slope(n - 2, k));
    const m = tridiagonal(a, b, c, r);
    m.forEach((v, i) => (out[i][k] = v));
  }
  return out;
}

/** The same continuity all the way round: a cyclic system (pts repeats the first point last). */
function periodicDerivs(pts: Vec2[], t: number[]): Vec2[] {
  const n = pts.length - 1; // distinct points
  const h = (i: number) => t[((i % n) + n) % n + 1] - t[((i % n) + n) % n];
  const slope = (i: number, k: 0 | 1) => {
    const j = ((i % n) + n) % n;
    return (pts[j + 1][k] - pts[j][k]) / h(j);
  };
  const out: Vec2[] = pts.map(() => [0, 0]);
  for (const k of [0, 1] as const) {
    const A = Array.from({ length: n }, () => new Float64Array(n));
    const r = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      A[i][(i - 1 + n) % n] += h(i);
      A[i][i] += 2 * (h(i - 1) + h(i));
      A[i][(i + 1) % n] += h(i - 1);
      r[i] = 3 * (h(i) * slope(i - 1, k) + h(i - 1) * slope(i, k));
    }
    const m = dense(A, r);
    for (let i = 0; i < n; i++) out[i][k] = m[i];
    out[n][k] = m[0];
  }
  return out;
}

function tridiagonal(a: Float64Array, b: Float64Array, c: Float64Array, r: Float64Array): Float64Array {
  const n = b.length;
  const cp = new Float64Array(n);
  const rp = new Float64Array(n);
  cp[0] = c[0] / b[0];
  rp[0] = r[0] / b[0];
  for (let i = 1; i < n; i++) {
    const d = b[i] - a[i] * cp[i - 1];
    cp[i] = c[i] / d;
    rp[i] = (r[i] - a[i] * rp[i - 1]) / d;
  }
  const x = new Float64Array(n);
  x[n - 1] = rp[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = rp[i] - cp[i] * x[i + 1];
  return x;
}

function dense(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length;
  const M = A.map((row) => Float64Array.from(row));
  const v = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    [v[c], v[p]] = [v[p], v[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r][k] -= f * M[c][k];
      v[r] -= f * v[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = v[r];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// ----------------------------------------------------------- Bezier pieces

/** A Bezier's point at u in [0, 1]. */
export function bezierPoint([p0, p1, p2, p3]: Bezier, u: number): Vec2 {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** A Bezier's derivative d/du at u. */
export function bezierDeriv([p0, p1, p2, p3]: Bezier, u: number): Vec2 {
  const v = 1 - u;
  const a = 3 * v * v;
  const b = 6 * v * u;
  const c = 3 * u * u;
  return [a * (p1[0] - p0[0]) + b * (p2[0] - p1[0]) + c * (p3[0] - p2[0]), a * (p1[1] - p0[1]) + b * (p2[1] - p1[1]) + c * (p3[1] - p2[1])];
}

/** A Bezier's second derivative at u. */
export function bezierDeriv2([p0, p1, p2, p3]: Bezier, u: number): Vec2 {
  const v = 1 - u;
  return [6 * v * (p2[0] - 2 * p1[0] + p0[0]) + 6 * u * (p3[0] - 2 * p2[0] + p1[0]), 6 * v * (p2[1] - 2 * p1[1] + p0[1]) + 6 * u * (p3[1] - 2 * p2[1] + p1[1])];
}

export function reverseBezier([p0, p1, p2, p3]: Bezier): Bezier {
  return [p3, p2, p1, p0];
}

/** The same curve run the other way: a closed one still starts (and ends) at its first point. */
export function reverseSpline(s: SplineCurve): SplineCurve {
  const total = s.knots[s.knots.length - 1];
  const points = s.closed ? [s.points[0], ...s.points.slice(1).reverse()] : [...s.points].reverse();
  return {
    points,
    closed: s.closed,
    knots: s.knots.map((k) => total - k).reverse(),
    derivs: s.derivs.map(([x, y]) => [-x, -y] as Vec2).reverse(),
    spans: s.spans.map(reverseBezier).reverse(),
  };
}

const GAUSS3: [number, number][] = [
  [0.5 - Math.sqrt(15) / 10, 5 / 18],
  [0.5, 8 / 18],
  [0.5 + Math.sqrt(15) / 10, 5 / 18],
];

/** ½∫(x dy − y dx) over the piece: exact (the integrand is a quintic; three Gauss points integrate it exactly). */
export function bezierArea(b: Bezier): number {
  let s = 0;
  for (const [u, w] of GAUSS3) {
    const p = bezierPoint(b, u);
    const d = bezierDeriv(b, u);
    s += w * (p[0] * d[1] - p[1] * d[0]);
  }
  return 0.5 * s;
}

/** A piece's length (Gauss–Legendre over 16 sub-intervals: well under a micrometre off for sketch-sized curves). */
export function bezierLength(b: Bezier): number {
  let s = 0;
  const parts = 16;
  for (let k = 0; k < parts; k++) {
    for (const [u, w] of GAUSS3) {
      const d = bezierDeriv(b, (k + u) / parts);
      s += (w * Math.hypot(d[0], d[1])) / parts;
    }
  }
  return s;
}

/** Points along a piece, ends included, at most `maxStep` apart along the control polygon (and at least 8 steps). */
export function sampleBezier(b: Bezier, maxStep = Infinity, minSteps = 8): Vec2[] {
  const poly = Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1]) + Math.hypot(b[2][0] - b[1][0], b[2][1] - b[1][1]) + Math.hypot(b[3][0] - b[2][0], b[3][1] - b[2][1]);
  const n = Math.max(minSteps, Math.min(400, Math.ceil(poly / maxStep)));
  return Array.from({ length: n + 1 }, (_, i) => (i === 0 ? b[0] : i === n ? b[3] : bezierPoint(b, i / n)));
}

// ---------------------------------------------------------- whole splines

/** The point at a global parameter (0 to the last knot). */
export function splinePoint(s: SplineCurve, t: number): Vec2 {
  const [i, u] = locate(s, t);
  return bezierPoint(s.spans[i], u);
}

/** The unit tangent at a global parameter, the way the spline runs. */
export function splineTangentAt(s: SplineCurve, t: number): Vec2 {
  const [i, u] = locate(s, t);
  const d = bezierDeriv(s.spans[i], u);
  const l = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / l, d[1] / l];
}

/** The unit tangent at the start (`end` false) or end of an open spline, the way it runs. */
export function endTangent(s: SplineCurve, end: boolean): Vec2 {
  const d = end ? s.derivs[s.derivs.length - 1] : s.derivs[0];
  const l = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / l, d[1] / l];
}

/** Which piece a parameter falls in, and where in it (0..1). */
function locate(s: SplineCurve, t: number): [number, number] {
  const k = s.knots;
  let i = 0;
  while (i < s.spans.length - 1 && t > k[i + 1]) i++;
  return [i, Math.min(1, Math.max(0, (t - k[i]) / (k[i + 1] - k[i])))];
}

/** Signed ½∮(x dy − y dx) along the whole spline (closed: its enclosed area, positive when counter-clockwise). */
export function splineArea(s: SplineCurve): number {
  return s.spans.reduce((t, b) => t + bezierArea(b), 0);
}

export function splineLength(s: SplineCurve): number {
  return s.spans.reduce((t, b) => t + bezierLength(b), 0);
}

/** A polyline along the spline, through every point it interpolates. */
export function sampleSpline(s: SplineCurve, maxStep = Infinity, minSteps = 8): Vec2[] {
  const out: Vec2[] = [];
  s.spans.forEach((b, i) => {
    const pts = sampleBezier(b, maxStep, minSteps);
    out.push(...(i === 0 ? pts : pts.slice(1)));
  });
  return out;
}

/** The nearest point of the spline to p: the global parameter, the point and the distance. */
export function closestOnSpline(s: SplineCurve, p: Vec2): { t: number; at: Vec2; distance: number } {
  let best = { t: 0, at: s.spans[0][0], distance: Infinity };
  s.spans.forEach((b, i) => {
    const k0 = s.knots[i];
    const h = s.knots[i + 1] - k0;
    const steps = 24;
    let bu = 0;
    let bd = Infinity;
    for (let j = 0; j <= steps; j++) {
      const q = bezierPoint(b, j / steps);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) (bd = d), (bu = j / steps);
    }
    // A few Newton steps on (B(u) − p)·B'(u) = 0.
    let u = bu;
    for (let it = 0; it < 12; it++) {
      const q = bezierPoint(b, u);
      const d1 = bezierDeriv(b, u);
      const d2 = bezierDeriv2(b, u);
      const f = (q[0] - p[0]) * d1[0] + (q[1] - p[1]) * d1[1];
      const df = d1[0] * d1[0] + d1[1] * d1[1] + (q[0] - p[0]) * d2[0] + (q[1] - p[1]) * d2[1];
      if (Math.abs(df) < 1e-15) break;
      const next = Math.min(1, Math.max(0, u - f / df));
      if (Math.abs(next - u) < 1e-15) break;
      u = next;
    }
    const q = bezierPoint(b, u);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < best.distance) best = { t: k0 + u * h, at: q, distance: d };
  });
  return best;
}
