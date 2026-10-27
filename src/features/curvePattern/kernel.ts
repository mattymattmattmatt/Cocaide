// curvePattern, kernel side: the path as one wire (a sketch chain placed in
// its plane, or model edges put end to end), the instance distances along
// it, and each seed's tool moved there (turned with the tangent unless the
// orientation is fixed).

import { seedIds } from "../../doc/types";
import { scoped, type Scope } from "../../kernel/oc";
import { OpError } from "../../kernel/ops";
import { chainEdges, orderEdges, pathOf, reversedPath, samplePath, type PathShape } from "../../kernel/paths";
import { curveInstances, pathPlaneNormal, repeatSeeds, seedsOf } from "../../kernel/pattern";
import { edgeSelectionError, selectEdges } from "../../kernel/selectors";
import type { Vec3 } from "../../doc/types";
import type { KernelOp, RebuildCtx } from "../kernelDefs";
import { ChainError, sketchChain } from "../sweep/chain";
import { curveDistances, type CurvePatternFeature } from "./doc";

/** The path and the normal of the plane it lies in (null: straight, or not flat). */
function curveOf(ctx: RebuildCtx, s: Scope, f: CurvePatternFeature): { path: PathShape; normal: Vec3 | null } {
  const { oc } = ctx;
  if ("sketch" in f.path) {
    const id = f.path.sketch;
    const base = ctx.profiles.get(id);
    const sketch = ctx.sketch(id);
    if (!base || !sketch) throw new OpError(`path.sketch: ${ctx.missing(id, "sketch")}, so there is no curve to follow`);
    let chain;
    try {
      chain = sketchChain(sketch.entities, "a curve-driven pattern");
    } catch (e) {
      if (e instanceof ChainError) throw new OpError(`path.sketch: sketch "${id}": ${e.message}`);
      throw e;
    }
    return { path: pathOf(oc, s, chainEdges(oc, s, base.frame, chain), chain.closed), normal: base.frame.z };
  }
  if (ctx.bodies.size === 0) throw new OpError("path.edges: there is no solid before this feature to take edges from");
  const part = ctx.part(s, true);
  const chosen = new Set<number>();
  f.path.edges.forEach((sel, i) => {
    const where = `path.edges[${i}]`;
    const found = selectEdges(part.edgeInfos, part.faceInfos, sel, where);
    const problem = edgeSelectionError(sel, found, where);
    if (problem) throw new OpError(problem);
    for (const e of found.matches) chosen.add(e.index);
  });
  const ordered = orderEdges(oc, s, [...chosen].sort((a, b) => a - b).map((i) => part.edges[i]), "path.edges");
  const path = pathOf(oc, s, ordered.edges, ordered.closed);
  return { path, normal: pathPlaneNormal(samplePath(oc, s, path, { perEdge: 8 }).map((p) => p.p)) };
}

export const kernel: KernelOp<CurvePatternFeature> = {
  op: "curvePattern",
  run(ctx, f) {
    const seeds = seedsOf(ctx, seedIds(f));
    scoped((s) => {
      const curve = curveOf(ctx, s, f);
      const path = f.reverse ? reversedPath(ctx.oc, s, curve.path) : curve.path;
      const distances = curveDistances(path.length, path.closed, f.count, f.spacing);
      if (typeof distances === "string") throw new OpError(`${f.spacing !== undefined ? "spacing" : "count"}: ${distances}`);
      repeatSeeds(ctx, s, seeds, curveInstances(ctx.oc, s, path, distances, f.orientation !== "fixed", curve.normal, f.skip));
    });
  },
};
