// Outlines of curved faces for the line display styles (hidden lines
// removed or visible, wireframe). A B-rep cylinder has edges only at its
// ends, so drawn as lines alone it would be two circles; the outline is
// where the surface turns from facing the eye to facing away, found from the
// tessellation: a triangle edge between a front-facing and a back-facing
// triangle of the same curved face. Plain typed arrays, no three.js, so
// Vitest covers it.

import type { Vec3 } from "../../doc/types";

export interface Adjacency {
  /** Per shared triangle edge: its two vertex positions (6 floats). */
  ends: Float32Array;
  /** Per shared triangle edge: the two triangles' unit normals (6 floats) and a point of each (6 floats). */
  normals: Float32Array;
  points: Float32Array;
  count: number;
}

/**
 * The triangle edges shared inside each curved face (`curved[i]`: face i is
 * not flat; flat faces have no outline). Vertices are matched by position, so
 * a seam where the tessellation repeats a vertex still joins up.
 */
export function adjacency(positions: Float32Array, indices: Uint32Array, ranges: { start: number; count: number }[], curved: boolean[]): Adjacency {
  const ends: number[] = [];
  const normals: number[] = [];
  const points: number[] = [];
  const key = (i: number) => `${Math.round(positions[3 * i] * 1e4)},${Math.round(positions[3 * i + 1] * 1e4)},${Math.round(positions[3 * i + 2] * 1e4)}`;
  ranges.forEach((r, face) => {
    if (!curved[face]) return;
    const open = new Map<string, { tri: number; a: number; b: number }>();
    const triNormal = (t: number): Vec3 => {
      const [i, j, k] = [indices[t], indices[t + 1], indices[t + 2]];
      const u: Vec3 = [positions[3 * j] - positions[3 * i], positions[3 * j + 1] - positions[3 * i + 1], positions[3 * j + 2] - positions[3 * i + 2]];
      const v: Vec3 = [positions[3 * k] - positions[3 * i], positions[3 * k + 1] - positions[3 * i + 1], positions[3 * k + 2] - positions[3 * i + 2]];
      const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      return [n[0] / l, n[1] / l, n[2] / l];
    };
    for (let t = r.start; t < r.start + r.count; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = indices[t + e];
        const b = indices[t + ((e + 1) % 3)];
        const ka = key(a);
        const kb = key(b);
        if (ka === kb) continue;
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const other = open.get(k);
        if (!other) {
          open.set(k, { tri: t, a, b });
          continue;
        }
        open.delete(k);
        for (const i of [a, b]) ends.push(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
        normals.push(...triNormal(other.tri), ...triNormal(t));
        points.push(positions[3 * indices[other.tri]], positions[3 * indices[other.tri] + 1], positions[3 * indices[other.tri] + 2]);
        points.push(positions[3 * indices[t]], positions[3 * indices[t] + 1], positions[3 * indices[t] + 2]);
      }
    }
  });
  return { ends: new Float32Array(ends), normals: new Float32Array(normals), points: new Float32Array(points), count: ends.length / 6 };
}

/**
 * The outline as seen from `eye` (perspective) or along `look` (orthographic,
 * eye null): segment pairs, 6 floats each.
 */
export function silhouette(adj: Adjacency, eye: Vec3 | null, look: Vec3): Float32Array {
  const out: number[] = [];
  const facing = (n: number, p: number) => {
    const d: Vec3 = eye ? [adj.points[p] - eye[0], adj.points[p + 1] - eye[1], adj.points[p + 2] - eye[2]] : look;
    return adj.normals[n] * d[0] + adj.normals[n + 1] * d[1] + adj.normals[n + 2] * d[2] < 0;
  };
  for (let i = 0; i < adj.count; i++) {
    if (facing(6 * i, 6 * i) !== facing(6 * i + 3, 6 * i + 3)) for (let k = 0; k < 6; k++) out.push(adj.ends[6 * i + k]);
  }
  return new Float32Array(out);
}
