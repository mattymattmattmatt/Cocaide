// Where a pattern's copies go: one transform per instance, numbered the way
// the document numbers them (1 is the original, which is never copied), less
// the instances the pattern skips. A linear pattern's direction and a
// circular pattern's axis may be references to the model (an edge, an axis,
// a face), resolved on the part as it stands at the pattern.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { CircularPatternFeature, DatumRef, FaceSelector, LinearPatternFeature, Vec2, Vec3 } from "../doc/types";
import type { RebuildCtx } from "../features/kernelDefs";
import { boxFootprint, edgePolyline, roundFootprint } from "../features/fillPattern/layout";
import { facePlaneFrame, to2D, to3D, type Frame } from "../geom/frame";
import { sampleSeg } from "../geom/profile";
import { add3, cross3, dot3, formatDirection, normalize3, roundTo, scale3, sub3 } from "../geom/vec";
import { resolveDatum, nameOf, type DatumContext } from "./datum";
import { boundingBoxOf } from "./measure";
import { type OC, type Scope } from "./oc";
import { dir, identity, OpError, pnt, transformed, vec, type Trsf } from "./ops";
import { edgeLength, traveller, type PathShape } from "./paths";
import type { Seed } from "./rebuild";
import { selectFaces, selectionError } from "./selectors";

/** One copy of a pattern: its instance number, a label for messages, and its transform. */
export interface PatternInstance {
  n: number;
  label: string;
  trsf: Trsf;
}

/** A linear pattern's direction as a unit vector: written out, or an edge's or axis's direction, a face's or plane's normal; reversed with `reverse`. */
export function lineDirection(ctx: DatumContext, written: Vec3 | undefined, ref: DatumRef | undefined, reverse: boolean | undefined, path: string): Vec3 {
  let d: Vec3;
  if (ref) {
    const got = resolveDatum(ctx, ref, "any", path);
    if (got.kind === "point") throw new OpError(`${path}: ${nameOf(ref)} is a point; a direction needs a straight edge, an axis or a flat face (its normal)`);
    d = got.kind === "axis" ? got.direction : got.normal;
  } else d = written!;
  d = normalize3(d);
  return reverse ? scale3(d, -1) : d;
}

/** A circular pattern's axis: written out, or an edge, an axis feature or a cylindrical face. */
export function patternAxis(ctx: DatumContext, f: CircularPatternFeature): { origin: Vec3; direction: Vec3 } {
  if ("ref" in f.axis) {
    const a = resolveDatum(ctx, f.axis.ref, "axis", "axis.ref");
    return { origin: a.origin, direction: normalize3(a.direction) };
  }
  return { origin: f.axis.origin, direction: normalize3(f.axis.direction) };
}

/**
 * The copies a linear or circular pattern makes, in instance order. Linear:
 * instance 1 + i + j * count is i steps along the first direction and j
 * along the second. Circular: instance k is k - 1 steps round the axis.
 */
export function patternInstances(oc: OC, s: Scope, ctx: DatumContext, f: LinearPatternFeature | CircularPatternFeature): PatternInstance[] {
  const skip = new Set(f.skip ?? []);
  const instances: PatternInstance[] = [];
  if (f.op === "linearPattern") {
    const d1 = lineDirection(ctx, f.direction, f.along, f.reverse, "along");
    const two = f.count2 !== undefined;
    const d2 = two ? lineDirection(ctx, f.direction2, f.along2, f.reverse2, "along2") : ([0, 0, 0] as Vec3);
    if (two && Math.abs(d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) > 1 - 1e-9) {
      throw new OpError(`the second direction ${formatDirection(d2)} is parallel to the first: a grid needs two different directions`);
    }
    const n2 = f.count2 ?? 1;
    for (let j = 0; j < n2; j++) {
      for (let i = 0; i < f.count; i++) {
        const n = 1 + i + j * f.count;
        if (n === 1 || skip.has(n)) continue;
        const offset = add3(scale3(d1, i * f.spacing), scale3(d2, j * (f.spacing2 ?? 0)));
        const t = identity(oc, s);
        t.SetTranslation(vec(oc, s, offset));
        instances.push({ n, label: `instance ${n}${n2 > 1 ? ` [${i + 1}, ${j + 1}]` : ""} (offset ${fmt3(offset)})`, trsf: t });
      }
    }
    return instances;
  }
  const total = f.angle ?? 360;
  const step = (total >= 360 ? total / f.count : total / (f.count - 1)) * (f.reverse ? -1 : 1);
  const a = patternAxis(ctx, f);
  const axis = s.track(new oc.gp_Ax1(pnt(oc, s, a.origin), dir(oc, s, a.direction)));
  for (let k = 1; k < f.count; k++) {
    if (skip.has(k + 1)) continue;
    const t = identity(oc, s);
    t.SetRotation(axis, (k * step * Math.PI) / 180);
    instances.push({ n: k + 1, label: `instance ${k + 1} (${roundTo(k * step, 4)} deg)`, trsf: t });
  }
  return instances;
}

