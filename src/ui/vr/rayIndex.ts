// A bounding-volume tree over a mesh's triangles, for VR's rays. A house is hundreds of thousands of triangles; three's
// own raycast tests every one of them for every ray, and the teleport arc casts sixty a frame. This finds the nearest
// triangle a ray meets in a few dozen box and triangle tests. Triangles can be skipped (hidden in VR) without building
// it again. Pure (no three.js): positions and the index in, triangle and distance out, in the mesh's own frame.

export interface RayHit {
  /** The triangle (its place in the index, as three's faceIndex). */
  tri: number;
  /** Along the ray, in its direction's units. */
  t: number;
  /** The triangle's normal (unit, its winding's side). */
  normal: [number, number, number];
}

const LEAF = 8;

export class RayIndex {
  /** Per node: min xyz, max xyz. */
  private boxes: Float32Array;
  /** Per node: for a leaf, the first triangle in `order` and how many (count > 0); else the two children (count 0). */
  private first: Int32Array;
  private count: Int32Array;
  private right: Int32Array;
  private order: Uint32Array;
  private nodes = 0;
  readonly triangles: number;

  constructor(
    private pos: ArrayLike<number>,
    private index: ArrayLike<number>,
  ) {
    const n = Math.floor(index.length / 3);
    this.triangles = n;
    const cen = new Float32Array(n * 3);
    const tb = new Float32Array(n * 6);
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 3; k++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let v = 0; v < 3; v++) {
          const x = pos[index[t * 3 + v] * 3 + k];
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
        tb[t * 6 + k] = lo;
        tb[t * 6 + 3 + k] = hi;
        cen[t * 3 + k] = (lo + hi) / 2;
      }
    }
    const cap = Math.max(1, 2 * Math.ceil(n / (LEAF / 2)) + 1);
    this.boxes = new Float32Array(cap * 6);
    this.first = new Int32Array(cap);
    this.count = new Int32Array(cap);
    this.right = new Int32Array(cap);
    this.order = new Uint32Array(n);
    for (let t = 0; t < n; t++) this.order[t] = t;
    // Built top down, splitting each node's triangles at the middle of their centres' spread along its widest axis.
    const stack: [number, number, number][] = [[this.alloc(), 0, n]];
    while (stack.length) {
      const [node, a, b] = stack.pop()!;
      const bx = this.boxes;
      const c0 = [Infinity, Infinity, Infinity];
      const c1 = [-Infinity, -Infinity, -Infinity];
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = a; i < b; i++) {
        const t = this.order[i];
        for (let k = 0; k < 3; k++) {
          if (tb[t * 6 + k] < lo[k]) lo[k] = tb[t * 6 + k];
          if (tb[t * 6 + 3 + k] > hi[k]) hi[k] = tb[t * 6 + 3 + k];
          const c = cen[t * 3 + k];
          if (c < c0[k]) c0[k] = c;
          if (c > c1[k]) c1[k] = c;
        }
      }
      for (let k = 0; k < 3; k++) {
        bx[node * 6 + k] = lo[k];
        bx[node * 6 + 3 + k] = hi[k];
      }
      const axis = c1[0] - c0[0] >= c1[1] - c0[1] && c1[0] - c0[0] >= c1[2] - c0[2] ? 0 : c1[1] - c0[1] >= c1[2] - c0[2] ? 1 : 2;
      const mid = (c0[axis] + c1[axis]) / 2;
      let m = a;
      if (b - a > LEAF && c1[axis] > c0[axis]) {
        for (let i = a; i < b; i++) {
          const t = this.order[i];
          if (cen[t * 3 + axis] < mid) {
            this.order[i] = this.order[m];
            this.order[m++] = t;
          }
        }
      }
      if (m === a || m === b) {
        this.first[node] = a;
        this.count[node] = b - a;
        continue;
      }
      const l = this.alloc();
      const r = this.alloc();
      this.first[node] = l;
      this.right[node] = r;
      this.count[node] = 0;
      stack.push([l, a, m], [r, m, b]);
    }
  }

  private alloc(): number {
    if (this.nodes >= this.first.length) {
      const grow = <T extends Float32Array | Int32Array>(x: T, per: number): T => {
        const y = new (x.constructor as new (n: number) => T)(x.length * 2 + per);
        y.set(x);
        return y;
      };
      this.boxes = grow(this.boxes, 6);
      this.first = grow(this.first, 1);
      this.count = grow(this.count, 1);
      this.right = grow(this.right, 1);
    }
    return this.nodes++;
  }

  /**
   * The nearest triangle the ray from `o` along `d` meets within `far` (both sides of a triangle count), skipping
   * triangles `skip` marks (non-zero), or null.
   */
  cast(o: [number, number, number], d: [number, number, number], far: number, skip?: Uint8Array | null): RayHit | null {
    if (!this.nodes) return null;
    const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
    let best = far;
    let bestTri = -1;
    const stack = [0];
    const bx = this.boxes;
    const P = this.pos;
    const I = this.index;
    while (stack.length) {
      const node = stack.pop()!;
      // The slab test: does the ray reach this box before the best hit so far?
      let t0 = 0;
      let t1 = best;
      for (let k = 0; k < 3; k++) {
        let a = (bx[node * 6 + k] - o[k]) * inv[k];
        let b = (bx[node * 6 + 3 + k] - o[k]) * inv[k];
        if (a > b) [a, b] = [b, a];
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) break;
      }
      if (t0 > t1 || Number.isNaN(t0)) continue;
      const n = this.count[node];
      if (n === 0) {
        stack.push(this.first[node], this.right[node]);
        continue;
      }
      for (let i = this.first[node]; i < this.first[node] + n; i++) {
        const tri = this.order[i];
        if (skip && skip[tri]) continue;
        const ia = I[tri * 3] * 3;
        const ib = I[tri * 3 + 1] * 3;
        const ic = I[tri * 3 + 2] * 3;
        // Möller–Trumbore.
        const e1x = P[ib] - P[ia];
        const e1y = P[ib + 1] - P[ia + 1];
        const e1z = P[ib + 2] - P[ia + 2];
        const e2x = P[ic] - P[ia];
        const e2y = P[ic + 1] - P[ia + 1];
        const e2z = P[ic + 2] - P[ia + 2];
        const px = d[1] * e2z - d[2] * e2y;
        const py = d[2] * e2x - d[0] * e2z;
        const pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const f = 1 / det;
        const sx = o[0] - P[ia];
        const sy = o[1] - P[ia + 1];
        const sz = o[2] - P[ia + 2];
        const u = f * (sx * px + sy * py + sz * pz);
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = f * (d[0] * qx + d[1] * qy + d[2] * qz);
        if (v < 0 || u + v > 1) continue;
        const t = f * (e2x * qx + e2y * qy + e2z * qz);
        if (t > 1e-9 && t < best) {
          best = t;
          bestTri = tri;
        }
      }
    }
    if (bestTri < 0) return null;
    const ia = I[bestTri * 3] * 3;
    const ib = I[bestTri * 3 + 1] * 3;
    const ic = I[bestTri * 3 + 2] * 3;
    const e1 = [P[ib] - P[ia], P[ib + 1] - P[ia + 1], P[ib + 2] - P[ia + 2]];
    const e2 = [P[ic] - P[ia], P[ic + 1] - P[ia + 1], P[ic + 2] - P[ia + 2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    return { tri: bestTri, t: best, normal: [nx / l, ny / l, nz / l] };
  }
}
