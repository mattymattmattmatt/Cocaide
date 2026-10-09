// point, kernel side: the references resolved on the part as it stands, the
// point worked out, kept in ctx.datums. No body changes.

import type { Vec3 } from "../../doc/types";
import { formatDirection } from "../../geom/vec";
import { edgePlace, findEdge, findFace, nameOf, resolveDatum } from "../../kernel/datum";
import { OpError } from "../../kernel/ops";
import { axisPlanePoint, cleanDatum } from "../datum";
import type { KernelOp } from "../kernelDefs";
import type { PointFeature } from "./doc";

export const kernel: KernelOp<PointFeature> = {
  op: "point",
  run(ctx, f) {
    let at: Vec3;
    switch (f.mode) {
      case "coords":
        at = f.at!;
        break;
      case "center": {
        const ref = f.refs[0];
        if ("face" in ref) at = findFace(ctx, ref.face, "refs[0].face").centroid;
        else if ("edge" in ref) {
          const e = findEdge(ctx, ref.edge, "refs[0].edge");
          if (e.kind !== "circle" || !e.center) {
            throw new OpError(`refs[0]: the edge is ${e.kind === "line" ? "straight" : "curved but not round"}, so it has no centre: use mode "onEdge" (t 0.5 is its middle), or pick a circular edge`);
          }
          at = e.center;
        } else throw new OpError(`refs[0]: ${nameOf(ref)} has no centre: pick a circular edge or a face`);
        break;
      }
      case "intersection": {
        const axis = resolveDatum(ctx, f.refs[0], "axis", "refs[0]");
        const plane = resolveDatum(ctx, f.refs[1], "plane", "refs[1]");
        const crossing = axisPlanePoint(axis, plane);
        if (!crossing) {
          throw new OpError(
            `refs: ${nameOf(f.refs[0])} runs ${formatDirection(axis.direction)}, parallel to ${nameOf(f.refs[1])} (normal ${formatDirection(plane.normal)}), so it never crosses it: pick a plane the axis passes through`,
          );
        }
        at = crossing;
        break;
      }
      case "onEdge": {
        const ref = f.refs[0] as { edge: Parameters<typeof edgePlace>[1] };
        at = edgePlace(ctx, ref.edge, "refs[0].edge", { t: f.t ?? 0.5 }).at;
        break;
      }
    }
    ctx.datums.set(f.id, cleanDatum({ kind: "point", at }));
  },
};
