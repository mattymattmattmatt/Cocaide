// Measurements read from the solid. The agent reads these instead of trusting
// its own prompt, so every number here comes from the B-rep.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Material, Vec3 } from "../doc/types";
import { add3, dot3, roundTo, scale3, sub3 } from "../geom/vec";
import { type OC, type Scope } from "./oc";
import { countSubShapes, describeFaces, type CylinderInfo } from "./topology";

export const DEFAULT_MATERIAL: Required<Material> = { name: "steel (default)", densityKgPerM3: 7850 };

export interface HoleMeasurement {
  /** Smallest wall diameter: the drill size. */
  diameter: number;
  /** Every coaxial wall diameter, e.g. drill and counterbore. */
  diameters: number[];
  /** A point on the hole axis and the axis direction. */
  axisPoint: Vec3;
  axis: Vec3;
  /** Length of the hole walls along the axis. */
  length: number;
}

export interface Measurements {
  units: "mm";
  boundingBox: { min: Vec3; max: Vec3; size: Vec3 } | null;
  /** mm³ */
  volume: number;
  /** mm² */
  surfaceArea: number;
  holeCount: number;
  /** One per hole (its drill diameter), ascending. */
  holeDiameters: number[];
  holes: HoleMeasurement[];
  mass: { kg: number; densityKgPerM3: number; material: string };
  solids: number;
  faces: number;
}

export function volumeOf(oc: OC, s: Scope, shape: TopoDS_Shape): number {
  const props = s.track(new oc.GProp_GProps());
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  return props.Mass();
}

export function areaOf(oc: OC, s: Scope, shape: TopoDS_Shape): number {
  const props = s.track(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(shape, props, false, false);
  return props.Mass();
}

export function boundingBoxOf(oc: OC, s: Scope, shape: TopoDS_Shape): { min: Vec3; max: Vec3 } | null {
  const box = s.track(new oc.Bnd_Box());
  oc.BRepBndLib.AddOptimal(shape, box, false, false);
  if (box.IsVoid()) return null;
  const lo = s.track(box.CornerMin());
  const hi = s.track(box.CornerMax());
  return { min: [lo.X(), lo.Y(), lo.Z()], max: [hi.X(), hi.Y(), hi.Z()] };
}

export function isValidShape(oc: OC, s: Scope, shape: TopoDS_Shape): boolean {
  return s.track(new oc.BRepCheck_Analyzer(shape, true, false, false)).IsValid();
}

export function measure(oc: OC, s: Scope, shape: TopoDS_Shape, material: Material | undefined): Measurements {
  const bb = boundingBoxOf(oc, s, shape);
  const volume = volumeOf(oc, s, shape);
  const { infos } = describeFaces(oc, s, shape);
  const holes = findHoles(infos.flatMap((f) => (f.cylinder ? [f.cylinder] : [])));
  const mat = material ?? DEFAULT_MATERIAL;
  return {
    units: "mm",
    boundingBox: bb && { min: bb.min, max: bb.max, size: sub3(bb.max, bb.min) },
    volume,
    surfaceArea: areaOf(oc, s, shape),
    holeCount: holes.length,
    holeDiameters: holes.map((h) => h.diameter).sort((a, b) => a - b),
    holes,
    mass: {
      kg: volume * 1e-9 * mat.densityKgPerM3,
      densityKgPerM3: mat.densityKgPerM3,
      material: mat.name ?? "unnamed",
    },
    solids: countSubShapes(oc, s, shape, "solid"),
    faces: infos.length,
  };
}

const TOL = 1e-6;

/**
 * A hole is a run of full (360°) concave cylinders on one axis whose axial
 * extents touch: a plain hole is one cylinder, a counterbored hole two. Slot
 * ends and fillets are partial cylinders and are not holes.
 */
export function findHoles(cylinders: CylinderInfo[]): HoleMeasurement[] {
  // 1. Canonical axis line and axial range per concave cylinder.
  type Wall = { axis: Vec3; point: Vec3; radius: number; span: number; lo: number; hi: number };
  const walls: Wall[] = cylinders
    .filter((c) => c.concave)
    .map((c) => {
      const flip = c.axis[0] < -TOL || (Math.abs(c.axis[0]) <= TOL && (c.axis[1] < -TOL || (Math.abs(c.axis[1]) <= TOL && c.axis[2] < 0)));
      const axis = flip ? scale3(c.axis, -1) : c.axis;
      const point = sub3(c.origin, scale3(axis, dot3(c.origin, axis))); // foot of the origin on the line
      const shift = dot3(c.origin, axis);
      const [a, b] = c.axial.map((v) => shift + (flip ? -v : v));
      return { axis, point, radius: c.radius, span: c.span, lo: Math.min(a, b), hi: Math.max(a, b) };
    });
  const sameLine = (a: Wall, b: Wall) =>
    Math.abs(dot3(a.axis, b.axis)) > 1 - 1e-9 && Math.hypot(...sub3(a.point, b.point)) <= TOL;

  // 2. Merge split faces of one cylinder (same line, same radius) and keep full ones.
  const full: Wall[] = [];
  const pending = [...walls];
  while (pending.length) {
    const w = pending.shift()!;
    const group = [w, ...pending.filter((o) => sameLine(o, w) && Math.abs(o.radius - w.radius) <= TOL)];
    for (const g of group.slice(1)) pending.splice(pending.indexOf(g), 1);
    const span = group.reduce((t, g) => t + g.span, 0);
    if (span >= 2 * Math.PI - 1e-6) {
      full.push({ ...w, lo: Math.min(...group.map((g) => g.lo)), hi: Math.max(...group.map((g) => g.hi)) });
    }
  }

  // 3. Chain coaxial full cylinders whose extents touch into one hole.
  const holes: HoleMeasurement[] = [];
  const rest = [...full];
  while (rest.length) {
    const run = [rest.shift()!];
    let grew = true;
    while (grew) {
      grew = false;
      for (const o of [...rest]) {
        if (run.some((r) => sameLine(r, o) && o.lo <= r.hi + TOL && o.hi >= r.lo - TOL)) {
          run.push(o);
          rest.splice(rest.indexOf(o), 1);
          grew = true;
        }
      }
    }
    const diameters = [...new Set(run.map((r) => roundTo(2 * r.radius, 6)))].sort((a, b) => a - b);
    const lo = Math.min(...run.map((r) => r.lo));
    const hi = Math.max(...run.map((r) => r.hi));
    holes.push({
      diameter: diameters[0],
      diameters,
      axisPoint: add3(run[0].point, scale3(run[0].axis, lo)),
      axis: run[0].axis,
      length: hi - lo,
    });
  }
  return holes;
}
