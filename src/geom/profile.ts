// Sketch entities -> closed profile loops -> regions (outer loop + holes).
//
// Pure 2D, no kernel. Loops must be simple and must not touch each other;
// nesting is decided by winding number, so a loop inside a loop is a hole and
// a loop inside that hole is an island again.

import type { SketchEntity, Vec2 } from "../doc/types";
import { add2, angleOf, cross2, dist2, dot2, len2, polar, scale2, sub2, wrapAngle } from "./vec";

/** Positional tolerance in document units (mm). */
export const TOL = 1e-6;

export type Seg =
  | { kind: "line"; entity: string; a: Vec2; b: Vec2 }
  /** sweep > 0 is counter-clockwise. A full circle has |sweep| = 2π and a == b. */
  | { kind: "arc"; entity: string; c: Vec2; r: number; a: Vec2; b: Vec2; start: number; sweep: number };

export interface Loop {
  segs: Seg[];
  /** Signed area; positive when counter-clockwise. */
  area: number;
}

export interface Region {
  /** Counter-clockwise. */
  outer: Loop;
  /** Clockwise. */
  holes: Loop[];
}

export type ProfileResult = { ok: true; regions: Region[]; area: number } | { ok: false; error: string };

export function buildProfile(entities: SketchEntity[]): ProfileResult {
  try {
    const live = entities.filter((e) => !e.construction);
    const loops: Loop[] = [];
    const open: Seg[] = [];
    for (const e of live) {
      switch (e.type) {
        case "circle":
          loops.push(makeLoop([fullCircle(e.id, e.center, e.radius)]));
          break;
        case "rect":
          loops.push(makeLoop(rectSegs(e.id, e.center, e.w, e.h)));
          break;
        case "slot":
          loops.push(makeLoop(slotSegs(e.id, e.center1, e.center2, e.width)));
          break;
        case "line":
          if (dist2(e.start, e.end) <= TOL) throw new ProfileError(`line "${e.id}" has zero length`);
          open.push({ kind: "line", entity: e.id, a: e.start, b: e.end });
          break;
        case "arc":
          open.push(arcSeg(e.id, e.center, e.start, e.end, e.clockwise ?? false));
          break;
        case "point":
          break; // a sketch point marks a place; it bounds nothing
      }
    }
    loops.push(...chain(open));
    checkIntersections(loops);
    const regions = nest(loops);
    const area = regions.reduce((s, r) => s + r.outer.area + r.holes.reduce((h, l) => h + l.area, 0), 0);
    return { ok: true, regions, area };
  } catch (e) {
    if (e instanceof ProfileError) return { ok: false, error: e.message };
    throw e;
  }
}

class ProfileError extends Error {}

// ------------------------------------------------------------ primitives

function fullCircle(entity: string, c: Vec2, r: number): Seg {
  const a = add2(c, [r, 0]);
  return { kind: "arc", entity, c, r, a, b: a, start: 0, sweep: 2 * Math.PI };
}

function rectSegs(entity: string, c: Vec2, w: number, h: number): Seg[] {
  const [x0, x1, y0, y1] = [c[0] - w / 2, c[0] + w / 2, c[1] - h / 2, c[1] + h / 2];
  const p: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return p.map((a, i) => ({ kind: "line" as const, entity, a, b: p[(i + 1) % 4] }));
}

function slotSegs(entity: string, c1: Vec2, c2: Vec2, width: number): Seg[] {
  const length = dist2(c1, c2);
  if (length <= TOL) throw new ProfileError(`slot "${entity}" has coincident centres; use a circle`);
  const u = scale2(sub2(c2, c1), 1 / length);
  const n: Vec2 = [-u[1], u[0]];
  const r = width / 2;
  const p1 = sub2(c1, scale2(n, r));
  const p2 = sub2(c2, scale2(n, r));
  const p3 = add2(c2, scale2(n, r));
  const p4 = add2(c1, scale2(n, r));
  const up = angleOf(n);
  return [
    { kind: "line", entity, a: p1, b: p2 },
    { kind: "arc", entity, c: c2, r, a: p2, b: p3, start: up + Math.PI, sweep: Math.PI },
    { kind: "line", entity, a: p3, b: p4 },
    { kind: "arc", entity, c: c1, r, a: p4, b: p1, start: up, sweep: Math.PI },
  ];
}

