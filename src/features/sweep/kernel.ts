// sweep, kernel side: the path as one wire (a sketch chain, model edges in
// order, or an exact helix), the profile's loops (or a circle square to the
// path at its start) each carried along it with BRepOffsetAPI_MakePipeShell
// and closed into a solid, holes cut from their outer loop, then put in the
// part by the operation. Sharp corners of the path are rounded (the profile
// turns about the corner); a twist turns the profile with an auxiliary spine.

import type { TopoDS_Shape, TopoDS_Wire } from "replicad-opencascadejs";
import type { DatumRef, Vec3 } from "../../doc/types";
import { to3D } from "../../geom/frame";
import { sampleSeg } from "../../geom/profile";
import { dot3, len3, normalize3, roundTo, scale3, sub3, add3, cross3 } from "../../geom/vec";
import { resolveDatum } from "../../kernel/datum";
import { isValidShape, volumeOf } from "../../kernel/measure";
import { scoped, type Scope } from "../../kernel/oc";
import { applyOperation } from "../../kernel/operation";
import { boolean, compoundOf, dir, loopWire, noClosedProfile, OpError, pnt, profileFaces, type SketchProfile } from "../../kernel/ops";
import { chainEdges, edgeStarts, helixEdge, orderEdges, pathOf, reversedPath, rotatedPath, twistSpine, type PathShape } from "../../kernel/paths";
import { edgeSelectionError, selectEdges, selectFaces } from "../../kernel/selectors";
import type { KernelOp, RebuildCtx } from "../kernelDefs";
import { ChainError, ON_PLANE, sketchChain, startOnPlane } from "./chain";
import type { SweepFeature } from "./doc";
import { axisFrame, helixNumbers } from "./helix";

/** The profile's plane: where it is, which way it faces, its centre. */
interface ProfilePlace {
  profile: SketchProfile;
  origin: Vec3;
  normal: Vec3;
  centre: Vec3;
}

/** How the profile is carried: the helix's axis (it keeps its angle to the axis), or null. */
interface Built {
  path: PathShape;
  helixAxis?: { origin: Vec3; axis: Vec3 };
}

export const kernel: KernelOp<SweepFeature> = {
  op: "sweep",
  run(ctx, f) {
    const { oc } = ctx;
    scoped((s) => {
      const place = f.profile ? profilePlace(ctx, s, f.profile) : null;
      const built = buildPath(ctx, s, f, place);
      const { path } = built;
      if (place) {
        // A profile lying along the path at its start would sweep flat.
        const across = Math.abs(dot3(place.normal, path.startTangent));
        if (across < Math.sin((5 * Math.PI) / 180)) {
          const deg = roundTo((Math.asin(Math.min(1, across)) * 180) / Math.PI, 2);
          throw new OpError(`the path runs along the profile's plane where it starts (at ${deg}° to it): the profile must stand across the path; sketch it on a plane the path passes through${"helix" in f.path ? " (for a helix, a plane through its axis)" : ""}`);
        }
      }
      if (f.twist && !path.smooth) throw new OpError("twist: the path has sharp corners, and a profile can twist only along a smooth path; round the corners (sketch fillets) or leave out the twist");
      const carry = (wire: TopoDS_Wire, what: string) => pipe(ctx, s, f, built, wire, what);
      let tool: TopoDS_Shape;
      if (place) {
        const solids = place.profile.regions.map((region) => {
          const frame = place.profile.frame;
          let solid = carry(loopWire(oc, s, frame, region.outer), `the profile through "${region.outer.segs[0].entity}"`);
          for (const hole of region.holes) solid = boolean(oc, s, "cut", solid, carry(loopWire(oc, s, frame, hole), `the hole through "${hole.segs[0].entity}"`));
          return solid;
        });
        tool = compoundOf(oc, s, solids);
      } else {
        const { diameter, inner } = f.circle!;
        const outer = carry(circleWire(ctx, s, path, diameter / 2), `the ${diameter} mm circle`);
        tool = inner ? boolean(oc, s, "cut", outer, carry(circleWire(ctx, s, path, inner / 2), `the ${inner} mm bore`)) : outer;
      }
      if (!isValidShape(oc, s, tool)) throw new OpError(`the sweep makes an invalid solid: ${selfCrossing(f)}`);
      applyOperation(ctx, s, f, tool, "sweep");
    });
  },
};

