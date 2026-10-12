// Sketch entities -> closed profile loops -> regions (outer loop + holes).
//
// Pure 2D, no kernel. Loops must be simple and must not touch each other;
// nesting is decided by winding number, so a loop inside a loop is a hole and
// a loop inside that hole is an island again.

import type { SketchEntity, Vec2 } from "../doc/types";
import { closestOnEllipse, closestOnSpline, ellipseGeom, ellipsePoint, ellipseSpan, splineOf } from "./curves";
import { bezierArea, bezierLength, reverseSpline, sampleBezier, SplineError, type SplineCurve } from "./spline";
import { add2, angleOf, cross2, dist2, dot2, len2, polar, scale2, sub2, wrapAngle } from "./vec";

/** Positional tolerance in document units (mm). */
export const TOL = 1e-6;

export type Seg =
  | { kind: "line"; entity: string; a: Vec2; b: Vec2 }
  /** sweep > 0 is counter-clockwise. A full circle has |sweep| = 2π and a == b. */
  | { kind: "arc"; entity: string; c: Vec2; r: number; a: Vec2; b: Vec2; start: number; sweep: number }
  /**
   * An ellipse or part of one: the point at parameter t is c + rx·cos t·u + ry·sin t·v (v is u turned a
   * quarter left); it runs from parameter `start` through `sweep` (> 0 counter-clockwise). Whole: |sweep| = 2π.
   */
  | { kind: "ellipse"; entity: string; c: Vec2; u: Vec2; rx: number; ry: number; a: Vec2; b: Vec2; start: number; sweep: number }
  /** A spline through points (spline.ts), run from a to b; closed when a == b. */
  | { kind: "spline"; entity: string; a: Vec2; b: Vec2; curve: SplineCurve };

export type EllipseSeg = Extract<Seg, { kind: "ellipse" }>;
export type SplineSeg = Extract<Seg, { kind: "spline" }>;

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
    // Construction geometry never makes a profile; nor does a reference to the model, unless converted (construction: false).
    const live = entities.filter((e) => !(e.construction ?? !!e.ref));
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
        case "ellipse": {
          const s = ellipseSeg(e);
          if (Math.abs(s.sweep) >= 2 * Math.PI - 1e-12) loops.push(makeLoop([s]));
          else open.push(s);
          break;
        }
        case "spline": {
          const s = splineSeg(e);
          if (e.closed) loops.push(makeLoop([s]));
          else open.push(s);
          break;
        }
      }
    }
    loops.push(...chain(open));
    checkIntersections(loops);
    const regions = nest(loops);
    const area = regions.reduce((s, r) => s + r.outer.area + r.holes.reduce((h, l) => h + l.area, 0), 0);
    return { ok: true, regions, area };
  } catch (e) {
    if (e instanceof ProfileError || e instanceof SplineError) return { ok: false, error: e.message };
    throw e;
  }
}

class ProfileError extends Error {}

/** An ellipse entity's segment: the whole ellipse from its major end, or the arc from start to end (counter-clockwise). */
export function ellipseSeg(e: Extract<SketchEntity, { type: "ellipse" }>): EllipseSeg {
  const g = ellipseGeom(e);
  if (!(g.a > TOL) || !(g.b > TOL)) throw new ProfileError(`ellipse "${e.id}" has a zero radius`);
  const { start, sweep } = ellipseSpan(e);
  return { kind: "ellipse", entity: e.id, c: g.c, u: g.u, rx: g.a, ry: g.b, a: ellipsePoint(g, start), b: ellipsePoint(g, start + sweep), start, sweep };
}

/** A spline entity's segment, from its first point (to its last, or round to its first when closed). */
export function splineSeg(e: Extract<SketchEntity, { type: "spline" }>): SplineSeg {
  let curve: SplineCurve;
  try {
    curve = splineOf(e);
  } catch (err) {
    throw new ProfileError(`spline "${e.id}": ${(err as Error).message}`);
  }
  const spans = curve.spans;
  return { kind: "spline", entity: e.id, a: spans[0][0], b: spans[spans.length - 1][3], curve };
}

/** The point of an ellipse segment at parameter t. */
export function ellipseSegPoint(s: EllipseSeg, t: number): Vec2 {
  return ellipsePoint({ c: s.c, u: s.u, v: [-s.u[1], s.u[0]], a: s.rx, b: s.ry }, t);
}

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

