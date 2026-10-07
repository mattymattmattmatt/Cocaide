// The Phase A operations. Each takes the current body and returns a new one,
// or throws OpError with a message the agent can act on. Every result is
// verified (valid solid, material actually added or removed) before it is
// accepted.

import type { TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import type {
  ChamferFeature,
  CircularPatternFeature,
  ExtrudeFeature,
  FilletFeature,
  HoleFeature,
  LinearPatternFeature,
  Vec2,
  Vec3,
} from "../doc/types";
import { facePlaneFrame, to3D, type Frame } from "../geom/frame";
import { arcMid, type Loop, type Region } from "../geom/profile";
import { add3, dot3, formatDirection, len3, normalize3, roundTo, scale3, sub3 } from "../geom/vec";
import { boundingBoxOf, isValidShape, volumeOf } from "./measure";
import { type OC, type Scope } from "./oc";
import { edgeSelectionError, selectEdges, selectFaces, selectionError } from "./selectors";
import { describeEdges, describeFaces } from "./topology";

export class OpError extends Error {}

/** A feature that adds or removes one tool body; patterns replay the tool. */
export interface ToolResult {
  /** The new body. Owned by the caller. */
  body: TopoDS_Shape;
  /** The tool solid, before the boolean. Owned by the caller. */
  tool: TopoDS_Shape;
  kind: BooleanKind;
}

/** What a sketch feature leaves behind for the features that consume it. */
export interface SketchProfile {
  frame: Frame;
  regions: Region[];
  /** Total enclosed area, from exact 2D geometry. */
  area: number;
}

const VOLUME_EPS = 1e-9;

// ------------------------------------------------------------ primitives

const pnt = (oc: OC, s: Scope, v: Vec3) => s.track(new oc.gp_Pnt(v[0], v[1], v[2]));
const dir = (oc: OC, s: Scope, v: Vec3) => s.track(new oc.gp_Dir(v[0], v[1], v[2]));
const vec = (oc: OC, s: Scope, v: Vec3) => s.track(new oc.gp_Vec(v[0], v[1], v[2]));

function loopWire(oc: OC, s: Scope, frame: Frame, loop: Loop) {
  const wire = s.track(new oc.BRepBuilderAPI_MakeWire());
  for (const seg of loop.segs) {
    let edge;
    if (seg.kind === "line") {
      edge = s.track(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, s, to3D(frame, seg.a)), pnt(oc, s, to3D(frame, seg.b))));
    } else if (Math.abs(seg.sweep) >= 2 * Math.PI - 1e-12) {
      const axis = seg.sweep > 0 ? frame.z : scale3(frame.z, -1);
      const ax2 = s.track(new oc.gp_Ax2(pnt(oc, s, to3D(frame, seg.c)), dir(oc, s, axis), dir(oc, s, frame.x)));
      const circ = s.track(new oc.gp_Circ(ax2, seg.r));
      edge = s.track(new oc.BRepBuilderAPI_MakeEdge(circ));
    } else {
      const arc = s.track(
        new oc.GC_MakeArcOfCircle(
          pnt(oc, s, to3D(frame, seg.a)),
          pnt(oc, s, to3D(frame, arcMid(seg))),
          pnt(oc, s, to3D(frame, seg.b)),
        ),
      );
      // Value() is a reference into the builder, not a copy: the builder owns it.
      edge = s.track(new oc.BRepBuilderAPI_MakeEdge(arc.Value()));
    }
    if (!edge.IsDone()) throw new OpError(`could not build an edge for "${seg.entity}"`);
    wire.Add(s.track(edge.Edge()));
  }
  if (!wire.IsDone()) throw new OpError(`profile loop through "${loop.segs[0].entity}" did not close into a wire`);
  return s.track(wire.Wire());
}

/** One planar face per region, holes included. The face area is checked against the 2D area. */
export function profileFaces(oc: OC, s: Scope, profile: SketchProfile): TopoDS_Face[] {
  const { frame } = profile;
  const ax3 = s.track(new oc.gp_Ax3(pnt(oc, s, frame.origin), dir(oc, s, frame.z), dir(oc, s, frame.x)));
  const plane = s.track(new oc.gp_Pln(ax3));
  return profile.regions.map((region) => {
    const mf = s.track(new oc.BRepBuilderAPI_MakeFace(plane, loopWire(oc, s, frame, region.outer), true));
    for (const hole of region.holes) mf.Add(loopWire(oc, s, frame, hole));
    if (!mf.IsDone()) throw new OpError(`could not build a face for the profile through "${region.outer.segs[0].entity}"`);
    const face = s.track(mf.Face());
    const props = s.track(new oc.GProp_GProps());
    oc.BRepGProp.SurfaceProperties(face, props, false, false);
    const expected = region.outer.area + region.holes.reduce((t, h) => t + h.area, 0);
    if (Math.abs(props.Mass() - expected) > 1e-6 * Math.max(1, expected)) {
      throw new OpError(
        `profile face area ${roundTo(props.Mass(), 6)} does not match the sketch area ${roundTo(expected, 6)}`,
      );
    }
    return face;
  });
}

