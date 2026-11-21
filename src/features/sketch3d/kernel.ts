// sketch3d, kernel side: nothing to build; its lines and points go in the
// view's sketches, drawn and picked like a sketch's (lines3d).

import type { Vec3 } from "../../doc/types";
import { sketch3dSegments } from "../../geom/sketch3d";
import type { KernelOp } from "../kernelDefs";
import type { Sketch3dFeature } from "./doc";

const WORLD = { origin: [0, 0, 0] as Vec3, x: [1, 0, 0] as Vec3, y: [0, 1, 0] as Vec3, z: [0, 0, 1] as Vec3 };

export const kernel: KernelOp<Sketch3dFeature> = {
  op: "sketch3d",
  run(ctx, f) {
    const segs = sketch3dSegments(f, new Map(Object.entries(f.placed)));
    ctx.showSketch({
      id: f.id,
      ok: true,
      frame: WORLD,
      entities: [],
      polylines: segs.map((s) => ({ construction: s.construction, points: [s.a, s.b] })),
      points: Object.values(f.placed).map((at) => ({ at })),
      lines3d: segs,
      points3d: Object.entries(f.placed).map(([id, at]) => ({ id, at })),
    });
  },
};
