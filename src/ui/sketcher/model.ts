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
//
// The entities of the other sketches in view (earlier ones: a sketch takes
// only an earlier sketch's entities, DESIGN §2.9) stand in the same way, by
// "@s:<sketch>:<entity>", projected into this sketch's plane as a model edge
// is; one becomes a reference entity with ref { sketch, entity }. Every model
// edge and other sketch's entity also keeps its 3D outline, which the
// sketcher draws and hits where the 3D view shows it when the view is turned.

import { ENTITY_PREFIX, isConstruction, nextEntityId } from "../../doc/sketch";
import type { Constraint, EdgeSelector, SketchEntity, Vec2, Vec3 } from "../../doc/types";
import { planeFrame, to2D, to3D, type Frame } from "../../geom/frame";
import { entityPolylines } from "../../geom/profile";
import { projectEdge, projectPoint, REFERENCEABLE } from "../../geom/projection";
import { SKETCH_REFERENCEABLE, sketchEntityEdge } from "../../geom/sketchEdge";
import { dist2 } from "../../geom/vec";
import { edgeSelectorFor } from "../../kernel/synthesize";
import { selectEdges } from "../../kernel/selectors";
import type { EdgeInfo, FaceInfo } from "../../kernel/topology";
import type { MeshData } from "../../kernel/mesh";

/** What stands for model edge `index` inside the sketcher. */
export const modelId = (index: number) => `@e${index}`;
/** What stands for entity `entity` of the earlier sketch `sketch` inside the sketcher. */
export const sketchStandIn = (sketch: string, entity: string) => `@s:${sketch}:${entity}`;
/** A stand-in (or a point of one): a model edge's ("@e12") or another sketch's entity's ("@s:sketch_1:l2"), not the sketch's own. */
export const isModelId = (id: string | null | undefined): boolean => !!id && (id.startsWith("@e") || id.startsWith("@s:"));
/** Another sketch's entity's stand-in (or a point of one). */
export const isSketchStandIn = (id: string | null | undefined): boolean => !!id && id.startsWith("@s:");
/** The edge index a model edge's stand-in id ("@e12", or a point of it, "@e12.start") stands for (NaN for another sketch's). */
export const modelIndex = (id: string): number => (id.startsWith("@e") ? Number(id.slice(2).split(".")[0]) : NaN);
/** The sketch and entity another sketch's stand-in ("@s:sketch_1:l2", or a point of it) stands for. */
export function standInSource(id: string): { sketch: string; entity: string } | null {
  if (!isSketchStandIn(id)) return null;
  const [, sketch, entity] = id.split(".")[0].split(":");
  return sketch && entity ? { sketch, entity } : null;
}

/** A placeholder ref on a stand-in: it marks it as a reference (the solver holds it) until it is materialized. */
const PENDING: { edge: EdgeSelector } = { edge: { type: "edge", pick: "all" } };

export interface ModelEdge {
  /** The B-rep edge's index (−1 for another sketch's entity). */
  index: number;
  /** "@e<index>" ("@s:<sketch>:<entity>" for another sketch's entity). */
  id: string;
  kind: EdgeInfo["kind"];
  /** The projected edge as drawn: its tessellation, in sketch mm. */
  poly: Vec2[];
  /** The edge in the model: its tessellation, world mm (what the 3D view shows; a turned view hits it there). */
  poly3: Vec3[];
  /** The stand-in entity, when the edge projects to something a sketch can reference. */
  entity: SketchEntity | null;
  /** Why it can't be referenced, when it can't. */
  problem?: string;
  /** Both its ends lie in the sketch plane. */
  inPlane: boolean;
  /** The faces it bounds (FaceInfo indices). */
  faces: number[];
  length: number;
  /** Another sketch's entity: which, as that sketch is solved, and its points in 3D (its ends, centre, a point's place) by name. */
  source?: { sketch: string; entity: SketchEntity; points: { name: string; at: Vec3 }[] };
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
  /** The other sketches' entities in view (each with `source`): drawn in the 3D view, referenced by { sketch, entity }. */
  others: ModelEdge[];
  /** The part's own descriptions, for selectors that find these edges again on rebuild. */
  source: { edges: EdgeInfo[]; faces: FaceInfo[] };
  frame: Frame;
}

export const EMPTY_MODEL: ModelView = { edges: [], faces: [], others: [], source: { edges: [], faces: [] }, frame: planeFrame([0, 0, 1], [0, 0, 0]) };

/** Within this, mm, a point counts as on the sketch plane. */
const ON_PLANE = 1e-6;

/** What modelView reads of another sketch: as the rebuild drew and solved it (src/kernel/rebuild.ts SketchOverlay). */
export interface SketchInView {
  id: string;
  ok: boolean;
  entities: SketchEntity[];
  frame: Frame;
}

