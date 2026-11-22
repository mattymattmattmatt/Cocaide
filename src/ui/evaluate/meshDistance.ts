// The closest points between two picked faces or edges, worked out from the
// shapes as they are drawn: each face's triangles, each edge's segments (the
// view's mesh, src/kernel/mesh.ts). Where the kernel has a solid to ask
// (the part) it measures on the exact geometry; an assembly's view is the
// placed parts' meshes, so it is measured here: exact for flat faces and
// straight edges, and to the drawing's tessellation (a fraction of a
// millimetre on a part) for curved ones. Pure.

import type { Vec3 } from "../../doc/types";
import type { MeshData } from "../../kernel/mesh";
import type { Closest } from "../../kernel/evaluate";

export type MeshRef = { kind: "face"; index: number } | { kind: "edge"; index: number };

type Tri = [Vec3, Vec3, Vec3];
type Seg = [Vec3, Vec3];
interface Prim {
  tri?: Tri;
  seg?: Seg;
  min: Vec3;
  max: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const d2 = (a: Vec3, b: Vec3) => { const d = sub(a, b); return dot(d, d); };
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The closest point of a triangle to p (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestOnTriangle(p: Vec3, [a, b, c]: Tri): Vec3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2_ = dot(ac, ap);
  if (d1 <= 0 && d2_ <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2_;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2_ - d1 * d6;
  if (vb <= 0 && d2_ >= 0 && d6 <= 0) return add(a, mul(ac, d2_ / (d2_ - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return add(a, add(mul(ab, vb * den), mul(ac, vc * den)));
}

/** The closest points of two segments (Ericson 5.1.9). */
export function closestSegSeg([p1, q1]: Seg, [p2, q2]: Seg): [Vec3, Vec3] {
  const d1 = sub(q1, p1), d2v = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2v, d2v), f = dot(d2v, r);
  let s: number, t: number;
  if (a <= 1e-12 && e <= 1e-12) return [p1, p2];
  if (a <= 1e-12) { s = 0; t = clamp01(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { t = 0; s = clamp01(-c / a); }
    else {
      const b = dot(d1, d2v), den = a * e - b * b;
      s = den > 1e-12 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  return [add(p1, mul(d1, s)), add(p2, mul(d2v, t))];
}

/** Where a segment passes through a triangle, if it does. */
function pierce([p, q]: Seg, [a, b, c]: Tri): Vec3 | null {
  const n = cross(sub(b, a), sub(c, a));
  const dp = dot(sub(p, a), n), dq = dot(sub(q, a), n);
  if ((dp > 0 && dq > 0) || (dp < 0 && dq < 0) || Math.abs(dp - dq) < 1e-12) return null;
  const x = add(p, mul(sub(q, p), dp / (dp - dq)));
  const inside = (u: Vec3, v: Vec3) => dot(cross(sub(v, u), sub(x, u)), n) >= -1e-9;
  return inside(a, b) && inside(b, c) && inside(c, a) ? x : null;
}

/** The closest points of a segment and a triangle. */
function segTri(s: Seg, t: Tri): [Vec3, Vec3] {
  const x = pierce(s, t);
  if (x) return [x, x];
  let best: [Vec3, Vec3] = [s[0], closestOnTriangle(s[0], t)];
  let bd = d2(...best);
  const q = closestOnTriangle(s[1], t);
  if (d2(s[1], q) < bd) { best = [s[1], q]; bd = d2(s[1], q); }
  for (const e of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]] as Seg[]) {
    const [u, v] = closestSegSeg(s, e);
    const dd = d2(u, v);
    if (dd < bd) { best = [u, v]; bd = dd; }
  }
  return best;
}

function closestPrims(a: Prim, b: Prim): [Vec3, Vec3] {
  if (a.seg && b.seg) return closestSegSeg(a.seg, b.seg);
  if (a.seg && b.tri) return segTri(a.seg, b.tri);
  if (a.tri && b.seg) { const [u, v] = segTri(b.seg, a.tri); return [v, u]; }
  // Two triangles: each one's edges against the other.
  const A = a.tri!, B = b.tri!;
  let best: [Vec3, Vec3] | null = null;
  let bd = Infinity;
  for (const e of [[A[0], A[1]], [A[1], A[2]], [A[2], A[0]]] as Seg[]) { const r = segTri(e, B); const dd = d2(...r); if (dd < bd) { bd = dd; best = r; } }
  for (const e of [[B[0], B[1]], [B[1], B[2]], [B[2], B[0]]] as Seg[]) { const [u, v] = segTri(e, A); const dd = d2(u, v); if (dd < bd) { bd = dd; best = [v, u]; } }
  return best!;
}

const boxed = (pts: Vec3[]): { min: Vec3; max: Vec3 } => ({
  min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.min(...pts.map((p) => p[2]))],
  max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[2]))],
});
const boxGap2 = (a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }) => {
  let s = 0;
  for (let k = 0; k < 3; k++) { const g = Math.max(0, a.min[k] - b.max[k], b.min[k] - a.max[k]); s += g * g; }
  return s;
};

/** A face's triangles or an edge's segments, from the mesh. */
export function primitives(mesh: MeshData, ref: MeshRef): Prim[] {
  const v = (i: number): Vec3 => [mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]];
  const out: Prim[] = [];
  if (ref.kind === "face") {
    const r = mesh.faceRanges[ref.index];
    if (!r) return out;
    for (let k = r.start; k + 2 < r.start + r.count; k += 3) {
      const tri: Tri = [v(mesh.indices[k]), v(mesh.indices[k + 1]), v(mesh.indices[k + 2])];
      out.push({ tri, ...boxed(tri) });
    }
  } else {
    const r = mesh.edgeRanges[ref.index];
    if (!r) return out;
    for (let k = r.start; k < r.start + r.count; k++) {
      const e = mesh.edges;
      const seg: Seg = [[e[6 * k], e[6 * k + 1], e[6 * k + 2]], [e[6 * k + 3], e[6 * k + 4], e[6 * k + 5]]];
      out.push({ seg, ...boxed(seg) });
    }
  }
  return out;
}

/** The minimum distance between two picked faces or edges, and where it is; null when either has nothing drawn. */
export function meshClosest(mesh: MeshData, a: MeshRef, b: MeshRef): Closest | null {
  const A = primitives(mesh, a);
  const B = primitives(mesh, b);
  if (!A.length || !B.length) return null;
  // Pairs nearest by their boxes first, so the best found early lets most of the rest be skipped.
  const bb = boxed(B.flatMap((p) => [p.min, p.max]));
  const order = [...A].sort((p, q) => boxGap2(p, bb) - boxGap2(q, bb));
  let best: [Vec3, Vec3] | null = null;
  let bd = Infinity;
  for (const p of order) {
    if (boxGap2(p, bb) >= bd) break;
    for (const q of B) {
      if (boxGap2(p, q) >= bd) continue;
      const r = closestPrims(p, q);
      const dd = d2(...r);
      if (dd < bd) { bd = dd; best = r; if (dd === 0) break; }
    }
    if (bd === 0) break;
  }
  return best ? { distance: Math.sqrt(bd), a: best[0], b: best[1] } : null;
}
