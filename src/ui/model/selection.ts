// What is selected in the 3D view, and how a click changes it, as SOLIDWORKS
// does: a plain click selects that one face, edge, vertex or plane; Ctrl- or
// Shift-click adds it, or takes it out again if it was in. Faces, edges,
// vertices and reference geometry (planes, axes, points) mix freely.
//
// Pure: no three.js, so Vitest covers it in node.

import type { Vec3 } from "../../doc/types";
import { DEFAULT_DATUMS, type Datum } from "../../features/datum";
import { formatDirection } from "../../geom/vec";
import type { EdgeInfo, FaceInfo } from "../../kernel/topology";

/** An end of an edge: a vertex of the part (several edges share it; one stands for it). */
export interface VertexPick {
  edge: number;
  at: "start" | "end";
}

/** A click on the part (a B-rep face, edge or vertex) or on reference geometry (a plane, axis or point, by id), and where. */
export type PickTarget =
  | { kind: "face" | "edge"; index: number; point: Vec3 }
  | { kind: "vertex"; edge: number; at: "start" | "end"; point: Vec3 }
  | { kind: "datum"; id: string; point: Vec3 };

export interface Selection {
  faces: number[];
  edges: number[];
  /** Vertices, as an end of an edge. */
  vertices?: VertexPick[];
  /** Reference geometry by id: a default plane ("Top"), the origin, or a plane, axis or point feature. */
  datums?: string[];
  /** Where the last face was clicked; a new hole goes here. */
  point?: Vec3;
}

export const EMPTY_SELECTION: Selection = { faces: [], edges: [] };

/** The selection holding just this one thing. */
export function only(target: PickTarget): Selection {
  switch (target.kind) {
    case "face":
      return { faces: [target.index], edges: [], point: target.point };
    case "edge":
      return { faces: [], edges: [target.index] };
    case "vertex":
      return { faces: [], edges: [], vertices: [{ edge: target.edge, at: target.at }] };
    case "datum":
      return { faces: [], edges: [], datums: [target.id] };
  }
}

/** Is the target in the selection? */
export function isSelected(sel: Selection, target: PickTarget): boolean {
  switch (target.kind) {
    case "face":
      return sel.faces.includes(target.index);
    case "edge":
      return sel.edges.includes(target.index);
    case "vertex":
      return (sel.vertices ?? []).some((v) => v.edge === target.edge && v.at === target.at);
    case "datum":
      return (sel.datums ?? []).includes(target.id);
  }
}

/** A list with `x` added at the end, or taken out if it was in; an empty list is left out of the selection. */
function toggle<T>(list: T[] | undefined, x: T, same: (a: T, b: T) => boolean): T[] | undefined {
  const l = list ?? [];
  const next = l.some((y) => same(x, y)) ? l.filter((y) => !same(x, y)) : [...l, x];
  return next.length ? next : undefined;
}

/** The selection without an empty optional list. */
function tidy(sel: Selection): Selection {
  const { vertices, datums, ...rest } = sel;
  return { ...rest, ...(vertices?.length ? { vertices } : {}), ...(datums?.length ? { datums } : {}) };
}

/**
 * The selection after a click on `target` (null: empty space). `additive`
 * when Ctrl, Shift or Cmd is held: the target goes in, or comes out if it
 * was in; a click on empty space then keeps what is selected.
 */
export function pickInto(sel: Selection, target: PickTarget | null, additive: boolean): Selection {
  if (!target) return additive ? sel : EMPTY_SELECTION;
  if (!additive) return only(target);
  switch (target.kind) {
    case "edge": {
      const has = sel.edges.includes(target.index);
      return { ...sel, edges: has ? sel.edges.filter((e) => e !== target.index) : [...sel.edges, target.index] };
    }
    case "vertex":
      return tidy({ ...sel, vertices: toggle(sel.vertices, { edge: target.edge, at: target.at }, (a, b) => a.edge === b.edge && a.at === b.at) });
    case "datum":
      return tidy({ ...sel, datums: toggle(sel.datums, target.id, (a, b) => a === b) });
    case "face":
      break;
  }
  if (sel.faces.includes(target.index)) {
    const faces = sel.faces.filter((f) => f !== target.index);
    // The click point belongs to the face clicked last: with no face left there is none.
    const { point: _point, ...rest } = sel;
    return faces.length ? { ...sel, faces } : { ...rest, faces };
  }
  return { ...sel, faces: [...sel.faces, target.index], point: target.point };
}

/** How many things are selected. */
export function selectionSize(sel: Selection): number {
  return sel.faces.length + sel.edges.length + (sel.vertices?.length ?? 0) + (sel.datums?.length ?? 0);
}