/** Copies moved by these offsets, numbered 2, 3, ... in order (a sketch-driven pattern), less the skipped. */
export function offsetInstances(oc: OC, s: Scope, offsets: { offset: Vec3; label: string }[], skip: readonly number[] = []): PatternInstance[] {
  const out: PatternInstance[] = [];
  offsets.forEach((o, i) => {
    const n = i + 2;
    if (skip.includes(n)) return;
    const t = identity(oc, s);
    t.SetTranslation(vec(oc, s, o.offset));
    out.push({ n, label: `instance ${n} ${o.label}`, trsf: t });
  });
  return out;
}

function fmt3(v: Vec3): string {
  return `[${v.map((x) => roundTo(x, 4)).join(", ")}]`;
}

// ---------------------------------------------------------------- table, curve and fill patterns (Phase P)

/** A pattern op's seeds and the tools they left, or OpError naming the one that is missing. */
export function seedsOf(ctx: RebuildCtx, ids: readonly string[]): [string, Seed][] {
  return ids.map((id) => {
    const seed = ctx.seed(id);
    if (!seed) throw new OpError(`${ctx.missing(id, "feature")}, so there is nothing to repeat`);
    return [id, seed];
  });
}

/**
 * Each seed repeated over the instances (each onto the bodies as the seeds
 * before it left them), committed; a hole copied this way is one callout
 * with a count.
 */
export function repeatSeeds(ctx: RebuildCtx, s: Scope, seeds: [string, Seed][], instances: PatternInstance[]): void {
  if (ctx.bodies.size === 0) throw new OpError("nothing to pattern onto: there is no solid before this feature");
  if (instances.length === 0) throw new OpError("there are no copies to make: every place is skipped, or none fits");
  const changed = new Map<string, TopoDS_Shape>();
  for (const [id, seed] of seeds) {
    const mine = seeds.length > 1 ? instances.map((i) => ({ ...i, label: `${id}: ${i.label}` })) : instances;
    ctx.repeat(s, mine, seed, (k) => `${seed.newBody}_${mine[k].n}`, "pattern", changed);
  }
  ctx.commit(changed);
  for (const [id] of seeds) for (const h of ctx.holes.ofFeature(id)) h.copies += instances.length;
}

/** Copies moved in a plane (frame) from `from` to each of `places` (2D), numbered 2, 3 ... less the skipped. */
export function planeInstances(oc: OC, s: Scope, frame: Frame, from: Vec2, places: readonly Vec2[], skip: readonly number[] = []): PatternInstance[] {
  const origin = to3D(frame, from);
  return offsetInstances(
    oc,
    s,
    places.map((p) => ({ offset: sub3(to3D(frame, p), origin), label: `at [${p.map((x) => roundTo(x, 4)).join(", ")}]` })),
    skip,
  );
}

/** A point along a path and its unit tangent (the way the path runs). */
export interface PathPlace {
  p: Vec3;
  t: Vec3;
}

/**
 * The points of a path at these distances along it (each from 0 to its
 * length): exact on lines and circles (their parameter runs with their
 * length), found from a fine table of length on other curves.
 */
