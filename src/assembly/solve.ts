// The mate solver: moves the components that aren't fixed until every mate
// holds, the least it can (Levenberg–Marquardt on each free component's move
// and turn, a numeric Jacobian). Mates hold planes, axes and points of the
// components' parts, given in each part's own frame (resolve.ts finds them
// from the mates' selectors). Pure: placements in, placements out.

import type { MateType, Vec3 } from "../doc/types";
import { apply, mul, pointTo, rotationOf, type Placement } from "./transform";

/** A thing a mate holds, in its part's frame: a plane (a point on it and its outward normal), an axis (a point and its direction) or a point. */
export type MateGeom = { kind: "plane"; p: Vec3; n: Vec3 } | { kind: "axis"; p: Vec3; d: Vec3; /** A round face's radius (tangent mates). */ r?: number } | { kind: "point"; p: Vec3 };

export interface SolverMate {
  id: string;
  type: MateType;
  a: { component: string; geom: MateGeom };
  b: { component: string; geom: MateGeom };
  value?: number;
  aligned?: boolean;
  opposed?: boolean;
  flip?: boolean;
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
  if (g.kind === "axis") return { kind: "axis", p: pointTo(p, g.p), d: unit(apply(p.R, g.d)), ...(g.r !== undefined ? { r: g.r } : {}) };
  return { kind: "point", p: pointTo(p, g.p) };
}

/** What two kinds a mate may join, in words, for a mate that can't be written. */
const KIND = { plane: "a plane", axis: "an axis", point: "a point" } as const;

/**
 * The mate's residuals (each 0 when it holds), or why it can't be written.
 * a and b are in the assembly.
 */
export function residuals(m: SolverMate, a: MateGeom, b: MateGeom): number[] | string {
  // Flipped: the other side of the first face.
  const d = (m.value ?? 0) * (m.flip ? -1 : 1);
  // Two directions: the same way (aligned), opposite (opposed), or either (cross: parallel).
  const together = (u: Vec3, v: Vec3): number[] => (m.aligned ? sub(u, v) : m.opposed ? add(u, v) : cross(u, v));
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
        if (type === "distance") return [...together(x.d, y.d), Math.hypot(...across(sub(y.p, x.p), x.d)) - Math.abs(d)];
        return [...together(x.d, y.d), ...across(sub(y.p, x.p), x.d)];
      }
      if (pair === "axis-point" && x.kind === "axis" && y.kind === "point") {
        const off = across(sub(y.p, x.p), x.d);
        return type === "distance" ? [Math.hypot(...off) - Math.abs(d)] : off;
      }
      if (pair === "point-point" && x.kind === "point" && y.kind === "point") {
        const v = sub(y.p, x.p);
        return type === "distance" ? [Math.hypot(...v) - Math.abs(d)] : v;
      }
      return bad(type === "distance" ? "a distance apart" : "coincident");
    }
    case "concentric": {
      if (pair !== "axis-axis" || x.kind !== "axis" || y.kind !== "axis") return `concentric takes two axes (round faces, round edges, straight edges or axes): ${bad("concentric")}`;
      return [...together(x.d, y.d), ...across(sub(y.p, x.p), x.d)];
    }
    case "tangent": {
      // A flat face touching a round one: the axis along the face, the radius in front of it (behind it, flipped).
      if (pair === "plane-axis" && x.kind === "plane" && y.kind === "axis") {
        if (y.r === undefined) return "tangent takes a round face (not an edge or axis) and a flat or round face";
        return [dot(y.d, x.n), dot(sub(y.p, x.p), x.n) - (m.flip ? -y.r : y.r)];
      }
      // Two round faces touching: side by side (the radii apart), or one inside the other (flipped: their difference).
      if (pair === "axis-axis" && x.kind === "axis" && y.kind === "axis") {
        if (x.r === undefined || y.r === undefined) return "tangent takes round faces (not edges or axes)";
        return [...cross(x.d, y.d), Math.hypot(...across(sub(y.p, x.p), x.d)) - (m.flip ? Math.abs(x.r - y.r) : x.r + y.r)];
      }
      return `tangent takes a round face and a flat or round face: ${bad("tangent")}`;
    }
    case "parallel": {
      const u = x.kind === "plane" ? x.n : x.kind === "axis" ? x.d : null;
      const v = y.kind === "plane" ? y.n : y.kind === "axis" ? y.d : null;
      if (!u || !v) return bad("parallel");
      // A plane and an axis are parallel when the axis lies along the plane.
      return pair === "plane-axis" ? [dot(u, v)] : together(u, v);
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
  // First only what is out of place moves: the components of the mates that don't hold yet (a new mate's two
  // parts), the rest held where they are, as other CAD moves the part being mated and leaves the placed ones be.
  // Failing that, everything not fixed may move.
  const anchor = fixed.size ? fixed : new Set([...placements.keys()].slice(0, 1));
  const unmet = new Set(
    mates.flatMap((m) => {
      const r = residuals(m, world(m.a.geom, placements.get(m.a.component)!), world(m.b.geom, placements.get(m.b.component)!));
      return typeof r !== "string" && norm(r) >= 1e-5 ? [m.a.component, m.b.component] : [];
    }),
  );
  // Placed already: a component with a mate that holds now. Of a new mate's two parts, the new one moves first.
  const settled = new Set(
    mates.flatMap((m) => {
      const r = residuals(m, world(m.a.geom, placements.get(m.a.component)!), world(m.b.geom, placements.get(m.b.component)!));
      return typeof r !== "string" && norm(r) < 1e-5 ? [m.a.component, m.b.component] : [];
    }),
  );
  const fresh = new Set([...unmet].filter((k) => !settled.has(k)));
  // Failing that, the one put in last (a second mate on a part placed by its first), then both.
  const order = [...placements.keys()];
  const last = new Set([...unmet].filter((k) => !anchor.has(k)).sort((x, y) => order.indexOf(y) - order.indexOf(x)).slice(0, 1));
  for (const moving of [fresh, last, unmet]) {
    if (!moving.size || ![...placements.keys()].some((k) => !moving.has(k) && !anchor.has(k))) continue;
    const held = new Set([...placements.keys()].filter((k) => anchor.has(k) || !moving.has(k)));
    const near = withFlips(placements, held, mates, opts);
    if (near.solved) return near;
  }
  return withFlips(placements, fixed, mates, opts);
}

