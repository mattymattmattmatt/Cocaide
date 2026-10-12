// A sketch's curves as one chain, pure (no kernel), in sketch coordinates:
// the path a sweep follows and the line a rib stands on.
//   - sketchChain: the sketch's profile curves (not construction, not points)
//     joined end to end into one chain, open or closed, in order, or an error
//     that says what is wrong with them (two chains, a branch, nothing);
//   - where the chain meets a plane (the profile's), and the chain turned so
//     it starts there: SOLIDWORKS's rule that the path starts on the profile's
//     plane, applied for the user (an open path runs from whichever end is on
//     the plane; a closed one is split where it crosses it);
//   - points and tangents along it.

import type { SketchEntity, Vec2, Vec3 } from "../../doc/types";
import { to3D, type Frame } from "../../geom/frame";
import { buildProfile, sampleSeg, type Seg } from "../../geom/profile";
import { add2, angleOf, dist2, dot2, dot3, len2, scale2, sub2, sub3, wrapAngle } from "../../geom/vec";

/** Positional tolerance (mm), as the profile builder's. */
const TOL = 1e-6;
/** How far off a plane (mm) a path end may be and still count as on it. */
export const ON_PLANE = 1e-4;

export class ChainError extends Error {}

/** One chain of lines and arcs, in order; `closed`: its end is its start. */
export interface Chain {
  segs: Seg[];
  closed: boolean;
}

const isConstruction = (e: SketchEntity) => e.construction ?? !!e.ref;

function lineSeg(e: Extract<SketchEntity, { type: "line" }>): Seg {
  if (dist2(e.start, e.end) <= TOL) throw new ChainError(`line "${e.id}" has zero length`);
  return { kind: "line", entity: e.id, a: e.start, b: e.end };
}

function arcSeg(e: Extract<SketchEntity, { type: "arc" }>): Seg {
  const r = dist2(e.start, e.center);
  if (r <= TOL || Math.abs(r - dist2(e.end, e.center)) > TOL) throw new ChainError(`arc "${e.id}": its ends are not on one circle about its centre`);
  if (dist2(e.start, e.end) <= TOL) throw new ChainError(`arc "${e.id}" starts where it ends; use a circle`);
  const start = angleOf(sub2(e.start, e.center));
  const end = angleOf(sub2(e.end, e.center));
  const sweep = e.clockwise ? -wrapAngle(start - end) : wrapAngle(end - start);
  return { kind: "arc", entity: e.id, c: e.center, r, a: e.start, b: e.end, start, sweep };
}

export function reverseSeg(s: Seg): Seg {
  if (s.kind === "line") return { ...s, a: s.b, b: s.a };
  return { ...s, a: s.b, b: s.a, start: s.start + s.sweep, sweep: -s.sweep };
}

/** The chain the other way round. */
export function reverseChain(c: Chain): Chain {
  return { segs: c.segs.map(reverseSeg).reverse(), closed: c.closed };
}

const fmtN = (x: number) => String(Math.round(x * 1e4) / 1e4);
const fmt = (p: Vec2) => `[${fmtN(p[0])}, ${fmtN(p[1])}]`;

/**
 * The sketch's curves as one chain. `what` names the use in messages ("a
 * sweep path", "a rib"). `closedOk`: a closed chain (a circle, a rectangle, a
 * closed run of lines) is accepted. An open chain runs from the free end with
 * the lowest coordinates, so its direction does not depend on drawing order.
 */
