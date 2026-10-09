// Revolve's 2D geometry, pure (no kernel), in sketch coordinates:
//   - which side of the axis a profile lies on (a revolve needs all of it on
//     one side: an axis through the profile would turn material into itself);
//   - the open chain of lines and arcs a thin revolve thickens;
//   - the band a thin feature turns: the chain (or each closed loop) offset
//     by the wall thickness on one side, the other or both, closed into a
//     region that profileFaces can build.
// Offsets of lines are lines and of arcs are concentric arcs, so the band is
// exact; corners are mitred (the offset curves meet where they cross) and,
// where they do not cross, bevelled with a short line.

import type { SketchEntity, Vec2 } from "../../doc/types";
import type { Loop, Region, Seg } from "../../geom/profile";
import { sampleSeg } from "../../geom/profile";
import type { THIN_SIDES } from "./doc";
import { add2, angleOf, cross2, dist2, dot2, len2, polar, scale2, sub2, wrapAngle } from "../../geom/vec";

/** Positional tolerance (mm), as the profile builder's. */
const TOL = 1e-6;

export class BandError extends Error {}

/** Which side of the profile the wall goes. */
export type ThinSide = (typeof THIN_SIDES)[number];

/** A line in the sketch plane: a point on it and its unit direction. */
export interface Line2 {
  p: Vec2;
  u: Vec2;
}

// ------------------------------------------------------------ the axis

/**
 * Where the segments lie relative to the axis: the signed distances' extremes
 * (left of the axis direction is positive). Arcs are sampled finely, plus
 * their exact extremes in the axis' normal direction.
 */
export function sideRange(segs: readonly Seg[], axis: Line2): { min: number; max: number } {
  const side = (q: Vec2) => cross2(axis.u, sub2(q, axis.p));
  let min = Infinity;
  let max = -Infinity;
  const see = (q: Vec2) => {
    const d = side(q);
    min = Math.min(min, d);
    max = Math.max(max, d);
  };
  for (const s of segs) {
    for (const q of sampleSeg(s, Math.PI / 90)) see(q);
    if (s.kind === "arc") {
      // The arc's points farthest each way across the axis, when the arc passes through them.
      const n: Vec2 = [-axis.u[1], axis.u[0]];
      for (const k of [1, -1]) {
        const at = angleOf(scale2(n, k));
        if (onArc(s, at)) see(polar(s.c, s.r, at));
      }
    }
  }
  return { min, max };
}

/** Does the arc pass through the point at this angle about its centre? */
function onArc(s: Extract<Seg, { kind: "arc" }>, angle: number): boolean {
  if (Math.abs(s.sweep) >= 2 * Math.PI - 1e-12) return true;
  const t = s.sweep > 0 ? wrapAngle(angle - s.start) : wrapAngle(s.start - angle);
  return t <= Math.abs(s.sweep) + 1e-12;
}

/** Why these segments cannot turn about the axis (the axis runs through them), or null. */
export function axisCrossing(segs: readonly Seg[], axis: Line2): string | null {
  const { min, max } = sideRange(segs, axis);
  const scale = Math.max(1, Math.abs(min), Math.abs(max));
  if (min < -TOL * scale && max > TOL * scale) return "the axis passes through the profile: a revolve needs the whole profile on one side of the axis";
  if (Math.max(Math.abs(min), Math.abs(max)) <= TOL * scale) return "the profile lies on the axis: there is nothing to turn";
  return null;
}

/** The segments of every loop of the regions. */
export function regionSegs(regions: readonly Region[]): Seg[] {
  return regions.flatMap((r) => [r.outer, ...r.holes].flatMap((l) => l.segs));
}

// ------------------------------------------------------------ open chains

/** A segment of a line or arc entity, as the profile builder makes it. */
function entitySeg(e: SketchEntity): Seg | null {
  if (e.type === "line") {
    if (dist2(e.start, e.end) <= TOL) throw new BandError(`line "${e.id}" has zero length`);
    return { kind: "line", entity: e.id, a: e.start, b: e.end };
  }
  if (e.type === "arc") {
    const r = dist2(e.start, e.center);
    if (r <= TOL || Math.abs(r - dist2(e.end, e.center)) > TOL) throw new BandError(`arc "${e.id}": its ends are not on one circle about its centre`);
    const start = angleOf(sub2(e.start, e.center));
    const end = angleOf(sub2(e.end, e.center));
    const sweep = e.clockwise ? -wrapAngle(start - end) : wrapAngle(end - start);
    return { kind: "arc", entity: e.id, c: e.center, r, a: e.start, b: e.end, start, sweep };
  }
  return null;
}

