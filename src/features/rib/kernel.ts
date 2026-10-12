// rib, kernel side. The rule for "out to the body's walls":
//   1. The chain's end lines are extended a long way, so the rib can reach
//      walls the line stops short of.
//   2. A long slab is made from the (extended) chain toward one side: in the
//      sketch's plane, the strip the chain sweeps across itself, "thickness"
//      thick across the plane; out of the plane, the chain's band of
//      "thickness" pushed straight along the normal.
//   3. The body is cut out of the slab. What is left falls apart into pieces;
//      the rib is the pieces that touch the line as drawn (not its
//      extensions), and every one of them must be closed in by the body: a
//      piece that runs on to the far end of the slab never met a wall.
//   4. Both sides are tried; the rib goes where it is closed in (the first
//      side when both are: left of the line's direction in the plane, behind
//      the sketch out of it); "flip" takes the other one.
// Limits: the region between the line and the walls must be closed in on
// the side it fills (a line across an open corner, or beyond the body's
// outline, has nothing to stop at, and says so); arcs at the chain's ends are
// not extended.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../../doc/types";
import { to3D } from "../../geom/frame";
import { dist3, dot3, len3, scale3, sub3 } from "../../geom/vec";
import { boundingBoxOf, volumeOf } from "../../kernel/measure";
import { scoped, type Scope } from "../../kernel/oc";
import { compoundOf, fuseInto, OpError, prism, profileFaces, type SketchProfile } from "../../kernel/ops";
import { chainEdges } from "../../kernel/paths";
import { BandError } from "../revolve/band";
import { ChainError, sketchChain, type Chain } from "../sweep/chain";
import type { KernelOp, RebuildCtx } from "../kernelDefs";
import type { RibFeature } from "./doc";
import { chainLeft, extendedChain, ribBand, sweptRegions } from "./region";

export const kernel: KernelOp<RibFeature> = {
  op: "rib",
  run(ctx, f) {
    const { oc } = ctx;
    const base = ctx.profiles.get(f.sketch);
    const sketch = ctx.sketch(f.sketch);
    if (!base || !sketch) throw new OpError(`${ctx.missing(f.sketch, "sketch")}, so there is no line for the rib`);
    let chain: Chain;
    try {
      chain = sketchChain(sketch.entities, "a rib", false);
    } catch (e) {
      if (e instanceof ChainError) throw new OpError(`sketch "${f.sketch}": ${e.message}`);
      throw e;
    }
    const name = f.body ?? [...ctx.bodies.keys()][0];
    if (name === undefined) throw new OpError("there is no body before the rib to stiffen: a rib reaches out to a body's walls");
    const body = ctx.need(name);
    scoped((s) => {
      const frame = base.frame;
      const box = boundingBoxOf(oc, s, body);
      if (!box) throw new OpError(`body "${name}" is empty`);
      // Long enough to cross the whole body from anywhere on the line.
      const centre = scale3([box.min[0] + box.max[0], box.min[1] + box.max[1], box.min[2] + box.max[2]], 0.5);
      const reach = len3(sub3(box.max, box.min)) + Math.max(...chain.segs.map((seg) => dist3(to3D(frame, seg.a), centre)), dist3(to3D(frame, chain.segs[chain.segs.length - 1].b), centre));
      const far = 2 * reach + 10;
      const long = extendedChain(chain, far);
      const drawn = s.track(new oc.BRepBuilderAPI_MakeWire());
      for (const e of chainEdges(oc, s, frame, chain)) drawn.Add(e);
      const line = s.track(drawn.Wire());
      const start = to3D(frame, chain.segs[0].a);

      // The two sides, the default first.
      const sides: { label: string; slab: () => TopoDS_Shape; along: Vec3 }[] = [];
      if (!f.normal) {
        const n = chainLeft(chain);
        const t = f.thickness;
        const [from, depth] = f.side === "left" ? [0, t] : f.side === "right" ? [-t, t] : [-t / 2, t];
        for (const k of [1, -1]) {
          const v: [number, number] = [n[0] * far * k, n[1] * far * k];
          const profile: SketchProfile = { frame, regions: sweptRegions(long, v), area: 0 };
          sides.push({
            label: k === 1 ? "left of the line" : "right of the line",
            along: sub3(to3D(frame, v), frame.origin),
            slab: () => fuseAll(ctx, s, profileFaces(oc, s, profile).map((face) => prism(oc, s, [face], scale3(frame.z, from), scale3(frame.z, depth)))),
          });
        }
      } else {
        let band;
        try {
          band = ribBand(long, f.thickness, f.side ?? "both");
        } catch (e) {
          if (e instanceof BandError) throw new OpError(`thickness: ${e.message}`);
          throw e;
        }
        const profile: SketchProfile = { frame, regions: [band], area: 0 };
        for (const k of [-1, 1]) {
          const along = scale3(frame.z, far * k);
          sides.push({ label: k === -1 ? "behind the sketch" : "in front of the sketch", along, slab: () => prism(oc, s, profileFaces(oc, s, profile), [0, 0, 0], along) });
        }
      }

      const tried = sides.map((side) => ({ side, fill: fillOf(ctx, s, side.slab(), body, line, start, side.along, far) }));
      const ok = tried.filter((x) => typeof x.fill !== "string");
      let pick: (typeof tried)[number] | undefined;
      if (f.flip) {
        if (ok.length === 0) throw new OpError(nowhere(tried));
        // The other side from the one it would take.
        pick = tried.find((x) => x !== ok[0]);
        if (!pick || typeof pick.fill === "string") throw new OpError(`flip: ${pick?.side.label ?? "the other side"} the rib ${pick && typeof pick.fill === "string" ? pick.fill : "has nowhere to go"}; leave out flip to reach ${ok[0].side.label}`);
      } else {
        pick = ok[0];
        if (!pick) throw new OpError(nowhere(tried));
      }
      const tool = pick.fill as TopoDS_Shape;
      ctx.commit(new Map([[name, fuseInto(oc, s, body, tool, "rib")]]));
      ctx.setSeed(f.id, { tool, kind: "fuse", into: name });
    });
  },
};

