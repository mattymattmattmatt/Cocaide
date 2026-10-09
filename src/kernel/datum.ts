// Resolving reference geometry (DatumRef, DESIGN §2.1) on the part as it
// stands at a feature's place in the history: a default plane, axis or the
// origin; a plane, axis or point feature (ctx.datums); a face; an edge; a
// point. The result is a plain frame. A reference that resolves to the wrong
// kind, or to nothing, is an OpError that names it.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { DatumRef, EdgePoint, EdgeSelector, FaceSelector, PlaneSpec, Vec3 } from "../doc/types";
import type { ValidationResult } from "../doc/validate";
import { aKind, DATUM_OPS, defaultDatum, facePlane, refPlaneFrame, xDirProblem, type Datum, type DatumKind, type DatumOf } from "../features/datum";
import { planeFrame, type Frame } from "../geom/frame";
import { dist3, formatDirection, normalize3, roundTo, sub3 } from "../geom/vec";
import { describePart, type DescribedPart } from "./bodies";
import { scoped, type OC } from "./oc";
import { OpError } from "./ops";
import { describeEdgeSelector, describeWanted, edgeSelectionError, selectEdges, selectFaces, selectionError } from "./selectors";
import type { EdgeInfo, FaceInfo } from "./topology";

/** What resolving a reference needs from the rebuild (a RebuildCtx has all of it). */
export interface DatumContext {
  oc: OC;
  v: ValidationResult;
  bodies: ReadonlyMap<string, TopoDS_Shape>;
  datums: ReadonlyMap<string, Datum>;
  missing(id: string, what: string): string;
}

/**
 * The plane, axis or point a reference stands for now. `want` is the kind the
 * caller needs ("any" takes what the reference is: a circular edge is then
 * its axis). `path` is the reference's field, for messages ("axis", "plane.ref").
 */
export function resolveDatum<K extends DatumKind>(ctx: DatumContext, ref: DatumRef, want: K, path?: string): DatumOf<K>;
export function resolveDatum(ctx: DatumContext, ref: DatumRef, want: "any", path?: string): Datum;
export function resolveDatum(ctx: DatumContext, ref: DatumRef, want: DatumKind | "any", path = "ref"): Datum {
  const got = resolve(ctx, ref, want, path);
  if (want !== "any" && got.kind !== want) throw new OpError(`${path}: ${nameOf(ref)} is ${aKind(got.kind)}, but ${aKind(want)} is needed here`);
  return got;
}

/** A sketch's (or a mirror's, a split's) plane as a frame: written out, or resolved by reference with its offset, flip and xDir. */
export function planeSpecFrame(ctx: DatumContext, spec: PlaneSpec, path = "plane"): Frame {
  if (spec.type === "datum") return planeFrame(spec.normal, spec.origin, spec.xDir);
  const plane = resolveDatum(ctx, spec.ref, "plane", `${path}.ref`);
  if (spec.xDir) {
    const problem = xDirProblem(plane.normal, spec.xDir);
    if (problem) throw new OpError(`${path}.xDir: ${problem} (${nameOf(spec.ref)} has normal ${formatDirection(plane.normal)})`);
  }
  return refPlaneFrame(plane, spec);
}

function resolve(ctx: DatumContext, ref: DatumRef, want: DatumKind | "any", path: string): Datum {
  if ("datum" in ref) return byId(ctx, ref.datum);
  if ("point" in ref) return { kind: "point", at: [...ref.point] };
  if (ctx.bodies.size === 0) throw new OpError(`${path}: there is no solid before this feature to take ${"face" in ref ? "a face" : "an edge"} from`);
  return "face" in ref ? fromFace(ctx, ref.face, path) : fromEdge(ctx, ref.edge, ref.at, want, path);
}

function byId(ctx: DatumContext, id: string): Datum {
  const d = defaultDatum(id) ?? ctx.datums.get(id);
  if (d) return d;
  // Validation sees to it that the id is an earlier plane, axis or point: here it failed or is suppressed.
  const op = ctx.v.features.find((f) => f.id === id)?.op ?? "reference";
  const kind = Object.hasOwn(DATUM_OPS, op) ? DATUM_OPS[op] : "reference";
  throw new OpError(`${ctx.missing(id, op)}, so there is no ${kind} to use`);
}