/** Why a sweep may come out invalid, for its message. */
function selfCrossing(f: SweepFeature): string {
  if ("helix" in f.path) return "the coils probably run into each other or the axis (the profile is wider than the pitch, or than the radius allows); make the profile smaller, the pitch larger or the radius larger";
  return "the profile probably runs into itself where the path bends more tightly than the profile is wide; make the profile smaller or the bends wider";
}

function profilePlace(ctx: RebuildCtx, s: Scope, id: string): ProfilePlace {
  const profile = ctx.profiles.get(id);
  if (!profile) throw new OpError(`profile: ${ctx.missing(id, "sketch")}, so there is no profile to sweep`);
  if (profile.regions.length === 0) throw new OpError(`profile: ${noClosedProfile(id, profile, "sweep")}; for a round section with no sketch use "circle": { "diameter": <mm> }`);
  const { oc } = ctx;
  const faces = profileFaces(oc, s, profile);
  const props = s.track(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(compoundOf(oc, s, faces), props, false, false);
  const c = s.track(props.CentreOfMass());
  return { profile, origin: profile.frame.origin, normal: profile.frame.z, centre: [c.X(), c.Y(), c.Z()] };
}

function buildPath(ctx: RebuildCtx, s: Scope, f: SweepFeature, place: ProfilePlace | null): Built {
  const { oc } = ctx;
  const plane = place ? { origin: place.origin, normal: place.normal } : null;
  if ("sketch" in f.path) {
    const id = f.path.sketch;
    const base = ctx.profiles.get(id);
    const sketch = ctx.sketch(id);
    if (!base || !sketch) throw new OpError(`path.sketch: ${ctx.missing(id, "sketch")}, so there is no path to sweep along`);
    let chain;
    try {
      chain = sketchChain(sketch.entities, "a sweep path");
      if (plane) chain = startOnPlane(chain, base.frame, plane, place!.centre);
    } catch (e) {
      if (e instanceof ChainError) throw new OpError(`path.sketch: sketch "${id}": ${e.message}`);
      throw e;
    }
    return { path: pathOf(oc, s, chainEdges(oc, s, base.frame, chain), chain.closed) };
  }
  if ("edges" in f.path) {
    if (ctx.bodies.size === 0) throw new OpError("path.edges: there is no solid before this feature to take edges from");
    const part = ctx.part(s, true);
    const chosen = new Set<number>();
    f.path.edges.forEach((sel, i) => {
      const where = `path.edges[${i}]`;
      const found = selectEdges(part.edgeInfos, part.faceInfos, sel, where);
      const problem = edgeSelectionError(sel, found, where);
      if (problem) throw new OpError(problem);
      for (const e of found.matches) chosen.add(e.index);
    });
    const ordered = orderEdges(oc, s, [...chosen].sort((a, b) => a - b).map((i) => part.edges[i]), "path.edges");
    let path = pathOf(oc, s, ordered.edges, ordered.closed);
    if (plane) path = edgesOnPlane(ctx, s, path, plane);
    return { path };
  }
  // A helix: with a profile, it starts at the profile (its centre's angle and height about the axis).
  const h = f.path.helix;
  const axis = helixRun(ctx, s, h.axis, resolveDatum(ctx, h.axis, "axis", "path.helix.axis"), !!h.reverse);
  const numbers = helixNumbers(h);
  if (typeof numbers === "string") throw new OpError(`path.helix: ${numbers}`);
  let frame = axisFrame(axis.origin, axis.direction, h.startAngle ?? 0);
  if (place) {
    const rel = sub3(place.centre, frame.origin);
    const up = dot3(rel, frame.z);
    const radial = sub3(rel, scale3(frame.z, up));
    if (len3(radial) < 1e-6) throw new OpError("path.helix: the profile is centred on the helix's axis; sketch it off the axis, where the coil is to run (at the helix radius)");
    const x = normalize3(radial);
    frame = { origin: add3(frame.origin, scale3(frame.z, up)), x, y: cross3(frame.z, x), z: frame.z };
  }
  const edge = helixEdge(oc, s, frame, h.radius, numbers.pitch, numbers.turns, { leftHanded: h.leftHanded, taper: h.taper });
  const path = pathOf(oc, s, [edge], false);
  // Neighbouring coils are a pitch apart along the axis: a profile as wide as that runs into the next coil.
  if (numbers.turns > 1) {
    const span = place ? spanAlong(place, frame.z) : f.circle!.diameter * Math.sqrt(Math.max(0, 1 - dot3(frame.z, path.startTangent) ** 2));
    if (span >= numbers.pitch - 1e-9) {
      throw new OpError(`path.helix: the coils run into each other: the ${place ? "profile" : "circle"} spans ${roundTo(span, 4)} mm along the axis but the pitch is only ${roundTo(numbers.pitch, 4)} mm; make the pitch larger or the ${place ? "profile" : "diameter"} smaller`);
    }
  }
  return { path, helixAxis: { origin: frame.origin, axis: frame.z } };
}

/**
 * Where a helix starts and which way it climbs. About a default axis or an
 * axis feature: from the axis's point along its direction. About a cylinder:
 * from the end of the cylinder the axis direction leaves from, so the coil runs
 * along the face (a thread down a shaft, a spring round a boss). About a
 * circular edge: from the edge's centre, into the round face (or faces) the
 * edge bounds. `reverse` climbs the other way (from the cylinder's other end).
 */
function helixRun(ctx: RebuildCtx, s: Scope, ref: DatumRef, axis: { origin: Vec3; direction: Vec3 }, reverse: boolean): { origin: Vec3; direction: Vec3 } {
  let origin = axis.origin;
  let direction = axis.direction;
  // Where the centres of the round edges of these faces lie along the axis (mm from its point).
  const along = (part: ReturnType<RebuildCtx["part"]>, faces: number[]) =>
    part.edgeInfos.filter((e) => e.kind === "circle" && e.center && e.faces.some((i) => faces.includes(i))).map((e) => dot3(sub3(e.center!, origin), direction));
  if ("face" in ref || "edge" in ref) {
    const part = ctx.part(s, true);
    if ("face" in ref) {
      const face = selectFaces(part.faceInfos, ref.face).matches[0];
      const ts = face?.type === "cylinder" ? along(part, [face.index]) : [];
      if (ts.length > 0) {
        const [lo, hi] = [Math.min(...ts), Math.max(...ts)];
        origin = add3(origin, scale3(direction, reverse ? hi : lo));
        return { origin, direction: reverse ? scale3(direction, -1) : direction };
      }
    } else {
      const found = selectEdges(part.edgeInfos, part.faceInfos, ref.edge, "path.helix.axis.edge").matches[0];
      const round = found ? found.faces.filter((i) => part.faceInfos[i]?.type === "cylinder" || part.faceInfos[i]?.type === "cone") : [];
      const ts = along(part, round).filter((t) => Math.abs(t) > 1e-6);
      if (ts.length > 0) {
        const far = ts.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
        if (far < 0) direction = scale3(direction, -1);
      }
    }
  }
  return { origin, direction: reverse ? scale3(direction, -1) : direction };
}

/** How far the profile reaches along a direction (its outer loops, arcs sampled). */
function spanAlong(place: ProfilePlace, d: Vec3): number {
  const { frame, regions } = place.profile;
  const along = regions.flatMap((r) => r.outer.segs.flatMap((seg) => sampleSeg(seg, Math.PI / 90))).map((p) => dot3(to3D(frame, p), d));
  return Math.max(...along) - Math.min(...along);
}

/** A path of model edges arranged to start on the profile's plane (from either end, or a corner of a closed chain on it). */
function edgesOnPlane(ctx: RebuildCtx, s: Scope, path: PathShape, plane: { origin: Vec3; normal: Vec3 }): PathShape {
  const { oc } = ctx;
  const off = (p: Vec3) => Math.abs(dot3(sub3(p, plane.origin), plane.normal));
  if (off(path.start) <= ON_PLANE) return path;
  if (!path.closed) {
    if (off(path.end) <= ON_PLANE) return reversedPath(oc, s, path);
    throw new OpError(`path.edges: the path must start on the profile's plane, but its ends are ${roundTo(off(path.start), 4)} mm and ${roundTo(off(path.end), 4)} mm from it: sketch the profile on a plane through an end of the chain`);
  }
  const starts = edgeStarts(oc, s, path);
  const k = starts.findIndex((p) => off(p) <= ON_PLANE);
  if (k < 0) throw new OpError("path.edges: the closed chain has no corner on the profile's plane: sketch the profile on a plane through one of its corners");
  return rotatedPath(oc, s, path, k);
}

/** A circle square to the path at its start (radius r), as a wire. */
function circleWire(ctx: RebuildCtx, s: Scope, path: PathShape, r: number): TopoDS_Wire {
  const { oc } = ctx;
  const ax2 = s.track(new oc.gp_Ax2(pnt(oc, s, path.start), dir(oc, s, path.startTangent)));
  const edge = s.track(s.track(new oc.BRepBuilderAPI_MakeEdge(s.track(new oc.gp_Circ(ax2, r)))).Edge());
  return s.track(s.track(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
}

/** Why a path with a sharp corner beside a curve failed: the corner modes cannot join a curved piece cleanly. */
const CURVED_CORNER = "the path has a sharp corner next to a curve, which the profile cannot turn: round the corner with a sketch fillet";

/** Does the path have a piece that is not a straight line (an arc, ellipse, spline or helix)? */
function hasCurvedPiece(ctx: RebuildCtx, s: Scope, path: PathShape): boolean {
  const { oc } = ctx;
  return path.edges.some((e) => s.track(new oc.BRepAdaptor_Curve(e)).GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line);
}

/**
 * One closed loop carried along the path into a solid. Sharp corners are
 * rounded; where that fails (a corner beside a curved piece), the pieces are
 * met at a mitre before giving up.
 */
function pipe(ctx: RebuildCtx, s: Scope, f: SweepFeature, built: Built, wire: TopoDS_Wire, what: string): TopoDS_Shape {
  const { oc } = ctx;
  const { path } = built;
  const T = oc.BRepBuilderAPI_TransitionMode;
  if (path.smooth) return pipeWith(ctx, s, f, built, wire, what, T.BRepBuilderAPI_RoundCorner, false);
  let first: unknown = null;
  // Not BRepBuilderAPI_Transformed: it lets the profile lean off square to the path, and the solid comes out short.
  for (const mode of [T.BRepBuilderAPI_RoundCorner, T.BRepBuilderAPI_RightCorner]) {
    try {
      return pipeWith(ctx, s, f, built, wire, what, mode, true);
    } catch (e) {
      first ??= e;
    }
  }
  if (hasCurvedPiece(ctx, s, path)) throw new OpError(CURVED_CORNER);
  throw first;
}

/** pipe with one transition mode at the corners; `checked`: refuse an invalid solid here (so another mode can be tried). */
function pipeWith(ctx: RebuildCtx, s: Scope, f: SweepFeature, built: Built, wire: TopoDS_Wire, what: string, mode: unknown, checked: boolean): TopoDS_Shape {
  const { oc } = ctx;
  const { path } = built;
  const ps = s.track(new oc.BRepOffsetAPI_MakePipeShell(path.wire));
  if (f.twist) {
    const aux = twistSpine(oc, s, path, f.twist, built.helixAxis ?? null);
    ps.SetMode(aux, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
  } else if (f.orientation === "fixed") {
    ps.SetMode(s.track(new oc.gp_Ax2(pnt(oc, s, path.start), dir(oc, s, path.startTangent))));
  } else if (built.helixAxis) {
    // Along a helix the profile keeps its angle to the axis (a spring's wire, a thread's tooth).
    ps.SetMode(dir(oc, s, built.helixAxis.axis));
  } else {
    ps.SetMode(false);
  }
  ps.Add(wire, false, false);
  ps.SetTransitionMode(mode as Parameters<typeof ps.SetTransitionMode>[0]);
  ps.Build(s.track(new oc.Message_ProgressRange()));
  if (!ps.IsDone()) throw new OpError(`could not sweep ${what} along the path: ${selfCrossing(f)}`);
  if (!ps.MakeSolid()) throw new OpError(`sweeping ${what} along the path did not close into a solid`);
  let solid = s.track(ps.Shape());
  if (volumeOf(oc, s, solid) < 0) solid = s.track(solid.Reversed());
  if (volumeOf(oc, s, solid) <= 1e-9) throw new OpError(`sweeping ${what} along the path makes no volume`);
  if (checked && !isValidShape(oc, s, solid)) throw new OpError(`the sweep makes an invalid solid: ${selfCrossing(f)}`);
  return solid;
}
