// dome, kernel side: the flat face found on the part as it stands; on a
// round face (one circular edge) its half profile, a circular or elliptical
// arc from the rim to the top, revolved about the face's axis; on any other
// face its outline lofted up through copies shrunk along the same curve to a
// point. Added to the face's body, or cut from it reversed.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../../doc/types";
import { add3, cross3, dist3, dot3, normalize3, scale3, sub3 } from "../../geom/vec";
import { findFace } from "../../kernel/datum";
import { isValidShape } from "../../kernel/measure";
import { scoped, type OC, type Scope } from "../../kernel/oc";
import { dir, fuseInto, identity, OpError, pnt, removeFrom, vec } from "../../kernel/ops";
import type { KernelOp } from "../kernelDefs";
import type { DomeFeature, DomeShape } from "./doc";

/** The solid of revolution of the dome on a round face: centre c, unit outward normal n (the way it rises), radius a. */
function roundDome(oc: OC, s: Scope, c: Vec3, n: Vec3, a: number, h: number, shape: DomeShape): TopoDS_Shape {
  const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize3(sub3(ref, scale3(n, dot3(ref, n))));
  const at = (r: number, z: number) => add3(c, add3(scale3(u, r), scale3(n, z)));
  const edge = (mk: { IsDone(): boolean; Edge(): unknown }) => {
    if (!mk.IsDone()) throw new OpError("could not build the dome's profile");
    return s.track(mk.Edge() as never);
  };
  let arc;
  if (shape === "spherical") {
    const R = (a * a + h * h) / (2 * h);
    // The arc's middle, half way (in angle about the sphere's centre) between the rim and the top.
    const rim = Math.atan2(R - h, a);
    const mid = (rim + Math.PI / 2) / 2;
    const m = s.track(new oc.GC_MakeArcOfCircle(pnt(oc, s, at(a, 0)), pnt(oc, s, at(R * Math.cos(mid), h - R + R * Math.sin(mid))), pnt(oc, s, at(0, h))));
    if (!m.IsDone()) throw new OpError("could not build the dome's arc");
    arc = edge(s.track(new oc.BRepBuilderAPI_MakeEdge(m.Value())));
  } else {
    // Half an ellipse: a across the face, h up; the larger is the major axis.
    const [X, Y, R, r] = a >= h ? [u, n, a, h] : [n, u, h, a];
    const elips = s.track(new oc.gp_Elips(s.track(new oc.gp_Ax2(pnt(oc, s, c), dir(oc, s, cross3(X, Y)), dir(oc, s, X))), R, r));
    arc = edge(s.track(new oc.BRepBuilderAPI_MakeEdge(elips, 0, Math.PI / 2)));
  }
  const base = edge(s.track(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, s, c), pnt(oc, s, at(a, 0)))));
  const axis = edge(s.track(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, s, at(0, h)), pnt(oc, s, c))));
  const mw = s.track(new oc.BRepBuilderAPI_MakeWire());
  for (const e of [base, arc, axis]) mw.Add(e as never);
  if (!mw.IsDone()) throw new OpError("could not close the dome's profile");
  const face = s.track(s.track(new oc.BRepBuilderAPI_MakeFace(s.track(mw.Wire()), true)).Face());
  const rev = s.track(new oc.BRepPrimAPI_MakeRevol(face, s.track(new oc.gp_Ax1(pnt(oc, s, c), dir(oc, s, n))), 2 * Math.PI, false));
  if (!rev.IsDone()) throw new OpError("could not revolve the dome");
  return s.track(rev.Shape());
}

/** How much of the face's size a section at height z keeps (1 at the rim, 0 at the top). */
function shrink(shape: DomeShape, z: number, h: number, a: number): number {
  if (shape === "elliptical") return Math.sqrt(Math.max(0, 1 - (z / h) ** 2));
  const R = (a * a + h * h) / (2 * h);
  return Math.sqrt(Math.max(0, R * R - (z + R - h) ** 2)) / a;
}

export const kernel: KernelOp<DomeFeature> = {
  op: "dome",
  run(ctx, f) {
    const { oc } = ctx;
    const info = findFace(ctx, f.face, "face");
    if (info.type !== "plane" || !info.normal) throw new OpError("face: a dome stands on a flat face; that face is curved");
    const shape = f.shape ?? "spherical";
    const n = normalize3(f.reverse ? scale3(info.normal, -1) : info.normal);
    const body = info.body ?? [...ctx.bodies.keys()][0];
    scoped((s) => {
      const part = ctx.part(s, true);
      const edges = part.edgeInfos.filter((e) => e.faces.includes(info.index) && !e.seam);
      let tool: TopoDS_Shape;
      const round = edges.length === 1 && edges[0].kind === "circle" && edges[0].center && edges[0].radius ? edges[0] : null;
      if (round) {
        tool = roundDome(oc, s, round.center!, n, round.radius!, f.height, shape);
      } else {
        // Any outline: lofted up through shrunk copies (about the face's centroid) to a point.
        const wire = oc.BRepTools.OuterWire(part.faces[info.index]);
        s.track(wire);
        const c = info.centroid;
        const a = Math.max(...edges.flatMap((e) => [e.start, e.end, e.mid]).map((p) => dist3(p, c)));
        const loft = s.track(new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6));
        const N = 8;
        for (let k = 0; k < N; k++) {
          const z = shape === "elliptical" ? f.height * Math.sin(((k / N) * Math.PI) / 2) : (f.height * k) / N;
          const t = identity(oc, s);
          t.SetScale(pnt(oc, s, c), Math.max(1e-3, shrink(shape, z, f.height, a)));
          const up = identity(oc, s);
          up.SetTranslation(vec(oc, s, scale3(n, z)));
          up.Multiply(t);
          const moved = s.track(s.track(new oc.BRepBuilderAPI_Transform(wire, up, true, false)).Shape());
          loft.AddWire(s.track(oc.TopoDS.Wire(moved)));
        }
        loft.AddVertex(s.track(s.track(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, s, add3(c, scale3(n, f.height))))).Vertex()));
        loft.Build(s.track(new oc.Message_ProgressRange()));
        if (!loft.IsDone()) throw new OpError("could not loft the dome over that face's outline; try a round face, or a lower dome");
        tool = s.track(loft.Shape());
      }
      if (!isValidShape(oc, s, tool)) throw new OpError("the dome's solid is invalid; try a lower dome");
      const now = ctx.need(body);
      const changed = f.reverse ? removeFrom(oc, s, [[body, now]], tool, { listed: true, what: "dish", missed: "" }) : new Map([[body, fuseInto(oc, s, now, tool, "dome")]]);
      ctx.commit(changed);
    });
  },
};
