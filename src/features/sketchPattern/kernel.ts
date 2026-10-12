// sketchPattern, kernel side: each seed's tool moved, in the sketch's plane,
// from where the seed is to each other place (the sketch's points as the
// rebuild solved them, or the table of positions), added or cut as the seed
// was. A hole copied this way is one callout with a count.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import { seedIds, type Vec2 } from "../../doc/types";
import { to3D } from "../../geom/frame";
import { roundTo, sub3 } from "../../geom/vec";
import { scoped } from "../../kernel/oc";
import { OpError } from "../../kernel/ops";
import { offsetInstances } from "../../kernel/pattern";
import type { KernelOp } from "../kernelDefs";
import { copyPlaces, type SketchPatternFeature } from "./doc";

export const kernel: KernelOp<SketchPatternFeature> = {
  op: "sketchPattern",
  run(ctx, f) {
    const seeds = seedIds(f).map((id) => {
      const seed = ctx.seed(id);
      if (!seed) throw new OpError(`${ctx.missing(id, "feature")}, so there is nothing to repeat`);
      return [id, seed] as const;
    });
    if (ctx.bodies.size === 0) throw new OpError("nothing to pattern onto: there is no solid before this feature");
    const profile = ctx.profiles.get(f.sketch);
    const sketch = ctx.sketch(f.sketch);
    if (!profile || !sketch) throw new OpError(`${ctx.missing(f.sketch, "sketch")}, so there are no places to copy to`);
    const places: Vec2[] = f.positions ?? sketch.entities.flatMap((e) => (e.type === "point" ? [e.at] : []));
    if (places.length === 0) throw new OpError(`sketch "${f.sketch}" has no points: put a point (the Point tool) where each copy goes, or list "positions"`);
    const from = f.from ?? places[0];
    const origin = to3D(profile.frame, from);
    const offsets = copyPlaces(places, from).map((p) => ({ offset: sub3(to3D(profile.frame, p), origin), label: `at [${p.map((x) => roundTo(x, 4)).join(", ")}]` }));
    let made = 0;
    scoped((s) => {
      const instances = offsetInstances(ctx.oc, s, offsets, f.skip);
      made = instances.length;
      // Each seed in turn, onto the bodies as the seeds before it left them.
      const changed = new Map<string, TopoDS_Shape>();
      for (const [id, seed] of seeds) {
        const mine = seeds.length > 1 ? instances.map((i) => ({ ...i, label: `${id}: ${i.label}` })) : instances;
        ctx.repeat(s, mine, seed, (k) => `${seed.newBody}_${mine[k].n}`, "pattern", changed);
      }
      ctx.commit(changed);
    });
    for (const [id] of seeds) for (const h of ctx.holes.ofFeature(id)) h.copies += made;
  },
};