function arcSeg(entity: string, c: Vec2, a: Vec2, b: Vec2, clockwise: boolean): Seg {
  const r = dist2(a, c);
  const rEnd = dist2(b, c);
  if (r <= TOL) throw new ProfileError(`arc "${entity}" has zero radius`);
  if (Math.abs(r - rEnd) > TOL) {
    throw new ProfileError(
      `arc "${entity}": start is ${fmt(r)} from center but end is ${fmt(rEnd)}; both must be on one circle`,
    );
  }
  if (dist2(a, b) <= TOL) throw new ProfileError(`arc "${entity}" starts where it ends; use a circle`);
  const start = angleOf(sub2(a, c));
  const end = angleOf(sub2(b, c));
  const sweep = clockwise ? -wrapAngle(start - end) : wrapAngle(end - start);
  return { kind: "arc", entity, c, r, a, b, start, sweep };
}

// -------------------------------------------------------------- chaining

function chain(segs: Seg[]): Loop[] {
  if (segs.length === 0) return [];
  const nodes: Vec2[] = [];
  const nodeOf = (p: Vec2): number => {
    const i = nodes.findIndex((q) => dist2(p, q) <= TOL);
    if (i >= 0) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  const ends = segs.map((s) => [nodeOf(s.a), nodeOf(s.b)] as const);
  const incident = nodes.map(() => [] as number[]);
  ends.forEach(([i, j], s) => {
    incident[i].push(s);
    incident[j].push(s);
  });
  incident.forEach((list, n) => {
    if (list.length === 1) {
      const s = segs[list[0]];
      const which = ends[list[0]][0] === n ? "start" : "end";
      throw new ProfileError(`profile is open at ${fmtPt(nodes[n])} (${which} of "${s.entity}")`);
    }
    if (list.length > 2) {
      const names = list.map((s) => `"${segs[s].entity}"`).join(", ");
      throw new ProfileError(`${names} meet at ${fmtPt(nodes[n])}; each profile vertex must join exactly two entities`);
    }
  });

  const used = new Array(segs.length).fill(false);
  const loops: Loop[] = [];
  for (let first = 0; first < segs.length; first++) {
    if (used[first]) continue;
    const out: Seg[] = [];
    let s = first;
    let from = ends[s][0];
    while (!used[s]) {
      used[s] = true;
      const forward = ends[s][0] === from;
      out.push(forward ? segs[s] : reverseSeg(segs[s]));
      const to = forward ? ends[s][1] : ends[s][0];
      const next = incident[to].find((t) => t !== s) ?? s; // a closed single entity loops onto itself
      from = to;
      s = next;
    }
    loops.push(makeLoop(out));
  }
  return loops;
}

function reverseSeg(s: Seg): Seg {
  if (s.kind === "line") return { ...s, a: s.b, b: s.a };
  return { ...s, a: s.b, b: s.a, start: s.start + s.sweep, sweep: -s.sweep };
}

function makeLoop(segs: Seg[]): Loop {
  return { segs, area: segs.reduce((sum, s) => sum + segArea(s), 0) };
}

/** Green's theorem contribution: ½∮(x dy − y dx). */
function segArea(s: Seg): number {
  if (s.kind === "line") return 0.5 * cross2(s.a, s.b);
  const { c, r, a, b, sweep } = s;
  return 0.5 * (r * r * sweep + c[0] * (b[1] - a[1]) - c[1] * (b[0] - a[0]));
}

export function reverseLoop(loop: Loop): Loop {
  return { segs: loop.segs.map(reverseSeg).reverse(), area: -loop.area };
}

// --------------------------------------------------------- intersections

function checkIntersections(loops: Loop[]): void {
  const all = loops.flatMap((loop, li) => loop.segs.map((seg, si) => ({ seg, li, si, n: loop.segs.length })));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const A = all[i];
      const B = all[j];
      const hit = intersect(A.seg, B.seg);
      if (hit === "overlap") {
        throw new ProfileError(`"${A.seg.entity}" and "${B.seg.entity}" overlap`);
      }
      // Points the two segments are allowed to share: their common vertices in one loop.
      const shared: Vec2[] = [];
      if (A.li === B.li) {
        if ((A.si + 1) % A.n === B.si) shared.push(A.seg.b);
        if ((B.si + 1) % B.n === A.si) shared.push(B.seg.b);
      }
      for (const p of hit) {
        if (shared.some((q) => dist2(p, q) <= 10 * TOL)) continue;
        const what = A.seg.entity === B.seg.entity ? `"${A.seg.entity}" crosses itself` : `"${A.seg.entity}" and "${B.seg.entity}" intersect`;
        throw new ProfileError(`${what} at ${fmtPt(p)}; profiles must not cross or touch`);
      }
    }
  }
}

