// Reading a .glb (binary glTF 2.0): its triangles, their texture coordinates, each primitive's material (base colour
// and base colour texture) and the texture images, every node's transform applied. What a mesh part needs to be drawn
// (src/mesh/meshPart.ts), not a general glTF reader: triangle lists only, no skins, morphs or animation, and no
// compressed meshes (Draco, meshopt) or quantised attributes. Pure (bytes in, arrays out).

export interface GlbImage {
  mime: string;
  bytes: Uint8Array;
}

export interface GlbMaterial {
  /** Base colour factor, linear RGBA 0–1. */
  color: [number, number, number, number];
  /** The base colour texture's image (an index into `images`). */
  image?: number;
  doubleSided: boolean;
}

export interface GlbMesh {
  /** glTF's own frame (Y up, metres as the file has it), every node's transform applied. */
  positions: Float32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  indices: Uint32Array;
  /** Runs of `indices`, each drawn with one material. */
  primitives: { start: number; count: number; material: number }[];
  materials: GlbMaterial[];
  images: GlbImage[];
}

type Json = Record<string, unknown>;
type Mat4 = number[];

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const UNSUPPORTED = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_mesh_quantization"];

/** Whether these bytes are a .glb (they start with its magic number). */
export function isGlb(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === GLB_MAGIC;
}

