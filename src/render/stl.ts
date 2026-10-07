// Binary STL from the tessellation. STL is a mesh, so it is an export for
// printing and viewing only; STEP stays the exchange format.

import type { MeshData } from "../kernel/mesh";

export function encodeSTL(mesh: MeshData, name: string): Uint8Array {
  const I = mesh.indices;
  const P = mesh.positions;
  const count = I.length / 3;
  const out = new Uint8Array(84 + count * 50);
  const view = new DataView(out.buffer);
  const header = `cocaide ${name}`.slice(0, 80);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, count, true);
  let o = 84;
  for (let t = 0; t < count; t++) {
    const a = I[t * 3] * 3,
      b = I[t * 3 + 1] * 3,
      c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a],
      uy = P[b + 1] - P[a + 1],
      uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a],
      vy = P[c + 1] - P[a + 1],
      vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const v of [nx, ny, nz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    o += 2; // attribute byte count
  }
  return out;
}

/** Signed volume of a closed binary STL, for checking an export. */
export function stlVolume(stl: Uint8Array): number {
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const count = view.getUint32(80, true);
  let vol = 0;
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50 + 12;
    const f = (k: number) => view.getFloat32(o + k * 4, true);
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7), f(8)];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}
