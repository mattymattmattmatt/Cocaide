// The operations. Each builds its tool and applies it to one body or several
// (Phase H), or throws OpError with a message the agent can act on. Every
// result is verified (valid solid, material actually added or removed) before
// it is accepted.

import type { TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import type {
  CombineFeature,
  EndCapFeature,
  GussetFeature,
  MemberFeature,
  ProfileDef,
  HoleFeature,
  MoveFeature,
  Vec2,
  Vec3,
} from "../doc/types";
import { to3D, type Frame } from "../geom/frame";
import { reach, placeSection, type PlacedSection } from "../geom/member";
import { arcMid, buildProfile, type Loop, type Region } from "../geom/profile";
import type { CutPlane, MemberEnds } from "../weldment/joints";
import { add3, cross3, dot3, len3, normalize3, roundTo, scale3, sub3 } from "../geom/vec";
import { boundingBoxOf, isValidShape, volumeOf } from "./measure";
import { type OC, type Scope } from "./oc";
import { countSubShapes } from "./topology";

export class OpError extends Error {}

/**
 * What a sketch feature leaves behind for the features that consume it: its
 * plane frame (resolved, for a sketch placed by reference) and its closed
 * regions. A sketch whose curves make no closed profile (an open chain, a
 * path, crossing lines) still builds: `regions` is empty and `open` says why,
 * for a feature that needs a closed profile to report.
 */
export interface SketchProfile {
  frame: Frame;
  regions: Region[];
  /** Total enclosed area, from exact 2D geometry. */
  area: number;
  /** Why the curves are no closed profile ("profile is open at [0, 0] (start of "l1")"), when they are not. */
  open?: string;
}

/** Volume (mm³) below which material counts as not added or removed. */
export const VOLUME_EPS = 1e-9;

// ------------------------------------------------------------ primitives

/** gp_Pnt, gp_Dir and gp_Vec from a Vec3, tracked in `s`. */
export const pnt = (oc: OC, s: Scope, v: Vec3) => s.track(new oc.gp_Pnt(v[0], v[1], v[2]));
export const dir = (oc: OC, s: Scope, v: Vec3) => s.track(new oc.gp_Dir(v[0], v[1], v[2]));
export const vec = (oc: OC, s: Scope, v: Vec3) => s.track(new oc.gp_Vec(v[0], v[1], v[2]));

/** One loop of a profile as a wire in the model (lines, arcs, whole circles). Tracked in `s`. */
export function loopWire(oc: OC, s: Scope, frame: Frame, loop: Loop) {
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

/** Each face moved by `offset`, then swept along `length` (a vector), as one solid or a compound of them. */
export function prism(oc: OC, s: Scope, faces: TopoDS_Face[], offset: Vec3, length: Vec3): TopoDS_Shape {
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

/** One shape, or a compound of several (tracked in `s`). */
export function compoundOf(oc: OC, s: Scope, shapes: TopoDS_Shape[]): TopoDS_Shape {
  if (shapes.length === 1) return shapes[0];
  const builder = s.track(new oc.TopoDS_Builder());
  const compound = s.track(new oc.TopoDS_Compound());
  builder.MakeCompound(compound);
  for (const sh of shapes) builder.Add(compound, sh);
  return compound;
}

export type BooleanKind = "fuse" | "cut";

/** Boolean, then merge coplanar faces and collinear edges so selectors see whole faces. */
export function boolean(oc: OC, s: Scope, kind: BooleanKind, a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape {
  const progress = s.track(new oc.Message_ProgressRange());
  const op = s.track(kind === "fuse" ? new oc.BRepAlgoAPI_Fuse(a, b, progress) : new oc.BRepAlgoAPI_Cut(a, b, progress));
  if (!op.IsDone()) throw new OpError(`the ${kind} boolean failed in the kernel`);
  return unify(oc, s, s.track(op.Shape()));
}

export function unify(oc: OC, s: Scope, shape: TopoDS_Shape): TopoDS_Shape {
  const u = s.track(new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false));
  u.Build();
  return s.track(u.Shape());
}

/** Length along `d` from `from` to the far side of the shape, plus a margin. */
export function reachAlong(oc: OC, s: Scope, shape: TopoDS_Shape, from: Vec3, d: Vec3): number {
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

// The extrude or cut's tool (its end conditions, draft, thin walls, regions) is in extrude.ts.

/** `sketch "s1" has no closed profile to extrude: profile is open at ...` */
export function noClosedProfile(sketch: string, profile: SketchProfile, verb: string): string {
  return `sketch "${sketch}" has no closed profile to ${verb}${profile.open ? `: ${profile.open}` : ""}`;
}

/** The body with the tool added, or the tool itself as a new body. In scope `s`. */
export function fuseInto(oc: OC, s: Scope, body: TopoDS_Shape | null, tool: TopoDS_Shape, what: string): TopoDS_Shape {
  if (!body) {
    if (!isValidShape(oc, s, tool)) throw new OpError(`the ${what} produced an invalid solid`);
    return tool;
  }
  const before = volumeOf(oc, s, body);
  const result = boolean(oc, s, "fuse", body, tool);
  const after = volumeOf(oc, s, result);
  if (!isValidShape(oc, s, result)) throw new OpError(`the ${what} produced an invalid solid`);
  if (after - before <= VOLUME_EPS * Math.max(1, before)) {
    throw new OpError(`added no material: the ${what} lies entirely inside the existing solid`);
  }
  return result;
}

/**
 * Cuts the tool from each target body. A body the tool misses is left as it
 * is, unless it was listed by name: then it must lose material. At least one
 * body must. Returns the changed bodies, in scope `s`.
 */
export function removeFrom(
  oc: OC,
  s: Scope,
  targets: [string, TopoDS_Shape][],
  tool: TopoDS_Shape,
  opts: { listed: boolean; what: string; missed: string },
): Map<string, TopoDS_Shape> {
  const changed = new Map<string, TopoDS_Shape>();
  const single = targets.length === 1 && !opts.listed;
  const toolBox = boundingBoxOf(oc, s, tool);
  for (const [name, body] of targets) {
    if (!single && toolBox && !boxesMeet(toolBox, boundingBoxOf(oc, s, body))) {
      if (opts.listed) throw new OpError(`removed no material from body "${name}"${opts.missed ? `: ${opts.missed}` : ""}`);
      continue;
    }
    const before = volumeOf(oc, s, body);
    const result = boolean(oc, s, "cut", body, tool);
    const after = volumeOf(oc, s, result);
    if (!isValidShape(oc, s, result)) throw new OpError(`the ${opts.what} produced an invalid solid${single ? "" : ` in body "${name}"`}`);
    if (before - after <= VOLUME_EPS * Math.max(1, before)) {
      if (opts.listed) throw new OpError(`removed no material from body "${name}"${opts.missed ? `: ${opts.missed}` : ""}`);
      continue;
    }
    changed.set(name, result);
  }
  if (changed.size === 0) throw new OpError(opts.missed ? `removed no material: ${opts.missed}` : "removed no material");
  return changed;
}

/**
 * What the body and the tool have in common (an intersect operation). It must
 * be one valid solid with volume, smaller than the body. In scope `s`.
 */
export function commonWith(oc: OC, s: Scope, name: string, body: TopoDS_Shape, tool: TopoDS_Shape, what: string): TopoDS_Shape {
  const op = s.track(new oc.BRepAlgoAPI_Common(body, tool, s.track(new oc.Message_ProgressRange())));
  if (!op.IsDone()) throw new OpError(`the ${what}'s intersect with body "${name}" failed in the kernel`);
  const result = unify(oc, s, s.track(op.Shape()));
  const before = volumeOf(oc, s, body);
  const after = volumeOf(oc, s, result);
  if (after <= VOLUME_EPS * Math.max(1, before)) throw new OpError(`the ${what} does not overlap body "${name}": their common part is empty`);
  if (!isValidShape(oc, s, result)) throw new OpError(`the ${what}'s intersect with body "${name}" produced an invalid solid`);
  if (before - after <= VOLUME_EPS * Math.max(1, before)) throw new OpError(`the ${what} holds all of body "${name}": intersecting removes nothing`);
  return result;
}

function boxesMeet(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 } | null): boolean {
  if (!b) return false;
  const tol = 1e-6;
  return [0, 1, 2].every((i) => a.min[i] <= b.max[i] + tol && b.min[i] <= a.max[i] + tol);
}

// ------------------------------------------------------------------ hole

/** Where a hole was drilled: its centre on the face, the direction into the part, and how deep. */
export interface Drilled {
  entry: Vec3;
  into: Vec3;
  length: number;
}

// Where holes go and how deep is in hole.ts.

/**
 * The hole as one solid of revolution: a closed (radius, depth) profile spun
 * about the hole axis. depth 0 is the face, positive goes into the material.
 */
export function holeTool(oc: OC, s: Scope, f: Pick<HoleFeature, "diameter" | "counterbore" | "countersink">, entry: Vec3, into: Vec3, radial: Vec3, length: number) {
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

// Fillet and chamfer are in edgeTreat.ts.

// -------------------------------------------------------------- patterns

// Where a pattern's copies go is in pattern.ts.

export function transformed(oc: OC, s: Scope, shape: TopoDS_Shape, trsf: ReturnType<typeof identity>): TopoDS_Shape {
  return s.track(s.track(new oc.BRepBuilderAPI_Transform(shape, trsf, true, false)).Shape());
}

// ---------------------------------------------------------------- member

/**
 * A straight member: the profile at its size, placed on the line (its anchor,
 * or its `align` point), swept from `from` to `to`. A joint's ends extend it
 * past a node and cut it on planes. In scope `s`.
 */
export function memberTool(oc: OC, s: Scope, f: MemberFeature, def: ProfileDef, ends?: MemberEnds): TopoDS_Shape {
  const r = placeSection(f, def);
  if (!r.ok) throw new OpError(r.error);
  const { placed } = r;
  const before = ends?.start.extend ?? 0;
  const after = ends?.end.extend ?? 0;
  const start = sub3(f.from, scale3(placed.dir, before));
  const tool0 = prism(oc, s, profileFaces(oc, s, sectionAt3D(placed, start)), [0, 0, 0], scale3(placed.dir, placed.length + before + after));
  let tool = tool0;
  for (const [side, plane] of [...(ends?.start.planes ?? []).map((p) => ["start", p] as const), ...(ends?.end.planes ?? []).map((p) => ["end", p] as const)]) {
    tool = cutHalfSpace(oc, s, tool, plane);
    if (countSubShapes(oc, s, tool, "solid") !== 1 || volumeOf(oc, s, tool) <= VOLUME_EPS) {
      throw new OpError(`the joint at its ${side} (${(side === "start" ? ends!.start : ends!.end).joint}) cuts it away or in two`);
    }
  }
  if (!isValidShape(oc, s, tool)) throw new OpError("the member produced an invalid solid");
  return tool;
}

/** A placed section as a sketch profile whose plane passes through `at` on the member's line. */
function sectionAt3D(placed: PlacedSection, at: Vec3, outerOnly = false): SketchProfile {
  const { frame, on, props } = placed;
  const origin = sub3(at, add3(scale3(frame.x, on[0]), scale3(frame.y, on[1])));
  const regions = outerOnly ? props.regions.map((r) => ({ ...r, holes: [] })) : props.regions;
  const area = regions.reduce((t, r) => t + r.outer.area + r.holes.reduce((h, x) => h + x.area, 0), 0);
  return { frame: { ...frame, origin }, regions, area };
}

/** The shape with everything on the normal's side of the plane cut away. */
export function cutHalfSpace(oc: OC, s: Scope, shape: TopoDS_Shape, plane: CutPlane): TopoDS_Shape {
  const pln = s.track(new oc.gp_Pln(pnt(oc, s, plane.point), dir(oc, s, plane.normal)));
  const face = s.track(s.track(new oc.BRepBuilderAPI_MakeFace(pln)).Face());
  const half = s.track(new oc.BRepPrimAPI_MakeHalfSpace(face, pnt(oc, s, add3(plane.point, plane.normal))));
  return boolean(oc, s, "cut", shape, s.track(half.Solid()));
}

/** Where a member's end is, once its joint has extended it, and the way out of the member there. */
export function memberEndAt(f: MemberFeature, placed: PlacedSection, end: "start" | "end", ends?: MemberEnds): { at: Vec3; out: Vec3 } {
  return end === "start"
    ? { at: sub3(f.from, scale3(placed.dir, ends?.start.extend ?? 0)), out: scale3(placed.dir, -1) }
    : { at: add3(f.to, scale3(placed.dir, ends?.end.extend ?? 0)), out: placed.dir };
}

/** A plate of the section's outline (holes closed) on a member's square end, `thickness` thick. In scope `s`. */
export function endCapTool(oc: OC, s: Scope, f: EndCapFeature, member: MemberFeature, placed: PlacedSection, ends?: MemberEnds): TopoDS_Shape {
  const cut = ends?.[f.end];
  if (cut && cut.planes.length) throw new OpError(`the ${f.end} of ${member.id} is cut by ${cut.joint}; an end cap goes on a square end`);
  const { at, out } = memberEndAt(member, placed, f.end, ends);
  const tool = prism(oc, s, profileFaces(oc, s, sectionAt3D(placed, at, true)), [0, 0, 0], scale3(out, f.thickness));
  if (!isValidShape(oc, s, tool)) throw new OpError("the end cap produced an invalid solid");
  return tool;
}

/**
 * A triangular plate in the inside corner of two members at a node: in the
 * plane of their lines, centred on their sections, its corner where their
 * inner faces meet, its legs `size` along each. In scope `s`.
 */
export function gussetTool(oc: OC, s: Scope, f: GussetFeature, node: Vec3, a: { f: MemberFeature; placed: PlacedSection }, b: { f: MemberFeature; placed: PlacedSection }): TopoDS_Shape {
  const way = (m: typeof a, other: Vec3 | null): Vec3 => {
    if (m.f.fromNode === f.node) return m.placed.dir;
    if (m.f.toNode === f.node) return scale3(m.placed.dir, -1);
    // It runs through the node: the way toward the other member's side.
    return other && dot3(m.placed.dir, other) < 0 ? scale3(m.placed.dir, -1) : m.placed.dir;
  };
  const da = way(a, null);
  const db = way(b, da);
  const da2 = a.f.fromNode === f.node || a.f.toNode === f.node ? da : way(a, db);
  const normal = cross3(da2, db);
  if (len3(normal) < 1e-6) throw new OpError(`${a.f.id} and ${b.f.id} are in line at ${f.node}: a gusset needs a corner`);
  const m = normalize3(normal);
  const ua = normalize3(sub3(db, scale3(da2, dot3(db, da2))));
  const ub = normalize3(sub3(da2, scale3(db, dot3(da2, db))));
  // How far each member's inner face is from the node, across the corner.
  const inner = (x: typeof a, u: Vec3) => {
    const foot = add3(x.f.from, scale3(x.placed.dir, dot3(sub3(node, x.f.from), x.placed.dir)));
    return reach(x.placed, u) + dot3(sub3(foot, node), u);
  };
  const ha = inner(a, ua);
  const hb = inner(b, ub);
  const alpha = hb / dot3(da2, ub);
  const beta = ha / dot3(db, ua);
  // Centred on the members' sections across the plane.
  const mid = (x: typeof a) => {
    const t = x.placed.outline.map((o) => dot3(o, m));
    return (Math.max(...t) + Math.min(...t)) / 2;
  };
  const corner = add3(node, add3(add3(scale3(da2, alpha), scale3(db, beta)), scale3(m, (mid(a) + mid(b)) / 2)));
  const y = normalize3(cross3(m, da2));
  const frame: Frame = { origin: sub3(corner, scale3(m, f.thickness / 2)), x: da2, y, z: m };
  const p2 = (sa: number, sb: number): Vec2 => [sa + sb * dot3(db, da2), sb * dot3(db, y)];
  const c = f.chamfer ?? 0;
  const pts = c > 0 ? [p2(c, 0), p2(f.size, 0), p2(0, f.size), p2(0, c)] : [p2(0, 0), p2(f.size, 0), p2(0, f.size)];
  const outline = buildProfile(pts.map((p, i) => ({ id: `g${i}`, type: "line" as const, start: p, end: pts[(i + 1) % pts.length] })));
  if (!outline.ok) throw new OpError(`the gusset's outline: ${outline.error}`);
  const tool = prism(oc, s, profileFaces(oc, s, { frame, regions: outline.regions, area: outline.area }), [0, 0, 0], scale3(m, f.thickness));
  if (!isValidShape(oc, s, tool)) throw new OpError("the gusset produced an invalid solid");
  return tool;
}

// --------------------------------------------------------------- combine

/** The target with the tools added, subtracted or intersected. In scope `s`. */
export function combineBodies(oc: OC, s: Scope, f: CombineFeature, target: TopoDS_Shape, tools: TopoDS_Shape[]): TopoDS_Shape {
  const progress = s.track(new oc.Message_ProgressRange());
  let current = target;
  f.tools.forEach((name, i) => {
    const tool = tools[i];
    const before = volumeOf(oc, s, current);
    const op = s.track(
      f.operation === "add"
        ? new oc.BRepAlgoAPI_Fuse(current, tool, progress)
        : f.operation === "subtract"
          ? new oc.BRepAlgoAPI_Cut(current, tool, progress)
          : new oc.BRepAlgoAPI_Common(current, tool, progress),
    );
    if (!op.IsDone()) throw new OpError(`the ${f.operation} of "${name}" failed in the kernel`);
    const next = unify(oc, s, s.track(op.Shape()));
    const after = volumeOf(oc, s, next);
    if (f.operation !== "subtract" && countSubShapes(oc, s, next, "solid") > 1) {
      throw new OpError(`"${f.target}" and "${name}" don't touch: adding them would make one body of separate solids`);
    }
    if (after <= VOLUME_EPS) {
      throw new OpError(f.operation === "common" ? `"${f.target}" and "${name}" don't overlap: their common part is empty` : `subtracting "${name}" leaves nothing of "${f.target}"`);
    }
    if (f.operation === "subtract" && before - after <= VOLUME_EPS * Math.max(1, before)) {
      throw new OpError(`"${name}" doesn't overlap "${f.target}": subtracting it removes nothing`);
    }
    current = next;
  });
  if (!isValidShape(oc, s, current)) throw new OpError("the combine produced an invalid solid");
  return current;
}

// ------------------------------------------------------- multibody tools

export type Trsf = ReturnType<typeof identity>;

/** The mirror about a plane. */
export function mirrorTrsf(oc: OC, s: Scope, plane: { normal: Vec3; origin: Vec3 }): Trsf {
  const t = identity(oc, s);
  t.SetMirror(s.track(new oc.gp_Ax2(pnt(oc, s, plane.origin), dir(oc, s, normalize3(plane.normal)))));
  return t;
}

/** A move's steps, in order: the turn, then the shift. */
export function moveTrsfs(oc: OC, s: Scope, f: MoveFeature): Trsf[] {
  const out: Trsf[] = [];
  if (f.rotate) {
    const t = identity(oc, s);
    t.SetRotation(s.track(new oc.gp_Ax1(pnt(oc, s, f.rotate.axis.origin), dir(oc, s, normalize3(f.rotate.axis.direction)))), (f.rotate.angle * Math.PI) / 180);
    out.push(t);
  }
  if (f.translate) {
    const t = identity(oc, s);
    t.SetTranslation(vec(oc, s, f.translate));
    out.push(t);
  }
  return out;
}

/** A point, and a direction, under transforms applied in order. */
export function transformLine(oc: OC, s: Scope, from: Vec3, d: Vec3, steps: Trsf[]): { from: Vec3; dir: Vec3 } {
  const p = pnt(oc, s, from);
  const q = dir(oc, s, d);
  for (const t of steps) {
    p.Transform(t);
    q.Transform(t);
  }
  return { from: [p.X(), p.Y(), p.Z()], dir: [q.X(), q.Y(), q.Z()] };
}

/**
 * A body's mirror image fused into it: a symmetric body from one half. The
 * image must touch the body, or the result would be one body of two solids.
 */
export function mergeMirror(oc: OC, s: Scope, name: string, body: TopoDS_Shape, image: TopoDS_Shape): TopoDS_Shape {
  const before = volumeOf(oc, s, body);
  const result = unify(oc, s, boolean(oc, s, "fuse", body, image));
  if (!isValidShape(oc, s, result)) throw new OpError(`merging the mirror of "${name}" produced an invalid solid`);
  if (countSubShapes(oc, s, result, "solid") > 1) throw new OpError(`the mirror of "${name}" doesn't touch it: merged, they would be one body of separate solids. Leave merge off to make "${name}_mirror"`);
  if (volumeOf(oc, s, result) - before <= VOLUME_EPS * Math.max(1, before)) throw new OpError(`the mirror of "${name}" adds nothing: it is already symmetric about the plane`);
  return result;
}

/** A body cut in two by a plane: [the piece behind it, the piece the normal points to]. Each must be one solid. */
export function splitBody(oc: OC, s: Scope, name: string, body: TopoDS_Shape, plane: { normal: Vec3; origin: Vec3 }): [TopoDS_Shape, TopoDS_Shape] {
  const n = normalize3(plane.normal);
  const behind = cutHalfSpace(oc, s, body, { point: plane.origin, normal: n });
  const front = cutHalfSpace(oc, s, body, { point: plane.origin, normal: scale3(n, -1) });
  const total = volumeOf(oc, s, body);
  const [vb, vf] = [volumeOf(oc, s, behind), volumeOf(oc, s, front)];
  if (vb <= VOLUME_EPS * Math.max(1, total) || vf <= VOLUME_EPS * Math.max(1, total)) {
    throw new OpError(`the plane misses body "${name}": it lies wholly ${vf <= VOLUME_EPS * Math.max(1, total) ? "behind" : "in front of"} it`);
  }
  for (const [piece, side] of [
    [behind, "behind"],
    [front, "in front of"],
  ] as const) {
    const solids = countSubShapes(oc, s, piece, "solid");
    if (solids !== 1) throw new OpError(`the plane leaves ${solids} pieces of "${name}" ${side} it; a split makes two bodies, so cut it where it leaves one on each side`);
  }
  return [unify(oc, s, behind), unify(oc, s, front)];
}

/** A new identity gp_Trsf, tracked in `s`: set it with SetTranslation, SetRotation, SetMirror, SetScale. */
export function identity(oc: OC, s: Scope) {
  return s.track(new oc.gp_Trsf());
}


/**
 * A second embind handle to the same C++ shape. The scope deletes its own
 * handle; the object lives until this one is deleted too.
 */
export function copyOut(shape: TopoDS_Shape): TopoDS_Shape {
  return (shape as unknown as { clone(): TopoDS_Shape }).clone();
}
