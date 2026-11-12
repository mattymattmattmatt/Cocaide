// exportBody, kernel side: the frame the file's axes will be, worked out on
// the part as it stands (the chosen bodies' box for "centre" and "bottom",
// the references for the point, up and front) and kept in ctx.datums as a
// coordinate system, so the view shows it and the export reads it. No body
// changes.

import type { Vec3 } from "../../doc/types";
import { boxPoints, exportFrame } from "../../geom/exportFrame";
import { scale3 } from "../../geom/vec";
import { resolveDatum } from "../../kernel/datum";
import { boundingBoxOf } from "../../kernel/measure";
import { scoped } from "../../kernel/oc";
import { OpError } from "../../kernel/ops";
import { directionOf } from "../coordinateSystem/kernel";
import type { KernelOp } from "../kernelDefs";
import type { ExportBodyFeature } from "./doc";

export const kernel: KernelOp<ExportBodyFeature> = {
  op: "exportBody",
  run(ctx, f) {
    const names = f.bodies ?? [...ctx.bodies.keys()];
    const missing = names.filter((n) => !ctx.bodies.has(n));
    if (missing.length) throw new OpError(`bodies: no body ${missing.map((n) => `"${n}"`).join(", ")} before this feature (there are ${[...ctx.bodies.keys()].join(", ") || "none"})`);
    if (!names.length) throw new OpError("there is no body to export: make a solid first");
    const zero: Vec3 = [0, 0, 0];
    let up = f.up ? directionOf(ctx, f.up, zero, "up") : ([0, 0, 1] as Vec3);
    let front = f.front ? directionOf(ctx, f.front, zero, "front") : ([0, -1, 0] as Vec3);
    if (f.reverseUp) up = scale3(up, -1);
    if (f.reverseFront) front = scale3(front, -1);
    let origin: Vec3 = zero;
    const mode = f.origin ?? "model";
    if (mode === "point") origin = resolveDatum(ctx, f.point!, "point", "point").at;
    else if (mode !== "model") {
      const box = scoped((s) => {
        let lo: Vec3 | null = null;
        let hi: Vec3 | null = null;
        for (const n of names) {
          const b = boundingBoxOf(ctx.oc, s, ctx.bodies.get(n)!);
          if (!b) continue;
          lo = lo ? (lo.map((v, i) => Math.min(v, b.min[i])) as Vec3) : b.min;
          hi = hi ? (hi.map((v, i) => Math.max(v, b.max[i])) as Vec3) : b.max;
        }
        return lo && hi ? { min: lo, max: hi } : null;
      });
      if (!box) throw new OpError("the bodies have no extent to find the middle of");
      origin = boxPoints(box, up)[mode === "centre" ? "centre" : "bottom"];
    }
    const frame = exportFrame(origin, up, front, f.convention ?? "zUp");
    if (typeof frame === "string") throw new OpError(`front: ${frame}`);
    ctx.datums.set(f.id, { kind: "frame", ...frame });
  },
};
