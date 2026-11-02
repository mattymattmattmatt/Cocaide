// tablePattern, kernel side: the plane (or coordinate system) resolved on the
// part as it stands, each seed's tool moved in it from the seed's position to
// each other row of the table.

import { seedIds } from "../../doc/types";
import { resolveDatum } from "../../kernel/datum";
import { scoped } from "../../kernel/oc";
import { planeInstances, repeatSeeds, seedsOf } from "../../kernel/pattern";
import { refPlaneFrame } from "../datum";
import type { KernelOp } from "../kernelDefs";
import { copyPlaces } from "../sketchPattern/doc";
import type { TablePatternFeature } from "./doc";

export const kernel: KernelOp<TablePatternFeature> = {
  op: "tablePattern",
  run(ctx, f) {
    const seeds = seedsOf(ctx, seedIds(f));
    const frame = refPlaneFrame(resolveDatum(ctx, f.system ?? { datum: "Top" }, "plane", "system"));
    const from = f.from ?? f.positions[0];
    scoped((s) => repeatSeeds(ctx, s, seeds, planeInstances(ctx.oc, s, frame, from, copyPlaces(f.positions, from), f.skip)));
  },
};
