// plane, kernel side: resolve the references on the part as it stands, work
// out the plane (src/features/datum.ts has the geometry), and keep it in
// ctx.datums for what comes after. No body changes. A plane that cannot be
// made says which reference to change and to what.

import { formatDirection } from "../../geom/vec";
import { edgePlace, nameOf, resolveDatum } from "../../kernel/datum";
import { OpError } from "../../kernel/ops";
import { anglePlane, cleanDatum, flipPlane, midPlane, offsetPlane, planeDatum, threePointPlane, throughPointPlane, type PlaneDatum } from "../datum";
import type { KernelOp } from "../kernelDefs";
import type { PlaneFeature } from "./doc";

export const kernel: KernelOp<PlaneFeature> = {
  op: "plane",
  run(ctx, f) {
    const plane = (i: number) => resolveDatum(ctx, f.refs[i], "plane", `refs[${i}]`);
    const point = (i: number) => resolveDatum(ctx, f.refs[i], "point", `refs[${i}]`).at;
    let p: PlaneDatum;
    switch (f.mode) {
      case "offset":
        p = offsetPlane(plane(0), f.distance ?? 0);
        break;
      case "angle": {
        const base = plane(0);
        const axis = resolveDatum(ctx, f.refs[1], "axis", "refs[1]");
        const turned = anglePlane(base, axis, f.angle ?? 0);
        if (!turned) {
          throw new OpError(
            `refs[1]: ${nameOf(f.refs[1])} runs ${formatDirection(axis.direction)}, out of ${nameOf(f.refs[0])} (normal ${formatDirection(base.normal)}): ` +
              "pick an edge or axis that lies in the plane or runs parallel to it, or use mode \"normalToEdge\" for a plane square to it",
          );
        }
        p = turned;
        break;
      }
      case "threePoints": {
        const made = threePointPlane(point(0), point(1), point(2));
        if (!made) throw new OpError("refs: the three points lie on one line (or two are the same point), so no one plane goes through them: pick a third point off the line through the other two");
        p = made;
        break;
      }
      case "midplane":
        p = midPlane(plane(0), plane(1));
        break;
      case "normalToEdge": {
        const ref = f.refs[0];
        if ("edge" in ref) {
          const place = f.refs[1] ? edgePlace(ctx, ref.edge, "refs[0].edge", { near: point(1) }) : edgePlace(ctx, ref.edge, "refs[0].edge", { t: f.t ?? 0 });
          // Through the point given, else the point of the edge at t; square to the edge there.
          p = planeDatum(f.refs[1] ? point(1) : place.at, place.tangent);
        } else {
          const axis = resolveDatum(ctx, ref, "axis", "refs[0]");
          p = planeDatum(f.refs[1] ? point(1) : axis.origin, axis.direction);
        }
        break;
      }
      case "parallelThroughPoint":
        p = throughPointPlane(plane(0), point(1));
        break;
    }
    ctx.datums.set(f.id, cleanDatum(f.flip ? flipPlane(p) : p));
  },
};
