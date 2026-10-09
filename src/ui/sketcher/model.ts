// The model as the sketcher sees it (DESIGN §2.4): the part's edges projected
// into the sketch plane, each still knowing which edge it is, what kind, and
// its exact projection, so the sketcher can draw, hit, snap to and relate to
// them; and the faces lying along the sketch, for Convert Entities.
//
// Inside the sketcher a model edge goes by a stand-in id, "@e<index>", and
// is a sketch entity of that id (a line, circle or arc with the projection's
// numbers): picks, suggestions, snaps and relations use it like any entity.
// Before anything reaches the draft, `materialize` turns each stand-in into a
// reference entity of the sketch: a construction entity with
// ref { edge: <selector> } (or a converted one, construction: false), reusing
// one the sketch already has for that edge. Pure: unit-tested in node.

import { ENTITY_PREFIX, isConstruction, nextEntityId } from "../../doc/sketch";
import type { Constraint, EdgeSelector, SketchEntity, Vec2 } from "../../doc/types";
import { planeFrame, to2D, type Frame } from "../../geom/frame";
import { projectEdge, REFERENCEABLE } from "../../geom/projection";
import { dist2 } from "../../geom/vec";
import { edgeSelectorFor } from "../../kernel/synthesize";
import type { EdgeInfo, FaceInfo } from "../../kernel/topology";
import type { MeshData } from "../../kernel/mesh";

/** What stands for model edge `index` inside the sketcher. */
export const modelId = (index: number) => `@e${index}`;
export const isModelId = (id: string | null | undefined): boolean => !!id && id.startsWith("@e");
/** The edge index a stand-in id ("@e12", or a point of it, "@e12.start") stands for. */
export const modelIndex = (id: string): number => Number(id.slice(2).split(".")[0]);

/** A placeholder ref on a stand-in: it marks it as a reference (the solver holds it) until it is materialized. */
const PENDING: { edge: EdgeSelector } = { edge: { type: "edge", pick: "all" } };

export interface ModelEdge {
  index: number;
  /** "@e<index>". */
  id: string;
  kind: EdgeInfo["kind"];
  /** The projected edge as drawn: its tessellation, in sketch mm. */
  poly: Vec2[];
  /** The stand-in entity, when the edge projects to something a sketch can reference. */
  entity: SketchEntity | null;
  /** Why it can't be referenced, when it can't. */
  problem?: string;
  /** Both its ends lie in the sketch plane. */
  inPlane: boolean;
  /** The faces it bounds (FaceInfo indices). */
  faces: number[];
  length: number;
}

/** A face lying along the sketch plane: its boundary is what Convert Entities takes from it. */
export interface ModelFace {
  index: number;
  /** Its triangles projected into the sketch: for hit testing and the hover tint. */
  triangles: [Vec2, Vec2, Vec2][];
  /** Its bounding edges (indices), seams left out. */
  edges: number[];
  /** It lies in the sketch plane itself (not merely parallel). */
  inPlane: boolean;
}

export interface ModelView {
  edges: ModelEdge[];
  faces: ModelFace[];
  /** The part's own descriptions, for selectors that find these edges again on rebuild. */
  source: { edges: EdgeInfo[]; faces: FaceInfo[] };
  frame: Frame;
}

export const EMPTY_MODEL: ModelView = { edges: [], faces: [], source: { edges: [], faces: [] }, frame: planeFrame([0, 0, 1], [0, 0, 0]) };

/** Within this, mm, a point counts as on the sketch plane. */
const ON_PLANE = 1e-6;