function reversed(s: Seg): Seg {
  if (s.kind === "line") return { ...s, a: s.b, b: s.a };
  return { ...s, a: s.b, b: s.a, start: s.start + s.sweep, sweep: -s.sweep };
}

/**
 * The one open chain the sketch's profile entities make (lines and arcs, not
 * construction, not `skip`), in order from one free end to the other; or
 * BandError saying what is wrong with it.
 */
export function openChain(entities: readonly SketchEntity[], skip?: string): Seg[] {
  const live = entities.filter((e) => !e.construction && e.id !== skip && e.type !== "point");
  const closed = live.find((e) => e.type === "circle" || e.type === "rect" || e.type === "slot");
  if (closed) throw new BandError(`"${closed.id}" is a closed shape: a thin feature turns one open chain of lines and arcs, or closed profiles only`);
  const segs = live.map(entitySeg).filter((s): s is Seg => s !== null);
  if (segs.length === 0) throw new BandError("the sketch has no lines or arcs to thicken (construction lines do not count)");
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
  if (branch >= 0) throw new BandError(`three or more entities meet at [${fmt(nodes[branch])}]: a thin feature thickens one chain without branches`);
  const free = degree.flatMap((d, n) => (d === 1 ? [n] : []));
  if (free.length === 0) throw new BandError("the chain closes on itself: for a closed profile the thin feature thickens its loops (it should have built as a profile)");
  if (free.length > 2) throw new BandError(`the lines and arcs make ${free.length / 2} separate chains: a thin feature thickens one`);
  // Walk from the free end with the lowest coordinates, so the chain's direction does not depend on drawing order.
  const startNode = free.sort((m, n) => nodes[m][0] - nodes[n][0] || nodes[m][1] - nodes[n][1])[0];
  const used = new Array(segs.length).fill(false);
  const out: Seg[] = [];
  let at = startNode;
  for (;;) {
    const k = ends.findIndex(([i, j], s) => !used[s] && (i === at || j === at));
    if (k < 0) break;
    used[k] = true;
    const forward = ends[k][0] === at;
    out.push(forward ? segs[k] : reversed(segs[k]));
    at = forward ? ends[k][1] : ends[k][0];
  }
  return out;
}

// ------------------------------------------------------------ offsets

/** The left normal of travel along a segment at its start or end. */
function leftNormal(s: Seg, at: "a" | "b"): Vec2 {
  if (s.kind === "line") {
    const d = sub2(s.b, s.a);
    const l = len2(d);
    return [-d[1] / l, d[0] / l];
  }
  // On an arc, travel turns toward the centre when counter-clockwise: left is inward.
  const p = at === "a" ? s.a : s.b;
  const out = scale2(sub2(p, s.c), 1 / s.r);
  return s.sweep > 0 ? scale2(out, -1) : out;
}

/** The segment moved `d` to the left of its travel (a concentric arc for an arc). */
function offsetSeg(s: Seg, d: number): Seg {
  if (s.kind === "line") {
    const n = leftNormal(s, "a");
    return { ...s, a: add2(s.a, scale2(n, d)), b: add2(s.b, scale2(n, d)) };
  }
  const r = s.sweep > 0 ? s.r - d : s.r + d;
  if (r <= TOL) throw new BandError(`the wall is thicker than arc "${s.entity}"'s radius (${fmtN(s.r)} mm): make it thinner, or put it on the other side`);
  return { ...s, r, a: polar(s.c, r, s.start), b: polar(s.c, r, s.start + s.sweep) };
}

