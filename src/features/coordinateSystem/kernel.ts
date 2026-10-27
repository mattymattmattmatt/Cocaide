// coordinateSystem, kernel side: the origin and the two directions resolved
// on the part as it stands, made right-handed and square, kept in ctx.datums.
// No body changes.

import type { DatumRef, Vec3 } from "../../doc/types";
import { formatDirection, scale3, sub3 } from "../../geom/vec";
import { nameOf, resolveDatum } from "../../kernel/datum";
import { OpError } from "../../kernel/ops";
import { csysFrame } from "../datum";
import type { KernelOp, RebuildCtx } from "../kernelDefs";
import type { CoordinateSystemFeature } from "./doc";

/** A direction from a reference: an axis's direction, a plane's normal, or from `origin` toward a point. */
export function directionOf(ctx: RebuildCtx, ref: DatumRef, origin: Vec3, path: string): Vec3 {
  const got = resolveDatum(ctx, ref, "any", path);
  if (got.kind === "axis") return got.direction;
  if (got.kind === "plane") return got.normal;
  const d = sub3(got.at, origin);
  if (Math.hypot(...d) < 1e-9) throw new OpError(`${path}: ${nameOf(ref)} is the origin itself, so it gives no direction; pick another point, an edge or an axis`);
  return d;
}

export const kernel: KernelOp<CoordinateSystemFeature> = {
  op: "coordinateSystem",
  run(ctx, f) {
    const origin = f.origin ? resolveDatum(ctx, f.origin, "point", "origin").at : ([0, 0, 0] as Vec3);
    let x = f.x ? directionOf(ctx, f.x, origin, "x") : ([1, 0, 0] as Vec3);
    // Y defaults to the world's Y, or its Z when X runs along Y.
    let y = f.y ? directionOf(ctx, f.y, origin, "y") : Math.abs(x[1]) / Math.hypot(...x) > 1 - 1e-9 ? ([0, 0, 1] as Vec3) : ([0, 1, 0] as Vec3);
    if (f.reverseX) x = scale3(x, -1);
    if (f.reverseY) y = scale3(y, -1);
    const frame = csysFrame(origin, x, y);
    if (!frame) {
      throw new OpError(`y: its direction ${formatDirection(y)} is parallel to X ${formatDirection(x)}, so it fixes no Y axis: pick a direction across X`);
    }
    ctx.datums.set(f.id, frame);
  },
};
