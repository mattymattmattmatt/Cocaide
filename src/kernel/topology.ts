// Face queries on a B-rep. Everything here is recomputed from geometry on
// every rebuild; nothing stores a topology index.

import type { TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../doc/types";
import { cross3, dot3, len3, normalize3, scale3, sub3 } from "../geom/vec";
import { type OC, type Scope } from "./oc";

export interface CylinderInfo {
  radius: number;
  /** Unit axis direction, as OCCT stores it. */
  axis: Vec3;
  /** A point on the axis. */
  origin: Vec3;
  /** Material is outside the cylinder: a hole wall, not a boss. */
  concave: boolean;
  /** Angular span in radians; 2π for a full cylinder. */
  span: number;
  /** Extent along `axis`, measured from `origin`. */
  axial: [number, number];
}

export interface FaceInfo {
  /** Position in TopExp_Explorer order for this rebuild only. Never store it. */
  index: number;
  type: "plane" | "cylinder" | "cone" | "other";
  area: number;
  /** Outward unit normal, planes only. */
  normal?: Vec3;
  /** A point on the plane, planes only. */
  point?: Vec3;
  /** Signed distance of the plane from the origin along `normal`. */
  offset?: number;
  cylinder?: CylinderInfo;
}

export function listFaces(oc: OC, s: Scope, shape: TopoDS_Shape): TopoDS_Face[] {
  const faces: TopoDS_Face[] = [];
  const ex = s.track(new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) {
    const current = s.track(ex.Current());
    faces.push(s.track(oc.TopoDS.Face(current)));
  }
  return faces;
}

export function countSubShapes(oc: OC, s: Scope, shape: TopoDS_Shape, kind: "solid" | "face" | "edge"): number {
  const type = {
    solid: oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    face: oc.TopAbs_ShapeEnum.TopAbs_FACE,
    edge: oc.TopAbs_ShapeEnum.TopAbs_EDGE,
  }[kind];
  const ex = s.track(new oc.TopExp_Explorer(shape, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  let n = 0;
  for (; ex.More(); ex.Next()) n++;
  return n;
}

export function describeFaces(oc: OC, s: Scope, shape: TopoDS_Shape): { faces: TopoDS_Face[]; infos: FaceInfo[] } {
  const faces = listFaces(oc, s, shape);
  return { faces, infos: faces.map((f, i) => faceInfo(oc, s, f, i)) };
}

export function faceInfo(oc: OC, s: Scope, face: TopoDS_Face, index: number): FaceInfo {
  const props = s.track(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(face, props, false, false);
  const area = props.Mass();
  const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
  const adaptor = s.track(new oc.BRepAdaptor_Surface(face, true));
  const type = adaptor.GetType();

  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
    const plane = s.track(adaptor.Plane());
    const ax = s.track(plane.Axis());
    const d = s.track(ax.Direction());
    const loc = s.track(plane.Location());
    const n = normalize3(scale3([d.X(), d.Y(), d.Z()], reversed ? -1 : 1));
    const point: Vec3 = [loc.X(), loc.Y(), loc.Z()];
    return { index, type: "plane", area, normal: n, point, offset: dot3(point, n) };
  }

  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
    const cyl = s.track(adaptor.Cylinder());
    const pos = s.track(cyl.Position());
    const d = s.track(pos.Direction());
    const loc = s.track(pos.Location());
    const axis: Vec3 = normalize3([d.X(), d.Y(), d.Z()]);
    const origin: Vec3 = [loc.X(), loc.Y(), loc.Z()];
    const u0 = adaptor.FirstUParameter();
    const u1 = adaptor.LastUParameter();
    const v0 = adaptor.FirstVParameter();
    const v1 = adaptor.LastVParameter();
    // Concavity from the actual outward normal at the middle of the face.
    const ev = adaptor.EvalD1((u0 + u1) / 2, (v0 + v1) / 2);
    const p: Vec3 = [ev.Point.X(), ev.Point.Y(), ev.Point.Z()];
    const du: Vec3 = [ev.D1U.X(), ev.D1U.Y(), ev.D1U.Z()];
    const dv: Vec3 = [ev.D1V.X(), ev.D1V.Y(), ev.D1V.Z()];
    for (const v of [ev.Point, ev.D1U, ev.D1V]) (v as unknown as { delete(): void }).delete();
    const outward = scale3(cross3(du, dv), reversed ? -1 : 1);
    const rel = sub3(p, origin);
    const radial = sub3(rel, scale3(axis, dot3(rel, axis)));
    const concave = len3(radial) > 0 && dot3(outward, radial) < 0;
    // For a cylinder v is the axial coordinate along the Ax3 direction.
    const axial: [number, number] = [Math.min(v0, v1), Math.max(v0, v1)];
    return {
      index,
      type: "cylinder",
      area,
      cylinder: { radius: cyl.Radius(), axis, origin, concave, span: u1 - u0, axial },
    };
  }

  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone) return { index, type: "cone", area };
  return { index, type: "other", area };
}
