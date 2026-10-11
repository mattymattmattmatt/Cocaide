// The extrude or cut's tool: its profile (the sketch's regions, the ones it
// picks, their complement for "flip side to cut", or a thin wall) pushed out
// along its direction from where it starts to where each direction ends.
//
// Every end is a plane, a curved face, or "the next face of the part":
//   - planes (blind, through all, up to a vertex, a plane, a flat face or an
//     offset of one): the prism is made long enough to pass the plane and
//     trimmed by the half-space beyond it, so a slanted plane gives a slanted
//     end face, exactly; a plane parallel to the sketch is the prism's end;
//   - a curved face: the prism is split by the face and the pieces that touch
//     the start are kept (the face must cover the whole profile);
//   - up to next: a boss keeps the space between its start and the material
//     it meets, a cut the material between its start (or the gap before the
//     part) and where the material ends.
// A start other than the sketch plane is a parallel plane (startOffset, a
// vertex, a parallel plane) where the prism simply begins, or a slanted plane
// it is trimmed by. Draft tapers the sides about the start (OCCT DraftAngle on
// the prism's side faces). Each direction is built on its own and the two are
// fused.

import type { TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import { DEFAULT_BODY, type DatumRef, type ExtrudeDraft, type ExtrudeFeature, type SketchEntity, type Vec2, type Vec3 } from "../doc/types";
import { isConstruction } from "../doc/sketch";
import { areaOf, complementRegions, pickRegions, regionPoints, RegionError, thinRegions } from "../features/extrude/regions";
import type { RebuildCtx } from "../features/kernelDefs";
import { to2D, to3D, type Frame } from "../geom/frame";
import type { Region } from "../geom/profile";
import { add3, dot3, formatDirection, len3, normalize3, roundTo, scale3, sub3 } from "../geom/vec";
import { describePart } from "./bodies";
import { nameOf, resolveDatum } from "./datum";
import { boundingBoxOf, isValidShape, volumeOf } from "./measure";
import type { Scope } from "./oc";
import { boolean, compoundOf, dir, noClosedProfile, OpError, pnt, profileFaces, reachAlong, unify, vec, type SketchProfile } from "./ops";
import { selectFaces, selectionError } from "./selectors";
import { countSubShapes } from "./topology";

/** A plane: a point on it and its unit normal. */
interface Plane {
  point: Vec3;
  normal: Vec3;
}

/** Where a direction ends. */
type End =
  | { kind: "plane"; plane: Plane; what: string }
  | { kind: "face"; face: TopoDS_Face; what: string }
  | { kind: "next" };

/** Positional tolerance (mm). */
const TOL = 1e-6;

/**
 * The tool of an extrude or cut: one solid (or a compound of separate ones).
 * `reach` is the part the feature works on (what through all goes through
 * and up to next meets); `entities` the sketch's (solved) entities, for a
 * thin feature's open chain. In scope `s`.
 */
export function extrudeTool(ctx: RebuildCtx, s: Scope, f: ExtrudeFeature, profile: SketchProfile, entities: readonly SketchEntity[], reach: TopoDS_Shape | null): TopoDS_Shape {
  const { oc } = ctx;
  const { frame } = profile;
  const d = normalize3(f.direction ?? frame.z);
  if (Math.abs(dot3(d, frame.z)) < 1e-6) {
    throw new OpError(`direction ${formatDirection(d)} lies in the sketch plane; it must leave the plane`);
  }
  if (f.op === "cut" && !reach) throw new OpError("nothing to cut: there is no solid before this feature");

  // The regions it pushes out.
  let regions = toolRegions(f, profile, entities);
  if (f.flipSide) {
    const [min, max] = flipRectangle(oc, s, reach!, frame, d, regions);
    regions = complementRegions(regions, min, max);
  }
  const shape: SketchProfile = { frame, regions, area: areaOf(regions) };
  const faces = profileFaces(oc, s, shape);
  const points = regionPoints(regions).map((p) => to3D(frame, p));
  const b = new Builder(ctx, s, f, frame, d, faces, points, reach);

  // Where it starts, and where each direction ends.
  const start = b.start();
  const extent = f.extent ?? "blind";
  const pieces: TopoDS_Shape[] = [];
  if (extent === "midplane") {
    const half = f.distance! / 2;
    pieces.push(b.piece(1, start, b.blind(start, 1, half), f.draft), b.piece(-1, start, b.blind(start, -1, half), f.draft));
  } else if (extent === "throughAllBoth") {
    pieces.push(b.piece(1, start, b.throughAll(start, 1), f.draft), b.piece(-1, start, b.throughAll(start, -1), f.draft));
  } else {
    pieces.push(b.piece(1, start, b.end(1, start, { extent, distance: f.distance, upTo: f.upTo, offset: f.offset }), f.draft));
    const d2 = f.direction2;
    if (d2) pieces.push(b.piece(-1, start, b.end(-1, start, d2), d2.draft));
  }
  let tool = pieces[0];
  for (const p of pieces.slice(1)) tool = boolean(oc, s, "fuse", tool, p);
  if (countSubShapes(oc, s, tool, "solid") === 0 || volumeOf(oc, s, tool) <= 1e-9) throw new OpError(`the ${f.op === "cut" ? "cut" : "extrusion"} has no volume: check its end conditions`);
  if (!isValidShape(oc, s, tool)) throw new OpError(`the ${f.op === "cut" ? "cut" : "extrusion"} came out as an invalid solid: check its end conditions${f.draft ? " and draft angle" : ""}`);
  return tool;
}

/** The regions the feature pushes out: the sketch's (or those picked), or a thin wall of them. */
export function toolRegions(f: ExtrudeFeature, profile: SketchProfile, entities: readonly SketchEntity[]): Region[] {
  try {
    const picked = f.regions ? pickRegions(profile.regions, f.regions) : profile.regions;
    if (f.thin) {
      if (f.regions && profile.regions.length === 0) throw new RegionError("regions: the sketch is an open chain, with no closed regions to pick");
      return thinRegions(picked, entities.filter((e) => !isConstruction(e)), f.thin.thickness, f.thin.side ?? "outside");
    }
    if (picked.length === 0) throw new OpError(`${noClosedProfile(f.sketch, profile, f.op)}; for an open sketch, make it a thin feature ("thin": { "thickness": 2 })`);
    return picked;
  } catch (e) {
    if (e instanceof RegionError) throw new OpError(e.message);
    throw e;
  }
}

/** A rectangle in the sketch plane around the part (seen along the direction) and the profile: what "flip side to cut" keeps the outside of. */
function flipRectangle(oc: RebuildCtx["oc"], s: Scope, reach: TopoDS_Shape, frame: Frame, d: Vec3, regions: Region[]): [Vec2, Vec2] {
  const pts: Vec2[] = regionPoints(regions);
  const bb = boundingBoxOf(oc, s, reach);
  if (bb) {
    for (let i = 0; i < 8; i++) {
      const c: Vec3 = [i & 1 ? bb.max[0] : bb.min[0], i & 2 ? bb.max[1] : bb.min[1], i & 4 ? bb.max[2] : bb.min[2]];
      // Along the direction onto the sketch plane.
      const t = dot3(sub3(c, frame.origin), frame.z) / dot3(d, frame.z);
      pts.push(to2D(frame, sub3(c, scale3(d, t))));
    }
  }
  const min: Vec2 = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
  const max: Vec2 = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  const m = 1 + 0.05 * Math.hypot(max[0] - min[0], max[1] - min[1]);
  return [
    [min[0] - m, min[1] - m],
    [max[0] + m, max[1] + m],
  ];
}

/** The end condition of one direction, as the document gives it. */
interface EndSpec {
  extent: string;
  distance?: number;
  upTo?: DatumRef;
  offset?: number;
}

class Builder {
  constructor(
    private readonly ctx: RebuildCtx,
    private readonly s: Scope,
    private readonly f: ExtrudeFeature,
    private readonly frame: Frame,
    /** The direction, unit. */
    private readonly d: Vec3,
    /** The profile's faces on the sketch plane. */
    private readonly faces: TopoDS_Face[],
    /** Points along the profile's loops, in the model: where its rays start. */
    private readonly points: Vec3[],
    private readonly reach: TopoDS_Shape | null,
  ) {}

  private get oc() {
    return this.ctx.oc;
  }

  /** How far along the direction a ray from P travels to reach the plane. */
  private tOn(plane: Plane, P: Vec3): number {
    return dot3(plane.normal, sub3(plane.point, P)) / dot3(plane.normal, this.d);
  }

  /** Is the plane parallel to the sketch plane (so the rays all meet it at the same t)? */
  private parallel(plane: Plane): boolean {
    return Math.abs(Math.abs(dot3(plane.normal, this.frame.z)) - 1) < 1e-9;
  }

  /** The sketch plane, moved by startOffset, or the plane or point `from` names. */
  start(): Plane {
    const { f, frame } = this;
    if (f.startOffset !== undefined) return { point: add3(frame.origin, scale3(frame.z, f.startOffset)), normal: frame.z };
    if (!f.from) return { point: frame.origin, normal: frame.z };
    const r = resolveDatum(this.ctx, f.from, "any", "from");
    if (r.kind === "point") return { point: r.at, normal: frame.z };
    if (r.kind === "axis") throw new OpError(`from: ${nameOf(f.from)} is an axis; the extrude starts at a plane, a flat face or a point`);
    const normal = normalize3(r.normal);
    if (Math.abs(dot3(normal, this.d)) < 1e-6) throw new OpError(`from: ${nameOf(f.from)} is parallel to the extrude's direction ${formatDirection(this.d)}: the profile never reaches it`);
    return { point: r.origin, normal };
  }

  /** The start plane moved `length` along direction `sign`: a blind end. */
  blind(start: Plane, sign: 1 | -1, length: number): End {
    if (this.parallel(start)) return { kind: "plane", plane: { point: add3(start.point, scale3(this.frame.z, (sign * length) * dot3(this.d, this.frame.z))), normal: this.frame.z }, what: "its depth" };
    return { kind: "plane", plane: { point: add3(start.point, scale3(this.d, sign * length)), normal: start.normal }, what: "its depth" };
  }

  /** Through every body it works on, that way. */
  throughAll(start: Plane, sign: 1 | -1): End {
    if (!this.reach) throw new OpError(`${sign > 0 ? "" : "direction2: "}through all needs an existing solid to go through`);
    const dd = scale3(this.d, sign);
    const back = this.extremeStart(start, sign > 0 ? -1 : 1);
    const from = add3(this.frame.origin, scale3(this.d, back));
    const length = reachAlong(this.oc, this.s, this.reach, from, dd);
    if (length <= 1e-6) throw new OpError(`the solid is entirely behind the ${this.parallel(start) ? "sketch plane" : "start"} in direction ${formatDirection(dd)}`);
    return { kind: "plane", plane: { point: add3(from, scale3(dd, length)), normal: this.frame.z }, what: "the far side of the part" };
  }

  /** The end the document gives for direction `sign` (1: direction 1, -1: direction 2). */
  end(sign: 1 | -1, start: Plane, e: EndSpec): End {
    const where = sign > 0 ? "" : "direction2.";
    switch (e.extent) {
      case "blind":
        return this.blind(start, sign, e.distance!);
      case "throughAll":
        return this.throughAll(start, sign);
      case "upToNext":
        return { kind: "next" };
      case "upToVertex": {
        const p = resolveDatum(this.ctx, e.upTo!, "point", `${where}upTo`);
        return { kind: "plane", plane: { point: p.at, normal: this.frame.z }, what: `the plane through ${nameOf(e.upTo!)}` };
      }
      case "upToFace":
      case "offsetFromFace": {
        const target = this.surface(e.upTo!, `${where}upTo`);
        if (e.extent === "upToFace") return target;
        if (target.kind !== "plane") throw new OpError(`${where}upTo: ${nameOf(e.upTo!)} is curved; an offset from a face needs a flat face or a plane (use upToFace for a curved one)`);
        // Back toward the start by `offset`: against the way the direction crosses the plane.
        const n = target.plane.normal;
        const toward = Math.sign(dot3(n, scale3(this.d, sign))) || 1;
        return { kind: "plane", plane: { point: sub3(target.plane.point, scale3(n, toward * e.offset!)), normal: n }, what: `${roundTo(e.offset!, 6)} mm from ${nameOf(e.upTo!)}` };
      }
    }
    throw new OpError(`${where}extent: "${e.extent}" is not an end condition`);
  }

  /** A face or plane to end at: a flat face as its whole plane, a curved face as itself. */
  private surface(ref: DatumRef, path: string): End {
    if ("face" in ref) {
      if (this.ctx.bodies.size === 0) throw new OpError(`${path}: there is no solid before this feature to take a face from`);
      const part = describePart(this.oc, this.s, this.ctx.bodies as Map<string, TopoDS_Shape>, false);
      const found = selectFaces(part.faceInfos, ref.face);
      const problem = selectionError(ref.face, found, 1);
      if (problem) throw new OpError(`${path}.face: ${problem}`);
      const info = found.matches[0];
      if (info.type === "plane" && info.normal && info.point) return { kind: "plane", plane: { point: info.point, normal: normalize3(info.normal) }, what: nameOf(ref) };
      return { kind: "face", face: part.faces[info.index], what: nameOf(ref) };
    }
    const p = resolveDatum(this.ctx, ref, "plane", path);
    return { kind: "plane", plane: { point: p.origin, normal: normalize3(p.normal) }, what: nameOf(ref) };
  }

  /** The start's t along the direction at the end of the profile farthest that way (sign) from the end. */
  private extremeStart(start: Plane, sign: 1 | -1): number {
    const ts = this.points.map((P) => this.tOn(start, P));
    return sign > 0 ? Math.max(...ts) : Math.min(...ts);
  }

  /** A margin past a plane or a part: 1 mm and 1% of the profile's size. */
  private margin(): number {
    let size = 0;
    for (const p of this.points) size = Math.max(size, len3(sub3(p, this.points[0])));
    return 1 + 0.01 * size;
  }

  /** The profile's faces moved `t` along the direction. */
  private facesAt(t: number): TopoDS_Shape[] {
    if (Math.abs(t) < 1e-15) return this.faces;
    const tr = this.s.track(new this.oc.gp_Trsf());
    tr.SetTranslation(vec(this.oc, this.s, scale3(this.d, t)));
    return this.faces.map((face) => this.s.track(this.s.track(new this.oc.BRepBuilderAPI_Transform(face, tr, true, false)).Shape()));
  }

  /** The profile swept from t = a to t = b along the direction. */
  private prism(a: number, b: number): TopoDS_Shape {
    const { oc, s } = this;
    const solids = this.facesAt(a).map((face) => {
      const p = s.track(new oc.BRepPrimAPI_MakePrism(face, vec(oc, s, scale3(this.d, b - a)), false, true));
      if (!p.IsDone()) throw new OpError("the extrusion failed in the kernel");
      return s.track(p.Shape());
    });
    return compoundOf(oc, s, solids);
  }

  /**
   * One direction (sign 1: along the direction, -1: back from the start)
   * from the start to its end, tapered by `draft` about the start.
   */
  piece(sign: 1 | -1, start: Plane, end: End, draft: ExtrudeDraft | undefined): TopoDS_Shape {
    const { oc, s } = this;
    const dd = scale3(this.d, sign);
    const label = sign > 0 ? "" : "direction2: ";
    const parallelStart = this.parallel(start);
    const ts = this.points.map((P) => this.tOn(start, P));
    const m = this.margin();
    // The prism runs from a (the start, or behind a slanted start) to b (the end, or past it).
    const a = parallelStart ? ts[0] : sign > 0 ? Math.min(...ts) - m : Math.max(...ts) + m;
    let b: number;
    if (end.kind === "plane") {
      if (Math.abs(dot3(end.plane.normal, this.d)) < 1e-6) throw new OpError(`${label}${end.what} is parallel to the direction ${formatDirection(dd)}: the extrude never reaches it`);
      const te = this.points.map((P) => this.tOn(end.plane, P));
      const short = te.findIndex((t, i) => sign * (t - ts[i]) <= TOL);
      if (short >= 0) {
        const behind = te.every((t, i) => sign * (t - ts[i]) <= TOL);
        throw new OpError(`${label}${end.what} is ${behind ? "behind the start" : "across the profile"} in direction ${formatDirection(dd)}: it must lie wholly ahead of where the extrude starts${behind ? " (reverse the direction?)" : ""}`);
      }
      b = this.parallel(end.plane) ? te[0] : sign > 0 ? Math.max(...te) + m : Math.min(...te) - m;
    } else {
      const target = end.kind === "face" ? end.face : this.reach;
      if (!target) throw new OpError(`${label}up to next needs a solid to meet: there is none before this feature`);
      const back = sign > 0 ? Math.min(...ts) : Math.max(...ts);
      const length = reachAlong(oc, s, target, add3(this.frame.origin, scale3(this.d, back)), dd);
      if (length <= 1e-6) throw new OpError(`${label}${end.kind === "face" ? end.what : "the part"} is entirely behind the start in direction ${formatDirection(dd)}`);
      b = back + sign * (length + m);
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    let solid = this.prism(lo, hi);
    if (draft) {
      if (!parallelStart) throw new OpError(`${label}draft needs a flat start parallel to the sketch (the sketch plane, an offset of it, or a vertex): leave the draft out, or start from the sketch plane`);
      solid = this.drafted(solid, dd, start, draft, label);
    }
    // The start: the prism begins there, or is trimmed by it.
    let startShape: TopoDS_Shape = compoundOf(oc, s, this.facesAt(a));
    if (!parallelStart) {
      solid = keepSide(oc, s, solid, start, add3(start.point, dd));
      startShape = planeFace(oc, s, start);
    }
    if (end.kind === "plane") {
      if (this.parallel(end.plane)) return solid;
      return keepSide(oc, s, solid, end.plane, sub3(end.plane.point, dd));
    }
    const farCap = compoundOf(oc, s, this.facesAt(b));
    if (end.kind === "face") return this.upToFace(solid, end, startShape, farCap, label);
    return this.upToNext(solid, startShape, farCap, label, dd);
  }

  /** The prism with its side faces tapered by the draft angle about the start plane. */
  private drafted(solid: TopoDS_Shape, dd: Vec3, start: Plane, draft: ExtrudeDraft, label: string): TopoDS_Shape {
    const { oc, s } = this;
    const angle = ((draft.outward ? -1 : 1) * draft.angle * Math.PI) / 180;
    const neutral = s.track(new oc.gp_Pln(pnt(oc, s, start.point), dir(oc, s, start.normal)));
    const pull = dir(oc, s, dd);
    const dr = s.track(new oc.BRepOffsetAPI_DraftAngle(solid));
    const ex = s.track(new oc.TopExp_Explorer(solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; ex.More(); ex.Next()) {
      const face = s.track(oc.TopoDS.Face(s.track(ex.Current())));
      const surface = s.track(new oc.BRepAdaptor_Surface(face, true));
      if (surface.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        const n = s.track(s.track(s.track(surface.Plane()).Axis()).Direction());
        // The caps face along the direction; the sides run along it.
        if (Math.abs(n.X() * this.d[0] + n.Y() * this.d[1] + n.Z() * this.d[2]) > 1e-6) continue;
      }
      dr.Add(face, pull, angle, neutral, true);
      if (!dr.AddDone()) throw new OpError(`${label}draft: the ${roundTo(draft.angle, 6)}° draft cannot be put on a side of the profile (sides that meet smoothly, or too steep an angle): try a smaller angle`);
    }
    dr.Build(s.track(new oc.Message_ProgressRange()));
    if (!dr.IsDone()) throw new OpError(`${label}draft: the ${roundTo(draft.angle, 6)}° draft failed in the kernel: try a smaller angle or a shorter extrude`);
    const out = s.track(dr.Shape());
    if (!isValidShape(oc, s, out)) throw new OpError(`${label}draft: at ${roundTo(draft.angle, 6)}° the sides meet before the end: make the angle smaller or the extrude shorter`);
    return out;
  }

  /** Split by a curved face: the pieces between the start and the face. The face must cover the whole profile. */
  private upToFace(solid: TopoDS_Shape, end: Extract<End, { kind: "face" }>, startShape: TopoDS_Shape, farCap: TopoDS_Shape, label: string): TopoDS_Shape {
    const { oc, s } = this;
    const sp = s.track(new oc.BRepAlgoAPI_Splitter());
    sp.SetArguments(s.track(new oc.NCollection_List_TopoDS_Shape([solid])));
    sp.SetTools(s.track(new oc.NCollection_List_TopoDS_Shape([end.face])));
    sp.Build(s.track(new oc.Message_ProgressRange()));
    if (!sp.IsDone()) throw new OpError(`${label}could not split the extrusion at ${end.what}`);
    const kept = solidsOf(oc, s, s.track(sp.Shape())).filter((p) => touches(oc, s, p, startShape));
    if (kept.length === 0) throw new OpError(`${label}${end.what} does not meet the extrusion`);
    if (kept.some((p) => touches(oc, s, p, farCap))) throw new OpError(`${label}${end.what} does not cover the whole profile: part of it would run on past the face; pick a face it meets all round`);
    return fuseAll(oc, s, kept);
  }

  /**
   * Up to the next face of the part: a boss keeps the space from its start to
   * the material it meets; a cut (and an intersect) the material from its
   * start, or from the far side of the gap before the part, to where it ends.
   */
  private upToNext(solid: TopoDS_Shape, startShape: TopoDS_Shape, farCap: TopoDS_Shape, label: string, dd: Vec3): TopoDS_Shape {
    const { oc, s } = this;
    const part = this.reach!;
    const run = (kind: "cut" | "common") => {
      const op = s.track(kind === "cut" ? new oc.BRepAlgoAPI_Cut(solid, part, s.track(new oc.Message_ProgressRange())) : new oc.BRepAlgoAPI_Common(solid, part, s.track(new oc.Message_ProgressRange())));
      if (!op.IsDone()) throw new OpError(`${label}up to next: the kernel could not find where the extrusion meets the part`);
      return solidsOf(oc, s, s.track(op.Shape()));
    };
    const gap = run("cut").filter((p) => touches(oc, s, p, startShape));
    if (this.f.op === "extrude" && !this.f.intersect) {
      if (gap.length === 0) throw new OpError(`${label}up to next: the extrude starts inside the material in direction ${formatDirection(dd)}, so there is no next face to go up to (reverse the direction?)`);
      if (gap.some((p) => touches(oc, s, p, farCap))) throw new OpError(`${label}up to next: the profile does not meet the part all round in direction ${formatDirection(dd)}: part of it would run on forever; use up to face or through all`);
      return fuseAll(oc, s, gap);
    }
    const inside = run("common");
    let kept = inside.filter((p) => touches(oc, s, p, startShape));
    if (kept.length === 0) kept = inside.filter((p) => gap.some((g) => touches(oc, s, p, g)));
    if (kept.length === 0) throw new OpError(`${label}up to next: the ${this.f.op} meets no material in direction ${formatDirection(dd)}`);
    return fuseAll(oc, s, [...gap.filter((g) => !touches(oc, s, g, farCap)), ...kept]);
  }
}

/** What of the shape is on the side of the plane where `ref` is. */
function keepSide(oc: RebuildCtx["oc"], s: Scope, shape: TopoDS_Shape, plane: Plane, ref: Vec3): TopoDS_Shape {
  const half = s.track(new oc.BRepPrimAPI_MakeHalfSpace(planeFace(oc, s, plane), pnt(oc, s, ref)));
  const op = s.track(new oc.BRepAlgoAPI_Common(shape, s.track(half.Solid()), s.track(new oc.Message_ProgressRange())));
  if (!op.IsDone()) throw new OpError("trimming the extrusion at its end failed in the kernel");
  return unify(oc, s, s.track(op.Shape()));
}

/** An unbounded planar face. */
function planeFace(oc: RebuildCtx["oc"], s: Scope, plane: Plane): TopoDS_Shape {
  const pln = s.track(new oc.gp_Pln(pnt(oc, s, plane.point), dir(oc, s, plane.normal)));
  return s.track(s.track(new oc.BRepBuilderAPI_MakeFace(pln)).Face());
}

/** The solids of a shape. */
function solidsOf(oc: RebuildCtx["oc"], s: Scope, shape: TopoDS_Shape): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = [];
  const ex = s.track(new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) {
    const solid = s.track(ex.Current());
    if (volumeOf(oc, s, solid) > 1e-9) out.push(solid);
  }
  return out;
}

/** Do the two shapes touch (or overlap)? */
function touches(oc: RebuildCtx["oc"], s: Scope, a: TopoDS_Shape, b: TopoDS_Shape): boolean {
  const dist = s.track(new oc.BRepExtrema_DistShapeShape(a, b));
  return dist.IsDone() && dist.Value() <= 1e-5;
}

/** Solids fused into one shape (one solid where they touch). */
function fuseAll(oc: RebuildCtx["oc"], s: Scope, solids: TopoDS_Shape[]): TopoDS_Shape {
  let out = solids[0];
  for (const p of solids.slice(1)) out = boolean(oc, s, "fuse", out, p);
  return out;
}

/** Why a cut removed nothing, in the cut's own terms. */
export function cutMissed(f: ExtrudeFeature, profile: SketchProfile): string {
  const d = normalize3(f.direction ?? profile.frame.z);
  const extent = f.extent ?? "blind";
  const hint = extent === "blind" || extent === "midplane" ? "; check direction and distance, or use extent throughAll" : extent === "throughAll" || extent === "throughAllBoth" ? "" : "; check the direction and what it goes up to";
  return `the cut does not reach the solid in direction ${formatDirection(d)}${hint}`;
}

/** The body an extrude adds to (or intersects), by the document's rule. */
export function extrudeBody(f: ExtrudeFeature): string {
  return f.newBody ?? f.body ?? DEFAULT_BODY;
}