/**
 * The part's edges and the faces along the sketch, projected into the
 * sketch's frame; and the other sketches' entities (those of `view.sketches`
 * that built, but `exclude`: the sketch being edited).
 */
export function modelView(view: { mesh: MeshData | null; edges: EdgeInfo[]; faces: FaceInfo[]; sketches?: SketchInView[] } | null, frame: Frame, opts: { exclude?: string } = {}): ModelView {
  const others = otherSketches(view?.sketches ?? [], frame, opts.exclude);
  if (!view?.mesh) return { ...EMPTY_MODEL, others, frame };
  const mesh = view.mesh;
  const height = (p: [number, number, number]) => (p[0] - frame.origin[0]) * frame.z[0] + (p[1] - frame.origin[1]) * frame.z[1] + (p[2] - frame.origin[2]) * frame.z[2];
  const edges: ModelEdge[] = [];
  view.edges.forEach((info, i) => {
    if (info.seam) return;
    const r = mesh.edgeRanges[i];
    const poly: Vec2[] = [];
    const poly3: Vec3[] = [];
    if (r) {
      for (let k = r.start; k < r.start + r.count; k++) {
        const a3: Vec3 = [mesh.edges[k * 6], mesh.edges[k * 6 + 1], mesh.edges[k * 6 + 2]];
        const b3: Vec3 = [mesh.edges[k * 6 + 3], mesh.edges[k * 6 + 4], mesh.edges[k * 6 + 5]];
        if (!poly.length) {
          poly.push(to2D(frame, a3));
          poly3.push(a3);
        }
        poly.push(to2D(frame, b3));
        poly3.push(b3);
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
      poly3,
      entity,
      ...(shape.ok ? {} : { problem: shape.error }),
      inPlane: lies(info, frame, height),
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
  return { edges, faces, others, source: { edges: view.edges, faces: view.faces }, frame };
}

/**
 * The entities of the other sketches that built (not `exclude`), each with
 * its stand-in: its projection into this sketch's frame when that is a line,
 * a circle, an arc or a point (else why it can't be referenced), its outline
 * in 3D and in this sketch, and its points in 3D.
 */
function otherSketches(sketches: SketchInView[], frame: Frame, exclude?: string): ModelEdge[] {
  const out: ModelEdge[] = [];
  for (const s of sketches) {
    if (!s.ok || s.id === exclude) continue;
    for (const e of s.entities) {
      const id = sketchStandIn(s.id, e.id);
      const lines = e.type === "point" ? [[e.at]] : entityPolylines(e, Math.PI / 48);
      const poly3 = lines.flatMap((pl) => pl.map((p) => to3D(s.frame, p)));
      const points = sketchPoints(e).map(([name, p]) => ({ name, at: to3D(s.frame, p) }));
      let entity: SketchEntity | null = null;
      let problem: string | undefined;
      if (e.type === "point") entity = { id, type: "point", at: projectPoint(to3D(s.frame, e.at), frame), construction: true, ref: { sketch: s.id, entity: e.id } };
      else {
        const edge = sketchEntityEdge(e, s.frame);
        if (typeof edge === "string") problem = edge;
        else {
          const shape = projectEdge(edge, frame);
          if (shape.ok) entity = { id, ...shape.shape, construction: true, ref: { sketch: s.id, entity: e.id } } as SketchEntity;
          else problem = shape.error.replace(/^the (straight|circular) edge/, `${s.id}'s ${e.type} ${e.id}`);
        }
      }
      const inPlane = poly3.length > 0 && poly3.every((p) => Math.abs((p[0] - frame.origin[0]) * frame.z[0] + (p[1] - frame.origin[1]) * frame.z[1] + (p[2] - frame.origin[2]) * frame.z[2]) < ON_PLANE);
      out.push({
        index: -1,
        id,
        kind: e.type === "line" ? "line" : e.type === "circle" || e.type === "arc" ? "circle" : "other",
        poly: poly3.map((p) => to2D(frame, p)),
        poly3,
        entity,
        ...(problem ? { problem } : {}),
        inPlane,
        faces: [],
        length: lines.reduce((t, pl) => t + pl.reduce((u, p, i) => (i ? u + dist2(pl[i - 1], p) : u), 0), 0),
        source: { sketch: s.id, entity: e, points },
      });
    }
  }
  return out;
}

/** The points of an entity another sketch may reference, by the name a point ref gives them ("start", "center", "at"). */
function sketchPoints(e: SketchEntity): [string, Vec2][] {
  switch (e.type) {
    case "line":
      return [["start", e.start], ["end", e.end]];
    case "arc":
      return [["start", e.start], ["end", e.end], ["center", e.center]];
    case "circle":
      return [["center", e.center]];
    case "point":
      return [["at", e.at]];
    default:
      return [];
  }
}

/**
 * Whether the edge lies in the sketch plane. A circle (or arc) does when its
 * plane is the sketch's: its centre on it, its axis along the normal. Its
 * ends alone don't say so: a hole's rim seen edge-on from a plane through its
 * axis starts and ends on that plane. Anything else: its ends and middle.
 */
function lies(info: EdgeInfo, frame: Frame, height: (p: [number, number, number]) => number): boolean {
  if (info.kind === "circle" && info.center && info.axis) {
    const a = info.axis;
    const along = Math.abs(a[0] * frame.z[0] + a[1] * frame.z[1] + a[2] * frame.z[2]) / (Math.hypot(a[0], a[1], a[2]) || 1);
    return along > 1 - 1e-9 && Math.abs(height(info.center)) < ON_PLANE;
  }
  return [info.start, info.end, info.mid].every((p) => Math.abs(height(p)) < ON_PLANE);
}

/**
 * The stand-in entities of the edges that can be referenced, those lying in
 * the sketch plane first: where an edge on the plane and one behind it
 * project to the same line, the one on the plane is what a pick means.
 */
export function modelEntities(m: ModelView): SketchEntity[] {
  const usable = m.edges.filter((e) => e.entity);
  return [...usable.filter((e) => e.inPlane), ...usable.filter((e) => !e.inPlane), ...m.others.filter((e) => e.entity)].map((e) => e.entity!);
}

/** The model edge, or other sketch's entity, a stand-in id (or a point of one) stands for. */
export function modelEdge(m: ModelView, id: string): ModelEdge | undefined {
  if (isSketchStandIn(id)) {
    const own = id.split(".")[0];
    return m.others.find((e) => e.id === own);
  }
  const index = modelIndex(id);
  return m.edges.find((e) => e.index === index);
}

/**
 * The reference entities whose model edge is gone (their selector finds no
 * edge, or several, in the part as the sketch sees it), or whose other
 * sketch's entity is not in view (that sketch failed, is suppressed, or no
 * longer has it): dangling relations, drawn brown. Datum and point references
 * are left to the rebuild.
 */
export function danglingRefs(entities: SketchEntity[], m: ModelView): Set<string> {
  const out = new Set<string>();
  for (const e of entities) {
    if (e.ref && "sketch" in e.ref) {
      const found = m.others.find((o) => o.source?.sketch === (e.ref as { sketch: string }).sketch && o.source.entity.id === (e.ref as { entity: string }).entity);
      if (!found) out.add(e.id);
      continue;
    }
    if (!e.ref || !("edge" in e.ref)) continue;
    try {
      const found = selectEdges(m.source.edges, m.source.faces, e.ref.edge);
      if (found.matches.length !== 1) out.add(e.id);
    } catch {
      out.add(e.id);
    }
  }
  return out;
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
    if (edge?.source) {
      // Another sketch's entity: a reference to it by { sketch, entity }, reused when the sketch has one already.
      if (!edge.entity) return `${edge.source.sketch}'s ${edge.source.entity.id} can't be referenced here: ${edge.problem ?? SKETCH_REFERENCEABLE}`;
      const { sketch, entity: target } = edge.source;
      const at = out.findIndex((e) => e.type === edge.entity!.type && !!e.ref && "sketch" in e.ref && e.ref.sketch === sketch && e.ref.entity === target.id && !e.ref.at);
      if (at >= 0) {
        if (opts.convert && isConstruction(out[at])) out[at] = { ...out[at], construction: false };
        map.set(id, out[at].id);
        continue;
      }
      const { id: _stand, construction: _c, ref: _r, ...numbers } = edge.entity as SketchEntity & Record<string, unknown>;
      const e = { id: nextEntityId(out, ENTITY_PREFIX[edge.entity.type]), ...cleaned(numbers), ref: { sketch, entity: target.id }, ...(opts.convert ? { construction: false } : {}) } as SketchEntity;
      out.push(e);
      added.push(e);
      map.set(id, e.id);
      continue;
    }
    if (!edge) return isSketchStandIn(id) ? "that sketch entity is not in view any more" : "that model edge is not in the part any more";
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
  // An offset relation's bases may be points ("m1.end": a round corner's centre).
  if (Array.isArray(out.entities)) out.entities = (out.entities as string[]).map((x) => (k.type === "offset" && x.includes(".") ? point(x) : id(x)));
  return out as unknown as Constraint;
}

/** Every stand-in id a constraint names. */
export function modelIdsOf(k: Constraint): string[] {
  const all = [...(("points" in k && k.points) || []), ...("point" in k && k.point ? [k.point] : []), ...("entity" in k && k.entity ? [k.entity] : []), ...("line" in k && k.line ? [k.line] : []), ...(("entities" in k && k.entities) || [])];
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
