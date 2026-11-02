// curvePattern: copies of earlier features along a curve: a sketch's chain of
// lines, arcs and curves, or a chain of model edges. The seed sits at the
// curve's start (its free end with the lowest coordinates, or the other end
// with `reverse`); `count` instances in all, spread evenly over the whole
// curve, or `spacing` mm apart along it. With "orientation": "curve" (the
// default) each copy turns with the curve's tangent, as if fixed to it;
// "fixed" keeps the seed's orientation (copies only slide).

import type { EdgeSelector, FeatureBase } from "../../doc/types";
import type { FeatureDef, FeatureSelector } from "../defs";
import { copyBodies } from "../tablePattern/doc";

type Raw = Record<string, unknown>;

export type CurvePath = { sketch: string } | { edges: EdgeSelector[] };

export interface CurvePatternFeature extends FeatureBase {
  op: "curvePattern";
  feature?: string;
  features?: string[];
  path: CurvePath;
  /** Instances in all, the seed one of them. */
  count: number;
  /** Between neighbours along the curve, mm. Default: the curve's length shared out evenly (a closed curve: all the way round). */
  spacing?: number;
  /** "curve" (default): copies turn with the curve; "fixed": they keep the seed's orientation. */
  orientation?: "curve" | "fixed";
  /** Start from the curve's other end. */
  reverse?: boolean;
  skip?: number[];
}

export const CURVE_ORIENTATIONS = ["curve", "fixed"] as const;

/** The most instances a curve-driven pattern makes. */
export const MAX_CURVE_COUNT = 1000;

/**
 * Where along a curve of `length` the instances are (mm from its start, the
 * seed's at 0): `count` of them `spacing` apart, or spread evenly (an open
 * curve end to end, a closed one round, the last a step short of the start).
 * A string says why they don't fit.
 */
export function curveDistances(length: number, closed: boolean, count: number, spacing?: number): number[] | string {
  if (!(length > 0)) return "the curve has no length";
  const step = spacing ?? (closed ? length / count : length / (count - 1));
  const last = step * (count - 1);
  if (last > length + 1e-6) return `${count} instances ${roundTo(step)} mm apart need ${roundTo(last)} mm of curve, but it is ${roundTo(length)} mm long: fewer instances or less spacing`;
  if (closed && last > length - 1e-6) return "the last instance would sit on the seed (the curve closes on itself): one fewer instance, or less spacing";
  return Array.from({ length: count - 1 }, (_, k) => step * (k + 1));
}

function roundTo(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** The selector-held edges of a path, for body checks and renames. */
function pathEdges(raw: Raw): unknown[] | null {
  const p = raw.path;
  return typeof p === "object" && p !== null && Array.isArray((p as Raw).edges) ? ((p as Raw).edges as unknown[]) : null;
}

function renameSelector(sel: unknown, rename: (name: unknown) => unknown): unknown {
  if (typeof sel !== "object" || sel === null || Array.isArray(sel)) return sel;
  const out: Raw = { ...(sel as Raw) };
  if (out.body !== undefined) out.body = rename(out.body);
  if (out.onFace !== undefined) out.onFace = renameSelector(out.onFace, rename);
  if (Array.isArray(out.between)) out.between = out.between.map((s) => renameSelector(s, rename));
  return out;
}

export const def: FeatureDef<CurvePatternFeature> = {
  op: "curvePattern",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "feature", "features", "path", "count", "spacing", "orientation", "reverse", "skip"]);
    const seeds = x.seeds(raw);
    let path: CurvePath | null = null;
    const p = raw.path;
    const shapes = '{ "sketch": "<sketch id>" } (its chain of curves) or { "edges": [<edge selector>, ...] } (model edges end to end)';
    if (!x.isObject(p)) c.fail("path", `needed: the curve the copies follow, ${shapes} (got ${x.describe(p)})`);
    else if ((p.sketch === undefined) === (p.edges === undefined)) c.fail("path", `must be one of ${shapes}`);
    else if (p.sketch !== undefined) {
      c.keys(p, "path", ["sketch"]);
      const sketch = x.sketch(p.sketch, "path.sketch");
      if (sketch) path = { sketch };
    } else {
      c.keys(p, "path", ["edges"]);
      const edges = x.edgeSelectors(p.edges, "path.edges");
      if (edges) path = { edges: Array.isArray(edges) ? edges : [edges] };
    }
    const count = c.num(raw, "count", "", { positive: true });
    if (count !== undefined && (!Number.isInteger(count) || count < 2 || count > MAX_CURVE_COUNT)) c.fail("count", `must be a whole number from 2 to ${MAX_CURVE_COUNT}: the instances in all, the seed one of them (got ${count})`);
    const spacing = raw.spacing === undefined ? undefined : c.num(raw, "spacing", "", { positive: true });
    const orientation = raw.orientation === undefined ? undefined : x.oneOf(raw, "orientation", "", CURVE_ORIENTATIONS);
    const reverse = x.bool(raw, "reverse", "");
    const skip = count !== undefined && Number.isInteger(count) ? x.skip(raw, count) : undefined;
    if (c.errors.length || !seeds || !path || count === undefined) return null;
    return {
      id: raw.id as string,
      op: "curvePattern",
      ...seeds,
      path,
      count,
      ...(spacing !== undefined ? { spacing } : {}),
      ...(orientation ? { orientation } : {}),
      ...(reverse ? { reverse } : {}),
      ...(skip ? { skip } : {}),
    };
  },
  references: (raw) => [
    ...(typeof raw.path === "object" && raw.path !== null && typeof (raw.path as Raw).sketch === "string" ? [(raw.path as Raw).sketch as string] : []),
    ...(Array.isArray(raw.features) ? raw.features.filter((v): v is string => typeof v === "string") : typeof raw.feature === "string" ? [raw.feature] : []),
  ],
  selectors: (f) => ("edges" in f.path ? f.path.edges.map((edge, i): FeatureSelector => ({ path: `path.edges[${i}]`, edge, many: true })) : []),
  renameBodies: (raw, rename) => {
    const edges = pathEdges(raw);
    return edges ? { path: { ...(raw.path as Raw), edges: edges.map((s) => renameSelector(s, rename)) } } : {};
  },
  bodies: copyBodies<CurvePatternFeature>((f) => f.count - 1),
  reference: `## curvePattern
{ "id": "cp_1", "op": "curvePattern", "feature": "hole_1", "path": { "sketch": "sketch_2" }, "count": 6 }
{ "id": "cp_2", "op": "curvePattern", "feature": "boss", "path": { "edges": [<edge selector>] }, "count": 5, "spacing": 12, "orientation": "fixed" }
Copies of earlier features along a curve: "feature" or "features": [...] (extrudes, cuts, holes, members, the ops that
pattern). "path": { "sketch": <id> } (the sketch's chain of lines, arcs, splines; construction and points ignored) or
{ "edges": [<edge selector>, ...] } (model edges end to end). The seed sits at the curve's START: an open chain starts
at its free end with the lowest coordinates (x, then y, then z; "reverse": true starts at the other end), a closed
one where its first piece starts. "count": instances in all (the seed is one). Spacing: "spacing" mm along the curve,
or (left out) the curve's length shared out evenly: an open curve end to end (count - 1 steps), a closed one round
(count steps). "orientation": "curve" (default; each copy turns with the curve's tangent, about the curve's plane
normal) or "fixed" (copies slide, keeping the seed's orientation). Instances 1 (the seed), 2, 3 ... along the curve;
"skip": [3] leaves some out. Put the seed where the curve starts (a hole whose centre is the chain's first point).
`,
};