function intersect(A: Seg, B: Seg): Vec2[] | "overlap" {
  if (A.kind === "line" && B.kind === "line") return lineLine(A.a, A.b, B.a, B.b);
  if (A.kind === "line" && B.kind === "arc") return lineCircle(A.a, A.b, B.c, B.r).filter((p) => onArc(B, p));
  if (A.kind === "arc" && B.kind === "line") return lineCircle(B.a, B.b, A.c, A.r).filter((p) => onArc(A, p));
  return arcArc(A as Extract<Seg, { kind: "arc" }>, B as Extract<Seg, { kind: "arc" }>);
}

function lineLine(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2[] | "overlap" {
  const r = sub2(b, a);
  const s = sub2(d, c);
  const denom = cross2(r, s);
  const lr = len2(r);
  const ls = len2(s);
  if (Math.abs(denom) <= 1e-12 * lr * ls) {
    if (Math.abs(cross2(sub2(c, a), r)) / lr > TOL) return []; // parallel, apart
    // Collinear: project c and d onto a->b.
    const t0 = dot2(sub2(c, a), r) / (lr * lr);
    const t1 = dot2(sub2(d, a), r) / (lr * lr);
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    const eps = TOL / lr;
    if (hi - lo > eps) return "overlap";
    if (hi - lo >= -eps) return [add2(a, scale2(r, (lo + hi) / 2))];
    return [];
  }
  const ca = sub2(c, a);
  const t = cross2(ca, s) / denom;
  const u = cross2(ca, r) / denom;
  const et = TOL / lr;
  const eu = TOL / ls;
  if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) return [];
  return [add2(a, scale2(r, t))];
}

function lineCircle(a: Vec2, b: Vec2, c: Vec2, r: number): Vec2[] {
  const d = sub2(b, a);
  const f = sub2(a, c);
  const A = dot2(d, d);
  const B = 2 * dot2(f, d);
  const C = dot2(f, f) - r * r;
  // Distance from the circle centre to the infinite line, to classify tangency robustly.
  const dist = Math.abs(cross2(d, sub2(c, a))) / Math.sqrt(A);
  if (dist > r + TOL) return [];
  const ts: number[] = [];
  if (Math.abs(dist - r) <= TOL) {
    ts.push(-B / (2 * A));
  } else {
    const disc = Math.sqrt(Math.max(0, B * B - 4 * A * C));
    ts.push((-B - disc) / (2 * A), (-B + disc) / (2 * A));
  }
  const eps = TOL / Math.sqrt(A);
  return ts.filter((t) => t >= -eps && t <= 1 + eps).map((t) => add2(a, scale2(d, t)));
}

type ArcSeg = Extract<Seg, { kind: "arc" }>;

function arcArc(A: ArcSeg, B: ArcSeg): Vec2[] | "overlap" {
  const d = dist2(A.c, B.c);
  if (d <= TOL && Math.abs(A.r - B.r) <= TOL) {
    // Same circle: overlap if an interior point of one lies on the other.
    const interiorOn = (X: ArcSeg, Y: ArcSeg) => onArc(Y, polar(X.c, X.r, X.start + X.sweep / 2));
    if (interiorOn(A, B) || interiorOn(B, A)) return "overlap";
    const pts = [A.a, A.b].filter((p) => dist2(p, B.a) <= TOL || dist2(p, B.b) <= TOL);
    return pts;
  }
  if (d <= TOL) return []; // concentric, different radii
  if (d > A.r + B.r + TOL || d < Math.abs(A.r - B.r) - TOL) return [];
  const along = (d * d + A.r * A.r - B.r * B.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, A.r * A.r - along * along));
  const u = scale2(sub2(B.c, A.c), 1 / d);
  const base = add2(A.c, scale2(u, along));
  const n: Vec2 = [-u[1], u[0]];
  const pts = h <= TOL ? [base] : [add2(base, scale2(n, h)), sub2(base, scale2(n, h))];
  return pts.filter((p) => onArc(A, p) && onArc(B, p));
}

