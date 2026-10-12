// Evaluate: what the Measure and Mass Properties tools ask of the rebuilt
// part. Read-only, plain data out (the kernel worker serves it; tests call it
// directly).
//
// - minDistance: the closest points between two things picked in the view (a
//   face, an edge, a vertex, a plane, an axis or a point), by
//   BRepExtrema_DistShapeShape (two-argument form: a third argument is not
//   bound in this build). A plane or axis is infinite; it is measured as a
//   square or a line far larger than the part, which gives the same answer.
// - massProperties: each body's volume, area, mass in its material, centre of
//   mass and inertia tensor about the centre of mass (BRepGProp; the tensor is
//   read from moments about six axes because MatrixOfInertia is not bound).

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Material, Vec3 } from "../doc/types";
import { combine, tensorFromMoments, inertiaOf, type MassBody } from "../geom/inertia";
import { add3, cross3, dist3, normalize3, scale3 } from "../geom/vec";
import { boundingBoxOf, DEFAULT_MATERIAL } from "./measure";
import { type OC, type Scope, scoped } from "./oc";
import { dir, pnt } from "./ops";
import { listEdges, listFaces } from "./topology";

/** One thing picked to measure: a face or edge of the part (index into this rebuild), or a point, plane or axis. */
export type MeasureRef =
  | { kind: "face"; index: number }
  | { kind: "edge"; index: number }
  | { kind: "point"; at: Vec3 }
  | { kind: "plane"; origin: Vec3; normal: Vec3 }
  | { kind: "axis"; origin: Vec3; direction: Vec3 };

export interface Closest {
  /** mm */
  distance: number;
  /** The closest point on the first thing, and on the second. */
  a: Vec3;
  b: Vec3;
}

/** The minimum distance between two things, and where it is. Throws an Error that says what is wrong. */
export function minDistance(oc: OC, solid: TopoDS_Shape | null, a: MeasureRef, b: MeasureRef): Closest {
  return scoped((s) => {
    const box = solid ? boundingBoxOf(oc, s, solid) : null;
    // Far enough that a plane or axis drawn this big covers every closest point there can be.
    const span = box ? dist3(box.min, box.max) : 100;
    const centre: Vec3 = box ? scale3(add3(box.min, box.max), 0.5) : [0, 0, 0];
    const reach = (r: MeasureRef) => (r.kind === "plane" || r.kind === "axis" || r.kind === "point" ? dist3(r.kind === "point" ? r.at : r.origin, centre) : 0);
    const half = 10 * (span + reach(a) + reach(b)) + 1000;
    const faces = (a.kind === "face" || b.kind === "face") && solid ? listFaces(oc, s, solid) : [];
    const edges = (a.kind === "edge" || b.kind === "edge") && solid ? listEdges(oc, s, solid).edges : [];
    const shape = (r: MeasureRef, which: string): TopoDS_Shape => {
      switch (r.kind) {
        case "face":
          if (!faces[r.index]) throw new Error(`${which}: there is no face ${r.index} in this rebuild; pick it again`);
          return faces[r.index];
        case "edge":
          if (!edges[r.index]) throw new Error(`${which}: there is no edge ${r.index} in this rebuild; pick it again`);
          return edges[r.index];
        case "point":
          return s.track(s.track(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, s, r.at))).Vertex());
        case "axis": {
          const d = normalize3(r.direction);
          const e = s.track(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, s, add3(r.origin, scale3(d, -half))), pnt(oc, s, add3(r.origin, scale3(d, half)))));
          if (!e.IsDone()) throw new Error(`${which}: could not make the axis`);
          return s.track(e.Edge());
        }
        case "plane":
          return square(oc, s, r.origin, r.normal, half);
      }
    };
    const sa = shape(a, "first");
    const sb = shape(b, "second");
    const d = s.track(new oc.BRepExtrema_DistShapeShape(sa, sb));
    if (!d.IsDone() || d.NbSolution() < 1) throw new Error("the kernel found no closest points between these two");
    const p = s.track(d.PointOnShape1(1));
    const q = s.track(d.PointOnShape2(1));
    return { distance: d.Value(), a: [p.X(), p.Y(), p.Z()], b: [q.X(), q.Y(), q.Z()] };
  });
}