export function sketchChain(entities: readonly SketchEntity[], what: string, closedOk = true): Chain {
  const live = entities.filter((e) => !isConstruction(e) && e.type !== "point");
  if (live.length === 0) throw new ChainError(`the sketch has no curves for ${what} (construction lines and points do not count)`);
  const shapes = live.filter((e) => e.type === "circle" || e.type === "rect" || e.type === "slot");
  if (shapes.length > 0) {
    if (!closedOk) throw new ChainError(`"${shapes[0].id}" is a closed shape: ${what} needs an open chain of lines and arcs`);
    if (live.length > 1) throw new ChainError(`"${shapes[0].id}" is a closed shape and the sketch has other curves too: ${what} follows one chain`);
    const p = buildProfile([shapes[0]]);
    if (!p.ok) throw new ChainError(p.error);
    return { segs: p.regions[0].outer.segs, closed: true };
  }
  const segs = live.map((e) => (e.type === "line" ? lineSeg(e) : arcSeg(e as Extract<SketchEntity, { type: "arc" }>)));
  const nodes: Vec2[] = [];
  const nodeOf = (p: Vec2) => {
    const i = nodes.findIndex((q) => dist2(p, q) <= TOL);
    if (i >= 0) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  const ends = segs.map((s) => [nodeOf(s.a), nodeOf(s.b)] as const);
  const degree = nodes.map((_, n) => ends.filter(([i, j]) => i === n || j === n).length);
  const branch = degree.findIndex((d) => d > 2);
  if (branch >= 0) throw new ChainError(`three or more curves meet at ${fmt(nodes[branch])}: ${what} follows one chain without branches`);
  const free = degree.flatMap((d, n) => (d === 1 ? [n] : []));
  const startNode = free.length ? free.sort((m, n) => nodes[m][0] - nodes[n][0] || nodes[m][1] - nodes[n][1])[0] : ends[0][0];
  const used = new Array(segs.length).fill(false);
  const out: Seg[] = [];
  let at = startNode;
  for (;;) {
    const k = ends.findIndex(([i, j], s) => !used[s] && (i === at || j === at));
    if (k < 0) break;
    used[k] = true;
    const forward = ends[k][0] === at;
    out.push(forward ? segs[k] : reverseSeg(segs[k]));
    at = forward ? ends[k][1] : ends[k][0];
  }
  if (used.some((u) => !u)) throw new ChainError(`the curves make ${components(ends, nodes.length)} separate chains: ${what} follows one (join them end to end)`);
  const closed = free.length === 0;
  if (closed && !closedOk) throw new ChainError(`the chain closes on itself: ${what} needs an open chain of lines and arcs`);
  return { segs: out, closed };
}

/** How many connected pieces the segments (as node pairs) make. */
function components(ends: readonly (readonly [number, number])[], n: number): number {
  const parent = Array.from({ length: n }, (_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (const [i, j] of ends) parent[root(i)] = root(j);
  return new Set(ends.map(([i]) => root(i))).size;
}

// ------------------------------------------------------------ points along it

/** The unit tangent of travel along a segment, at its start or end. */
export function segTangent(s: Seg, at: "a" | "b"): Vec2 {
  if (s.kind === "line") {
    const d = sub2(s.b, s.a);
    return scale2(d, 1 / len2(d));
  }
  const angle = at === "a" ? s.start : s.start + s.sweep;
  const sign = s.sweep > 0 ? 1 : -1;
  return [-Math.sin(angle) * sign, Math.cos(angle) * sign];
}

/** The chain's length. */
export function chainLength(c: Chain): number {
  return c.segs.reduce((t, s) => t + (s.kind === "line" ? dist2(s.a, s.b) : Math.abs(s.sweep) * s.r), 0);
}

/** Do neighbouring pieces meet tangentially everywhere (a closed chain also where it closes)? */
export function chainSmooth(c: Chain, tol = 1e-6): boolean {
  const n = c.segs.length;
  const joints = c.closed ? n : n - 1;
  for (let i = 0; i < joints; i++) {
    const t1 = segTangent(c.segs[i], "b");
    const t2 = segTangent(c.segs[(i + 1) % n], "a");
    if (dot2(t1, t2) < 1 - tol) return false;
  }
  return true;
}

/** Points along the chain (arcs sampled), for drawing and measuring. */
export function chainPoints(c: Chain, maxAngleStep = Math.PI / 32): Vec2[] {
  const out: Vec2[] = [];
  for (const s of c.segs) {
    const pts = sampleSeg(s, maxAngleStep);
    out.push(...(out.length ? pts.slice(1) : pts));
  }
  return out;
}

// ------------------------------------------------------------ meeting a plane

/** A plane in the model: a point on it and its unit normal. */
export interface Plane3 {
  origin: Vec3;
  normal: Vec3;
}

/** Signed distance of a sketch point from the plane. */
function above(frame: Frame, plane: Plane3, p: Vec2): number {
  return dot3(sub3(to3D(frame, p), plane.origin), plane.normal);
}

/** Where a segment crosses the plane (the points of it at distance 0), as [point, angle on an arc]. */
function crossings(frame: Frame, plane: Plane3, s: Seg): Vec2[] {
  // In the sketch plane the distance is linear: d(p) = d0 + g·p.
  const d0 = above(frame, plane, [0, 0]);
  const g: Vec2 = [dot3(frame.x, plane.normal), dot3(frame.y, plane.normal)];
  const gl = len2(g);
  if (gl < 1e-12) return [];
  if (s.kind === "line") {
    const da = d0 + dot2(g, s.a);
    const db = d0 + dot2(g, s.b);
    if (da * db > 0 || Math.abs(da - db) < 1e-15) return [];
    const t = da / (da - db);
    return [add2(s.a, scale2(sub2(s.b, s.a), t))];
  }
  // The line d = 0 against the arc's circle.
  const u = scale2(g, 1 / gl);
  const dc = (d0 + dot2(g, s.c)) / gl; // the centre's distance from the line, along u
  if (Math.abs(dc) > s.r) return [];
  const foot = sub2(s.c, scale2(u, dc));
  const h = Math.sqrt(Math.max(0, s.r * s.r - dc * dc));
  const t: Vec2 = [-u[1], u[0]];
  const out: Vec2[] = [];
  for (const q of h < 1e-12 ? [foot] : [add2(foot, scale2(t, h)), add2(foot, scale2(t, -h))]) {
    if (onArc(s, angleOf(sub2(q, s.c)))) out.push(q);
  }
  return out;
}

function onArc(s: Extract<Seg, { kind: "arc" }>, angle: number): boolean {
  if (Math.abs(s.sweep) >= 2 * Math.PI - 1e-12) return true;
  const t = s.sweep > 0 ? wrapAngle(angle - s.start) : wrapAngle(s.start - angle);
  return t <= Math.abs(s.sweep) + 1e-12 || t >= 2 * Math.PI - 1e-12;
}

/** The segment split at a point on it: [up to it, from it]; a piece of no length is left out. */
function splitSeg(s: Seg, q: Vec2): Seg[] {
  if (s.kind === "line") {
    return [
      { ...s, b: q },
      { ...s, a: q },
    ].filter((x) => dist2(x.a, x.b) > TOL);
  }
  const full = Math.abs(s.sweep) >= 2 * Math.PI - 1e-12;
  const angle = angleOf(sub2(q, s.c));
  if (full) return [{ ...s, a: q, b: q, start: angle }];
  const part = s.sweep > 0 ? wrapAngle(angle - s.start) : -wrapAngle(s.start - angle);
  const first: Seg = { ...s, b: q, sweep: part };
  const second: Seg = { ...s, a: q, start: s.start + part, sweep: s.sweep - part };
  return [first, second].filter((x) => x.kind === "arc" && Math.abs(x.sweep) * x.r > TOL);
}

/**
 * The chain arranged to start on the plane (the sweep profile's): an open
 * chain from whichever end lies on it (reversed if it is the far end); a
 * closed chain split where it crosses the plane, nearest `near` (the
 * profile's centre). An error when it does not reach the plane, or lies in it.
 */
export function startOnPlane(c: Chain, frame: Frame, plane: Plane3, near: Vec3): Chain {
  const g: Vec2 = [dot3(frame.x, plane.normal), dot3(frame.y, plane.normal)];
  const flat = len2(g) < 1e-9;
  const first = c.segs[0].a;
  const last = c.segs[c.segs.length - 1].b;
  const dFirst = above(frame, plane, first);
  if (flat && Math.abs(dFirst) <= ON_PLANE) throw new ChainError("the path lies in the profile's plane: sketch the profile on a plane the path crosses (a plane normal to the path at its start, say)");
  if (!c.closed) {
    const dLast = above(frame, plane, last);
    if (Math.abs(dFirst) <= ON_PLANE) return c;
    if (Math.abs(dLast) <= ON_PLANE) return reverseChain(c);
    throw new ChainError(
      `the path must start on the profile's plane, but its ends are ${fmtN(Math.abs(dFirst))} mm and ${fmtN(Math.abs(dLast))} mm from it: draw the path from a point of that plane (or the profile on a plane through the path's end)`,
    );
  }
  // Closed: start at a crossing, the one nearest the profile.
  const hits: { i: number; q: Vec2 }[] = [];
  c.segs.forEach((s, i) => crossings(frame, plane, s).forEach((q) => hits.push({ i, q })));
  if (Math.abs(dFirst) <= ON_PLANE) hits.push({ i: 0, q: first });
  if (hits.length === 0) {
    const ds = chainPoints(c).map((p) => Math.abs(above(frame, plane, p)));
    throw new ChainError(`the closed path never crosses the profile's plane (it comes ${fmtN(Math.min(...ds))} mm from it at the nearest): the profile must stand across the path`);
  }
  const dist = (q: Vec2) => {
    const p = to3D(frame, q);
    return Math.hypot(p[0] - near[0], p[1] - near[1], p[2] - near[2]);
  };
  const best = hits.sort((a, b) => dist(a.q) - dist(b.q))[0];
  const s = c.segs[best.i];
  if (dist2(best.q, s.a) <= TOL) return { segs: [...c.segs.slice(best.i), ...c.segs.slice(0, best.i)], closed: true };
  if (dist2(best.q, s.b) <= TOL) return { segs: [...c.segs.slice(best.i + 1), ...c.segs.slice(0, best.i + 1)], closed: true };
  const parts = splitSeg(s, best.q);
  if (parts.length === 1) return { segs: [parts[0], ...c.segs.slice(best.i + 1), ...c.segs.slice(0, best.i)], closed: true };
  return { segs: [parts[1], ...c.segs.slice(best.i + 1), ...c.segs.slice(0, best.i), parts[0]], closed: true };
}