function prism(oc: OC, s: Scope, faces: TopoDS_Face[], offset: Vec3, length: Vec3): TopoDS_Shape {
  const solids = faces.map((face) => {
    let base: TopoDS_Shape = face;
    if (len3(offset) > 0) {
      const t = s.track(new oc.gp_Trsf());
      t.SetTranslation(vec(oc, s, offset));
      base = s.track(s.track(new oc.BRepBuilderAPI_Transform(face, t, true, false)).Shape());
    }
    const p = s.track(new oc.BRepPrimAPI_MakePrism(base, vec(oc, s, length), false, true));
    if (!p.IsDone()) throw new OpError("the extrusion failed in the kernel");
    return s.track(p.Shape());
  });
  return compoundOf(oc, s, solids);
}

function compoundOf(oc: OC, s: Scope, shapes: TopoDS_Shape[]): TopoDS_Shape {
  if (shapes.length === 1) return shapes[0];
  const builder = s.track(new oc.TopoDS_Builder());
  const compound = s.track(new oc.TopoDS_Compound());
  builder.MakeCompound(compound);
  for (const sh of shapes) builder.Add(compound, sh);
  return compound;
}

export type BooleanKind = "fuse" | "cut";

/** Boolean, then merge coplanar faces and collinear edges so selectors see whole faces. */
function boolean(oc: OC, s: Scope, kind: BooleanKind, a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape {
  const progress = s.track(new oc.Message_ProgressRange());
  const op = s.track(kind === "fuse" ? new oc.BRepAlgoAPI_Fuse(a, b, progress) : new oc.BRepAlgoAPI_Cut(a, b, progress));
  if (!op.IsDone()) throw new OpError(`the ${kind} boolean failed in the kernel`);
  return unify(oc, s, s.track(op.Shape()));
}

function unify(oc: OC, s: Scope, shape: TopoDS_Shape): TopoDS_Shape {
  const u = s.track(new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false));
  u.Build();
  return s.track(u.Shape());
}

/** Length along `d` from `from` to the far side of the shape, plus a margin. */
function reachAlong(oc: OC, s: Scope, shape: TopoDS_Shape, from: Vec3, d: Vec3): number {
  const bb = boundingBoxOf(oc, s, shape);
  if (!bb) return 0;
  let far = -Infinity;
  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = [i & 1 ? bb.max[0] : bb.min[0], i & 2 ? bb.max[1] : bb.min[1], i & 4 ? bb.max[2] : bb.min[2]];
    far = Math.max(far, dot3(sub3(corner, from), d));
  }
  const diag = len3(sub3(bb.max, bb.min));
  return far + 1 + 0.01 * diag;
}

// ------------------------------------------------------- extrude and cut

/** Returns the new body and the tool. The caller owns both; everything else is in scope `s`. */
export function extrudeOrCut(
  oc: OC,
  s: Scope,
  f: ExtrudeFeature,
  profile: SketchProfile,
  body: TopoDS_Shape | null,
): ToolResult {
  if (profile.regions.length === 0) throw new OpError(`sketch "${f.sketch}" has no closed profile to ${f.op}`);
  const { frame } = profile;
  const d = normalize3(f.direction ?? frame.z);
  if (Math.abs(dot3(d, frame.z)) < 1e-6) {
    throw new OpError(`direction ${formatDirection(d)} lies in the sketch plane; it must leave the plane`);
  }
  if (f.op === "cut" && !body) throw new OpError("nothing to cut: there is no solid before this feature");

  const extent = f.extent ?? "blind";
  let offset: Vec3 = [0, 0, 0];
  let length: number;
  if (extent === "throughAll") {
    if (!body) throw new OpError("throughAll needs an existing solid to go through");
    length = reachAlong(oc, s, body, frame.origin, d);
    if (length <= 1e-6) {
      throw new OpError(`the solid is entirely behind the sketch plane in direction ${formatDirection(d)}`);
    }
  } else {
    length = f.distance!;
    if (extent === "midplane") offset = scale3(d, -length / 2);
  }
  const tool = prism(oc, s, profileFaces(oc, s, profile), offset, scale3(d, length));

  const kind: BooleanKind = f.op === "extrude" ? "fuse" : "cut";
  if (!body) {
    if (!isValidShape(oc, s, tool)) throw new OpError("the extrusion produced an invalid solid");
    return { body: copyOut(tool), tool: copyOut(tool), kind };
  }
  const before = volumeOf(oc, s, body);
  const result = boolean(oc, s, kind, body, tool);
  const after = volumeOf(oc, s, result);
  if (!isValidShape(oc, s, result)) throw new OpError(`the ${f.op} produced an invalid solid`);
  if (f.op === "extrude" && after - before <= VOLUME_EPS * Math.max(1, before)) {
    throw new OpError("added no material: the extrusion lies entirely inside the existing solid");
  }
  if (f.op === "cut" && before - after <= VOLUME_EPS * Math.max(1, before)) {
    throw new OpError(
      `removed no material: the cut does not reach the solid in direction ${formatDirection(d)}` +
        (extent === "throughAll" ? "" : "; check direction and distance, or use extent throughAll"),
    );
  }
  return { body: copyOut(result), tool: copyOut(tool), kind };
}