export function pathPlaces(oc: OC, s: Scope, path: PathShape, distances: readonly number[]): PathPlace[] {
  const edges = path.edges.map((e) => {
    const go = traveller(oc, s, e);
    const length = edgeLength(oc, s, e);
    const type = s.track(new oc.BRepAdaptor_Curve(e)).GetType();
    const exact = type === oc.GeomAbs_CurveType.GeomAbs_Line || type === oc.GeomAbs_CurveType.GeomAbs_Circle;
    let table: number[] | null = null;
    if (!exact) {
      const N = 400;
      table = [0];
      let prev = go(0).p;
      for (let k = 1; k <= N; k++) {
        const q = go(k / N).p;
        table.push(table[k - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]));
        prev = q;
      }
    }
    return { go, length, table };
  });
  return distances.map((d) => {
    let left = d;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (left > e.length + 1e-9 && i < edges.length - 1) {
        left -= e.length;
        continue;
      }
      const at = Math.max(0, Math.min(e.length, left));
      if (!e.table) return e.go(e.length > 0 ? at / e.length : 0);
      const want = (at / e.length) * e.table[e.table.length - 1];
      const k = Math.max(1, e.table.findIndex((x) => x >= want));
      const a = e.table[k - 1];
      const b = e.table[k];
      const u = (k - 1 + (b > a ? (want - a) / (b - a) : 0)) / (e.table.length - 1);
      return e.go(Math.min(1, u));
    }
    return { p: path.end, t: path.endTangent };
  });
}

/** The signed angle (radians) from a to b about the unit normal n. */
function angleAbout(a: Vec3, b: Vec3, n: Vec3): number {
  return Math.atan2(dot3(cross3(a, b), n), dot3(a, b));
}

/**
 * A curve-driven pattern's copies: instance k + 2 at `distances[k]` along
 * the path, moved from where the path starts to there and, with `align`,
 * turned with the path's tangent (about `normal`, the plane the path lies
 * in, else by the least turn that takes the start tangent to that one).
 */
export function curveInstances(oc: OC, s: Scope, path: PathShape, distances: readonly number[], align: boolean, normal: Vec3 | null, skip: readonly number[] = []): PatternInstance[] {
  const places = pathPlaces(oc, s, path, distances);
  const p0 = path.start;
  const t0 = path.startTangent;
  const out: PatternInstance[] = [];
  places.forEach((pl, k) => {
    const n = k + 2;
    if (skip.includes(n)) return;
    const turn = identity(oc, s);
    if (align) {
      let axis: Vec3 | null = null;
      let angle = 0;
      if (normal) {
        axis = normal;
        angle = angleAbout(t0, pl.t, normal);
      } else {
        const c = cross3(t0, pl.t);
        if (Math.hypot(...c) > 1e-9) {
          axis = normalize3(c);
          angle = Math.atan2(Math.hypot(...c), dot3(t0, pl.t));
        }
      }
      if (axis && Math.abs(angle) > 1e-12) turn.SetRotation(s.track(new oc.gp_Ax1(pnt(oc, s, p0), dir(oc, s, axis))), angle);
    }
    const move = identity(oc, s);
    move.SetTranslation(vec(oc, s, sub3(pl.p, p0)));
    // Turned about the path's start, then moved along it.
    move.Multiply(turn);
    out.push({ n, label: `instance ${n} (${roundTo(distances[k], 4)} mm along)`, trsf: move });
  });
  return out;
}

/** The plane a path lies in (its unit normal), or null when it is straight or not flat. */
export function pathPlaneNormal(points: readonly Vec3[]): Vec3 | null {
  if (points.length < 3) return null;
  const c = points.reduce((a, p) => add3(a, scale3(p, 1 / points.length)), [0, 0, 0] as Vec3);
  // Newell's normal of the polyline about its centroid.
  let n: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) n = add3(n, cross3(sub3(points[i], c), sub3(points[(i + 1) % points.length], c)));
  const size = Math.max(...points.map((p) => Math.hypot(...sub3(p, c))));
  if (!(size > 0) || Math.hypot(...n) < 1e-9 * size * size) return null;
  n = normalize3(n);
  return points.every((p) => Math.abs(dot3(sub3(p, c), n)) < 1e-6 * Math.max(1, size)) ? n : null;
}

