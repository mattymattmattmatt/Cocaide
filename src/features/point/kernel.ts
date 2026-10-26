// point, kernel side: the references resolved on the part as it stands, the
// point worked out, kept in ctx.datums. No body changes.

import type { Vec3 } from "../../doc/types";
import { sketchEntityPlace } from "../../geom/sketchEdge";
import { formatDirection } from "../../geom/vec";
import { edgePlace, findEdge, findFace, nameOf, resolveDatum, sketchSource } from "../../kernel/datum";
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
        } else if ("sketch" in ref) {
          // A sketch's circle or arc: its centre. Anything else has none (said before resolving it, which would ask for an "at").
          const { entity } = sketchSource(ctx, ref, "refs[0]");
          if (entity.type !== "circle" && entity.type !== "arc") {
            throw new OpError(`refs[0]: ${nameOf(ref)} is ${entity.type === "ellipse" ? "an" : "a"} ${entity.type}, so it has no centre: pick a circle or arc of the sketch${entity.type === "line" ? ', or use mode "onEdge" (t 0.5 is its middle)' : ""}`);
          }
          at = resolveDatum(ctx, ref, "point", "refs[0]").at;
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
        const ref = f.refs[0];
        if ("sketch" in ref) {
          // Along another sketch's line, arc or circle, as it was solved.
          const { entity, frame } = sketchSource(ctx, ref, "refs[0]");
          const place = sketchEntityPlace(entity, frame, { t: f.t ?? 0.5 });
          if (typeof place === "string") throw new OpError(`refs[0]: ${place}`);
          at = place.at;
        } else at = edgePlace(ctx, (ref as { edge: Parameters<typeof edgePlace>[1] }).edge, "refs[0].edge", { t: f.t ?? 0.5 }).at;
        break;
      }
    }
    ctx.datums.set(f.id, cleanDatum({ kind: "point", at }));
  },
};
