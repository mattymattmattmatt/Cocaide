// A small software renderer for agent screenshots: shaded faces, B-rep edges
// and an axis triad, orthographic, from a named view or any direction. It
// needs no GPU and no DOM, so the MCP server can render in plain Node.
//
// Pure: MeshData in, RGBA pixels out. png.ts turns the pixels into a file.

import type { Vec3 } from "../doc/types";
import { cross3, dot3, normalize3 } from "../geom/vec";
import type { MeshData } from "../kernel/mesh";

export const VIEWS = {
  iso: { direction: [1, -1, 0.8], up: [0, 0, 1] },
  front: { direction: [0, -1, 0], up: [0, 0, 1] },
  back: { direction: [0, 1, 0], up: [0, 0, 1] },
  right: { direction: [1, 0, 0], up: [0, 0, 1] },
  left: { direction: [-1, 0, 0], up: [0, 0, 1] },
  top: { direction: [0, 0, 1], up: [0, 1, 0] },
  bottom: { direction: [0, 0, -1], up: [0, -1, 0] },
  /** Iso from below and behind, for undersides. */
  isoBack: { direction: [-1, 1, -0.8], up: [0, 0, 1] },
} satisfies Record<string, Camera>;
export type ViewName = keyof typeof VIEWS;

export interface Camera {
  /** From the part toward the eye. */
  direction: Vec3 | number[];
  /** Up on screen. Defaults to +Z, or +Y when looking along Z. */
  up?: Vec3 | number[];
}

export interface RenderOptions {
  width?: number;
  height?: number;
  camera: Camera;
  /** Faces (by B-rep face index) to tint. */
  highlightFaces?: number[];
  /** Edges (by B-rep edge index) to draw thick and coloured. */
  highlightEdges?: number[];
  /** Edges hidden behind material are drawn faintly too. */
  hiddenEdges?: boolean;
  /** Edges (by B-rep edge index) not to draw: seams, which are not feature edges. */
  skipEdges?: number[];
}

export interface Image {
  width: number;
  height: number;
  /** RGBA, row-major from the top. */
  data: Uint8Array;
}

type RGB = [number, number, number];
const BACKGROUND_TOP: RGB = [250, 251, 252];
const BACKGROUND_BOTTOM: RGB = [226, 230, 236];
const PART: RGB = [196, 202, 211];
const HIGHLIGHT: RGB = [242, 140, 40];
const EDGE: RGB = [31, 41, 55];
const HIDDEN: RGB = [150, 158, 170];
const AXES: RGB[] = [
  [214, 54, 56],
  [46, 160, 67],
  [47, 109, 214],
];
/** Supersampling factor per axis. */
const SS = 2;