/**
 * A planar face's region for a fill pattern: its frame (as a hole or a sketch
 * on that face has it) and its edges as polylines in that frame.
 */
export function faceRegion(ctx: RebuildCtx, s: Scope, sel: FaceSelector, path: string): { frame: Frame; boundary: Vec2[][] } {
  if (ctx.bodies.size === 0) throw new OpError(`${path}: there is no solid before this feature to take a face from`);
  const part = ctx.part(s, true);
  const found = selectFaces(part.faceInfos, sel);
  const problem = selectionError(sel, found, 1);
  if (problem) throw new OpError(`${path}: ${problem}`);
  const face = found.matches[0];
  if (face.type !== "plane" || !face.normal || !face.point) throw new OpError(`${path}: the face is curved; a fill pattern fills a flat face (or a sketch's closed region)`);
  const frame = facePlaneFrame(face.normal, face.point);
  const { oc } = ctx;
  const boundary = part.edgeInfos
    .filter((e) => e.faces.includes(face.index) && !e.seam)
    .map((e) => {
      let other: Vec3[] | null = null;
      if (e.kind === "other") {
        const go = traveller(oc, s, part.edges[e.index]);
        other = Array.from({ length: 65 }, (_, k) => go(k / 64).p);
      }
      return edgePolyline(e, other).map((p) => to2D(frame, p));
    });
  return { frame, boundary };
}

/** A sketch's closed regions for a fill pattern: its frame, and its loops as polylines. */
export function sketchRegion(ctx: RebuildCtx, sketch: string): { frame: Frame; boundary: Vec2[][] } {
  const profile = ctx.profile(sketch, "fill");
  const boundary = profile.regions.flatMap((r) => [r.outer, ...r.holes]).map((loop) => loop.segs.flatMap((seg, i) => (i === 0 ? sampleSeg(seg, Math.PI / 90) : sampleSeg(seg, Math.PI / 90).slice(1))));
  return { frame: profile.frame, boundary };
}

/**
 * Where the seeds sit in a plane and what they cover there: a lone hole of
 * one centre, its centre and its widest diameter; else the centre of the
 * tools' box seen in the plane, and that box.
 */
export function seedFootprint(ctx: RebuildCtx, s: Scope, seeds: [string, Seed][], frame: Frame): { at: Vec2; footprint: Vec2[] } {
  const { oc } = ctx;
  if (seeds.length === 1) {
    const holes = ctx.holes.ofFeature(seeds[0][0]);
    if (holes.length === 1) {
      const h = holes[0];
      const r = Math.max(h.diameter, h.counterbore?.diameter ?? 0, h.countersink?.diameter ?? 0) / 2;
      return { at: to2D(frame, h.entry), footprint: roundFootprint(r) };
    }
  }
  const ax3 = s.track(new oc.gp_Ax3(pnt(oc, s, frame.origin), dir(oc, s, frame.z), dir(oc, s, frame.x)));
  const toLocal = identity(oc, s);
  toLocal.SetTransformation(ax3);
  let lo: Vec2 = [Infinity, Infinity];
  let hi: Vec2 = [-Infinity, -Infinity];
  for (const [, seed] of seeds) {
    const box = boundingBoxOf(oc, s, transformed(oc, s, seed.tool, toLocal));
    if (!box) continue;
    lo = [Math.min(lo[0], box.min[0]), Math.min(lo[1], box.min[1])];
    hi = [Math.max(hi[0], box.max[0]), Math.max(hi[1], box.max[1])];
  }
  if (!Number.isFinite(lo[0])) throw new OpError("the seed has no size to place: it made nothing");
  const at: Vec2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  return { at, footprint: boxFootprint([lo[0] - at[0], lo[1] - at[1]], [hi[0] - at[0], hi[1] - at[1]]) };
}