/** One solve, and when it sticks, again with each stuck component turned half round about each axis; the best. */
function withFlips(placements: Map<string, Placement>, fixed: Set<string>, mates: SolverMate[], opts: { iterations?: number }): SolveResult {
  const first = solveOnce(placements, fixed, mates, opts);
  if (first.solved) return first;
  // Stuck (a part would have to turn over to meet its mates, through places where they hold less): try each stuck
  // component turned half round about each axis, and keep the best.
  const total = (r: SolveResult) => r.mates.reduce((s, m) => s + (Number.isFinite(m.error) ? m.error : 1e9), 0);
  const held = new Set(fixed.size ? fixed : [...placements.keys()].slice(0, 1));
  const stuck = [...new Set(first.mates.filter((m) => !m.ok && !m.problem).flatMap((m) => {
    const x = mates.find((y) => y.id === m.id);
    return x ? [x.a.component, x.b.component] : [];
  }))].filter((k) => !held.has(k));
  let best = first;
  for (const k of stuck)
    for (const w of [[Math.PI, 0, 0], [0, Math.PI, 0], [0, 0, Math.PI]] as Vec3[]) {
      const start = new Map(best.placements);
      const p = start.get(k)!;
      start.set(k, { R: mul(rotationOf(w), p.R), t: p.t });
      const r = solveOnce(start, fixed, mates, opts);
      if (total(r) < total(best) - 1e-12) best = { ...r, iterations: best.iterations + r.iterations };
      if (best.solved) return best;
    }
  return best;
}

function solveOnce(placements: Map<string, Placement>, fixed: Set<string>, mates: SolverMate[], opts: { iterations?: number } = {}): SolveResult {
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
  // Each component's reach: how far its mated geometry is from its origin (a turn of θ moves it θ × that), so its
  // turns are counted in mm like its shifts and the least move is the least for both.
  const reach = new Map<string, number>(free.map((k) => [k, 20]));
  for (const m of mates)
    for (const side of [m.a, m.b])
      if (reach.has(side.component)) reach.set(side.component, Math.max(reach.get(side.component)!, Math.hypot(...side.geom.p)));
  // A component moved by its 6 numbers: a shift, then a turn about its own origin's place (in mm at its reach).
  const moved = (base: Map<string, Placement>, x: number[]): Map<string, Placement> => {
    const out = new Map(base);
    free.forEach((k, i) => {
      const p = base.get(k)!;
      const L = reach.get(k)!;
      const dw: Vec3 = [x[6 * i + 3] / L, x[6 * i + 4] / L, x[6 * i + 5] / L];
      out.set(k, { R: mul(rotationOf(dw), p.R), t: [p.t[0] + x[6 * i], p.t[1] + x[6 * i + 1], p.t[2] + x[6 * i + 2]] });
    });
    return out;
  };
  // What a mate moves when it could move either part: the one put in later. Earlier components (placed already) weigh
  // more, so the least weighted move leaves them be, as other CAD moves the part being mated, not the ones it mates to.
  const weight = free.map((_, i) => Math.pow(8, Math.min(6, free.length - 1 - i)));
  let iterations = 0;
  let r = all(live);
  let lambda = 1e-3;
  const n = free.length * 6;
  const max = opts.iterations ?? 200;
  while (n && norm(r) > 1e-10 && iterations < max) {
    iterations++;
    // Numeric Jacobian, column by column.
    const h = 1e-6;
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
    // Damped in every direction, the ones no mate cares about too: a step moves nothing its mates don't ask it to (an
    // under-held component stays where it is rather than drifting off along what it is free to do).
    const big = Math.max(1e-12, ...JtJ.map((row, a) => row[a]));
    for (let tries = 0; tries < 12 && !improved; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v + (lambda * (v + 1e-3 * big) + 1e-9 * big) * weight[Math.floor(a / 6)] : v)));
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

