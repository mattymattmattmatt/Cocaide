// Cutting lines down to a region of a view (Phase Q): a detail view keeps what
// is inside its circle, a crop what is inside its outline, a break leaves out
// what is between its two lines. Pure 2D on polylines; a polyline that leaves
// the region and comes back becomes two.

import type { Vec2 } from "../doc/types";

/** True when p is inside the closed polygon (even-odd). */
export function insidePolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Where segment p→q crosses the polygon's sides, as fractions along it, in order. */
function crossings(p: Vec2, q: Vec2, poly: Vec2[]): number[] {
  const out: number[] = [];
  const d: Vec2 = [q[0] - p[0], q[1] - p[1]];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const e: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-14) continue;
    const t = ((a[0] - p[0]) * e[1] - (a[1] - p[1]) * e[0]) / den;
    const u = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den;
    if (t > 1e-12 && t < 1 - 1e-12 && u >= -1e-12 && u <= 1 + 1e-12) out.push(t);
  }
  return out.sort((x, y) => x - y);
}

/** Where segment p→q crosses a circle, as fractions along it. */
function circleCrossings(p: Vec2, q: Vec2, c: Vec2, r: number): number[] {
  const d: Vec2 = [q[0] - p[0], q[1] - p[1]];
  const f: Vec2 = [p[0] - c[0], p[1] - c[1]];
  const a = d[0] * d[0] + d[1] * d[1];
  const b = 2 * (f[0] * d[0] + f[1] * d[1]);
  const k = f[0] * f[0] + f[1] * f[1] - r * r;
  const disc = b * b - 4 * a * k;
  if (a < 1e-18 || disc <= 0) return [];
  const s = Math.sqrt(disc);
  return [(-b - s) / (2 * a), (-b + s) / (2 * a)].filter((t) => t > 1e-12 && t < 1 - 1e-12);
}

const lerp = (p: Vec2, q: Vec2, t: number): Vec2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/** The pieces of a polyline that `keep` says are in, split where `cross` says it crosses the boundary. */
function clipBy(pts: Vec2[], keep: (p: Vec2) => boolean, cross: (p: Vec2, q: Vec2) => number[]): Vec2[][] {
  const out: Vec2[][] = [];
  let cur: Vec2[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const ts = [0, ...cross(p, q), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      const a = lerp(p, q, ts[k]);
      const b = lerp(p, q, ts[k + 1]);
      if (keep(lerp(p, q, (ts[k] + ts[k + 1]) / 2))) {
        if (!cur.length) cur.push(a);
        else {
          const last = cur[cur.length - 1];
          if (Math.hypot(last[0] - a[0], last[1] - a[1]) > 1e-9) {
            flush();
            cur.push(a);
          }
        }
        cur.push(b);
      } else flush();
    }
  }
  flush();
  return out;
}

/** The parts of a polyline inside (or, `outside`, outside) a closed polygon. */
export function clipToPolygon(pts: Vec2[], poly: Vec2[], outside = false): Vec2[][] {
  return clipBy(pts, (p) => insidePolygon(p, poly) !== outside, (p, q) => crossings(p, q, poly));
}

/** The parts of a polyline inside (or outside) a circle. */
export function clipToCircle(pts: Vec2[], c: Vec2, r: number, outside = false): Vec2[][] {
  return clipBy(pts, (p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < r !== outside, (p, q) => circleCrossings(p, q, c, r));
}

/** The parts of a polyline outside the open intervals along an axis (0 x, 1 y): a broken view's lines. */
export function clipOutside(pts: Vec2[], axis: 0 | 1, gaps: [number, number][]): Vec2[][] {
  if (!gaps.length) return [pts];
  const keep = (p: Vec2) => !gaps.some(([a, b]) => p[axis] > a && p[axis] < b);
  const cross = (p: Vec2, q: Vec2) => {
    const out: number[] = [];
    const d = q[axis] - p[axis];
    if (Math.abs(d) < 1e-14) return out;
    for (const [a, b] of gaps) for (const v of [a, b]) {
      const t = (v - p[axis]) / d;
      if (t > 1e-12 && t < 1 - 1e-12) out.push(t);
    }
    return out.sort((x, y) => x - y);
  };
  return clipBy(pts, keep, cross);
}

/** A polygon's signed area (counter-clockwise positive). */
export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** The area inside a set of loops, even-odd (holes subtract): the larger loops minus what is in them. */
export function loopsArea(loops: Vec2[][]): number {
  let total = 0;
  for (const l of loops) {
    // A loop inside an odd number of others is a hole.
    const depth = loops.filter((o) => o !== l && insidePolygon(l[0], o)).length;
    total += (depth % 2 ? -1 : 1) * Math.abs(signedArea(l));
  }
  return total;
}
