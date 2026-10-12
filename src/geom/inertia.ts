// Mass properties as plain numbers: the inertia tensor of a body about its
// centre of mass, bodies added up (parallel axes), and the principal moments
// and axes. Pure: the kernel measures each body (src/kernel/evaluate.ts) and
// everything after that is arithmetic that Vitest checks against formulas.
//
// Conventions (kg and mm, so moments are kg·mm²):
//   Ixx = ∫(y² + z²) dm, Iyy = ∫(x² + z²) dm, Izz = ∫(x² + y²) dm
//   Pxy = ∫x·y dm, Pxz = ∫x·z dm, Pyz = ∫y·z dm   (products of inertia)
//   The inertia tensor is [[Ixx, −Pxy, −Pxz], [−Pxy, Iyy, −Pyz], [−Pxz, −Pyz, Izz]],
//   and the moment about a unit axis n through the same point is nᵀ·I·n.

import type { Vec3 } from "../doc/types";
import { add3, normalize3, scale3, sub3 } from "./vec";

/** A symmetric 3×3 matrix, rows. */
export type Mat3 = [Vec3, Vec3, Vec3];

export interface Inertia {
  /** Moments about the axes through the centre of mass, parallel to X, Y and Z (kg·mm²). */
  ixx: number;
  iyy: number;
  izz: number;
  /** Products of inertia about the centre of mass (kg·mm²): ∫xy dm, ∫xz dm, ∫yz dm. */
  pxy: number;
  pxz: number;
  pyz: number;
}

export interface MassBody {
  name: string;
  /** mm³ */
  volume: number;
  /** mm² */
  area: number;
  densityKgPerM3: number;
  material: string;
  /** kg */
  mass: number;
  /** mm */
  centre: Vec3;
  /** About the centre of mass. */
  inertia: Inertia;
}

/** The tensor of the moments and products. */
export function tensorOf(i: Inertia): Mat3 {
  return [
    [i.ixx, -i.pxy, -i.pxz],
    [-i.pxy, i.iyy, -i.pyz],
    [-i.pxz, -i.pyz, i.izz],
  ];
}

export function inertiaOf(t: Mat3): Inertia {
  return { ixx: t[0][0], iyy: t[1][1], izz: t[2][2], pxy: -t[0][1] + 0, pxz: -t[0][2] + 0, pyz: -t[1][2] + 0 };
}

/** The moment about a unit axis through the point the tensor is taken at. */
export function momentAbout(t: Mat3, axis: Vec3): number {
  const n = normalize3(axis);
  let m = 0;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m += n[r] * t[r][c] * n[c];
  return m;
}

/**
 * The tensor from moments about six axes through one point: X, Y, Z and the
 * diagonals X+Y, X+Z, Y+Z (each normalised). What the kernel can measure
 * (a moment about an axis) turned into what CAD users read (the tensor).
 */
export function tensorFromMoments(m: { x: number; y: number; z: number; xy: number; xz: number; yz: number }): Mat3 {
  // nᵀ·I·n with n = (1, 1, 0)/√2 is (Ixx + Iyy)/2 + Ixy, where Ixy is the tensor's off-diagonal entry.
  const txy = m.xy - (m.x + m.y) / 2;
  const txz = m.xz - (m.x + m.z) / 2;
  const tyz = m.yz - (m.y + m.z) / 2;
  return [
    [m.x, txy, txz],
    [txy, m.y, tyz],
    [txz, tyz, m.z],
  ];
}

/** The tensor about a point `d` away from the centre of mass (parallel axes): I + m(|d|²E − d·dᵀ). */
export function shifted(t: Mat3, mass: number, d: Vec3): Mat3 {
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  return t.map((row, r) => row.map((v, c) => v + mass * ((r === c ? dd : 0) - d[r] * d[c]))) as Mat3;
}

/**
 * Several bodies as one: masses and volumes added, the centre of mass
 * weighted by mass, each body's tensor carried to the common centre.
 * Null for no bodies.
 */
export function combine(bodies: MassBody[], name = "total"): MassBody | null {
  if (!bodies.length) return null;
  const mass = bodies.reduce((s, b) => s + b.mass, 0);
  const volume = bodies.reduce((s, b) => s + b.volume, 0);
  const area = bodies.reduce((s, b) => s + b.area, 0);
  const weight = mass > 0 ? mass : volume;
  const part = (b: MassBody) => (mass > 0 ? b.mass : b.volume);
  const centre = scale3(
    bodies.reduce((s, b) => add3(s, scale3(b.centre, part(b))), [0, 0, 0] as Vec3),
    weight > 0 ? 1 / weight : 0,
  );
  const zero: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const t = bodies.reduce((sum, b) => {
    const moved = shifted(tensorOf(b.inertia), b.mass, sub3(b.centre, centre));
    return sum.map((row, r) => row.map((v, c) => v + moved[r][c])) as Mat3;
  }, zero);
  const materials = [...new Set(bodies.map((b) => b.material))];
  return {
    name,
    volume,
    area,
    densityKgPerM3: volume > 0 ? (mass / volume) * 1e9 : 0,
    material: materials.join(", "),
    mass,
    centre,
    inertia: inertiaOf(t),
  };
}

/**
 * Principal moments (ascending) and their axes (unit, right-handed) of a
 * symmetric tensor, by Jacobi rotations. Axes of equal moments are any
 * orthonormal pair in their plane.
 */
export function principal(t: Mat3): { moments: Vec3; axes: [Vec3, Vec3, Vec3] } {
  const a = t.map((r) => [...r]) as number[][];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const scale = Math.max(1e-300, ...a.flat().map(Math.abs));
  for (let sweep = 0; sweep < 64; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off <= 1e-15 * scale) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) <= 1e-18 * scale) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const tt = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(tt * tt + 1);
      const s = tt * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  const axes = order.map((i) => [v[0][i], v[1][i], v[2][i]] as Vec3);
  // Each axis pointing mostly positive, the third the cross product of the first two (right-handed).
  for (const k of [0, 1]) {
    const big = axes[k].reduce((bi, x, i) => (Math.abs(x) > Math.abs(axes[k][bi]) + 1e-12 ? i : bi), 0);
    if (axes[k][big] < 0) axes[k] = scale3(axes[k], -1);
  }
  const [e1, e2] = axes;
  axes[2] = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  return { moments: order.map((i) => a[i][i]) as Vec3, axes: axes as [Vec3, Vec3, Vec3] };
}

/** A box's moments about its centre, mm and kg: the textbook formula, for tests and checks. */
export function boxInertia(mass: number, size: Vec3): Inertia {
  const [a, b, c] = size;
  return { ixx: (mass * (b * b + c * c)) / 12, iyy: (mass * (a * a + c * c)) / 12, izz: (mass * (a * a + b * b)) / 12, pxy: 0, pxz: 0, pyz: 0 };
}