/** Where the curves under two segments cross (lines endless, arcs as whole circles). */
function crossings(p: Seg, q: Seg): Vec2[] {
  if (p.kind === "line" && q.kind === "line") {
    const u = sub2(p.b, p.a);
    const v = sub2(q.b, q.a);
    const den = cross2(u, v);
    if (Math.abs(den) <= 1e-12 * len2(u) * len2(v)) return [];
    const t = cross2(sub2(q.a, p.a), v) / den;
    return [add2(p.a, scale2(u, t))];
  }
  if (p.kind === "arc" && q.kind === "arc") {
    const d = dist2(p.c, q.c);
    if (d <= TOL || d > p.r + q.r || d < Math.abs(p.r - q.r)) return [];
    const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, p.r * p.r - a * a));
    const u = scale2(sub2(q.c, p.c), 1 / d);
    const m = add2(p.c, scale2(u, a));
    return [add2(m, scale2([-u[1], u[0]], h)), add2(m, scale2([u[1], -u[0]], h))];
  }
  const [line, arc] = p.kind === "line" ? [p, q as Extract<Seg, { kind: "arc" }>] : [q as Extract<Seg, { kind: "line" }>, p];
  const u = sub2(line.b, line.a);
  const l = len2(u);
  const e = scale2(u, 1 / l);
  const t0 = dot2(sub2(arc.c, line.a), e);
  const foot = add2(line.a, scale2(e, t0));
  const h2 = arc.r * arc.r - dist2(foot, arc.c) ** 2;
  if (h2 < 0) return [];
  const h = Math.sqrt(h2);
  return [add2(foot, scale2(e, h)), add2(foot, scale2(e, -h))];
}

/** The segment with its end (or start) moved to `p`, which lies on its curve. */
function trimmed(s: Seg, which: "a" | "b", p: Vec2): Seg {
  if (s.kind === "line") {
    const next = which === "a" ? { ...s, a: p } : { ...s, b: p };
    if (dot2(sub2(next.b, next.a), sub2(s.b, s.a)) <= 0) throw new BandError(`the wall is thicker than "${s.entity}" is long: make it thinner`);
    return next;
  }
  const angle = angleOf(sub2(p, s.c));
  const half = (x: number) => wrapAngle(x + Math.PI) - Math.PI; // to (-π, π]
  if (which === "b") {
    const sweep = s.sweep + half(angle - (s.start + s.sweep));
    if (sweep * s.sweep <= 0) throw new BandError(`the wall is thicker than arc "${s.entity}" is long: make it thinner`);
    return { ...s, b: p, sweep };
  }
  const delta = half(angle - s.start);
  const sweep = s.sweep - delta;
  if (sweep * s.sweep <= 0) throw new BandError(`the wall is thicker than arc "${s.entity}" is long: make it thinner`);
  return { ...s, a: p, start: s.start + delta, sweep };
}

/**
 * The chain moved `d` to the left of its travel, its pieces joined again
 * (mitred where the offset curves cross near the corner, else bevelled).
 * `closed`: the last piece joins the first too.
 */
export function offsetChain(chain: readonly Seg[], d: number, closed: boolean): Seg[] {
  if (Math.abs(d) <= 0) return [...chain];
  const segs = chain.map((s) => offsetSeg(s, d));
  const out: Seg[] = [];
  const joints = closed ? segs.length : segs.length - 1;
  // Join i with i+1 (mod n): trim both to where they cross, nearest the original corner.
  const extra = new Map<number, Seg>();
  for (let i = 0; i < joints; i++) {
    const j = (i + 1) % segs.length;
    const p = segs[i];
    const q = segs[j];
    if (dist2(p.b, q.a) <= TOL) continue;
    const corner = chain[i].b;
    const hits = crossings(p, q).sort((x, y) => dist2(x, corner) - dist2(y, corner));
    const hit = hits.find((x) => dist2(x, corner) <= 4 * Math.abs(d) + TOL);
    if (hit) {
      segs[i] = trimmed(segs[i], "b", hit);
      segs[j] = trimmed(segs[j], "a", hit);
    } else {
      extra.set(i, { kind: "line", entity: chain[i].entity, a: segs[i].b, b: segs[j].a });
    }
  }
  segs.forEach((s, i) => {
    out.push(s);
    const e = extra.get(i);
    if (e) out.push(e);
  });
  return out;
}

/** Green's theorem contribution of a segment: ½∮(x dy − y dx). */
function segArea(s: Seg): number {
  if (s.kind === "line") return 0.5 * cross2(s.a, s.b);
  const { c, r, a, b, sweep } = s;
  return 0.5 * (r * r * sweep + c[0] * (b[1] - a[1]) - c[1] * (b[0] - a[0]));
}

function loopOf(segs: Seg[]): Loop {
  return { segs, area: segs.reduce((t, s) => t + segArea(s), 0) };
}

