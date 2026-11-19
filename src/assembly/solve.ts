// The mate solver: moves the components that aren't fixed until every mate
// holds, the least it can (Levenberg–Marquardt on each free component's move
// and turn, a numeric Jacobian). Mates hold planes, axes and points of the
// components' parts, given in each part's own frame (resolve.ts finds them
// from the mates' selectors). Pure: placements in, placements out.

import type { MateType, Vec3 } from "../doc/types";
import { apply, mul, pointTo, rotationOf, type Placement } from "./transform";

/** A thing a mate holds, in its part's frame: a plane (a point on it and its outward normal), an axis (a point and its direction) or a point. */
export type MateGeom = { kind: "plane"; p: Vec3; n: Vec3 } | { kind: "axis"; p: Vec3; d: Vec3 } | { kind: "point"; p: Vec3 };

export interface SolverMate {
  id: string;
  type: MateType;
  a: { component: string; geom: MateGeom };
  b: { component: string; geom: MateGeom };
  value?: number;
  aligned?: boolean;
}

export interface MateStatus {
  id: string;
  /** How far from holding: mm (or the sine of an angle) — 0 when it holds. */
  error: number;
  ok: boolean;
  /** Why it can't hold, in words, when it can't even be written (a plane mated concentric, say). */
  problem?: string;
}