/** A square face `2·half` across on a plane, centred on its origin. */
function square(oc: OC, s: Scope, origin: Vec3, normal: Vec3, half: number): TopoDS_Shape {
  const n = normalize3(normal);
  const helper: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize3(cross3(helper, n));
  const v = cross3(n, u);
  const corner = (i: number, j: number) => add3(origin, add3(scale3(u, i * half), scale3(v, j * half)));
  const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const wire = s.track(new oc.BRepBuilderAPI_MakeWire());
  pts.forEach((p, i) => wire.Add(s.track(s.track(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, s, p), pnt(oc, s, pts[(i + 1) % 4]))).Edge())));
  const mf = s.track(new oc.BRepBuilderAPI_MakeFace(s.track(wire.Wire()), true));
  if (!mf.IsDone()) throw new Error("could not make the plane to measure to");
  return s.track(mf.Face());
}

export interface MassProperties {
  /** Each body, in the order they were made. */
  bodies: MassBody[];
  /** All of them together (the same as the one body when there is one). */
  total: MassBody | null;
}

/** Mass properties of each body in its material (the body's own, else the part's, else steel), and of all of them. */
export function massProperties(
  oc: OC,
  bodies: { name: string; shape: TopoDS_Shape }[],
  material: Material | undefined,
  bodyMaterials: Record<string, Material> = {},
): MassProperties {
  const list = scoped((s) => bodies.map((b) => bodyMass(oc, s, b.name, b.shape, bodyMaterials[b.name] ?? material ?? DEFAULT_MATERIAL)));
  return { bodies: list, total: list.length === 1 ? { ...list[0], name: "total" } : combine(list) };
}

function bodyMass(oc: OC, s: Scope, name: string, shape: TopoDS_Shape, material: Material): MassBody {
  const props = s.track(new oc.GProp_GProps());
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  const volume = props.Mass();
  const c = s.track(props.CentreOfMass());
  const centre: Vec3 = [c.X(), c.Y(), c.Z()];
  const area = scoped((t) => {
    const sp = t.track(new oc.GProp_GProps());
    oc.BRepGProp.SurfaceProperties(shape, sp, false, false);
    return sp.Mass();
  });
  // kg per mm³: the moments the kernel gives are per unit density, in mm⁵.
  const rho = (material.densityKgPerM3 ?? DEFAULT_MATERIAL.densityKgPerM3) * 1e-9;
  const about = (d: Vec3) => props.MomentOfInertia(s.track(new oc.gp_Ax1(pnt(oc, s, centre), dir(oc, s, normalize3(d))))) * rho;
  const tensor = tensorFromMoments({
    x: about([1, 0, 0]),
    y: about([0, 1, 0]),
    z: about([0, 0, 1]),
    xy: about([1, 1, 0]),
    xz: about([1, 0, 1]),
    yz: about([0, 1, 1]),
  });
  // Products far below the moments are rounding: a symmetric part reads exactly 0.
  const big = Math.max(Math.abs(tensor[0][0]), Math.abs(tensor[1][1]), Math.abs(tensor[2][2]));
  const clean = (x: number) => (Math.abs(x) <= big * 1e-12 ? 0 : x);
  const inertia = inertiaOf(tensor.map((row) => row.map(clean)) as typeof tensor);
  return {
    name,
    volume,
    area,
    densityKgPerM3: material.densityKgPerM3 ?? DEFAULT_MATERIAL.densityKgPerM3,
    material: material.name ?? "unnamed",
    mass: volume * rho,
    centre,
    inertia,
  };
}