/** The same segment run the other way. */
export function reverseSeg(s: Seg): Seg {
  if (s.kind === "line") return { ...s, a: s.b, b: s.a };
  if (s.kind === "spline") return { ...s, a: s.b, b: s.a, curve: reverseSpline(s.curve) };
  return { ...s, a: s.b, b: s.a, start: s.start + s.sweep, sweep: -s.sweep };
}

function makeLoop(segs: Seg[]): Loop {
  return { segs, area: segs.reduce((sum, s) => sum + segArea(s), 0) };
}

/**
 * Green's theorem contribution: ½∮(x dy − y dx). Exact for every kind: an
 * ellipse's is ½(rx·ry·sweep + c × (b − a)) (the arc's with r² → rx·ry), a
 * spline's the sum over its cubic pieces, integrated exactly.
 */
export function segArea(s: Seg): number {
  if (s.kind === "line") return 0.5 * cross2(s.a, s.b);
  if (s.kind === "spline") return s.curve.spans.reduce((t, b) => t + bezierArea(b), 0);
  const { c, a, b, sweep } = s;
  const r2 = s.kind === "arc" ? s.r * s.r : s.rx * s.ry;
  return 0.5 * (r2 * sweep + c[0] * (b[1] - a[1]) - c[1] * (b[0] - a[0]));
}

export function reverseLoop(loop: Loop): Loop {
  return { segs: loop.segs.map(reverseSeg).reverse(), area: -loop.area };
}

// --------------------------------------------------------- intersections

