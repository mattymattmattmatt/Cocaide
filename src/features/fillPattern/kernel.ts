// fillPattern, kernel side: the region (a flat face's edges, or a sketch's
// loops) in its plane, the seed's place and footprint there, the layout's
// places that fit (layout.ts), and each seed's tool copied to them.

import { seedIds } from "../../doc/types";
import { scoped } from "../../kernel/oc";
import { OpError } from "../../kernel/ops";
import { faceRegion, planeInstances, repeatSeeds, seedFootprint, seedsOf, sketchRegion } from "../../kernel/pattern";
import type { KernelOp } from "../kernelDefs";
import type { FillPatternFeature } from "./doc";
import { fillPlaces } from "./layout";

export const kernel: KernelOp<FillPatternFeature> = {
  op: "fillPattern",
  run(ctx, f) {
    const seeds = seedsOf(ctx, seedIds(f));
    scoped((s) => {
      const region = f.face ? faceRegion(ctx, s, f.face, "face") : sketchRegion(ctx, f.sketch!);
      const seed = seedFootprint(ctx, s, seeds, region.frame);
      const from = f.from ?? seed.at;
      const places = fillPlaces({ layout: f.layout ?? "square", spacing: f.spacing, spacing2: f.spacing2, angle: f.angle, margin: f.margin }, from, seed.footprint, region.boundary);
      if (typeof places === "string") throw new OpError(places);
      if (places.length === 0) throw new OpError(`no copy fits in the region${f.margin ? ` ${f.margin} mm from its edges` : ""} at a spacing of ${f.spacing} mm: make the spacing or the margin smaller, or check that the seed sits on the region`);
      const skip = (f.skip ?? []).filter((n) => n <= places.length + 1);
      repeatSeeds(ctx, s, seeds, planeInstances(ctx.oc, s, region.frame, from, places, skip));
    });
  },
};
