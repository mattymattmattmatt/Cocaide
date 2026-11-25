// A mesh part: a part the assembly carries that is a .glb model (furniture made elsewhere) rather than features. In
// the file it is a part document with no features and a `mesh`:
//
//   { "version": 1, "units": "mm", "name": "Ivory sofa", "features": [],
//     "mesh": { "glb": "<the .glb, base64>", "scale": 1.62 } }        (or "url": "https://.../sofa.glb")
//
// It is drawn (textured), picked, hidden, measured point to point and carried in VR like any component, and left out
// of what needs solids (STEP, interference, drawings). glTF is Y up in metres: the model is turned Z up, made
// millimetres, scaled by `scale`, and stood with the middle of its underside on the part's origin. Pure.

import type { FaceInfo } from "../kernel/topology";
import type { RebuildView } from "../worker/protocol";
import { base64ToBytes, type GlbMesh } from "./glb";

export interface MeshSpec {
  /** The .glb itself, base64. */
  glb?: string;
  /** Or where to fetch it from (it must allow being read from another site). */
  url?: string;
  /** How much bigger than the file says (its units taken as metres): 1 = as modelled. */
  scale?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The mesh a part document is, if it is one. */
export function meshSpecOf(part: unknown): MeshSpec | null {
  return isObject(part) && isObject(part.mesh) ? (part.mesh as MeshSpec) : null;
}
export const isMeshPart = (part: unknown) => meshSpecOf(part) !== null;

/** What is wrong with a `mesh` as written (empty: nothing). */
export function meshSpecProblems(raw: unknown): string[] {
  if (!isObject(raw)) return [`must be { "glb": "<base64>" } or { "url": "..." }, with "scale"? (got ${JSON.stringify(raw)})`];
  const out: string[] = [];
  for (const k of Object.keys(raw)) if (!["glb", "url", "scale"].includes(k)) out.push(`${k}: not a mesh field (glb, url, scale)`);
  const has = (k: string) => raw[k] !== undefined;
  if (has("glb") === has("url")) out.push('needs one of "glb" (the file, base64) or "url" (where to fetch it)');
  if (has("glb") && (typeof raw.glb !== "string" || !raw.glb)) out.push("glb: must be the .glb file as base64 text");
  if (has("url") && (typeof raw.url !== "string" || !/^(https?:|data:|blob:|\.{0,2}\/)/.test(raw.url))) out.push("url: must be a web address (https://...)");
  if (has("scale") && !(typeof raw.scale === "number" && raw.scale > 0 && Number.isFinite(raw.scale))) out.push("scale: must be a number above 0");
  return out;
}

/** The .glb's bytes: decoded from the file, or fetched from its address. */
export async function meshBytes(spec: MeshSpec, fetcher: (url: string) => Promise<ArrayBuffer> = (u) => fetch(u).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))): Promise<Uint8Array> {
  if (spec.glb) return base64ToBytes(spec.glb);
  if (spec.url) return new Uint8Array(await fetcher(spec.url));
  throw new Error("the mesh has no .glb (glb or url)");
}

/** The part's body name in its view: one body, the model. */
export const MESH_BODY = "model";

/**
 * A parsed .glb as a part's view: Z up, millimetres, `scale` times, the middle of its underside at the origin; a face
 * for each of its primitives (one material each), coloured and textured as the file says. `key` makes its texture
 * keys unique in an assembly's joined view.
 */
export function meshPartView(g: GlbMesh, name: string, scale = 1, key = "mesh"): RebuildView {
  const k = 1000 * scale;
  const n = g.positions.length / 3;
  const pos = new Float32Array(n * 3);
  // Y up to Z up: (x, y, z) → (x, −z, y); metres to mm, scaled.
  for (let i = 0; i < n; i++) {
    pos[i * 3] = g.positions[i * 3] * k;
    pos[i * 3 + 1] = -g.positions[i * 3 + 2] * k;
    pos[i * 3 + 2] = g.positions[i * 3 + 1] * k;
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    const v = pos[i * 3 + c];
    if (v < min[c]) min[c] = v;
    if (v > max[c]) max[c] = v;
  }
  const shift = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) pos[i * 3 + c] -= shift[c];
  let normals: Float32Array;
  if (g.normals) {
    normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      normals[i * 3] = g.normals[i * 3];
      normals[i * 3 + 1] = -g.normals[i * 3 + 2];
      normals[i * 3 + 2] = g.normals[i * 3 + 1];
    }
  } else normals = vertexNormals(pos, g.indices);
  // Faces: a primitive each, its area and middle, its look.
  const hex = (c: number) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255).toString(16).padStart(2, "0");
  const faces: FaceInfo[] = g.primitives.map((p, i) => {
    const m = g.materials[p.material];
    let area = 0;
    const c = [0, 0, 0];
    for (let t = p.start; t + 2 < p.start + p.count; t += 3) {
      const [a, b, d] = [g.indices[t] * 3, g.indices[t + 1] * 3, g.indices[t + 2] * 3];
      const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
      const e2 = [pos[d] - pos[a], pos[d + 1] - pos[a + 1], pos[d + 2] - pos[a + 2]];
      const ar = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
      area += ar;
      for (let q = 0; q < 3; q++) c[q] += ((pos[a + q] + pos[b + q] + pos[d + q]) / 3) * ar;
    }
    const centroid: [number, number, number] = area > 0 ? [c[0] / area, c[1] / area, c[2] / area] : [0, 0, 0];
    return {
      index: i,
      type: "other",
      area,
      centroid,
      body: MESH_BODY,
      mesh: {
        color: m ? `#${hex(m.color[0])}${hex(m.color[1])}${hex(m.color[2])}` : "#ffffff",
        ...(m?.image !== undefined && g.images[m.image]?.bytes.length && g.uvs ? { texture: `${key}#${m.image}` } : {}),
        ...(m?.doubleSided ? { doubleSided: true } : {}),
      },
    };
  });
  const textures: NonNullable<RebuildView["textures"]> = {};
  for (const f of faces) {
    const t = f.mesh?.texture;
    if (t && !textures[t]) {
      const im = g.images[Number(t.slice(t.lastIndexOf("#") + 1))];
      textures[t] = { mime: im.mime, bytes: im.bytes };
    }
  }
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    ok: true,
    name,
    errors: [],
    features: [],
    sketches: [],
    measurements: null,
    mesh: {
      positions: pos,
      normals,
      indices: g.indices,
      faceRanges: g.primitives.map((p) => ({ start: p.start, count: p.count })),
      edges: new Float32Array(0),
      edgeRanges: [],
      ...(g.uvs ? { uvs: g.uvs } : {}),
    },
    faces,
    edges: [],
    bodies: [{ name: MESH_BODY, faces: [0, faces.length], edges: [0, 0] }],
    datums: {},
    ...(Object.keys(textures).length ? { textures } : {}),
    meshSize: size,
  };
}

/** A mesh part's size as shown (mm: across X, Y, up Z). */
export function meshSizeOf(v: RebuildView | undefined): [number, number, number] | null {
  return v?.meshSize ?? null;
}

/** The scale that makes one of a model's sides `length` mm, from its size now (at `scale`). */
export function scaleForSize(size: [number, number, number], scale: number, axis: 0 | 1 | 2, length: number): number {
  const now = size[axis];
  if (!(now > 0) || !(length > 0)) return scale;
  return (scale * length) / now;
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

function vertexNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
  const out = new Float32Array(pos.length);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) for (let q = 0; q < 3; q++) out[v + q] += n[q];
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l;
    out[i + 1] /= l;
    out[i + 2] /= l;
  }
  return out;
}