// ------------------------------------------------------------------ hole

export function hole(oc: OC, s: Scope, f: HoleFeature, body: TopoDS_Shape | null): ToolResult {
  if (!body) throw new OpError("nothing to drill: there is no solid before this feature");
  const { faces, infos } = describeFaces(oc, s, body);
  const selection = selectFaces(infos, f.face);
  const problem = selectionError(f.face, selection, 1);
  if (problem) throw new OpError(problem);
  const info = selection.matches[0];
  const face = faces[info.index];

  const frame = facePlaneFrame(info.normal!, info.point!);
  const entry = to3D(frame, f.center);
  const vertex = s.track(s.track(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, s, entry))).Vertex());
  const dist = s.track(new oc.BRepExtrema_DistShapeShape(vertex, face));
  if (!dist.IsDone()) throw new OpError("could not locate the hole centre on the face");
  if (dist.Value() > 1e-6) {
    throw new OpError(
      `center ${fmtPt(f.center)} is not on the selected face (it is ${roundTo(dist.Value(), 4)} mm outside it)`,
    );
  }

  const into = scale3(frame.z, -1);
  const through = f.depth === "through";
  const length = through ? reachAlong(oc, s, body, entry, into) : (f.depth as number);
  const tool = holeTool(oc, s, f, entry, into, frame.x, length);

  const before = volumeOf(oc, s, body);
  const result = boolean(oc, s, "cut", body, tool);
  const after = volumeOf(oc, s, result);
  if (!isValidShape(oc, s, result)) throw new OpError("the hole produced an invalid solid");
  if (before - after <= VOLUME_EPS * Math.max(1, before)) throw new OpError("removed no material");
  return { body: copyOut(result), tool: copyOut(tool), kind: "cut" };
}

/**
 * The hole as one solid of revolution: a closed (radius, depth) profile spun
 * about the hole axis. depth 0 is the face, positive goes into the material.
 */
function holeTool(oc: OC, s: Scope, f: HoleFeature, entry: Vec3, into: Vec3, radial: Vec3, length: number) {
  const r = f.diameter / 2;
  const profile: Vec2[] = [[0, 0]];
  if (f.counterbore) {
    if (f.counterbore.depth >= length) throw new OpError("the counterbore reaches through the part");
    profile.push([f.counterbore.diameter / 2, 0], [f.counterbore.diameter / 2, f.counterbore.depth], [r, f.counterbore.depth]);
  } else if (f.countersink) {
    const rs = f.countersink.diameter / 2;
    const sink = (rs - r) / Math.tan(((f.countersink.angle / 2) * Math.PI) / 180);
    if (sink >= length) throw new OpError("the countersink reaches through the part");
    profile.push([rs, 0], [r, sink]);
  } else {
    profile.push([r, 0]);
  }
  profile.push([r, length], [0, length]);

  const at = (p: Vec2): Vec3 => add3(entry, add3(scale3(radial, p[0]), scale3(into, p[1])));
  const wire = s.track(new oc.BRepBuilderAPI_MakeWire());
  profile.forEach((p, i) => {
    const q = profile[(i + 1) % profile.length];
    wire.Add(s.track(s.track(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, s, at(p)), pnt(oc, s, at(q)))).Edge()));
  });
  const face = s.track(s.track(new oc.BRepBuilderAPI_MakeFace(s.track(wire.Wire()), true)).Face());
  const axis = s.track(new oc.gp_Ax1(pnt(oc, s, entry), dir(oc, s, into)));
  const revol = s.track(new oc.BRepPrimAPI_MakeRevol(face, axis, 2 * Math.PI, false));
  if (!revol.IsDone()) throw new OpError("could not build the hole tool");
  return s.track(revol.Shape());
}

// ---------------------------------------------------- fillet and chamfer