/** Why neither side works. */
function nowhere(tried: { side: { label: string }; fill: TopoDS_Shape | string }[]): string {
  return `the rib meets nothing to stop at: ${tried.map((x) => `${x.side.label} it ${x.fill as string}`).join("; ")}. Draw the line where the body closes in around it (across an inside corner, between walls)`;
}

/** Several solids fused into one. */
function fuseAll(ctx: RebuildCtx, s: Scope, shapes: TopoDS_Shape[]): TopoDS_Shape {
  if (shapes.length === 1) return shapes[0];
  const { oc } = ctx;
  const progress = s.track(new oc.Message_ProgressRange());
  const op = s.track(new oc.BRepAlgoAPI_Fuse());
  op.SetArguments(s.track(new oc.NCollection_List_TopoDS_Shape([shapes[0]])));
  op.SetTools(s.track(new oc.NCollection_List_TopoDS_Shape(shapes.slice(1))));
  op.Build(progress);
  if (!op.IsDone()) throw new OpError("could not join the pieces of the rib's slab");
  return s.track(op.Shape());
}

/**
 * What the rib fills on one side: the slab less the body, the pieces of it
 * that touch the drawn line, each closed in by the body; or why not ("runs
 * past the body's edge", "meets no material").
 */
function fillOf(ctx: RebuildCtx, s: Scope, slab: TopoDS_Shape, body: TopoDS_Shape, line: TopoDS_Shape, start: Vec3, along: Vec3, far: number): TopoDS_Shape | string {
  const { oc } = ctx;
  const cut = s.track(new oc.BRepAlgoAPI_Cut(slab, body, s.track(new oc.Message_ProgressRange())));
  if (!cut.IsDone()) return "could not be cut against the body";
  const rest = s.track(cut.Shape());
  const pieces: TopoDS_Shape[] = [];
  const ex = s.track(new oc.TopExp_Explorer(rest, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) pieces.push(s.track(ex.Current()));
  const touching = pieces.filter((p) => {
    const d = s.track(new oc.BRepExtrema_DistShapeShape(p, line));
    return d.IsDone() && d.Value() < 1e-4 && volumeOf(oc, s, p) > 1e-9;
  });
  if (touching.length === 0) return "would lie wholly inside the body (the line is buried in material)";
  const dir = scale3(along, 1 / len3(along));
  for (const p of touching) {
    const b = boundingBoxOf(oc, s, p);
    if (!b) continue;
    let reach = -Infinity;
    for (let i = 0; i < 8; i++) {
      const corner: Vec3 = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
      reach = Math.max(reach, dot3(sub3(corner, start), dir));
    }
    if (reach > 0.75 * far) return "runs on past the body without meeting a wall";
  }
  return compoundOf(oc, s, touching);
}