/** "planar face of base · normal +Z · offset 6", for a face under the pointer or selected alone. */
export function describeFace(f: FaceInfo | undefined): string {
  if (!f) return "face";
  const of = f.body ? ` of ${f.body}` : "";
  if (f.type === "plane" && f.normal) return `planar face${of} · normal ${formatDirection(f.normal)} · offset ${fmt(f.offset ?? 0)}`;
  if (f.type === "cylinder" && f.cylinder) return `cylindrical face${of} · Ø${fmt(2 * f.cylinder.radius)} · ${f.cylinder.concave ? "hole wall" : "boss"}`;
  return (f.type === "cone" ? "conical face" : "freeform face") + of;
}

/** "straight edge · +X · length 80", for an edge under the pointer or selected alone. */
export function describeEdge(e: EdgeInfo | undefined): string {
  if (!e) return "edge";
  const of = e.body ? ` of ${e.body}` : "";
  if (e.kind === "line") return `straight edge${of} · ${formatDirection(e.direction!)} · length ${fmt(e.length)}`;
  if (e.kind === "circle") return `circular edge${of} · Ø${fmt(2 * e.radius!)}`;
  return `curved edge${of} · length ${fmt(e.length)}`;
}

/** Where a vertex is: the end of its edge. */
export function vertexPoint(v: VertexPick, edges: EdgeInfo[]): Vec3 | undefined {
  const e = edges[v.edge];
  return e ? (v.at === "start" ? e.start : e.end) : undefined;
}

/** "vertex · 40, -20, 6". */
export function describeVertex(v: VertexPick, edges: EdgeInfo[]): string {
  const p = vertexPoint(v, edges);
  return p ? `vertex · ${p.map(fmt).join(", ")}` : "vertex";
}

/** What a default reference is called: "Top plane", "Origin". */
export const DEFAULT_DATUM_LABEL: Readonly<Record<string, string>> = {
  Front: "Front plane",
  Top: "Top plane",
  Right: "Right plane",
  Origin: "Origin",
  X: "X axis",
  Y: "Y axis",
  Z: "Z axis",
};

/** What a datum is, by id: a default one's kind, else the built feature's (from the rebuild). */
export function datumKindOf(id: string, datums: Readonly<Record<string, Datum>> = {}): Datum["kind"] | undefined {
  return (Object.hasOwn(DEFAULT_DATUMS, id) ? DEFAULT_DATUMS[id] : Object.hasOwn(datums, id) ? datums[id] : undefined)?.kind;
}

/** "Top plane", "plane_1 · plane · normal +Z", "axis_1 · axis · +X", "point_1 · point · 30, 0, 6". */
export function describeDatum(id: string, datums: Readonly<Record<string, Datum>> = {}): string {
  if (Object.hasOwn(DEFAULT_DATUM_LABEL, id)) return DEFAULT_DATUM_LABEL[id];
  const d = Object.hasOwn(datums, id) ? datums[id] : undefined;
  if (!d) return id;
  if (d.kind === "plane") return `${id} · plane · normal ${formatDirection(d.normal)}`;
  if (d.kind === "axis") return `${id} · axis · ${formatDirection(d.direction)}`;
  return `${id} · point · ${d.at.map(fmt).join(", ")}`;
}

/**
 * The selection chip's text: one thing described, more counted ("3 faces",
 * "2 faces + 1 edge", "1 plane + 1 vertex"). Empty when nothing is selected.
 */
export function selectionText(sel: Selection, faces: FaceInfo[], edges: EdgeInfo[], datums: Readonly<Record<string, Datum>> = {}): string {
  const nf = sel.faces.length;
  const ne = sel.edges.length;
  const vs = sel.vertices ?? [];
  const ds = sel.datums ?? [];
  const total = nf + ne + vs.length + ds.length;
  if (total === 1) {
    if (nf) return describeFace(faces[sel.faces[0]]);
    if (ne) return describeEdge(edges[sel.edges[0]]);
    if (vs.length) return describeVertex(vs[0], edges);
    return describeDatum(ds[0], datums);
  }
  const count = (n: number, one: string, many = `${one}s`) => (n ? `${n} ${n === 1 ? one : many}` : "");
  const kinds = { plane: 0, axis: 0, point: 0 };
  for (const id of ds) kinds[datumKindOf(id, datums) ?? "plane"]++;
  return [
    count(nf, "face"),
    count(ne, "edge"),
    count(vs.length, "vertex", "vertices"),
    count(kinds.plane, "plane"),
    count(kinds.axis, "axis", "axes"),
    count(kinds.point, "point"),
  ]
    .filter(Boolean)
    .join(" + ");
}

export function fmt(x: number): string {
  return String(Math.round(x * 1000) / 1000 + 0);
}
