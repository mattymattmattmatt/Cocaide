// Test-only registry ops, kernel side (see registry-fixtures.ts). ghost has
// none on purpose.

import type { Vec3 } from "../src/doc/types";
import type { KernelOp } from "../src/features/kernelDefs";
import { scoped } from "../src/kernel/oc";
import { applyOperation } from "../src/kernel/operation";
import { pnt } from "../src/kernel/ops";
import type { BlockFeature, ProbeFeature } from "./registry-fixtures";

export const blockKernel: KernelOp<BlockFeature> = {
  op: "block",
  run(ctx, f) {
    scoped((s) => {
      const box = s.track(new ctx.oc.BRepPrimAPI_MakeBox(pnt(ctx.oc, s, f.at), f.size[0], f.size[1], f.size[2]));
      applyOperation(ctx, s, f, s.track(box.Solid()), "block");
    });
  },
};

/** What each probe saw, in rebuild order. */
export const probed: { id: string; entities: number; open: string | undefined; frameZ: Vec3 | undefined; profile: string }[] = [];

export const probeKernel: KernelOp<ProbeFeature> = {
  op: "probe",
  run(ctx, f) {
    let profile = "closed";
    try {
      ctx.profile(f.sketch, "probe");
    } catch (e) {
      profile = (e as Error).message;
    }
    const p = ctx.profiles.get(f.sketch);
    probed.push({ id: f.id, entities: ctx.sketch(f.sketch)?.entities.length ?? -1, open: p?.open, frameZ: p?.frame.z.map((x) => x + 0) as Vec3 | undefined, profile });
  },
};