export function edgeTreatment(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, body: TopoDS_Shape | null): TopoDS_Shape {
  if (!body) throw new OpError(`nothing to ${f.op}: there is no solid before this feature`);
  const { faces, infos: faceInfos } = describeFaces(oc, s, body);
  const { edges, infos } = describeEdges(oc, s, body, faces);
  const selectors = Array.isArray(f.edges) ? f.edges : [f.edges];
  const chosen = new Set<number>();
  selectors.forEach((sel, i) => {
    const path = Array.isArray(f.edges) ? `edges[${i}]` : "edges";
    const result = selectEdges(infos, faceInfos, sel, path);
    const problem = edgeSelectionError(sel, result, path);
    if (problem) throw new OpError(problem);
    for (const e of result.matches) chosen.add(e.index);
  });

  const size = f.op === "fillet" ? f.radius : f.distance;
  const builder = s.track(f.op === "fillet" ? new oc.BRepFilletAPI_MakeFillet(body) : new oc.BRepFilletAPI_MakeChamfer(body));
  for (const i of chosen) builder.Add(size, edges[i]);
  builder.Build(s.track(new oc.Message_ProgressRange()));
  const n = chosen.size;
  if (!builder.IsDone()) {
    throw new OpError(
      `the ${f.op} failed in the kernel on ${n} edge${n === 1 ? "" : "s"}; ${f.op === "fillet" ? "radius" : "distance"} ${size} is probably too large for them`,
    );
  }
  const result = s.track(builder.Shape());
  if (!isValidShape(oc, s, result)) throw new OpError(`the ${f.op} produced an invalid solid`);
  const before = volumeOf(oc, s, body);
  if (Math.abs(volumeOf(oc, s, result) - before) <= VOLUME_EPS * Math.max(1, before)) {
    throw new OpError(`the ${f.op} changed nothing`);
  }
  return copyOut(result);
}

// -------------------------------------------------------------- patterns

/** Applies copies of a seed feature's tool. Every instance must add or remove material. */
export function pattern(
  oc: OC,
  s: Scope,
  f: LinearPatternFeature | CircularPatternFeature,
  seed: { tool: TopoDS_Shape; kind: BooleanKind },
  body: TopoDS_Shape | null,
): TopoDS_Shape {
  if (!body) throw new OpError("nothing to pattern onto: there is no solid before this feature");
  const instances: { label: string; trsf: ReturnType<typeof identity> }[] = [];
  if (f.op === "linearPattern") {
    const d1 = normalize3(f.direction);
    const d2 = f.direction2 ? normalize3(f.direction2) : ([0, 0, 0] as Vec3);
    const n2 = f.count2 ?? 1;
    for (let j = 0; j < n2; j++) {
      for (let i = 0; i < f.count; i++) {
        if (i === 0 && j === 0) continue;
        const offset = add3(scale3(d1, i * f.spacing), scale3(d2, j * (f.spacing2 ?? 0)));
        const t = identity(oc, s);
        t.SetTranslation(vec(oc, s, offset));
        const label = n2 > 1 ? `instance [${i + 1}, ${j + 1}]` : `instance ${i + 1}`;
        instances.push({ label: `${label} (offset ${fmt3(offset)})`, trsf: t });
      }
    }
  } else {
    const total = f.angle ?? 360;
    const step = total >= 360 ? total / f.count : total / (f.count - 1);
    const axis = s.track(new oc.gp_Ax1(pnt(oc, s, f.axis.origin), dir(oc, s, normalize3(f.axis.direction))));
    for (let k = 1; k < f.count; k++) {
      const t = identity(oc, s);
      t.SetRotation(axis, (k * step * Math.PI) / 180);
      instances.push({ label: `instance ${k + 1} (${roundTo(k * step, 4)} deg)`, trsf: t });
    }
  }

  let current = body;
  for (const inst of instances) {
    const moved = s.track(s.track(new oc.BRepBuilderAPI_Transform(seed.tool, inst.trsf, true, false)).Shape());
    const before = volumeOf(oc, s, current);
    const next = boolean(oc, s, seed.kind, current, moved);
    const after = volumeOf(oc, s, next);
    const changed = seed.kind === "fuse" ? after - before : before - after;
    if (changed <= VOLUME_EPS * Math.max(1, before)) {
      throw new OpError(`${inst.label} ${seed.kind === "fuse" ? "adds" : "removes"} no material`);
    }
    current = next;
  }
  if (!isValidShape(oc, s, current)) throw new OpError("the pattern produced an invalid solid");
  return copyOut(current);
}

function identity(oc: OC, s: Scope) {
  return s.track(new oc.gp_Trsf());
}

function fmt3(v: Vec3): string {
  return `[${v.map((x) => roundTo(x, 4)).join(", ")}]`;
}

/**
 * A second embind handle to the same C++ shape. The scope deletes its own
 * handle; the object lives until this one is deleted too.
 */
function copyOut(shape: TopoDS_Shape): TopoDS_Shape {
  return (shape as unknown as { clone(): TopoDS_Shape }).clone();
}

function fmtPt(p: Vec2): string {
  return `[${p.map((x) => roundTo(x, 4)).join(", ")}]`;
}
