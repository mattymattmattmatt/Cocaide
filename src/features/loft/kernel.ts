// loft, kernel side: each section's loop lined up with the one before (same
// way round, nearest start; src/features/loft/align.ts), joined with
// BRepOffsetAPI_ThruSections into a solid (a point at either end for a
// pointed loft, the first loop again at the end for a closed one), the
// sections' holes lofted the same way and cut out, then put in the part by
// the operation.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../../doc/types";
import { to3D } from "../../geom/frame";
import { dist3 } from "../../geom/vec";
import { isValidShape, volumeOf } from "../../kernel/measure";
import { scoped, type Scope } from "../../kernel/oc";
import { applyOperation } from "../../kernel/operation";
import { boolean, loopWire, noClosedProfile, OpError, pnt } from "../../kernel/ops";
import type { KernelOp, RebuildCtx } from "../kernelDefs";
import { alignLoops, loopCentroid, type PlacedLoop } from "./align";
import type { LoftFeature } from "./doc";

type Section = PlacedLoop | { point: Vec3 };

export const kernel: KernelOp<LoftFeature> = {
  op: "loft",
  run(ctx, f) {
    const { oc } = ctx;
    const sections = f.profiles.map((id, i) => sectionOf(ctx, f, id, i));
    // The holes: each section the same number, each lofted through its nearest in the next.
    const holeCounts = sections.map((sec) => ("point" in sec ? 0 : sec.holes.length));
    if (holeCounts.some((n) => n !== holeCounts[0])) {
      throw new OpError(`profiles: the sections have ${holeCounts.join(", ")} holes: to loft holes every section needs the same number (loft the outer shape, then cut the holes with a loft or extrude of their own)`);
    }
    const outer = alignLoops(sections.map((sec) => ("point" in sec ? sec : { frame: sec.frame, loop: sec.outer })));
    const holeChains = pairHoles(sections);
    scoped((s) => {
      let tool = thru(ctx, s, f, outer, "the loft");
      holeChains.forEach((chain, k) => {
        tool = boolean(oc, s, "cut", tool, thru(ctx, s, f, alignLoops(chain), `hole ${k + 1} of the loft`));
      });
      if (!isValidShape(oc, s, tool)) throw new OpError("the loft makes an invalid solid: the sections may be lined up so the surface crosses itself; check their order and that they are not drawn mirrored");
      applyOperation(ctx, s, f, tool, "loft");
    });
  },
};

interface LoopSection extends PlacedLoop {
  outer: PlacedLoop["loop"];
  holes: PlacedLoop["loop"][];
}

/** A section: the sketch's one region (outer loop and holes), or its one point at an end. */
function sectionOf(ctx: RebuildCtx, f: LoftFeature, id: string, i: number): LoopSection | { point: Vec3 } {
  const at = `profiles[${i}]`;
  const profile = ctx.profiles.get(id);
  if (!profile) throw new OpError(`${at}: ${ctx.missing(id, "sketch")}, so it is no section to loft through`);
  if (profile.regions.length > 1) throw new OpError(`${at}: sketch "${id}" has ${profile.regions.length} separate regions: a loft passes through one region in each sketch (split it into sketches, or loft each separately)`);
  if (profile.regions.length === 1) {
    const r = profile.regions[0];
    return { frame: profile.frame, loop: r.outer, outer: r.outer, holes: r.holes };
  }
  // No closed profile: a lone point makes a pointed end.
  const entities = (ctx.sketch(id)?.entities ?? []).filter((e) => !(e.construction ?? !!e.ref));
  const points = entities.filter((e) => e.type === "point");
  if (points.length === 1 && entities.length === 1 && points[0].type === "point") {
    const end = i === 0 || i === f.profiles.length - 1;
    if (!end || f.closed) throw new OpError(`${at}: sketch "${id}" is a point: a loft can come to a point only at its first or last section${f.closed ? ", and a closed loft has no ends" : ""}`);
    return { point: to3D(profile.frame, points[0].at) };
  }
  throw new OpError(`${at}: ${noClosedProfile(id, profile, "loft through")}${points.length ? " (a sketch with just one point and nothing else makes a pointed end)" : ""}`);
}

/** The sections' holes as chains through the loft: each hole joined to the nearest of the next section's. */
function pairHoles(sections: (LoopSection | { point: Vec3 })[]): PlacedLoop[][] {
  const first = sections[0];
  if ("point" in first || first.holes.length === 0) return [];
  const chains: PlacedLoop[][] = first.holes.map((h) => [{ frame: first.frame, loop: h }]);
  for (let k = 1; k < sections.length; k++) {
    const sec = sections[k] as LoopSection;
    const free = sec.holes.map((h) => ({ frame: sec.frame, loop: h }));
    for (const chain of chains) {
      const last = chain[chain.length - 1];
      const from = to3D(last.frame, loopCentroid(last.loop));
      free.sort((a, b) => dist3(to3D(a.frame, loopCentroid(a.loop)), from) - dist3(to3D(b.frame, loopCentroid(b.loop)), from));
      chain.push(free.shift()!);
    }
  }
  return chains;
}

/** The sections joined into a solid. */
function thru(ctx: RebuildCtx, s: Scope, f: LoftFeature, sections: Section[], what: string): TopoDS_Shape {
  const { oc } = ctx;
  const ts = s.track(new oc.BRepOffsetAPI_ThruSections(true, !!f.ruled, 1e-6));
  const wires = sections.map((sec) => ("point" in sec ? null : loopWire(oc, s, sec.frame, sec.loop)));
  sections.forEach((sec, k) => {
    if ("point" in sec) ts.AddVertex(s.track(s.track(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, s, sec.point))).Vertex()));
    else ts.AddWire(wires[k]!);
  });
  if (f.closed) ts.AddWire(wires[0]!);
  ts.Build(s.track(new oc.Message_ProgressRange()));
  if (!ts.IsDone()) throw new OpError(`${what} failed in the kernel: the sections may cross each other or be too unlike to join; check their order`);
  let solid = s.track(ts.Shape());
  if (volumeOf(oc, s, solid) < 0) solid = s.track(solid.Reversed());
  if (volumeOf(oc, s, solid) <= 1e-9) throw new OpError(`${what} has no volume: are the sections all in one plane?`);
  return solid;
}
