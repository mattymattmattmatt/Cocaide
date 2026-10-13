// sketchPattern: copies of earlier features at the points of a sketch
// (DESIGN §2.6). Each seed's tool is moved, in the sketch's plane, from
// where the seed is (`from`, by default the sketch's first point) to each
// other point. Instead of the sketch's points, `positions` lists the places
// as a table of [x, y] in the sketch's plane.

import type { FeatureBase, Vec2 } from "../../doc/types";
import type { FeatureContext } from "../../doc/validate";
import type { FeatureDef } from "../defs";

export interface SketchPatternFeature extends FeatureBase {
  op: "sketchPattern";
  /** One feature to copy; or `features`, several, each copied the same way. */
  feature?: string;
  features?: string[];
  /** Its point entities are where the copies go; its plane is the plane they move in. */
  sketch: string;
  /** Where the seed is, in the sketch's plane. Default: the first point (or position). */
  from?: Vec2;
  /** A table of places, [x, y] in the sketch's plane, instead of its points. */
  positions?: Vec2[];
  /** Instances left out, by number: 1 is the seed, then 2, 3 ... the other places in order. */
  skip?: number[];
}

/** Places the same as `from` (within this, mm) are the seed's own: no copy goes there. */
export const SAME_PLACE = 1e-9;

/** The places a sketch pattern copies to, in order: its positions or the sketch's points, less the seed's own. */
export function copyPlaces(places: readonly Vec2[], from: Vec2 | undefined): Vec2[] {
  return copyIndices(places, from).map((i) => places[i]);
}

/** Which of the places get a copy, by index (instance k + 2 is at places[copyIndices(...)[k]]). */
export function copyIndices(places: readonly Vec2[], from: Vec2 | undefined): number[] {
  const at = from ?? places[0];
  return places.flatMap((p, i) => (!at || Math.hypot(p[0] - at[0], p[1] - at[1]) > SAME_PLACE ? [i] : []));
}

/** The points of a sketch the document holds (validated), in order. */
export function sketchPoints(ctx: FeatureContext, sketch: string): Vec2[] | undefined {
  const sk = ctx.sketches.get(sketch);
  return sk?.entities.flatMap((e) => (e.type === "point" ? [e.at] : []));
}

/** How many copies each validated feature makes (for the body names of a seed's copies). */
const copiesOf = new WeakMap<SketchPatternFeature, number>();

export const def: FeatureDef<SketchPatternFeature> = {
  op: "sketchPattern",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "feature", "features", "sketch", "from", "positions", "skip"]);
    const seeds = x.seeds(raw);
    const sketch = x.sketch(raw.sketch, "sketch");
    const from = raw.from === undefined ? undefined : c.vec2(raw, "from", "");
    let positions: Vec2[] | undefined;
    if (raw.positions !== undefined) {
      if (!Array.isArray(raw.positions) || raw.positions.length === 0) c.fail("positions", `must be a list of [x, y] places in the sketch's plane, at least one (got ${x.describe(raw.positions)})`);
      else {
        const list = raw.positions.map((p, i) => c.vec2({ [`positions[${i}]`]: p }, `positions[${i}]`, ""));
        if (list.every((p) => p)) positions = list as Vec2[];
      }
    }
    // The places: the table, or the sketch's points (when the sketch validated: a broken one says so itself).
    const places = positions ?? (sketch ? sketchPoints(x.ctx, sketch) : undefined);
    let copies: number | undefined;
    if (places) {
      if (places.length === 0) c.fail("sketch", `sketch "${sketch}" has no points: put a point (the Point tool) where each copy goes, or list "positions"`);
      else {
        copies = copyPlaces(places, from).length;
        if (copies === 0) c.fail(positions ? "positions" : "sketch", "every place is where the seed is: there is nowhere to copy it to");
      }
    }
    const skip = copies ? x.skip(raw, copies + 1) : undefined;
    if (c.errors.length > 0 || !seeds || !sketch) return null;
    const f: SketchPatternFeature = { id: raw.id as string, op: "sketchPattern", ...seeds, sketch };
    if (from) f.from = from;
    if (positions) f.positions = positions;
    if (skip) f.skip = skip;
    if (copies !== undefined) copiesOf.set(f, copies);
    return f;
  },
  references: (raw) => [
    ...(typeof raw.sketch === "string" ? [raw.sketch] : []),
    ...(Array.isArray(raw.features) ? raw.features.filter((v): v is string => typeof v === "string") : typeof raw.feature === "string" ? [raw.feature] : []),
  ],
  bodies: {
    // A copy of a seed that starts a body is a body of its own: <body>_<instance number>, as a linear pattern names them.
    makes(f, state) {
      const copies = copiesOf.get(f) ?? 0;
      const ids = f.features ?? (f.feature ? [f.feature] : []);
      const names: string[] = [];
      for (const id of ids) {
        const seed = state.made.get(id);
        if (!seed) continue;
        for (let n = 2; n <= copies + 1; n++) if (!f.skip?.includes(n)) names.push(`${seed}_${n}`);
      }
      return names.length ? { names, path: f.features ? "features" : "feature" } : null;
    },
  },
  onlyBodies(raw, inScope, doc) {
    // Each seed touches only bodies in the scope: one added to such a body, a cut or hole that lists only them, a member that is one.
    const ids = Array.isArray(raw.features) ? raw.features : [raw.feature];
    return ids.every((id) => {
      const s = doc.features.find((g) => g.id === id);
      if (!s) return false;
      // "main": the default body (DEFAULT_BODY; the doc layer imports only types).
      if (s.op === "extrude") return inScope(s.newBody ?? s.body ?? "main");
      if (s.op === "cut" || s.op === "hole") return Array.isArray(s.bodies) && s.bodies.length > 0 && s.bodies.every(inScope);
      if (s.op === "member") return inScope(s.newBody ?? s.id);
      return false;
    });
  },
  reference: `## sketchPattern
{ "id": "sp_1", "op": "sketchPattern", "feature": "hole_1", "sketch": "sketch_2" }
Copies of earlier features at the points of a sketch: "feature" (one) or "features": [...] (several, each copied
the same way; extrudes, cuts, holes, members and the ops that pattern, such as revolve). "sketch": its point
entities ("type": "point") are where the copies go, moved in that sketch's plane. "from": [x, y] in that plane,
where the seed is (default: the sketch's first point, which then gets no copy; every other point gets one).
"positions": [[x, y], ...] lists the places as a table in the sketch's plane instead of its points (the sketch then
gives only the plane). Instances are numbered 1 (the seed), then 2, 3 ... the other places in order; "skip": [3]
leaves some out. A copy of a feature that starts a body is a new body named <body>_<instance number>.
`,
};
