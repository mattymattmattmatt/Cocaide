// Views of the rebuilt part (Phase L): OCCT's hidden-line removal projects
// every body at once, so one body hides another, and the visible and hidden
// edges are read back per body (a balloon needs to know which lines are its
// member's). The 2D coordinates are the view's own frame (src/drafting/views),
// in model mm: the sheet scales and places them.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec2, ViewLook } from "../doc/types";
import { viewFrame } from "../drafting/views";
import { type OC, type Scope, scoped } from "./oc";
import { listEdges } from "./topology";

export interface ProjectedBody {
  name: string;
  /** Polylines, view mm. */
  visible: Vec2[][];
  hidden: Vec2[][];
}

export interface ProjectedView {
  id: string;
  look: ViewLook;
  bodies: ProjectedBody[];
}

/** Arcs are drawn in steps of at most this angle. */
const ARC_STEP = Math.PI / 36;
/** Curves that are neither lines nor arcs: this many steps. */
const CURVE_STEPS = 48;

export function projectViews(oc: OC, bodies: { name: string; shape: TopoDS_Shape }[], views: { id: string; look: ViewLook }[]): ProjectedView[] {
  return views.map((v) =>
    scoped((s) => {
      const f = viewFrame(v.look);
      const ax = s.track(new oc.gp_Ax2(s.track(new oc.gp_Pnt(0, 0, 0)), s.track(new oc.gp_Dir(...f.eye)), s.track(new oc.gp_Dir(...f.right))));
      const algo = new oc.HLRBRep_Algo();
      try {
        for (const b of bodies) algo.Add(b.shape, 0);
        algo.Projector(s.track(new oc.HLRAlgo_Projector(ax)));
        algo.Update();
        algo.Hide();
        const hlr = s.track(new oc.HLRBRep_HLRToShape(algo));
        return {
          id: v.id,
          look: v.look,
          bodies: bodies.map((b) => ({
            name: b.name,
            // Sharp edges and the outlines of curved faces; tangent edges are left out, as drawings do.
            visible: [...polylines(oc, s, hlr.VCompound(b.shape)), ...polylines(oc, s, hlr.OutLineVCompound(b.shape))],
            hidden: [...polylines(oc, s, hlr.HCompound(b.shape)), ...polylines(oc, s, hlr.OutLineHCompound(b.shape))],
          })),
        };
      } finally {
        algo.delete();
      }
    }),
  );
}

function polylines(oc: OC, s: Scope, compound: TopoDS_Shape): Vec2[][] {
  s.track(compound);
  if (compound.IsNull()) return [];
  const out: Vec2[][] = [];
  for (const edge of listEdges(oc, s, compound).edges) {
    const curve = s.track(new oc.BRepAdaptor_Curve(edge));
    const t0 = curve.FirstParameter();
    const t1 = curve.LastParameter();
    const type = curve.GetType();
    const n =
      type === oc.GeomAbs_CurveType.GeomAbs_Line
        ? 1
        : type === oc.GeomAbs_CurveType.GeomAbs_Circle || type === oc.GeomAbs_CurveType.GeomAbs_Ellipse
          ? Math.max(2, Math.ceil(Math.abs(t1 - t0) / ARC_STEP))
          : CURVE_STEPS;
    const pts: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const p = curve.Value(t0 + ((t1 - t0) * i) / n);
      pts.push([round4(p.X()), round4(p.Y())]);
      p.delete();
    }
    out.push(pts);
  }
  return out;
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4 + 0;
}