/** The part's edges and the faces along the sketch, projected into the sketch's frame. */
export function modelView(view: { mesh: MeshData | null; edges: EdgeInfo[]; faces: FaceInfo[] } | null, frame: Frame): ModelView {
  if (!view?.mesh) return { ...EMPTY_MODEL, frame };
  const mesh = view.mesh;
  const height = (p: [number, number, number]) => (p[0] - frame.origin[0]) * frame.z[0] + (p[1] - frame.origin[1]) * frame.z[1] + (p[2] - frame.origin[2]) * frame.z[2];
  const edges: ModelEdge[] = [];
  view.edges.forEach((info, i) => {
    if (info.seam) return;
    const r = mesh.edgeRanges[i];
    const poly: Vec2[] = [];
    if (r) {
      for (let k = r.start; k < r.start + r.count; k++) {
        const a = to2D(frame, [mesh.edges[k * 6], mesh.edges[k * 6 + 1], mesh.edges[k * 6 + 2]]);
        const b = to2D(frame, [mesh.edges[k * 6 + 3], mesh.edges[k * 6 + 4], mesh.edges[k * 6 + 5]]);
        if (!poly.length) poly.push(a);
        poly.push(b);
      }
    }
    const shape = projectEdge(info, frame);
    const id = modelId(info.index);
    const entity: SketchEntity | null = shape.ok ? ({ id, ...shape.shape, construction: true, ref: PENDING } as SketchEntity) : null;
    edges.push({
      index: info.index,
      id,
      kind: info.kind,
      poly,
      entity,
      ...(shape.ok ? {} : { problem: shape.error }),
      inPlane: Math.abs(height(info.start)) < ON_PLANE && Math.abs(height(info.end)) < ON_PLANE,
      faces: info.faces,
      length: info.length,
    });
  });
  const faces: ModelFace[] = [];
  view.faces.forEach((f, i) => {
    // A flat face facing along the sketch normal (either way): what a sketch on or above it would trace.
    if (f.type !== "plane" || !f.normal || Math.abs(f.normal[0] * frame.z[0] + f.normal[1] * frame.z[1] + f.normal[2] * frame.z[2]) < 1 - 1e-9) return;
    const range = mesh.faceRanges[i];
    if (!range) return;
    const at = (v: number): Vec2 => to2D(frame, [mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]]);
    const triangles: [Vec2, Vec2, Vec2][] = [];
    for (let k = range.start; k + 2 < range.start + range.count; k += 3) triangles.push([at(mesh.indices[k]), at(mesh.indices[k + 1]), at(mesh.indices[k + 2])]);
    faces.push({
      index: f.index,
      triangles,
      edges: view.edges.filter((e) => !e.seam && e.faces.includes(f.index)).map((e) => e.index),
      inPlane: !!f.point && Math.abs(height(f.point)) < ON_PLANE,
    });
  });
  return { edges, faces, source: { edges: view.edges, faces: view.faces }, frame };
}

/**
 * The stand-in entities of the edges that can be referenced, those lying in
 * the sketch plane first: where an edge on the plane and one behind it
 * project to the same line, the one on the plane is what a pick means.
 */
export function modelEntities(m: ModelView): SketchEntity[] {
  const usable = m.edges.filter((e) => e.entity);
  return [...usable.filter((e) => e.inPlane), ...usable.filter((e) => !e.inPlane)].map((e) => e.entity!);
}

export function modelEdge(m: ModelView, id: string): ModelEdge | undefined {
  const index = modelIndex(id);
  return m.edges.find((e) => e.index === index);
}

/** The face under p, if any: the one in the sketch plane first, else the one nearest it. */
export function faceAt(m: ModelView, p: Vec2): ModelFace | null {
  const hits = m.faces.filter((f) => f.triangles.some((t) => inTriangle(p, t)));
  return hits.find((f) => f.inPlane) ?? hits[0] ?? null;
}

function inTriangle(p: Vec2, [a, b, c]: [Vec2, Vec2, Vec2]): boolean {
  const s = (u: Vec2, v: Vec2) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const d1 = s(a, b);
  const d2 = s(b, c);
  const d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// ------------------------------------------------------------------ materializing

export interface Materialized {
  /** The sketch's entities with the new references added (and converted ones updated). */
  entities: SketchEntity[];
  /** Stand-in id -> the reference entity's id. */
  ids: Map<string, string>;
  /** The reference entities added (not those reused). */
  added: SketchEntity[];
}

/**
 * Turns the model edges `ids` stands in for into reference entities of the
 * sketch, with a selector that finds each edge again when the part rebuilds.
 * An edge the sketch already references (the same selector, the same kind of
 * entity) is reused. `convert`: Convert Entities makes profile geometry
 * (construction: false), and turns a construction reference of that edge
 * already there into profile geometry. A string says why not.
 */
export function materialize(ids: Iterable<string>, m: ModelView, entities: SketchEntity[], opts: { convert?: boolean } = {}): Materialized | string {
  const out = [...entities];
  const map = new Map<string, string>();
  const added: SketchEntity[] = [];
  for (const raw of ids) {
    const id = raw.split(".")[0];
    if (!isModelId(id) || map.has(id)) continue;
    const edge = modelEdge(m, id);
    if (!edge) return "that model edge is not in the part any more";
    if (!edge.entity) return `that model edge can't be referenced: ${edge.problem ?? REFERENCEABLE}`;
    const sel = edgeSelectorFor(m.source.edges, m.source.faces, edge.index);
    if (!sel.ok) return `that model edge can't be referenced: ${sel.error}`;
    const key = JSON.stringify(sel.selector);
    const at = out.findIndex((e) => e.type === edge.entity!.type && !!e.ref && "edge" in e.ref && !e.ref.at && JSON.stringify(e.ref.edge) === key);
    if (at >= 0) {
      if (opts.convert && isConstruction(out[at])) out[at] = { ...out[at], construction: false };
      map.set(id, out[at].id);
      continue;
    }
    const { id: _stand, construction: _c, ref: _r, ...numbers } = edge.entity as SketchEntity & Record<string, unknown>;
    const e = { id: nextEntityId(out, ENTITY_PREFIX[edge.entity.type]), ...cleaned(numbers), ref: { edge: sel.selector }, ...(opts.convert ? { construction: false } : {}) } as SketchEntity;
    out.push(e);
    added.push(e);
    map.set(id, e.id);
  }
  return { entities: out, ids: map, added };
}

/** Projected numbers as the document keeps them: within 1e-9 of a 6-decimal number, that number (the rebuild projects them again anyway). */
function cleaned(fields: Record<string, unknown>): Record<string, unknown> {
  const c = (x: number) => {
    const r = Math.round(x * 1e6) / 1e6;
    return (Math.abs(x - r) < 1e-9 ? r : x) + 0;
  };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "number" ? c(v) : Array.isArray(v) ? v.map((x) => (typeof x === "number" ? c(x) : x)) : v]));
}