/** A way a component can still move with its mates holding: a slide along a direction, or a turn about an axis (through a point). */
export type FreeMotion = { kind: "slide"; along: Vec3 } | { kind: "turn"; axis: Vec3; through: Vec3 };

/**
 * What a component can still do with the other components where they are and
 * its mates holding: the motions its mates don't stop (none: it is fully
 * placed; six: nothing holds it). Read from the null space of its mates'
 * Jacobian over its own move and turn.
 */
export function freeMotions(placements: Map<string, Placement>, mates: SolverMate[], id: string, size = 100): FreeMotion[] {
  const p = placements.get(id);
  if (!p) return [];
  const mine = mates.filter((m) => m.a.component === id || m.b.component === id);
  const rows = (pl: Map<string, Placement>) =>
    mine.flatMap((m) => {
      const r = residuals(m, world(m.a.geom, pl.get(m.a.component)!), world(m.b.geom, pl.get(m.b.component)!));
      return typeof r === "string" ? [] : r;
    });
  // The six numbers: a slide (mm) and a turn about the component's origin scaled to mm at its size (radians × size),
  // so a slide and a turn weigh alike.
  const L = Math.max(1, size);
  const at = (x: number[]) => {
    const out = new Map(placements);
    out.set(id, { R: mul(rotationOf([x[3] / L, x[4] / L, x[5] / L]), p.R), t: [p.t[0] + x[0], p.t[1] + x[1], p.t[2] + x[2]] });
    return out;
  };
  const r0 = rows(placements);
  const h = 1e-6;
  const J: number[][] = r0.map(() => new Array(6).fill(0));
  for (let j = 0; j < 6; j++) {
    const x = new Array(6).fill(0);
    x[j] = h;
    const rj = rows(at(x));
    for (let i = 0; i < r0.length; i++) J[i][j] = (rj[i] - r0[i]) / h;
  }
  const JtJ: number[][] = Array.from({ length: 6 }, (_, a) => Array.from({ length: 6 }, (_, b) => J.reduce((sum, row) => sum + row[a] * row[b], 0)));
  const { values, vectors } = symmetricEigen(JtJ);
  const big = Math.max(1e-12, ...values.map(Math.abs));
  const basis = values.map((v, i) => ({ v, vec: vectors.map((row) => row[i]) })).filter((e) => Math.abs(e.v) < 1e-6 * Math.max(1, big)).map((e) => e.vec);
  // Back to radians for the turn part.
  return describeMotions(basis.map((v) => [v[0], v[1], v[2], v[3] / L, v[4] / L, v[5] / L]), p.t, L);
}

/**
 * A null space (slides t and turns w about the component's origin o) as
 * its turns and its pure slides: the combinations with no turn in them are
 * slides; the rest are turns, each about its own axis.
 */
function describeMotions(basis: number[][], o: Vec3, L: number): FreeMotion[] {
  const k = basis.length;
  if (!k) return [];
  const tidy = (v: Vec3): Vec3 => unit(v).map((x) => (Math.abs(x) < 1e-6 ? 0 : Math.round(x * 1e6) / 1e6 + 0)) as Vec3;
  // How much each combination turns: the k × k matrix of the turn parts' dot products.
  const W = basis.map((v) => [v[3] * L, v[4] * L, v[5] * L]);
  const G = W.map((a) => W.map((b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const { values, vectors } = symmetricEigen(G);
  const turns: FreeMotion[] = [];
  const slides: FreeMotion[] = [];
  values.forEach((ev, i) => {
    const c = vectors.map((row) => row[i]);
    const v = [0, 1, 2, 3, 4, 5].map((j) => basis.reduce((sum, b, n) => sum + c[n] * b[j], 0));
    const t: Vec3 = [v[0], v[1], v[2]];
    const w: Vec3 = [v[3], v[4], v[5]];
    const lw = Math.hypot(...w);
    if (ev < 1e-6 || lw * L < 1e-4 * Math.max(1, Math.hypot(...t))) {
      if (Math.hypot(...t) > 1e-9) slides.push({ kind: "slide", along: tidy(t) });
      return;
    }
    // A turn about an axis along w through p: t = −w × (p − o)  ⇒  p − o = (w × t) / |w|² (the slide along w, a screw, is left out).
    const off = scale(cross(w, t), 1 / (lw * lw));
    turns.push({ kind: "turn", axis: tidy(w), through: add(o, off).map((x) => Math.round(x * 1000) / 1000 + 0) as Vec3 });
  });
  return [...turns, ...slides];
}

/** Eigenvalues and eigenvectors (columns) of a small symmetric matrix, by Jacobi rotations. */
function symmetricEigen(M: number[][]): { values: number[]; vectors: number[][] } {
  const n = M.length;
  const A = M.map((r) => [...r]);
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return { values: A.map((r, i) => r[i]), vectors: V };
}
