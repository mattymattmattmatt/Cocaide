// fillPattern: copies of earlier features filling a region of a plane: a flat
// face (its outline and any holes in it) or a sketch's closed regions. The
// copies are laid out through the seed (a square grid, a staggered one, or
// rings about the seed) and only those whose footprint lies wholly inside the
// region, at least `margin` from its boundary, are made (layout.ts). The seed
// is where its feature put it (a hole's centre, the middle of its tool) unless
// `from` says; instances are numbered 1 (the seed), then row by row (rings
// outwards), and `skip` leaves some out (the editor skips one clicked in the
// view).

import type { FaceSelector, FeatureBase, Vec2 } from "../../doc/types";
import type { FeatureDef, FeatureSelector } from "../defs";
import { FILL_LAYOUTS, MAX_FILL_COPIES, type FillLayout } from "./layout";

export interface FillPatternFeature extends FeatureBase {
  op: "fillPattern";
  feature?: string;
  features?: string[];
  /** The flat face it fills; or `sketch`, a sketch's closed regions (in its plane). */
  face?: FaceSelector;
  sketch?: string;
  /** "square" (default), "staggered" (every other row shifted half a step) or "circular" (rings about the seed). */
  layout?: FillLayout;
  /** Between neighbours along a row (along a ring), mm. */
  spacing: number;
  /** Between rows (rings), mm. Default the spacing (staggered: spacing × √3/2). */
  spacing2?: number;
  /** The rows turned this many degrees from the plane's x axis. */
  angle?: number;
  /** Copies keep this far from the region's boundary (and its holes), mm. Default 0. */
  margin?: number;
  /** Where the seed sits, [x, y] in the region's plane. Default: where it is. */
  from?: Vec2;
  /** Instances left out: 1 is the seed, then the copies in layout order. */
  skip?: number[];
}

export const def: FeatureDef<FillPatternFeature> = {
  op: "fillPattern",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "feature", "features", "face", "sketch", "layout", "spacing", "spacing2", "angle", "margin", "from", "skip"]);
    const seeds = x.seeds(raw);
    if ((raw.face === undefined) === (raw.sketch === undefined)) c.fail("face", 'needs the region to fill: "face" (a flat face selector) or "sketch" (a sketch with a closed profile), one of them');
    const face = raw.face === undefined ? undefined : x.faceSelector(raw.face, "face");
    const sketch = raw.sketch === undefined ? undefined : x.sketch(raw.sketch, "sketch");
    const layout = raw.layout === undefined ? undefined : x.oneOf(raw, "layout", "", FILL_LAYOUTS);
    const spacing = c.num(raw, "spacing", "", { positive: true });
    const spacing2 = raw.spacing2 === undefined ? undefined : c.num(raw, "spacing2", "", { positive: true });
    const angle = raw.angle === undefined ? undefined : c.num(raw, "angle", "", {});
    const margin = raw.margin === undefined ? undefined : c.num(raw, "margin", "", { nonNegative: true });
    const from = raw.from === undefined ? undefined : c.vec2(raw, "from", "");
    // The copies depend on the part, so the skips are checked as whole numbers from 2 (the kernel drops those past the last).
    const skip = x.skip(raw, MAX_FILL_COPIES + 1);
    if (c.errors.length || !seeds || spacing === undefined || face === null) return null;
    return {
      id: raw.id as string,
      op: "fillPattern",
      ...seeds,
      ...(face ? { face } : {}),
      ...(sketch ? { sketch } : {}),
      ...(layout ? { layout } : {}),
      spacing,
      ...(spacing2 !== undefined ? { spacing2 } : {}),
      ...(angle !== undefined ? { angle } : {}),
      ...(margin !== undefined ? { margin } : {}),
      ...(from ? { from } : {}),
      ...(skip ? { skip } : {}),
    };
  },
  references: (raw) => [
    ...(typeof raw.sketch === "string" ? [raw.sketch] : []),
    ...(Array.isArray(raw.features) ? raw.features.filter((v): v is string => typeof v === "string") : typeof raw.feature === "string" ? [raw.feature] : []),
  ],
  selectors: (f) => (f.face ? [{ path: "face", face: f.face } as FeatureSelector] : []),
  reference: `## fillPattern
{ "id": "fp_1", "op": "fillPattern", "feature": "hole_1", "face": { "type": "planar", "normal": [0, 0, 1], "pick": "largest" }, "spacing": 15, "margin": 5 }
Copies of earlier features filling a flat region: "feature" or "features": [...] (extrudes, cuts, holes and the ops
that pattern). The region: "face" (a flat face selector: its outline and every hole in
it) or "sketch" (a sketch's closed profile, in its plane). "layout": "square" (default) | "staggered" (every other row
shifted half a step: neighbours equally far apart with the default row spacing spacing × √3/2) | "circular" (rings
about the seed). "spacing": mm between neighbours along a row (along a ring); "spacing2": between rows (rings),
default "spacing". "angle": the rows turned that many degrees from the plane's x axis. "margin": mm every copy keeps
from the region's boundary (default 0). A copy is made only where the seed's footprint (a hole's widest circle, else
its tool's outline box) fits wholly inside. The layout runs through the seed: where its feature put it (a hole's
centre, the middle of an extrude's tool), or "from": [x, y] in the region's plane (a face's plane: x, y as a sketch
on that face has them). Instances: 1 the seed, then row by row from the bottom (rings outwards); "skip": [n, ...]
leaves some out. The face's plane frame for "from" is the same as a hole's "center" on that face.
`,
};