/** The constraint with each stand-in id (and point of one) renamed by `ids`. */
export function renamed(k: Constraint, ids: Map<string, string>): Constraint {
  const id = (x: string) => ids.get(x) ?? x;
  const point = (r: string) => {
    const [owner, ...rest] = r.split(".");
    return ids.has(owner) ? [ids.get(owner)!, ...rest].join(".") : r;
  };
  const out = { ...k } as Record<string, unknown>;
  if (Array.isArray(out.points)) out.points = (out.points as string[]).map(point);
  if (typeof out.point === "string") out.point = point(out.point);
  if (typeof out.entity === "string") out.entity = id(out.entity);
  if (typeof out.line === "string") out.line = id(out.line);
  if (Array.isArray(out.entities)) out.entities = (out.entities as string[]).map(id);
  return out as unknown as Constraint;
}

/** Every stand-in id a constraint names. */
export function modelIdsOf(k: Constraint): string[] {
  const all = [...(("points" in k && k.points) || []), ...("point" in k && k.point ? [k.point] : []), ...("entity" in k && k.entity ? [k.entity] : []), ...("line" in k && k.line ? [k.line] : []), ...("entities" in k ? k.entities : [])];
  return [...new Set(all.map((x) => x.split(".")[0]).filter(isModelId))];
}

/**
 * Convert Entities: the picked model edges (and every edge of each picked
 * face) as reference entities, profile geometry unless `construction`, with a
 * coincident relation wherever two of their ends meet, so a converted loop
 * reads as one. A string says why not.
 */
export function convertEdges(edgeIds: string[], faceIndices: number[], m: ModelView, entities: SketchEntity[], constraints: Constraint[], construction = false): { entities: SketchEntity[]; constraints: Constraint[]; count: number } | string {
  const ids = [...new Set([...edgeIds.map((x) => x.split(".")[0]), ...faceIndices.flatMap((f) => m.faces.find((x) => x.index === f)?.edges ?? []).map(modelId)])];
  const usable = ids.filter((id) => modelEdge(m, id)?.entity);
  if (!usable.length) {
    const why = ids.map((id) => modelEdge(m, id)?.problem).find(Boolean);
    return why ? `nothing to convert: ${why}` : "nothing to convert: pick model edges or a face first";
  }
  const made = materialize(usable, m, entities, { convert: !construction });
  if (typeof made === "string") return made;
  const converted = usable.map((id) => made.entities.find((e) => e.id === made.ids.get(id))!);
  const out = [...constraints];
  const has = (a: string, b: string) => out.some((k) => k.type === "coincident" && k.points.includes(a) && k.points.includes(b));
  const ends = converted.flatMap((e) => (e.type === "line" || e.type === "arc" ? [[`${e.id}.start`, e.start], [`${e.id}.end`, e.end]] as [string, Vec2][] : []));
  const joined = new Set<string>();
  for (let i = 0; i < ends.length; i++) {
    if (joined.has(ends[i][0])) continue;
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i][0].split(".")[0] === ends[j][0].split(".")[0] || dist2(ends[i][1], ends[j][1]) > 1e-6) continue;
      if (!has(ends[i][0], ends[j][0])) out.push({ type: "coincident", points: [ends[i][0], ends[j][0]] });
      joined.add(ends[j][0]);
      break;
    }
  }
  return { entities: made.entities, constraints: out, count: usable.length };
}