/** The one face a selector picks on the part as it stands, or OpError (path: the selector's field, "refs[0].face"). */
export function findFace(ctx: DatumContext, sel: FaceSelector, path: string): FaceInfo {
  if (ctx.bodies.size === 0) throw new OpError(`${path}: there is no solid before this feature to take a face from`);
  return scoped((s) => {
    const part = describePart(ctx.oc, s, ctx.bodies as Map<string, TopoDS_Shape>, false);
    const found = selectFaces(part.faceInfos, sel);
    const problem = selectionError(sel, found, 1);
    if (problem) throw new OpError(`${path}: ${problem}`);
    return found.matches[0];
  });
}

/** The one edge a selector picks: its index in `part`, after describePart with edges. */
function pickEdge(part: DescribedPart, sel: EdgeSelector, path: string): number {
  const found = selectEdges(part.edgeInfos, part.faceInfos, sel, path);
  const problem = edgeSelectionError(sel, found, path);
  if (problem) throw new OpError(problem);
  if (found.matches.length > 1) {
    throw new OpError(`${path}: selector matched ${found.matches.length} edges (wanted 1 of ${describeEdgeSelector(sel)}); add "near", or pick "longest" or "shortest"`);
  }
  return found.matches[0].index;
}

/** The one edge a selector picks on the part as it stands, or OpError (path: the selector's field, "refs[0].edge"). */
export function findEdge(ctx: DatumContext, sel: EdgeSelector, path: string): EdgeInfo {
  if (ctx.bodies.size === 0) throw new OpError(`${path}: there is no solid before this feature to take an edge from`);
  return scoped((s) => {
    const part = describePart(ctx.oc, s, ctx.bodies as Map<string, TopoDS_Shape>, true);
    return part.edgeInfos[pickEdge(part, sel, path)];
  });
}

/** A point of an edge and the edge's direction there (unit, the way the edge runs from its start to its end). */
export interface EdgePlace {
  at: Vec3;
  tangent: Vec3;
  /** Where along the edge, 0 (start) to 1 (end), as a share of its parameter range. */
  t: number;
  edge: EdgeInfo;
}

/**
 * Along the edge a selector picks: at `t` (0 its start, 1 its end, a share of
 * its parameter, so of its length for lines and arcs), or at the point of it
 * nearest `near`. Works on any edge (straight, round or curved).
 */
export function edgePlace(ctx: DatumContext, sel: EdgeSelector, path: string, where: { t: number } | { near: Vec3 }): EdgePlace {
  if (ctx.bodies.size === 0) throw new OpError(`${path}: there is no solid before this feature to take an edge from`);
  const { oc } = ctx;
  return scoped((s) => {
    const part = describePart(oc, s, ctx.bodies as Map<string, TopoDS_Shape>, true);
    const index = pickEdge(part, sel, path);
    const curve = s.track(new oc.BRepAdaptor_Curve(part.edges[index]));
    const u0 = curve.FirstParameter();
    const u1 = curve.LastParameter();
    const point = (u: number): Vec3 => {
      const p = curve.EvalD0(u);
      const v: Vec3 = [p.X(), p.Y(), p.Z()];
      p.delete();
      return v;
    };
    let t: number;
    if ("t" in where) t = where.t;
    else {
      // The nearest point: the best of a fine sampling, then narrowed down by golden sections.
      const d = (k: number) => dist3(point(u0 + k * (u1 - u0)), where.near);
      const N = 64;
      let best = 0;
      for (let k = 1; k <= N; k++) if (d(k / N) < d(best / N)) best = k;
      let a = Math.max(0, (best - 1) / N);
      let b = Math.min(1, (best + 1) / N);
      const g = (Math.sqrt(5) - 1) / 2;
      for (let i = 0; i < 60; i++) {
        const m1 = b - g * (b - a);
        const m2 = a + g * (b - a);
        if (d(m1) <= d(m2)) b = m2;
        else a = m1;
      }
      t = (a + b) / 2;
    }
    const r = curve.EvalD1(u0 + t * (u1 - u0));
    const at: Vec3 = [r.Point.X(), r.Point.Y(), r.Point.Z()];
    const d1: Vec3 = [r.D1.X(), r.D1.Y(), r.D1.Z()];
    r.Point.delete();
    r.D1.delete();
    if (Math.hypot(...d1) < 1e-12) throw new OpError(`${path}: the edge has no direction at t = ${roundTo(t, 6)} (it is degenerate there); pick another point along it`);
    return { at, tangent: normalize3(d1), t, edge: part.edgeInfos[index] };
  });
}