export function cameraFrame(camera: Camera): { d: Vec3; x: Vec3; y: Vec3 } {
  const d = normalize3(camera.direction as Vec3);
  let up = (camera.up as Vec3 | undefined) ?? (Math.abs(d[2]) > 0.999 ? ([0, 1, 0] as Vec3) : ([0, 0, 1] as Vec3));
  if (Math.abs(dot3(normalize3(up), d)) > 0.999) up = Math.abs(d[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  const x = normalize3(cross3(up, d));
  const y = cross3(d, x);
  return { d, x, y };
}

export function render(mesh: MeshData, opts: RenderOptions): Image {
  const W = Math.round(opts.width ?? 800);
  const H = Math.round(opts.height ?? 600);
  const w = W * SS;
  const h = H * SS;
  const { d, x, y } = cameraFrame(opts.camera);

  const color = new Float32Array(w * h * 3);
  const depth = new Float32Array(w * h).fill(-Infinity);
  for (let r = 0; r < h; r++) {
    const t = r / (h - 1);
    for (let c = 0; c < w; c++) {
      const o = (r * w + c) * 3;
      for (let k = 0; k < 3; k++) color[o + k] = BACKGROUND_TOP[k] * (1 - t) + BACKGROUND_BOTTOM[k] * t;
    }
  }

  // Project every vertex: screen x, screen y (down), depth (toward the eye).
  const P = mesh.positions;
  const n = P.length / 3;
  const proj = new Float32Array(n * 3);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    const sx = dot3(p, x),
      sy = dot3(p, y),
      sz = dot3(p, d);
    proj[i * 3] = sx;
    proj[i * 3 + 1] = sy;
    proj[i * 3 + 2] = sz;
    minX = Math.min(minX, sx);
    maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy);
    maxY = Math.max(maxY, sy);
    minZ = Math.min(minZ, sz);
    maxZ = Math.max(maxZ, sz);
  }
  const margin = 0.1;
  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const scale = Math.min((w * (1 - 2 * margin)) / spanX, (h * (1 - 2 * margin)) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (let i = 0; i < n; i++) {
    proj[i * 3] = w / 2 + (proj[i * 3] - cx) * scale;
    proj[i * 3 + 1] = h / 2 - (proj[i * 3 + 1] - cy) * scale;
  }
  // Depth tolerance for edges lying on faces.
  const bias = Math.max(maxZ - minZ, spanX, spanY) * 2e-3 + 1.5 / scale;

  // Faces.
  const tinted = new Uint8Array(mesh.indices.length / 3);
  for (const f of opts.highlightFaces ?? []) {
    const range = mesh.faceRanges[f];
    if (range) for (let t = range.start / 3; t < (range.start + range.count) / 3; t++) tinted[t] = 1;
  }
  const N = mesh.normals;
  // Key light from the upper left of the screen, fill from the right; both in camera space.
  const key = normalize3([-0.35 * x[0] + 0.8 * y[0] + 0.6 * d[0], -0.35 * x[1] + 0.8 * y[1] + 0.6 * d[1], -0.35 * x[2] + 0.8 * y[2] + 0.6 * d[2]]);
  const fill = normalize3([0.8 * x[0] - 0.2 * y[0] + 0.5 * d[0], 0.8 * x[1] - 0.2 * y[1] + 0.5 * d[1], 0.8 * x[2] - 0.2 * y[2] + 0.5 * d[2]]);
  const I = mesh.indices;
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3],
      b = I[t * 3 + 1],
      c = I[t * 3 + 2];
    const ax = proj[a * 3],
      ay = proj[a * 3 + 1],
      az = proj[a * 3 + 2];
    const bx = proj[b * 3],
      by = proj[b * 3 + 1],
      bz = proj[b * 3 + 2];
    const qx = proj[c * 3],
      qy = proj[c * 3 + 1],
      qz = proj[c * 3 + 2];
    const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, qx)));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, qx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, qy)));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, qy)));
    const base = tinted[t] ? HIGHLIGHT : PART;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const sx = px + 0.5,
          sy = py + 0.5;
        const w0 = ((bx - sx) * (qy - sy) - (by - sy) * (qx - sx)) / area;
        const w1 = ((qx - sx) * (ay - sy) - (qy - sy) * (ax - sx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        const z = w0 * az + w1 * bz + w2 * qz;
        const o = py * w + px;
        if (z <= depth[o]) continue;
        depth[o] = z;
        let nx = w0 * N[a * 3] + w1 * N[b * 3] + w2 * N[c * 3];
        let ny = w0 * N[a * 3 + 1] + w1 * N[b * 3 + 1] + w2 * N[c * 3 + 1];
        let nz = w0 * N[a * 3 + 2] + w1 * N[b * 3 + 2] + w2 * N[c * 3 + 2];
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        // Two-sided: a normal facing away from the eye is flipped.
        if (nx * d[0] + ny * d[1] + nz * d[2] < 0) (nx = -nx), (ny = -ny), (nz = -nz);
        const lk = Math.max(0, nx * key[0] + ny * key[1] + nz * key[2]);
        const lf = Math.max(0, nx * fill[0] + ny * fill[1] + nz * fill[2]);
        const facing = nx * d[0] + ny * d[1] + nz * d[2];
        const shade = 0.34 + 0.5 * lk + 0.16 * lf + 0.1 * facing;
        for (let k = 0; k < 3; k++) color[o * 3 + k] = Math.min(255, base[k] * shade);
      }
    }
  }

  // Edges: depth-tested against the shaded faces.
  const E = mesh.edges;
  const thick = new Uint8Array(E.length / 6);
  for (const e of opts.skipEdges ?? []) {
    const range = mesh.edgeRanges[e];
    if (range) for (let s = range.start; s < range.start + range.count; s++) thick[s] = 2;
  }
  for (const e of opts.highlightEdges ?? []) {
    const range = mesh.edgeRanges[e];
    if (range) for (let s = range.start; s < range.start + range.count; s++) thick[s] = 1;
  }
  const projectPoint = (o: number): Vec3 => {
    const p: Vec3 = [E[o], E[o + 1], E[o + 2]];
    return [w / 2 + (dot3(p, x) - cx) * scale, h / 2 - (dot3(p, y) - cy) * scale, dot3(p, d)];
  };
  const segments: { p: Vec3; q: Vec3; hl: boolean }[] = [];
  for (let s = 0; s < E.length / 6; s++) {
    if (thick[s] !== 2) segments.push({ p: projectPoint(s * 6), q: projectPoint(s * 6 + 3), hl: thick[s] === 1 });
  }
  // Depth is read from the faces only, so edges never hide each other.
  const faceDepth = depth.slice();
  if (opts.hiddenEdges) {
    for (const g of segments) line(g.p, g.q, 0.9 * SS, (o, z) => z + bias < faceDepth[o], HIDDEN, 0.7);
  }
  for (const g of segments) {
    if (!g.hl) line(g.p, g.q, 1.1 * SS, (o, z) => z + bias >= faceDepth[o], EDGE, 1);
  }
  for (const g of segments) {
    if (g.hl) line(g.p, g.q, 2.6 * SS, () => true, HIGHLIGHT, 1);
  }

  axisTriad();

  // Downsample.
  const out = new Uint8Array(W * H * 4);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      for (let k = 0; k < 3; k++) {
        let sum = 0;
        for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) sum += color[((r * SS + i) * w + c * SS + j) * 3 + k];
        out[(r * W + c) * 4 + k] = Math.round(sum / (SS * SS));
      }
      out[(r * W + c) * 4 + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };

  /** A thick segment, stamped as discs; `test` decides per pixel whether it shows. */
  function line(p: Vec3, q: Vec3, width: number, test: (o: number, z: number) => boolean, rgb: RGB, alpha: number) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const steps = Math.max(1, Math.ceil(len / 0.5));
    const r = width / 2;
    const r2 = r * r;
    const done = new Set<number>();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = p[0] + (q[0] - p[0]) * t;
      const py = p[1] + (q[1] - p[1]) * t;
      const pz = p[2] + (q[2] - p[2]) * t;
      for (let yy = Math.floor(py - r); yy <= Math.ceil(py + r); yy++) {
        if (yy < 0 || yy >= h) continue;
        for (let xx = Math.floor(px - r); xx <= Math.ceil(px + r); xx++) {
          if (xx < 0 || xx >= w) continue;
          const dx = xx + 0.5 - px,
            dy = yy + 0.5 - py;
          if (dx * dx + dy * dy > r2) continue;
          const o = yy * w + xx;
          if (done.has(o) || !test(o, pz)) continue;
          done.add(o);
          for (let k = 0; k < 3; k++) color[o * 3 + k] = color[o * 3 + k] * (1 - alpha) + rgb[k] * alpha;
        }
      }
    }
  }

  function axisTriad() {
    const len = 26 * SS;
    const ox = 34 * SS,
      oy = h - 34 * SS;
    const axes: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    // Draw the axis pointing away from the eye first so the nearer ones sit on top.
    const order = [0, 1, 2].sort((i, j) => dot3(axes[i], d) - dot3(axes[j], d));
    for (const i of order) {
      const ex = ox + dot3(axes[i], x) * len;
      const ey = oy - dot3(axes[i], y) * len;
      line([ox, oy, 0], [ex, ey, 0], 2.2 * SS, () => true, AXES[i], 1);
      const lx = ox + dot3(axes[i], x) * (len + 9 * SS);
      const ly = oy - dot3(axes[i], y) * (len + 9 * SS);
      glyph("XYZ"[i], lx, ly, AXES[i]);
    }
  }

  function glyph(ch: string, cx0: number, cy0: number, rgb: RGB) {
    const rows = GLYPHS[ch];
    const px = 1.6 * SS;
    const left = cx0 - (5 * px) / 2,
      top = cy0 - (7 * px) / 2;
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < 5; rx++) {
        if (row[rx] !== "#") continue;
        for (let yy = Math.floor(top + ry * px); yy < Math.floor(top + (ry + 1) * px); yy++) {
          for (let xx = Math.floor(left + rx * px); xx < Math.floor(left + (rx + 1) * px); xx++) {
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const o = yy * w + xx;
            for (let k = 0; k < 3; k++) color[o * 3 + k] = rgb[k];
          }
        }
      }
    });
  }
}

const GLYPHS: Record<string, string[]> = {
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
};
