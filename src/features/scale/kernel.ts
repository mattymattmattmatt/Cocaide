// scale, kernel side: a uniform gp_Trsf scale of each listed body (or every
// body) about the origin or the body's own centroid. Holes in the scaled
// bodies scale with them; a scaled member is no longer a length of stock.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../../doc/types";
import { add3, scale3, sub3 } from "../../geom/vec";
import { centroidOf, isValidShape, volumeOf } from "../../kernel/measure";
import { scoped } from "../../kernel/oc";
import { identity, OpError, pnt, transformed, VOLUME_EPS } from "../../kernel/ops";
import type { KernelOp } from "../kernelDefs";
import type { ScaleFeature } from "./doc";

export const kernel: KernelOp<ScaleFeature> = {
  op: "scale",
  run(ctx, f) {
    if (ctx.bodies.size === 0) throw new OpError("nothing to scale: there is no solid before this feature");
    const { oc } = ctx;
    const listed = ctx.targets(f.bodies ?? null);
    /** Each body's fixed point. */
    const centres = new Map<string, Vec3>();
    scoped((s) => {
      const changed = new Map<string, TopoDS_Shape>();
      for (const [name, body] of listed) {
        const centre: Vec3 = f.about === "centroid" ? centroidOf(oc, s, body) : [0, 0, 0];
        centres.set(name, centre);
        const t = identity(oc, s);
        t.SetScale(pnt(oc, s, centre), f.factor);
        const scaled = transformed(oc, s, body, t);
        const where = listed.length > 1 ? ` body "${name}"` : "";
        if (!isValidShape(oc, s, scaled)) throw new OpError(`scaling${where || " the body"} by ${f.factor} produced an invalid solid`);
        const expected = volumeOf(oc, s, body) * f.factor ** 3;
        if (Math.abs(volumeOf(oc, s, scaled) - expected) > 1e-6 * Math.max(1, expected) + VOLUME_EPS) {
          throw new OpError(`scaling${where || " the body"} by ${f.factor} did not scale its volume by ${f.factor}³`);
        }
        changed.set(name, scaled);
      }
      ctx.commit(changed);
    });
    // Holes go where their bodies go: a hole whose bodies were all scaled, about one point, scales too.
    const names = listed.map(([n]) => n);
    for (const h of ctx.holes.inBodies(names)) {
      const centre = sameCentre([...ctx.holes.bodiesOf(h)].map((n) => centres.get(n)));
      if (!centre) continue;
      const k = f.factor;
      h.entry = round(add3(centre, scale3(sub3(h.entry, centre), k)));
      h.diameter = r6(h.diameter * k);
      h.depth = r6(h.depth * k);
      if (h.counterbore) h.counterbore = { diameter: r6(h.counterbore.diameter * k), depth: r6(h.counterbore.depth * k) };
      if (h.countersink) h.countersink = { ...h.countersink, diameter: r6(h.countersink.diameter * k) };
    }
    // A member scaled is no longer the stock size its profile says.
    for (const n of names) ctx.members.drop(n);
  },
};

/** The one fixed point all of a hole's bodies were scaled about, or null (one of them was not scaled, or they moved apart). */
function sameCentre(centres: (Vec3 | undefined)[]): Vec3 | null {
  const first = centres[0];
  if (!first || centres.some((c) => !c || Math.hypot(...sub3(c, first)) > 1e-9)) return null;
  return first;
}

function r6(x: number): number {
  return Math.round(x * 1e6) / 1e6 + 0;
}

function round(v: Vec3): Vec3 {
  return [r6(v[0]), r6(v[1]), r6(v[2])];
}