function fromFace(ctx: DatumContext, sel: FaceSelector, path: string): Datum {
  return scoped((s) => {
    const part = describePart(ctx.oc, s, ctx.bodies as Map<string, TopoDS_Shape>, false);
    const found = selectFaces(part.faceInfos, sel);
    const problem = selectionError(sel, found, 1);
    if (problem) throw new OpError(`${path}.face: ${problem}`);
    const face = found.matches[0];
    if (face.type === "plane" && face.normal && face.point) return facePlane(face.normal, face.point);
    if (face.type === "cylinder" && face.cylinder) return { kind: "axis", origin: [...face.cylinder.origin], direction: normalize3(face.cylinder.axis) };
    if (face.type === "cone") {
      // A cone's axis is the axis of the circles that bound it.
      const full = describePart(ctx.oc, s, ctx.bodies as Map<string, TopoDS_Shape>, true);
      const circle = full.edgeInfos.find((e) => e.kind === "circle" && e.faces.includes(face.index) && e.center && e.axis);
      if (circle) return { kind: "axis", origin: [...circle.center!], direction: normalize3(circle.axis!) };
      throw new OpError(`${path}.face: the conical face ${where(face)} has no circular edge to take its axis from`);
    }
    throw new OpError(`${path}.face: the face ${where(face)} is curved but not round: it is no plane or axis`);
  });
}

function fromEdge(ctx: DatumContext, sel: EdgeSelector, at: EdgePoint | undefined, want: DatumKind | "any", path: string): Datum {
  const edge = findEdge(ctx, sel, `${path}.edge`);
  const what = edge.kind === "line" ? "straight edge" : edge.kind === "circle" ? "circular edge" : "curved edge";
  switch (at) {
    case "start":
      return { kind: "point", at: edge.start };
    case "end":
      return { kind: "point", at: edge.end };
    case "mid":
      return { kind: "point", at: edge.mid };
    case "center":
      if (edge.kind !== "circle" || !edge.center) throw new OpError(`${path}.at: "center" is a circular edge's centre, but the edge is a ${what}${edge.kind === "line" ? '; use "mid" for its middle' : ""}`);
      return { kind: "point", at: edge.center };
  }
  if (edge.kind === "circle" && edge.center && edge.axis) {
    return want === "point" ? { kind: "point", at: edge.center } : { kind: "axis", origin: edge.center, direction: normalize3(edge.axis) };
  }
  if (edge.kind === "line" && edge.direction) {
    if (want === "point") throw new OpError(`${path}: the ${what} is an axis, but a point is needed here; give "at": "start", "end" or "mid" for a point of it`);
    return { kind: "axis", origin: edge.start, direction: normalize3(sub3(edge.end, edge.start)) };
  }
  throw new OpError(`${path}: the ${what} is neither straight nor circular, so it is no axis; give "at": "start", "end" or "mid" for a point of it`);
}

/** A reference as messages name it: "Top", "plane_1", "the planar face normal +Z", "the edge (line edges parallel to +Z)". */
export function nameOf(ref: DatumRef): string {
  if ("datum" in ref) return ref.datum;
  if ("face" in ref) return describeWanted(ref.face, 1).replace(/^1 /, "the ");
  if ("edge" in ref) return `${ref.at ? `the ${ref.at === "mid" ? "middle" : ref.at} of ` : ""}the edge (${describeEdgeSelector(ref.edge)})`;
  return `the point [${ref.point.map((x) => roundTo(x, 4)).join(", ")}]`;
}

function where(face: FaceInfo): string {
  return `at [${face.centroid.map((x) => roundTo(x, 4)).join(", ")}]`;
}
