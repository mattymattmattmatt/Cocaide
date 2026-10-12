// The Hole Wizard's kernel side: where each hole of a hole feature goes (its
// centres on the face, or a sketch's points), how deep (blind, through all,
// up to next), and the tool that drills them all, one solid of revolution per
// hole (ops.ts holeTool) in one compound, so the feature is one cut and a
// pattern repeats every hole of it.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { HoleFeature, SketchFeature, Vec2, Vec3 } from "../doc/types";
import { facePlaneFrame, to3D, type Frame } from "../geom/frame";
import { add3, dot3, roundTo, scale3, sub3 } from "../geom/vec";
import type { DescribedPart } from "./bodies";
import { type OC, type Scope } from "./oc";
import { boundingBoxOf } from "./measure";
import { boolean, boxesMeet, compoundOf, holeTool, OpError, pnt, reachAlong, type Drilled } from "./ops";
import { selectFaces, selectionError } from "./selectors";

/** One hole of a hole feature: where it enters, which way it goes, and what to call it in a message. */
export interface HoleSite {
  entry: Vec3;
  /** Into the part, unit. */
  into: Vec3;
  /** Square to `into`, unit: the hole profile's radial direction. */
  radial: Vec3;
  /** "center [30, 0]", "centers[2] [10, 5]", "point "p3" [10, 5]". */
  label: string;
}

/** The sketch a hole's `points` names: its entities as the rebuild solved them, and its plane frame. */
export interface PointSketch {
  sketch: SketchFeature;
  frame: Frame;
}

/**
 * Where each hole of the feature goes. On a face: the centres, or the
 * sketch's points dropped onto the face along its normal (the sketch must be
 * parallel to it), each of which must lie on the face. Without a face: the
 * sketch's points on its own plane, drilled against its normal.
 */
export function holeSites(oc: OC, s: Scope, f: HoleFeature, part: DescribedPart, points: PointSketch | null): HoleSite[] {
  const fromSketch = points
    ? points.sketch.entities.flatMap((e) => (e.type === "point" ? [{ at: e.at, world: to3D(points.frame, e.at), label: `point "${e.id}" ${fmt2(e.at)}` }] : []))
    : [];
  if (points && fromSketch.length === 0) throw new OpError(`sketch "${points.sketch.id}" has no points: put a point (the Point tool) where each hole goes`);
  if (!f.face) {
    const frame = points!.frame;
    return fromSketch.map((p) => ({ entry: p.world, into: scale3(frame.z, -1), radial: frame.x, label: p.label }));
  }
  const selection = selectFaces(part.faceInfos, f.face);
  const problem = selectionError(f.face, selection, 1);
  if (problem) throw new OpError(problem);
  const info = selection.matches[0];
  const face = part.faces[info.index];
  const frame = facePlaneFrame(info.normal!, info.point!);
  const n = frame.z;
  let sites: { entry: Vec3; label: string }[];
  if (points) {
    if (Math.abs(dot3(points.frame.z, n)) < 1 - 1e-6) throw new OpError(`sketch "${points.sketch.id}" is not parallel to the selected face: sketch the points on the face (or a plane parallel to it), or leave the face out to drill from the sketch's plane`);
    sites = fromSketch.map((p) => ({ entry: sub3(p.world, scale3(n, dot3(sub3(p.world, info.point!), n))), label: p.label }));
  } else {
    const centres: [Vec2, string][] = f.centers ? f.centers.map((c, i) => [c, `centers[${i}] ${fmt2(c)}`]) : [[f.center!, `center ${fmt2(f.center!)}`]];
    sites = centres.map(([c, label]) => ({ entry: to3D(frame, c), label }));
  }
  for (const site of sites) {
    const vertex = s.track(s.track(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, s, site.entry))).Vertex());
    const dist = s.track(new oc.BRepExtrema_DistShapeShape(vertex, face));
    if (!dist.IsDone()) throw new OpError(`could not locate the hole at ${site.label} on the face`);
    if (dist.Value() > 1e-6) throw new OpError(`${site.label} is not on the selected face (it is ${roundTo(dist.Value(), 4)} mm outside it)`);
  }
  return sites.map((site) => ({ entry: site.entry, into: scale3(n, -1), radial: frame.x, label: site.label }));
}

