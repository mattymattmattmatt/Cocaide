// The cut list, read from the bodies (Phase J): a member's length and end
// angles are measured on its trimmed solid, never worked out from the joints
// that trimmed it, so the list can't disagree with the model.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../doc/types";
import { dot3, sub3 } from "../geom/vec";
import { type OC, type Scope } from "./oc";
import { faceInfo, listEdges, listFaces } from "./topology";

export interface MemberCut {
  /** End to end along the line: long point to long point, mm. */
  length: number;
  /** The angle of each end's cut from square, degrees: [at from, at to]. 0 is square, 45 a mitre. */
  angles: [number, number];
  /** The length round the outside of each end face, mm: what an all-round weld there is. */
  perimeters: [number, number];
  /** The ends on the member's line, long point to long point: [at from, at to]. */
  ends: [Vec3, Vec3];
}

/** Samples along a curved edge: enough that an ellipse's long point is within a micron. */
const SAMPLES = 256;

export function memberCut(oc: OC, s: Scope, body: TopoDS_Shape, from: Vec3, dir: Vec3): MemberCut {
  let lo = Infinity;
  let hi = -Infinity;
  const along = (p: Vec3) => {
    const t = dot3(sub3(p, from), dir);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  };
  for (const edge of listEdges(oc, s, body).edges) {
    const curve = s.track(new oc.BRepAdaptor_Curve(edge));
    const t0 = curve.FirstParameter();
    const t1 = curve.LastParameter();
    const n = curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line ? 1 : SAMPLES;
    for (let i = 0; i <= n; i++) {
      const p = curve.EvalD0(t0 + ((t1 - t0) * i) / n);
      along([p.X(), p.Y(), p.Z()]);
      p.delete();
    }
  }
  // The end faces: planar, not along the line. Each belongs to the end it is nearer.
  const angles: [number, number] = [0, 0];
  const perimeters: [number, number] = [0, 0];
  const best: [number, number] = [-1, -1];
  for (const face of listFaces(oc, s, body)) {
    const info = faceInfo(oc, s, face, 0);
    if (info.type !== "plane" || !info.normal) continue;
    const c = Math.abs(dot3(info.normal, dir));
    if (c < 1e-6) continue;
    const t = dot3(sub3(info.centroid, from), dir);
    const end = t - lo < hi - t ? 0 : 1;
    // The biggest face at an end is its cut; anything smaller is a notch in it.
    if (info.area <= best[end]) continue;
    best[end] = info.area;
    angles[end] = (Math.acos(Math.min(1, c)) * 180) / Math.PI;
    const props = s.track(new oc.GProp_GProps());
    oc.BRepGProp.LinearProperties(s.track(oc.BRepTools.OuterWire(face)), props, false, false);
    perimeters[end] = props.Mass();
  }
  const on = (t: number): Vec3 => [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t];
  return { length: hi - lo, angles, perimeters, ends: [on(lo), on(hi)] };
}