function checkIntersections(loops: Loop[]): void {
  const all = loops.flatMap((loop, li) => loop.segs.map((seg, si) => ({ seg, li, si, n: loop.segs.length })));
  // A spline may loop over itself.
  for (const { seg } of all) {
    if (seg.kind !== "spline") continue;
    const hit = selfHits(segPolyline(seg), seg.curve.closed);
    if (hit.length) throw new ProfileError(`"${seg.entity}" crosses itself at ${fmtPt(hit[0])}; profiles must not cross or touch (move its points so it doesn't loop)`);
  }
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

/**
 * Where two segments meet. Lines, arcs and circles exactly; a line and an
 * ellipse exactly (a quadratic in the ellipse's own frame); anything else with
 * an ellipse or a spline along fine polylines of the curves (a few
 * micrometres off at most, for the messages; whether they meet is what
 * matters).
 */
export function intersect(A: Seg, B: Seg): Vec2[] | "overlap" {
  if (A.kind === "line" && B.kind === "ellipse") return lineEllipse(A.a, A.b, B);
  if (A.kind === "ellipse" && B.kind === "line") return lineEllipse(B.a, B.b, A);
  if (A.kind === "ellipse" || A.kind === "spline" || B.kind === "ellipse" || B.kind === "spline") return polylineHits(segPolyline(A), segPolyline(B));
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

/** A line segment and an ellipse (or part of one): in the ellipse's frame scaled to a unit circle it is a line and a circle. */
function lineEllipse(a: Vec2, b: Vec2, e: EllipseSeg): Vec2[] {
  const v: Vec2 = [-e.u[1], e.u[0]];
  const local = (p: Vec2): Vec2 => {
    const d = sub2(p, e.c);
    return [dot2(d, e.u) / e.rx, dot2(d, v) / e.ry];
  };
  const pa = local(a);
  const pb = local(b);
  const d = sub2(pb, pa);
  const A = dot2(d, d);
  const B = 2 * dot2(pa, d);
  const C = dot2(pa, pa) - 1;
  const disc = B * B - 4 * A * C;
  // Tolerances in mm, measured back in the sketch: the smaller radius scales the unit circle's.
  const scale = Math.min(e.rx, e.ry);
  const along = dist2(a, b);
  const ts: number[] = [];
  const foot = -B / (2 * A);
  const footDist = len2(add2(pa, scale2(d, foot)));
  if (Math.abs(footDist - 1) * scale <= TOL) ts.push(foot);
  else if (disc > 0) {
    const r = Math.sqrt(disc);
    ts.push((-B - r) / (2 * A), (-B + r) / (2 * A));
  }
  const eps = TOL / along;
  const full = Math.abs(e.sweep) >= 2 * Math.PI - 1e-12;
  return ts
    .filter((t) => t >= -eps && t <= 1 + eps)
    .map((t) => add2(a, scale2(sub2(b, a), t)))
    .filter((p) => full || onEllipseArc(e, p));
}

/** Whether a point of an ellipse lies on the part a segment covers. */
function onEllipseArc(s: EllipseSeg, p: Vec2): boolean {
  const v: Vec2 = [-s.u[1], s.u[0]];
  const d = sub2(p, s.c);
  const t = Math.atan2(dot2(d, v) / s.ry, dot2(d, s.u) / s.rx);
  const tolAngle = TOL / Math.min(s.rx, s.ry);
  const k = s.sweep > 0 ? wrapAngle(t - s.start) : wrapAngle(s.start - t);
  return k <= Math.abs(s.sweep) + tolAngle || k >= 2 * Math.PI - tolAngle;
}

/** A fine polyline along a segment (ends exact), for intersections and winding numbers. */
export function segPolyline(s: Seg): Vec2[] {
  if (s.kind === "line") return [s.a, s.b];
  if (s.kind === "spline") {
    const out: Vec2[] = [];
    s.curve.spans.forEach((b, i) => {
      const pts = sampleBezier(b, Infinity, 48);
      out.push(...(i === 0 ? pts : pts.slice(1)));
    });
    out[0] = s.a;
    out[out.length - 1] = s.b;
    return out;
  }
  const n = Math.max(16, Math.ceil(Math.abs(s.sweep) / (Math.PI / 180)));
  const at = (i: number): Vec2 => (s.kind === "arc" ? polar(s.c, s.r, s.start + (s.sweep * i) / n) : ellipseSegPoint(s, s.start + (s.sweep * i) / n));
  const out = Array.from({ length: n + 1 }, (_, i) => at(i));
  out[0] = s.a;
  out[n] = s.b;
  return out;
}

/** Where two polylines cross or touch (each point once), or "overlap" where pieces run along each other. */
function polylineHits(P: Vec2[], Q: Vec2[]): Vec2[] | "overlap" {
  const out: Vec2[] = [];
  const boxQ = Q.slice(1).map((q, j) => box(Q[j], q));
  for (let i = 0; i + 1 < P.length; i++) {
    const bp = box(P[i], P[i + 1]);
    for (let j = 0; j + 1 < Q.length; j++) {
      const bq = boxQ[j];
      if (bp[0] > bq[2] + TOL || bq[0] > bp[2] + TOL || bp[1] > bq[3] + TOL || bq[1] > bp[3] + TOL) continue;
      const hit = lineLine(P[i], P[i + 1], Q[j], Q[j + 1]);
      if (hit === "overlap") return "overlap";
      for (const p of hit) if (!out.some((q) => dist2(p, q) <= 10 * TOL)) out.push(p);
    }
  }
  return out;
}

/** Where a polyline crosses itself: pieces that are not neighbours (a closed one's last and first are). */
function selfHits(P: Vec2[], closed: boolean): Vec2[] {
  const out: Vec2[] = [];
  const n = P.length - 1;
  for (let i = 0; i < n; i++) {
    const bi = box(P[i], P[i + 1]);
    for (let j = i + 2; j < n; j++) {
      if (closed && i === 0 && j === n - 1) continue;
      const bj = box(P[j], P[j + 1]);
      if (bi[0] > bj[2] + TOL || bj[0] > bi[2] + TOL || bi[1] > bj[3] + TOL || bj[1] > bi[3] + TOL) continue;
      const hit = lineLine(P[i], P[i + 1], P[j], P[j + 1]);
      if (hit === "overlap") return [P[j]];
      out.push(...hit);
    }
  }
  return out;
}

function box(a: Vec2, b: Vec2): [number, number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
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
    if (s.kind === "ellipse" || s.kind === "spline") {
      // Along a fine polyline: exact unless p is closer to the curve than the polyline's sag (well under a micrometre).
      const pts = segPolyline(s);
      for (let i = 0; i + 1 < pts.length; i++) {
        const va = sub2(pts[i], p);
        const vb = sub2(pts[i + 1], p);
        total += Math.atan2(cross2(va, vb), dot2(va, vb));
      }
      continue;
    }
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

/** The segment moved by v. */
export function translateSeg(s: Seg, v: Vec2): Seg {
  const m = (p: Vec2) => add2(p, v);
  if (s.kind === "line") return { ...s, a: m(s.a), b: m(s.b) };
  if (s.kind === "spline") {
    const c = s.curve;
    return { ...s, a: m(s.a), b: m(s.b), curve: { ...c, points: c.points.map(m), spans: c.spans.map((b) => b.map(m) as typeof b) } };
  }
  return { ...s, c: m(s.c), a: m(s.a), b: m(s.b) };
}

/** How far p is from the segment (exact for every kind; an ellipse's and a spline's by their nearest point). */
export function distanceToSeg(s: Seg, p: Vec2): number {
  if (s.kind === "line") {
    const d = sub2(s.b, s.a);
    const l2 = dot2(d, d);
    const t = Math.max(0, Math.min(1, dot2(sub2(p, s.a), d) / l2));
    return dist2(add2(s.a, scale2(d, t)), p);
  }
  if (s.kind === "spline") return closestOnSpline(s.curve, p).distance;
  if (s.kind === "arc") {
    if (onArc(s, polar(s.c, s.r, angleOf(sub2(p, s.c))))) return Math.abs(dist2(p, s.c) - s.r);
    return Math.min(dist2(p, s.a), dist2(p, s.b));
  }
  const g = { c: s.c, u: s.u, v: [-s.u[1], s.u[0]] as Vec2, a: s.rx, b: s.ry };
  const near = closestOnEllipse(g, p);
  if (onEllipseArc(s, near.at)) return near.distance;
  return Math.min(dist2(p, s.a), dist2(p, s.b));
}

/** A segment's length (an ellipse's and a spline's by quadrature, to well under a micrometre). */
export function segLength(s: Seg): number {
  if (s.kind === "line") return dist2(s.a, s.b);
  if (s.kind === "arc") return Math.abs(s.sweep) * s.r;
  if (s.kind === "spline") return s.curve.spans.reduce((t, b) => t + bezierLength(b), 0);
  let total = 0;
  const parts = Math.max(16, Math.ceil(Math.abs(s.sweep) / (Math.PI / 32)));
  const g = [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)];
  const w = [5 / 9, 8 / 9, 5 / 9];
  const h = s.sweep / parts;
  for (let k = 0; k < parts; k++) {
    g.forEach((x, i) => {
      const t = s.start + h * (k + (x + 1) / 2);
      total += (w[i] * Math.abs(h) * Math.hypot(s.rx * Math.sin(t), s.ry * Math.cos(t))) / 2;
    });
  }
  return total;
}

/** The unit tangent of travel along a segment at its start (a) or end (b). */
export function segTangent(s: Seg, at: "a" | "b"): Vec2 {
  if (s.kind === "line") {
    const d = sub2(s.b, s.a);
    return scale2(d, 1 / len2(d));
  }
  if (s.kind === "spline") {
    const d = at === "a" ? s.curve.derivs[0] : s.curve.derivs[s.curve.derivs.length - 1];
    return scale2(d, 1 / len2(d));
  }
  const angle = at === "a" ? s.start : s.start + s.sweep;
  const sign = s.sweep > 0 ? 1 : -1;
  if (s.kind === "arc") return [-Math.sin(angle) * sign, Math.cos(angle) * sign];
  const v: Vec2 = [-s.u[1], s.u[0]];
  const d = add2(scale2(s.u, -s.rx * Math.sin(angle) * sign), scale2(v, s.ry * Math.cos(angle) * sign));
  return scale2(d, 1 / len2(d));
}

/** Point at the middle of an arc, used for three-point arc construction. */
export function arcMid(s: ArcSeg): Vec2 {
  return polar(s.c, s.r, s.start + s.sweep / 2);
}

/** Polyline approximation of a segment, for display only. */
export function sampleSeg(s: Seg, maxAngleStep = Math.PI / 32): Vec2[] {
  if (s.kind === "line") return [s.a, s.b];
  if (s.kind === "spline") {
    // A piece turns through well under a right angle at sketch spacing: a quarter turn's worth of steps per piece.
    const steps = Math.max(8, Math.ceil(Math.PI / 2 / maxAngleStep));
    const out: Vec2[] = [];
    s.curve.spans.forEach((b, i) => {
      const pts = sampleBezier(b, Infinity, steps);
      out.push(...(i === 0 ? pts : pts.slice(1)));
    });
    return out;
  }
  const n = Math.max(2, Math.ceil(Math.abs(s.sweep) / maxAngleStep));
  if (s.kind === "ellipse") return Array.from({ length: n + 1 }, (_, i) => ellipseSegPoint(s, s.start + (s.sweep * i) / n));
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
      case "ellipse":
        segs = [ellipseSeg(e)];
        break;
      case "spline":
        segs = [splineSeg(e)];
        break;
    }
    return segs.map((s) => sampleSeg(s, maxAngleStep));
  } catch {
    return [];
  }
}
