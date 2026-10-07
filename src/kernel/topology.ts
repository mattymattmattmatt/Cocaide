// Face queries on a B-rep. Everything here is recomputed from geometry on
// every rebuild; nothing stores a topology index.

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../doc/types";
import { cross3, dist3, dot3, len3, normalize3, scale3, sub3 } from "../geom/vec";
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
  /** Area centroid of the face. */
  centroid: Vec3;
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
  const cm = s.track(props.CentreOfMass());
  const centroid: Vec3 = [cm.X(), cm.Y(), cm.Z()];
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
    return { index, type: "plane", area, centroid, normal: n, point, offset: dot3(point, n) };
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
      centroid,
      cylinder: { radius: cyl.Radius(), axis, origin, concave, span: u1 - u0, axial },
    };
  }

  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone) return { index, type: "cone", area, centroid };
  return { index, type: "other", area, centroid };
}

export interface EdgeInfo {
  /** Position among the unique edges, in TopExp_Explorer order. Matches the edge mesh groups. */
  index: number;
  kind: "line" | "circle" | "other";
  length: number;
  start: Vec3;
  end: Vec3;
  mid: Vec3;
  /** Centre of the edge: a line's midpoint, a full circle's centre. */
  centroid: Vec3;
  /** Unit start-to-end direction, lines only. */
  direction?: Vec3;
  /** Circles only. */
  radius?: number;
  center?: Vec3;
  axis?: Vec3;
  /** Indices of the faces this edge bounds (FaceInfo.index). */
  faces: number[];
  /**
   * The edge where a closed surface (a hole wall) meets itself. It bounds one
   * face only and is not a feature edge: selectors and the viewport skip it.
   */
  seam: boolean;
}

const HASH_BOUND = 1 << 30;

/** Unique edges in explorer order. Each edge appears once even though the explorer visits it per face. */
export function listEdges(oc: OC, s: Scope, shape: TopoDS_Shape): { edges: TopoDS_Edge[]; find(e: TopoDS_Edge): number } {
  const edges: TopoDS_Edge[] = [];
  const buckets = new Map<number, number[]>();
  const find = (e: TopoDS_Edge) => {
    const bucket = buckets.get(oc.ReplicadShapeHasher.HashCode(e, HASH_BOUND)) ?? [];
    return bucket.find((i) => edges[i].IsSame(e)) ?? -1;
  };
  const ex = s.track(new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) {
    const e = s.track(oc.TopoDS.Edge(s.track(ex.Current())));
    if (find(e) >= 0) continue;
    const hash = oc.ReplicadShapeHasher.HashCode(e, HASH_BOUND);
    buckets.set(hash, [...(buckets.get(hash) ?? []), edges.length]);
    edges.push(e);
  }
  return { edges, find };
}

export function describeEdges(oc: OC, s: Scope, shape: TopoDS_Shape, faces: TopoDS_Face[]): { edges: TopoDS_Edge[]; infos: EdgeInfo[] } {
  const { edges, find } = listEdges(oc, s, shape);
  const infos = edges.map((e, i) => edgeInfo(oc, s, e, i));
  faces.forEach((face, fi) => {
    const ex = s.track(new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; ex.More(); ex.Next()) {
      const idx = find(s.track(oc.TopoDS.Edge(s.track(ex.Current()))));
      if (idx >= 0 && !infos[idx].faces.includes(fi)) infos[idx].faces.push(fi);
    }
  });
  for (const info of infos) info.seam = info.faces.length === 1;
  return { edges, infos };
}

function edgeInfo(oc: OC, s: Scope, edge: TopoDS_Edge, index: number): EdgeInfo {
  const props = s.track(new oc.GProp_GProps());
  oc.BRepGProp.LinearProperties(edge, props, false, false);
  const cm = s.track(props.CentreOfMass());
  const curve = s.track(new oc.BRepAdaptor_Curve(edge));
  const t0 = curve.FirstParameter();
  const t1 = curve.LastParameter();
  const at = (t: number): Vec3 => {
    const p = curve.EvalD0(t);
    const v: Vec3 = [p.X(), p.Y(), p.Z()];
    p.delete();
    return v;
  };
  const start = at(t0);
  const end = at(t1);
  const info: EdgeInfo = {
    index,
    kind: "other",
    length: props.Mass(),
    start,
    end,
    mid: at((t0 + t1) / 2),
    centroid: [cm.X(), cm.Y(), cm.Z()],
    faces: [],
    seam: false,
  };
  const type = curve.GetType();
  if (type === oc.GeomAbs_CurveType.GeomAbs_Line && dist3(start, end) > 0) {
    info.kind = "line";
    info.direction = normalize3(sub3(end, start));
  } else if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
    const circ = s.track(curve.Circle());
    const loc = s.track(circ.Location());
    const ax = s.track(circ.Axis());
    const d = s.track(ax.Direction());
    info.kind = "circle";
    info.radius = circ.Radius();
    info.center = [loc.X(), loc.Y(), loc.Z()];
    info.axis = [d.X(), d.Y(), d.Z()];
  }
  return info;
}

/**
 * What a face is, independent of how later features trimmed it: a plane's
 * normal and offset, a cylinder's radius and axis line. Used to find the
 * feature that first made a face.
 */
export function faceSignature(f: FaceInfo): string {
  const r = (x: number, q: number) => Math.round(x / q) * q + 0;
  const v = (a: Vec3, q: number) => a.map((x) => r(x, q).toFixed(6)).join(",");
  if (f.type === "plane" && f.normal) return `plane ${v(f.normal, 1e-4)} ${r(f.offset ?? 0, 1e-4).toFixed(4)}`;
  if (f.type === "cylinder" && f.cylinder) {
    const c = f.cylinder;
    // The axis line, sign-free: direction with its first non-zero component positive, and its point nearest the origin.
    const k = c.axis.findIndex((x) => Math.abs(x) > 1e-9);
    const axis = c.axis[k] < 0 ? scale3(c.axis, -1) : c.axis;
    const foot = sub3(c.origin, scale3(axis, dot3(c.origin, axis)));
    return `cylinder ${r(c.radius, 1e-4).toFixed(4)} ${v(axis, 1e-4)} ${v(foot, 1e-3)}`;
  }
  return `${f.type} ${v(f.centroid, 1e-2)}`;
}