function ccw(loop: Loop): Loop {
  return loop.area >= 0 ? loop : { segs: loop.segs.map(reversed).reverse(), area: -loop.area };
}

/** The two offsets (to the left of travel) bounding the wall, for a side; `away` is +1 when "outside" is to the left. */
export function wallOffsets(thickness: number, side: ThinSide, away: 1 | -1): [number, number] {
  if (side === "mid") return [-thickness / 2, thickness / 2];
  return side === "outside" ? [0, away * thickness] : [0, -away * thickness];
}

/**
 * Which way is "outside" for an open chain turned about an axis: away from
 * the axis (+1: to the left of the chain's travel). A chain square to the
 * axis (a flat washer) is as near on both sides: then outside is the way the
 * axis points.
 */
export function awayFromAxis(chain: readonly Seg[], axis: Line2): 1 | -1 {
  let radial = 0;
  let along = 0;
  for (const s of chain) {
    const pts = sampleSeg(s, Math.PI / 32);
    for (let k = 1; k < pts.length; k++) {
      const m = scale2(add2(pts[k - 1], pts[k]), 0.5);
      const t = sub2(pts[k], pts[k - 1]);
      const l = len2(t);
      if (l <= 0) continue;
      const n: Vec2 = [-t[1] / l, t[0] / l];
      const rel = sub2(m, axis.p);
      const perp = sub2(rel, scale2(axis.u, dot2(rel, axis.u)));
      const pl = len2(perp);
      if (pl > TOL) radial += dot2(n, scale2(perp, 1 / pl)) * l;
      along += dot2(n, axis.u) * l;
    }
  }
  const total = chain.reduce((t, s) => t + (s.kind === "line" ? dist2(s.a, s.b) : Math.abs(s.sweep) * s.r), 0);
  if (Math.abs(radial) > 1e-9 * Math.max(1, total)) return radial > 0 ? 1 : -1;
  return along >= 0 ? 1 : -1;
}

/** The band around an open chain between two offsets: one region, counter-clockwise. */
export function openBand(chain: readonly Seg[], d1: number, d2: number): Region {
  const p = offsetChain(chain, d1, false);
  const q = offsetChain(chain, d2, false);
  const back = p.map(reversed).reverse();
  const segs: Seg[] = [
    ...q,
    { kind: "line", entity: chain[chain.length - 1].entity, a: q[q.length - 1].b, b: back[0].a },
    ...back,
    { kind: "line", entity: chain[0].entity, a: back[back.length - 1].b, b: q[0].a },
  ];
  return { outer: ccw(loopOf(segs)), holes: [] };
}

/**
 * The ring a closed loop's wall makes between two offsets, as a region:
 * outer loop counter-clockwise, the inner one a clockwise hole. "outside"
 * for a loop is away from what it encloses.
 */
export function closedBand(loop: Loop, thickness: number, side: ThinSide): Region {
  const away: 1 | -1 = loop.area >= 0 ? -1 : 1;
  const [d1, d2] = wallOffsets(thickness, side, away);
  const a = loopOf(offsetChain(loop.segs, d1, true));
  const b = loopOf(offsetChain(loop.segs, d2, true));
  if (a.area * loop.area <= 0 || b.area * loop.area <= 0) throw new BandError(`the wall is too thick for the loop through "${loop.segs[0].entity}": nothing is left inside it`);
  const [outer, inner] = Math.abs(a.area) >= Math.abs(b.area) ? [a, b] : [b, a];
  const hole = ccw(inner);
  return { outer: ccw(outer), holes: [{ segs: hole.segs.map(reversed).reverse(), area: -hole.area }] };
}

/** Every loop of the regions, each made a thin ring. */
export function closedBands(regions: readonly Region[], thickness: number, side: ThinSide): Region[] {
  return regions.flatMap((r) => [r.outer, ...r.holes].map((l) => closedBand(l, thickness, side)));
}

/** The area the regions enclose (outer minus holes). */
export function regionsArea(regions: readonly Region[]): number {
  return regions.reduce((t, r) => t + r.outer.area + r.holes.reduce((h, l) => h + l.area, 0), 0);
}

function fmtN(x: number): string {
  return String(Math.round(x * 1e4) / 1e4);
}

function fmt(p: Vec2): string {
  return `${fmtN(p[0])}, ${fmtN(p[1])}`;
}
