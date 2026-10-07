import type { Vec2, Vec3 } from "../doc/types";

export const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale2 = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross2 = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const len2 = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const angleOf = (a: Vec2): number => Math.atan2(a[1], a[0]);
export const polar = (c: Vec2, r: number, angle: number): Vec2 => [c[0] + r * Math.cos(angle), c[1] + r * Math.sin(angle)];

export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize3 = (a: Vec3): Vec3 => scale3(a, 1 / len3(a));

/** Angle normalised to [0, 2π). */
export function wrapAngle(a: number): number {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

/** "+Z" for axis-aligned unit vectors, otherwise "[0.7071, 0, 0.7071]". */
export function formatDirection(v: Vec3): string {
  const n = normalize3(v);
  const axes = ["X", "Y", "Z"];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(Math.abs(n[i]) - 1) < 1e-9) return `${n[i] > 0 ? "+" : "-"}${axes[i]}`;
  }
  return `[${n.map((x) => roundTo(x, 4)).join(", ")}]`;
}

export function roundTo(x: number, digits: number): number {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}
