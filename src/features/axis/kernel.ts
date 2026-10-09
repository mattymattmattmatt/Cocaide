// axis, kernel side: the references resolved on the part as it stands, the
// axis worked out (src/features/datum.ts), kept in ctx.datums. No body changes.

import { formatDirection, roundTo } from "../../geom/vec";
import { nameOf, resolveDatum } from "../../kernel/datum";
import { OpError } from "../../kernel/ops";
import { cleanDatum, flipAxis, planesLine, twoPointAxis, type AxisDatum } from "../datum";
import type { KernelOp } from "../kernelDefs";
import type { AxisFeature } from "./doc";

export const kernel: KernelOp<AxisFeature> = {
  op: "axis",
  run(ctx, f) {
    const point = (i: number) => resolveDatum(ctx, f.refs[i], "point", `refs[${i}]`).at;
    const plane = (i: number) => resolveDatum(ctx, f.refs[i], "plane", `refs[${i}]`);
    let a: AxisDatum;
    switch (f.mode) {
      case "twoPoints": {
        const p = point(0);
        const made = twoPointAxis(p, point(1));
        if (!made) throw new OpError(`refs: both points are [${p.map((v) => roundTo(v, 4)).join(", ")}]: pick two different points`);
        a = made;
        break;
      }
      case "edge":
      case "cylinder":
        a = resolveDatum(ctx, f.refs[0], "axis", "refs[0]");
        break;
      case "twoPlanes": {
        const p1 = plane(0);
        const made = planesLine(p1, plane(1));
        if (!made) {
          throw new OpError(
            `refs: ${nameOf(f.refs[0])} and ${nameOf(f.refs[1])} are parallel (normal ${formatDirection(p1.normal)}), so they never meet in a line: pick two planes that cross (Front and Right meet in the Z axis)`,
          );
        }
        a = made;
        break;
      }
      case "pointNormal":
        a = { kind: "axis", origin: point(0), direction: plane(1).normal };
        break;
    }
    ctx.datums.set(f.id, cleanDatum(f.flip ? flipAxis(a) : a));
  },
};