/**
 * The stretches of the line from `entry` along `into` (unit) that are inside
 * the material of `shape`, as [from, to] distances along it, in order. The
 * line runs `length` mm.
 */
export function materialAlong(oc: OC, s: Scope, shape: TopoDS_Shape, entry: Vec3, into: Vec3, length: number): [number, number][] {
  const edge = s.track(s.track(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, s, entry), pnt(oc, s, add3(entry, scale3(into, length))))).Edge());
  const common = s.track(new oc.BRepAlgoAPI_Common(edge, shape, s.track(new oc.Message_ProgressRange())));
  if (!common.IsDone()) throw new OpError("could not find where the hole's axis meets the part");
  const runs: [number, number][] = [];
  const ex = s.track(new oc.TopExp_Explorer(s.track(common.Shape()), oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) {
    const curve = s.track(new oc.BRepAdaptor_Curve(s.track(oc.TopoDS.Edge(s.track(ex.Current())))));
    const along = (t: number) => {
      const p = curve.EvalD0(t);
      const d = dot3(sub3([p.X(), p.Y(), p.Z()], entry), into);
      p.delete();
      return d;
    };
    const [a, b] = [along(curve.FirstParameter()), along(curve.LastParameter())].sort((x, y) => x - y);
    if (b - a > 1e-9) runs.push([a, b]);
  }
  runs.sort((x, y) => x[0] - y[0]);
  // Pieces that touch are one stretch of material.
  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= 1e-6) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/**
 * How deep each hole goes: blind, its depth; through all, past the far side
 * of `reach`; up to next, to where it leaves the first material it meets.
 */
export function holeLength(oc: OC, s: Scope, f: HoleFeature, site: HoleSite, reach: TopoDS_Shape): number {
  if (typeof f.depth === "number") return f.depth;
  const far = reachAlong(oc, s, reach, site.entry, site.into);
  if (f.depth === "through") return far;
  const runs = materialAlong(oc, s, reach, site.entry, site.into, far);
  if (runs.length === 0) throw new OpError(`up to next: the hole at ${site.label} meets no material along its axis`);
  return runs[0][1];
}

/**
 * The tool for every hole of the feature, and where each was drilled. A hole
 * started off the part (from a sketch's plane) must still meet material.
 */
export function drillHoles(oc: OC, s: Scope, f: HoleFeature, sites: HoleSite[], reach: TopoDS_Shape, drilled?: (d: Drilled) => void): TopoDS_Shape {
  const tools = sites.map((site) => {
    const length = holeLength(oc, s, f, site, reach);
    // Started off the part (from a sketch's plane): it must meet material within its depth, through all included.
    if (!f.face && (length <= 1e-9 || materialAlong(oc, s, reach, site.entry, site.into, length).length === 0)) {
      const within = typeof f.depth === "number" ? `within its depth ${f.depth}` : "along its axis";
      throw new OpError(`the hole at ${site.label} meets no material ${within}: sketch its point over the part (drilled against the sketch's normal), or flip the sketch's plane`);
    }
    drilled?.({ entry: site.entry, into: site.into, length });
    return holeTool(oc, s, f, site.entry, site.into, site.radial, length);
  });
  if (tools.length === 1) return tools[0];
  // Holes that overlap (counterbores closer than their diameter) are fused into one tool: a cut by a
  // compound of overlapping solids is not well defined and can take the whole part with it.
  const boxes = tools.map((t) => boundingBoxOf(oc, s, t));
  const overlap = boxes.some((a, i) => a && boxes.some((b, j) => j > i && boxesMeet(a, b)));
  return overlap ? tools.slice(1).reduce((all, t) => boolean(oc, s, "fuse", all, t), tools[0]) : compoundOf(oc, s, tools);
}

function fmt2(p: Vec2): string {
  return `[${p.map((x) => roundTo(x, 4)).join(", ")}]`;
}