export interface SolveResult {
  placements: Map<string, Placement>;
  mates: MateStatus[];
  /** Every mate holds. */
  solved: boolean;
  iterations: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** The part of v square to the unit u. */
const across = (v: Vec3, u: Vec3): Vec3 => sub(v, scale(u, dot(v, u)));

/** The geometry in the assembly, as its component is placed. */
function world(g: MateGeom, p: Placement): MateGeom {
  if (g.kind === "plane") return { kind: "plane", p: pointTo(p, g.p), n: unit(apply(p.R, g.n)) };
  if (g.kind === "axis") return { kind: "axis", p: pointTo(p, g.p), d: unit(apply(p.R, g.d)) };
  return { kind: "point", p: pointTo(p, g.p) };
}

/** What two kinds a mate may join, in words, for a mate that can't be written. */
const KIND = { plane: "a plane", axis: "an axis", point: "a point" } as const;

/**
 * The mate's residuals (each 0 when it holds), or why it can't be written.
 * a and b are in the assembly.
 */
export function residuals(m: SolverMate, a: MateGeom, b: MateGeom): number[] | string {
  const d = m.value ?? 0;
  const type = m.type;
  // Put the plane first, then the axis, then the point, so each pair is one case.
  const order = { plane: 0, axis: 1, point: 2 };
  let [x, y] = [a, b];
  let swapped = false;
  if (order[x.kind] > order[y.kind]) {
    [x, y] = [y, x];
    swapped = true;
  }
  const pair = `${x.kind}-${y.kind}`;
  const bad = (what: string) => `${KIND[a.kind]} and ${KIND[b.kind]} can't be ${what}`;
  switch (type) {
    case "coincident":
    case "distance": {
      if (pair === "plane-plane" && x.kind === "plane" && y.kind === "plane") {
        // Facing each other (normals opposite) unless aligned; the second plane `d` in front of the first.
        const turn = m.aligned ? sub(x.n, y.n) : add(x.n, y.n);
        const first = swapped ? y : x;
        const second = swapped ? x : y;
        return [...turn, dot(sub(second.p, first.p), first.n) - d];
      }
      if (pair === "plane-axis" && x.kind === "plane" && y.kind === "axis") return [dot(y.d, x.n), dot(sub(y.p, x.p), x.n) - d];
      if (pair === "plane-point" && x.kind === "plane" && y.kind === "point") return [dot(sub(y.p, x.p), x.n) - d];
      if (pair === "axis-axis" && x.kind === "axis" && y.kind === "axis") {
        if (type === "distance") return [...cross(x.d, y.d), Math.hypot(...across(sub(y.p, x.p), x.d)) - d];
        return [...cross(x.d, y.d), ...across(sub(y.p, x.p), x.d)];
      }
      if (pair === "axis-point" && x.kind === "axis" && y.kind === "point") {
        const off = across(sub(y.p, x.p), x.d);
        return type === "distance" ? [Math.hypot(...off) - d] : off;
      }
      if (pair === "point-point" && x.kind === "point" && y.kind === "point") {
        const v = sub(y.p, x.p);
        return type === "distance" ? [Math.hypot(...v) - d] : v;
      }
      return bad(type === "distance" ? "a distance apart" : "coincident");
    }
    case "concentric": {
      if (pair !== "axis-axis" || x.kind !== "axis" || y.kind !== "axis") return `concentric takes two axes (round faces, round edges, straight edges or axes): ${bad("concentric")}`;
      return [...cross(x.d, y.d), ...across(sub(y.p, x.p), x.d)];
    }
    case "parallel": {
      const u = x.kind === "plane" ? x.n : x.kind === "axis" ? x.d : null;
      const v = y.kind === "plane" ? y.n : y.kind === "axis" ? y.d : null;
      if (!u || !v) return bad("parallel");
      // A plane and an axis are parallel when the axis lies along the plane.
      return pair === "plane-axis" ? [dot(u, v)] : cross(u, v);
    }
    case "perpendicular": {
      const u = x.kind === "plane" ? x.n : x.kind === "axis" ? x.d : null;
      const v = y.kind === "plane" ? y.n : y.kind === "axis" ? y.d : null;
      if (!u || !v) return bad("perpendicular");
      return pair === "plane-axis" ? cross(u, v) : [dot(u, v)];
    }
    case "angle": {
      const u = x.kind === "plane" ? x.n : x.kind === "axis" ? x.d : null;
      const v = y.kind === "plane" ? y.n : y.kind === "axis" ? y.d : null;
      if (!u || !v) return bad("at an angle");
      return [dot(u, v) - Math.cos(((m.value ?? 0) * Math.PI) / 180)];
    }
  }
}

const norm = (r: number[]) => Math.sqrt(r.reduce((s, x) => s + x * x, 0));

/**
 * Solves the mates. `placements`: every component's place now; `fixed`: the
 * ones held. With none fixed, the first component is held (as other CAD
 * holds the first part put in).
 */
export function solveMates(placements: Map<string, Placement>, fixed: Set<string>, mates: SolverMate[], opts: { iterations?: number } = {}): SolveResult {
  const ids = [...placements.keys()];
  const held = new Set(fixed.size ? fixed : ids.slice(0, 1));
  const live = new Map([...placements].map(([k, p]) => [k, { R: p.R.map((r) => [...r]) as Placement["R"], t: [...p.t] as Vec3 }]));
  // Only components some mate reaches move.
  const touched = new Set(mates.flatMap((m) => [m.a.component, m.b.component]));
  const free = ids.filter((k) => !held.has(k) && touched.has(k));
  const writable = mates.filter((m) => typeof residuals(m, world(m.a.geom, live.get(m.a.component)!), world(m.b.geom, live.get(m.b.component)!)) !== "string");
  const all = (pl: Map<string, Placement>): number[] =>
    writable.flatMap((m) => {
      const r = residuals(m, world(m.a.geom, pl.get(m.a.component)!), world(m.b.geom, pl.get(m.b.component)!));
      return typeof r === "string" ? [] : r;
    });
  // A component moved by its 6 numbers: a shift, then a turn about its own origin's place.
  const moved = (base: Map<string, Placement>, x: number[]): Map<string, Placement> => {
    const out = new Map(base);
    free.forEach((k, i) => {
      const p = base.get(k)!;
      const dw: Vec3 = [x[6 * i + 3], x[6 * i + 4], x[6 * i + 5]];
      out.set(k, { R: mul(rotationOf(dw), p.R), t: [p.t[0] + x[6 * i], p.t[1] + x[6 * i + 1], p.t[2] + x[6 * i + 2]] });
    });
    return out;
  };
  let iterations = 0;
  let r = all(live);
  let lambda = 1e-3;
  const n = free.length * 6;
  const max = opts.iterations ?? 200;
  while (n && norm(r) > 1e-10 && iterations < max) {
    iterations++;
    // Numeric Jacobian, column by column.
    const h = 1e-7;
    const J: number[][] = r.map(() => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const x = new Array(n).fill(0);
      x[j] = h;
      const rj = all(moved(live, x));
      for (let i = 0; i < r.length; i++) J[i][j] = (rj[i] - r[i]) / h;
    }
    // (JᵀJ + λ·diag) δ = −Jᵀr
    const JtJ: number[][] = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
    const Jtr: number[] = Array.from({ length: n }, (_, a) => J.reduce((s, row, i) => s + row[a] * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 12 && !improved; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v + lambda * (v + 1e-9) + 1e-12 : v)));
      const delta = solveLinear(A, Jtr.map((v) => -v));
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const next = moved(live, delta);
      const rn = all(next);
      if (norm(rn) < norm(r)) {
        for (const [k, p] of next) live.set(k, p);
        r = rn;
        lambda = Math.max(lambda / 3, 1e-12);
        improved = true;
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  const status: MateStatus[] = mates.map((m) => {
    const res = residuals(m, world(m.a.geom, live.get(m.a.component)!), world(m.b.geom, live.get(m.b.component)!));
    if (typeof res === "string") return { id: m.id, error: Infinity, ok: false, problem: res };
    const e = norm(res);
    return { id: m.id, error: e, ok: e < 1e-5 };
  });
  return { placements: live, mates: status, solved: status.every((s) => s.ok), iterations };
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-18) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}