export function parseGlb(bytes: Uint8Array): GlbMesh {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isGlb(bytes)) throw new Error("not a .glb file (binary glTF): it doesn't start with glTF's header");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`glTF version ${version}: only glTF 2.0 is read`);
  let json: Json | null = null;
  let bin: Uint8Array | null = null;
  for (let o = 12; o + 8 <= bytes.length; ) {
    const len = dv.getUint32(o, true);
    const type = dv.getUint32(o + 4, true);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === JSON_CHUNK && !json) json = JSON.parse(new TextDecoder().decode(data)) as Json;
    else if (type === BIN_CHUNK && !bin) bin = data;
    o += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error("the .glb has no glTF JSON in it");
  const used = [...((json.extensionsRequired as string[]) ?? []), ...((json.extensionsUsed as string[]) ?? [])];
  const bad = used.filter((e) => UNSUPPORTED.includes(e));
  if (bad.length) throw new Error(`the .glb is compressed (${[...new Set(bad)].join(", ")}): export it without compression`);

  const list = (k: string) => (Array.isArray(json![k]) ? (json![k] as Json[]) : []);
  const bufferViews = list("bufferViews");
  const accessors = list("accessors");
  const buffers = list("buffers");
  const viewBytes = (i: number): { data: Uint8Array; stride: number } => {
    const v = bufferViews[i];
    if (!v) throw new Error(`bufferView ${i} is missing`);
    if (((v.buffer as number) ?? 0) !== 0 || buffers.length > 1) throw new Error("only a .glb's own binary buffer is read (no external .bin files)");
    if (!bin) throw new Error("the .glb has no binary data");
    const off = (v.byteOffset as number) ?? 0;
    return { data: bin.subarray(off, off + (v.byteLength as number)), stride: (v.byteStride as number) ?? 0 };
  };
  /** An accessor's values as floats (normalised integers scaled to 0–1), `n` to an element. */
  const read = (i: number): { values: Float32Array; n: number; count: number } => {
    const a = accessors[i];
    if (!a) throw new Error(`accessor ${i} is missing`);
    if (a.sparse) throw new Error("sparse accessors aren't read");
    const n = COMPONENTS[a.type as string];
    const count = a.count as number;
    const out = new Float32Array(count * n);
    if (a.bufferView === undefined) return { values: out, n, count };
    const { data, stride } = viewBytes(a.bufferView as number);
    const ct = a.componentType as number;
    const size = ct === 5126 || ct === 5125 ? 4 : ct === 5123 || ct === 5122 ? 2 : 1;
    const step = stride || size * n;
    const base = (a.byteOffset as number) ?? 0;
    const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const norm = !!a.normalized;
    for (let e = 0; e < count; e++) {
      for (let c = 0; c < n; c++) {
        const at = base + e * step + c * size;
        let v: number;
        if (ct === 5126) v = d.getFloat32(at, true);
        else if (ct === 5125) v = d.getUint32(at, true);
        else if (ct === 5123) v = norm ? d.getUint16(at, true) / 65535 : d.getUint16(at, true);
        else if (ct === 5122) v = norm ? Math.max(d.getInt16(at, true) / 32767, -1) : d.getInt16(at, true);
        else if (ct === 5121) v = norm ? d.getUint8(at) / 255 : d.getUint8(at);
        else if (ct === 5120) v = norm ? Math.max(d.getInt8(at) / 127, -1) : d.getInt8(at);
        else throw new Error(`accessor ${i}: component type ${ct} isn't read`);
        out[e * n + c] = v;
      }
    }
    return { values: out, n, count };
  };
  const readIndices = (i: number): Uint32Array => {
    const a = accessors[i];
    const ct = a?.componentType as number;
    if (!a || a.bufferView === undefined) throw new Error(`index accessor ${i} is missing`);
    const { data, stride } = viewBytes(a.bufferView as number);
    const size = ct === 5125 ? 4 : ct === 5123 ? 2 : 1;
    const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const base = (a.byteOffset as number) ?? 0;
    const step = stride || size;
    const out = new Uint32Array(a.count as number);
    for (let k = 0; k < out.length; k++) {
      const at = base + k * step;
      out[k] = size === 4 ? d.getUint32(at, true) : size === 2 ? d.getUint16(at, true) : d.getUint8(at);
    }
    return out;
  };

  // Materials: the base colour and its texture's image.
  const textures = list("textures");
  const materials: GlbMaterial[] = list("materials").map((m) => {
    const pbr = (m.pbrMetallicRoughness as Json | undefined) ?? {};
    const f = (pbr.baseColorFactor as number[] | undefined) ?? [1, 1, 1, 1];
    const tex = pbr.baseColorTexture as Json | undefined;
    const source = tex && typeof tex.index === "number" ? (textures[tex.index]?.source as number | undefined) : undefined;
    return { color: [f[0], f[1], f[2], f[3] ?? 1], ...(source !== undefined ? { image: source } : {}), doubleSided: !!m.doubleSided };
  });
  const images: GlbImage[] = list("images").map((im) => {
    if (typeof im.bufferView === "number") return { mime: (im.mimeType as string) ?? "image/png", bytes: viewBytes(im.bufferView).data.slice() };
    const uri = im.uri as string | undefined;
    const m = uri && /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
    if (m && m[2]) return { mime: m[1] ?? "image/png", bytes: base64ToBytes(m[3]) };
    return { mime: "image/png", bytes: new Uint8Array() };
  });

  // Nodes from the scene's roots down, each with its transform; every mesh they hold, placed.
  const nodes = list("nodes");
  const meshes = list("meshes");
  const scenes = list("scenes");
  const scene = scenes[(json.scene as number) ?? 0];
  const roots = (scene?.nodes as number[] | undefined) ?? nodes.map((_, i) => i).filter((i) => !nodes.some((n) => ((n.children as number[]) ?? []).includes(i)));
  const P: number[] = [];
  const N: number[] = [];
  const U: number[] = [];
  const I: number[] = [];
  const prims: GlbMesh["primitives"] = [];
  let anyNormals = false;
  let anyUvs = false;
  const visit = (i: number, parent: Mat4, depth: number) => {
    if (depth > 64) throw new Error("the .glb's node tree is too deep (a loop?)");
    const node = nodes[i];
    if (!node) return;
    const M = multiply(parent, localMatrix(node));
    if (typeof node.mesh === "number") {
      const nm = normalMatrix(M);
      for (const p of (meshes[node.mesh]?.primitives as Json[]) ?? []) {
        const mode = (p.mode as number) ?? 4;
        if (mode !== 4) continue; // triangles only
        const at = (p.attributes as Json) ?? {};
        if (typeof at.POSITION !== "number") continue;
        const pos = read(at.POSITION);
        const nor = typeof at.NORMAL === "number" ? read(at.NORMAL) : null;
        const uv = typeof at.TEXCOORD_0 === "number" ? read(at.TEXCOORD_0) : null;
        const base = P.length / 3;
        for (let v = 0; v < pos.count; v++) {
          const [x, y, z] = [pos.values[v * 3], pos.values[v * 3 + 1], pos.values[v * 3 + 2]];
          P.push(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]);
          if (nor) {
            const [a, b, c] = [nor.values[v * 3], nor.values[v * 3 + 1], nor.values[v * 3 + 2]];
            const nx = nm[0] * a + nm[3] * b + nm[6] * c;
            const ny = nm[1] * a + nm[4] * b + nm[7] * c;
            const nz = nm[2] * a + nm[5] * b + nm[8] * c;
            const l = Math.hypot(nx, ny, nz) || 1;
            N.push(nx / l, ny / l, nz / l);
          } else N.push(0, 0, 0);
          if (uv) U.push(uv.values[v * 2], uv.values[v * 2 + 1]);
          else U.push(0, 0);
        }
        anyNormals ||= !!nor;
        anyUvs ||= !!uv;
        const start = I.length;
        if (typeof p.indices === "number") for (const k of readIndices(p.indices)) I.push(base + k);
        else for (let k = 0; k < pos.count; k++) I.push(base + k);
        // A mirroring transform turns the triangles inside out: wind them back.
        if (det3(M) < 0) for (let k = start; k + 2 < I.length; k += 3) [I[k + 1], I[k + 2]] = [I[k + 2], I[k + 1]];
        prims.push({ start, count: I.length - start, material: typeof p.material === "number" ? p.material : -1 });
      }
    }
    for (const c of (node.children as number[]) ?? []) visit(c, M, depth + 1);
  };
  for (const r of roots) visit(r, IDENTITY, 0);
  if (!I.length) throw new Error("the .glb has no triangles to draw");
  // Primitives with no material get a plain white one.
  if (prims.some((p) => p.material < 0)) {
    const white = materials.length;
    materials.push({ color: [1, 1, 1, 1], doubleSided: false });
    for (const p of prims) if (p.material < 0) p.material = white;
  }
  return {
    positions: new Float32Array(P),
    normals: anyNormals ? new Float32Array(N) : null,
    uvs: anyUvs ? new Float32Array(U) : null,
    indices: new Uint32Array(I),
    primitives: prims,
    materials,
    images,
  };
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A node's own transform: its matrix, or translation × rotation × scale (column-major, as glTF writes it). */
function localMatrix(node: Json): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix as number[];
  const [tx, ty, tz] = (node.translation as number[]) ?? [0, 0, 0];
  const [qx, qy, qz, qw] = (node.rotation as number[]) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = (node.scale as number[]) ?? [1, 1, 1];
  const [xx, yy, zz, xy, xz, yz, wx, wy, wz] = [qx * qx, qy * qy, qz * qz, qx * qy, qx * qz, qy * qz, qw * qx, qw * qy, qw * qz];
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function det3(m: Mat4): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

/** The inverse transpose of the matrix's upper 3×3 (column-major 3×3): turns normals. */
function normalMatrix(m: Mat4): number[] {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C || 1;
  // Inverse = adjugate / det; its transpose, column-major.
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}

/** Base64 to bytes (and back): how a .glb is carried in the JSON document. */
export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const bin = typeof atob === "function" ? atob(clean) : Buffer.from(clean, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToBase64(b: Uint8Array): string {
  if (typeof Buffer !== "undefined" && typeof window === "undefined") return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH));
  return btoa(s);
}
