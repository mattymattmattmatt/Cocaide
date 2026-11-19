// Rigid placements in the assembly: a component's rotation (degrees about
// the assembly's X, then Y, then Z: R = Rz·Ry·Rx) and its move `at`, as a
// matrix, and back. Pure.

import type { Vec3 } from "../doc/types";

export type Mat3 = [Vec3, Vec3, Vec3];
export interface Placement {
  R: Mat3;
  t: Vec3;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function mul(a: Mat3, b: Mat3): Mat3 {
  const out: number[][] = [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));
  return out as Mat3;
}

export function apply(R: Mat3, v: Vec3): Vec3 {
  return [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
}

export function transpose(R: Mat3): Mat3 {
  return [
    [R[0][0], R[1][0], R[2][0]],
    [R[0][1], R[1][1], R[2][1]],
    [R[0][2], R[1][2], R[2][2]],
  ];
}

export const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** R = Rz·Ry·Rx for angles in degrees. */
export function fromEuler(r: Vec3 | undefined): Mat3 {
  if (!r) return IDENTITY;
  const [x, y, z] = r.map(rad);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const Rx: Mat3 = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const Ry: Mat3 = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rz: Mat3 = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return mul(Rz, mul(Ry, Rx));
}

/** The angles (degrees, X then Y then Z) of R = Rz·Ry·Rx. */
export function toEuler(R: Mat3): Vec3 {
  const sy = Math.max(-1, Math.min(1, -R[2][0]));
  const y = Math.asin(sy);
  let x: number;
  let z: number;
  if (Math.abs(Math.cos(y)) > 1e-9) {
    x = Math.atan2(R[2][1], R[2][2]);
    z = Math.atan2(R[1][0], R[0][0]);
  } else {
    // Gimbal lock: the X and Z turns are about one axis; put it all in X.
    x = Math.atan2(-R[1][2], R[1][1]);
    z = 0;
  }
  return [deg(x), deg(y), deg(z)];
}

/** The turn by the rotation vector w (radians; its length is the angle), by Rodrigues. */
export function rotationOf(w: Vec3): Mat3 {
  const a = Math.hypot(w[0], w[1], w[2]);
  if (a < 1e-15) return IDENTITY;
  const [x, y, z] = [w[0] / a, w[1] / a, w[2] / a];
  const c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

export function placementOf(k: { at?: Vec3; rotation?: Vec3 }): Placement {
  return { R: fromEuler(k.rotation), t: k.at ? [...k.at] as Vec3 : [0, 0, 0] };
}

/** A point of the component's part, in the assembly. */
export function pointTo(p: Placement, v: Vec3): Vec3 {
  const r = apply(p.R, v);
  return [r[0] + p.t[0], r[1] + p.t[1], r[2] + p.t[2]];
}

/** A point of the assembly, in the component's part. */
export function pointFrom(p: Placement, v: Vec3): Vec3 {
  return apply(transpose(p.R), [v[0] - p.t[0], v[1] - p.t[1], v[2] - p.t[2]]);
}

/** A placement as the document writes it: angles rounded, -0 gone. */
export function written(p: Placement): { at: Vec3; rotation: Vec3 } {
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
  return { at: p.t.map(r6) as Vec3, rotation: toEuler(p.R).map(r6) as Vec3 };
}
