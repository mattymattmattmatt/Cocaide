// Resolving reference geometry (DatumRef, DESIGN §2.1) on the part as it
// stands at a feature's place in the history: a default plane, axis or the
// origin; a plane, axis or point feature (ctx.datums); a face; an edge; a
// point. The result is a plain frame. A reference that resolves to the wrong
// kind, or to nothing, is an OpError that names it.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { DatumRef, EdgePoint, EdgeSelector, FaceSelector, PlaneSpec } from "../doc/types";
import type { ValidationResult } from "../doc/validate";
import { aKind, DATUM_OPS, defaultDatum, facePlane, refPlaneFrame, xDirProblem, type Datum, type DatumKind, type DatumOf } from "../features/datum";
import { planeFrame, type Frame } from "../geom/frame";
import { formatDirection, normalize3, roundTo, sub3 } from "../geom/vec";
import { describePart } from "./bodies";
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
  const edge: EdgeInfo = scoped((s) => {
    const part = describePart(ctx.oc, s, ctx.bodies as Map<string, TopoDS_Shape>, true);
    const found = selectEdges(part.edgeInfos, part.faceInfos, sel, `${path}.edge`);
    const problem = edgeSelectionError(sel, found, `${path}.edge`);
    if (problem) throw new OpError(problem);
    if (found.matches.length > 1) {
      throw new OpError(`${path}.edge: selector matched ${found.matches.length} edges (wanted 1 of ${describeEdgeSelector(sel)}); add "near", or pick "longest" or "shortest"`);
    }
    return found.matches[0];
  });
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