function onArc(s: ArcSeg, p: Vec2): boolean {
  if (Math.abs(s.sweep) >= 2 * Math.PI - 1e-12) return true;
  const phi = angleOf(sub2(p, s.c));
  const tolAngle = TOL / s.r;
  const t = s.sweep > 0 ? wrapAngle(phi - s.start) : wrapAngle(s.start - phi);
  return t <= Math.abs(s.sweep) + tolAngle || t >= 2 * Math.PI - tolAngle;
}

// --------------------------------------------------------------- nesting

function nest(loops: Loop[]): Region[] {
  const containers = loops.map((loop, i) =>
    loops.map((_, j) => j).filter((j) => j !== i && windingNumber(loops[j], loop.segs[0].a) !== 0),
  );
  const depth = containers.map((c) => c.length);
  const regions: Region[] = [];
  const regionOf = new Map<number, Region>();
  loops.forEach((loop, i) => {
    if (depth[i] % 2 === 0) {
      const region: Region = { outer: loop.area > 0 ? loop : reverseLoop(loop), holes: [] };
      regions.push(region);
      regionOf.set(i, region);
    }
  });
  loops.forEach((loop, i) => {
    if (depth[i] % 2 === 1) {
      const parent = containers[i].find((j) => depth[j] === depth[i] - 1)!;
      regionOf.get(parent)!.holes.push(loop.area < 0 ? loop : reverseLoop(loop));
    }
  });
  return regions;
}

/** Exact winding number of p about a loop of lines and arcs. p must not lie on the loop. */
export function windingNumber(loop: Loop, p: Vec2): number {
  let total = 0;
  for (const s of loop.segs) {
    const va = sub2(s.a, p);
    const vb = sub2(s.b, p);
    const direct = Math.atan2(cross2(va, vb), dot2(va, vb));
    if (s.kind === "arc" && dist2(p, s.c) < s.r - TOL) {
      // Inside the arc's circle the viewing angle turns monotonically with the arc.
      const full = Math.abs(s.sweep) >= 2 * Math.PI - 1e-12;
      const turn = full ? 2 * Math.PI : s.sweep > 0 ? wrapAngle(angleOf(vb) - angleOf(va)) : wrapAngle(angleOf(va) - angleOf(vb));
      total += s.sweep > 0 ? turn : -turn;
    } else {
      total += direct;
    }
  }
  return Math.round(total / (2 * Math.PI));
}

// --------------------------------------------------------------- helpers

/** Point at the middle of an arc, used for three-point arc construction. */
export function arcMid(s: ArcSeg): Vec2 {
  return polar(s.c, s.r, s.start + s.sweep / 2);
}

/** Polyline approximation of a segment, for display only. */
export function sampleSeg(s: Seg, maxAngleStep = Math.PI / 32): Vec2[] {
  if (s.kind === "line") return [s.a, s.b];
  const n = Math.max(2, Math.ceil(Math.abs(s.sweep) / maxAngleStep));
  return Array.from({ length: n + 1 }, (_, i) => polar(s.c, s.r, s.start + (s.sweep * i) / n));
}

function fmt(x: number): string {
  return String(Math.round(x * 1e4) / 1e4);
}

function fmtPt(p: Vec2): string {
  return `[${fmt(p[0])}, ${fmt(p[1])}]`;
}

/** Polylines for drawing one entity, valid or not. Invalid geometry draws as nothing. */
export function entityPolylines(e: SketchEntity, maxAngleStep = Math.PI / 32): Vec2[][] {
  try {
    let segs: Seg[];
    switch (e.type) {
      case "line":
        segs = [{ kind: "line", entity: e.id, a: e.start, b: e.end }];
        break;
      case "circle":
        segs = [fullCircle(e.id, e.center, e.radius)];
        break;
      case "arc":
        segs = [arcSeg(e.id, e.center, e.start, e.end, e.clockwise ?? false)];
        break;
      case "rect":
        segs = rectSegs(e.id, e.center, e.w, e.h);
        break;
      case "slot":
        segs = slotSegs(e.id, e.center1, e.center2, e.width);
        break;
      case "point":
        return []; // drawn as a dot by whoever draws it
    }
    return segs.map((s) => sampleSeg(s, maxAngleStep));
  } catch {
    return [];
  }
}
