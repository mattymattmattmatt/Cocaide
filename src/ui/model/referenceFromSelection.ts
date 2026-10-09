// Plane, Axis and Point look at what is selected and pick the mode, so one
// button makes the reference the selection means (smarter than SOLIDWORKS,
// where the user picks references and then hunts for the mode):
//
//   Plane: a flat face or a plane -> offset 10 mm; a plane and a straight
//   edge or axis in it -> at 45° about it; three vertices or points -> through
//   them; two planes or faces -> half way between; an edge alone -> square to
//   it at its start; a plane and a vertex or point -> parallel through it.
//   Axis: a round face -> its axis; an edge -> along it (a circle: its axis);
//   two planes -> where they meet; two points -> through them; a point and a
//   plane -> through the point, square to the plane.
//   Point: a circular edge -> its centre; a face -> its centre; another edge
//   -> its middle; a vertex -> there; an axis and a plane -> where they cross.
//
// Nothing usable selected: a sensible default, and a notice that says what to
// select next time. The references are selectors and ids, never indices, so
// the new feature follows the model. Pure: Vitest covers it in node.

import type { DatumRef } from "../../doc/types";
import type { DatumKind } from "../../features/datum";
import { dot3 } from "../../geom/vec";
import { edgeSelectorFor, faceSelectorFor } from "../../kernel/synthesize";
import type { RebuildView } from "../../worker/protocol";
import { datumKindOf, type Selection } from "./selection";

type Raw = Record<string, unknown>;

/** A new reference feature (without its id), and a note for the user when it is a guess. */
export interface Proposal {
  feature: Raw;
  /** What happened and what to select next time, when the selection did not say what to make. */
  notice?: string;
  /** The selection could not be turned into references (a face the selector can't pin down). */
  error?: string;
}

/** One selected thing, as what it can be. */
interface Item {
  ref: DatumRef;
  /** planarFace, roundFace (cylinder or cone), otherFace; line, circle, curve (edges); vertex; datum plane, axis, point. */
  what: "planarFace" | "roundFace" | "otherFace" | "line" | "circle" | "curve" | "vertex" | "plane" | "axis" | "point";
  /** A plane's normal or an axis's direction, when known (for "is this edge in that plane"). */
  dir?: [number, number, number];
}

/** The selection as references, in a stable order (faces, edges, vertices, datums), or why it can't be. */
function itemsOf(sel: Selection, view: RebuildView | null, kindOf: (id: string) => DatumKind | undefined): Item[] | string {
  const items: Item[] = [];
  if (!view && sel.faces.length + sel.edges.length + (sel.vertices?.length ?? 0) > 0) return "The part has not rebuilt yet: wait for it, then try again.";
  for (const i of sel.faces) {
    const f = view!.faces[i];
    const s = faceSelectorFor(view!.faces, i);
    if (!f) continue;
    if (!s.ok) return s.error;
    items.push({ ref: { face: s.selector }, what: f.type === "plane" ? "planarFace" : f.type === "cylinder" || f.type === "cone" ? "roundFace" : "otherFace", dir: f.normal });
  }
  for (const i of sel.edges) {
    const e = view!.edges[i];
    const s = edgeSelectorFor(view!.edges, view!.faces, i);
    if (!e) continue;
    if (!s.ok) return s.error;
    items.push({ ref: { edge: s.selector }, what: e.kind === "line" ? "line" : e.kind === "circle" ? "circle" : "curve", dir: e.direction });
  }
  for (const v of sel.vertices ?? []) {
    if (!view!.edges[v.edge]) continue;
    const s = edgeSelectorFor(view!.edges, view!.faces, v.edge);
    if (!s.ok) return s.error;
    items.push({ ref: { edge: s.selector, at: v.at }, what: "vertex" });
  }
  for (const id of sel.datums ?? []) {
    const kind = kindOf(id);
    if (!kind) continue;
    const d = view?.datums?.[id];
    items.push({ ref: { datum: id }, what: kind, dir: d?.kind === "plane" ? d.normal : d?.kind === "axis" ? d.direction : undefined });
  }
  return items;
}

/** What a datum id is: a default one, a plane/axis/point feature of the document, or one the rebuild made. */
export function datumKinds(features: Raw[], view: RebuildView | null): (id: string) => DatumKind | undefined {
  const ops: Record<string, DatumKind> = { plane: "plane", axis: "axis", point: "point" };
  return (id) => datumKindOf(id, view?.datums ?? {}) ?? ops[String(features.find((f) => f.id === id)?.op)];
}

const is = (item: Item, ...what: Item["what"][]) => what.includes(item.what);
const PLANE_LIKE: Item["what"][] = ["planarFace", "plane"];
const AXIS_LIKE: Item["what"][] = ["line", "axis"];
const POINT_LIKE: Item["what"][] = ["vertex", "point"];

/** Splits the items into the groups the rules look at; null when something is in none of them. */
function groups(items: Item[], wanted: Record<string, Item["what"][]>): Record<string, Item[]> | null {
  const out: Record<string, Item[]> = Object.fromEntries(Object.keys(wanted).map((k) => [k, []]));
  for (const item of items) {
    const g = Object.keys(wanted).find((k) => is(item, ...wanted[k]));
    if (!g) return null;
    out[g].push(item);
  }
  return out;
}

const counts = (g: Record<string, Item[]> | null, want: Record<string, number>) => !!g && Object.keys(g).every((k) => g[k].length === (want[k] ?? 0));

export const PLANE_HELP =
  "Select a flat face or a plane (to offset it), a plane and an edge in it (at an angle), three vertices (through them), two faces (half way between), an edge (square to it) or a plane and a vertex (parallel, through it), then Plane.";
export const AXIS_HELP =
  "Select a round face (its axis), an edge (along it), two planes (where they meet), two vertices (through them) or a vertex and a plane (square to it), then Axis.";
export const POINT_HELP =
  "Select a circular edge (its centre), a face (its centre), an edge (its middle), a vertex, or an axis and a plane (where they cross), then Point.";

/** The plane the selection means. */
export function planeFromSelection(sel: Selection, view: RebuildView | null, kindOf: (id: string) => DatumKind | undefined): Proposal {
  const items = itemsOf(sel, view, kindOf);
  const fallback = (why?: string): Proposal => ({
    feature: { op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 10 },
    notice: `${why ? `${why} ` : ""}Made a plane 10 mm above Top. ${PLANE_HELP}`,
  });
  if (typeof items === "string") return { feature: {}, error: items };
  if (!items.length) return fallback();
  const g = groups(items, { plane: PLANE_LIKE, axis: AXIS_LIKE, point: POINT_LIKE, edge: ["circle", "curve"] });
  const refs = (...list: Item[]) => list.map((i) => i.ref);
  if (g && counts(g, { plane: 1 })) return { feature: { op: "plane", mode: "offset", refs: refs(g.plane[0]), distance: 10 } };
  if (g && counts(g, { plane: 1, axis: 1 })) {
    const [p, a] = [g.plane[0], g.axis[0]];
    // An edge out of the plane makes no angle plane: say so rather than make one that fails.
    if (p.dir && a.dir && Math.abs(dot3(p.dir, a.dir)) > 1e-6) {
      return { feature: { op: "plane", mode: "normalToEdge", refs: refs(a) }, notice: "The edge is not in the plane (nor parallel to it), so it can't be turned about: made a plane square to the edge instead." };
    }
    return { feature: { op: "plane", mode: "angle", refs: refs(p, a), angle: 45 } };
  }
  if (g && counts(g, { point: 3 })) return { feature: { op: "plane", mode: "threePoints", refs: refs(...g.point) } };
  if (g && counts(g, { plane: 2 })) return { feature: { op: "plane", mode: "midplane", refs: refs(...g.plane) } };
  if (g && counts(g, { plane: 1, point: 1 })) return { feature: { op: "plane", mode: "parallelThroughPoint", refs: refs(g.plane[0], g.point[0]) } };
  // An edge alone (straight or round): square to it at its start; with a vertex or point: through that.
  const edges = groups(items, { edge: ["line", "circle", "curve"], point: POINT_LIKE });
  if (edges && counts(edges, { edge: 1 })) return { feature: { op: "plane", mode: "normalToEdge", refs: refs(edges.edge[0]), t: 0 } };
  if (edges && counts(edges, { edge: 1, point: 1 })) return { feature: { op: "plane", mode: "normalToEdge", refs: refs(edges.edge[0], edges.point[0]) } };
  return fallback("That selection doesn't say which plane.");
}

/** The axis the selection means. */
export function axisFromSelection(sel: Selection, view: RebuildView | null, kindOf: (id: string) => DatumKind | undefined): Proposal {
  const items = itemsOf(sel, view, kindOf);
  const fallback = (why?: string): Proposal => ({
    feature: { op: "axis", mode: "twoPlanes", refs: [{ datum: "Front" }, { datum: "Right" }] },
    notice: `${why ? `${why} ` : ""}Made the vertical axis where Front and Right meet. ${AXIS_HELP}`,
  });
  if (typeof items === "string") return { feature: {}, error: items };
  if (!items.length) return fallback();
  const refs = (...list: Item[]) => list.map((i) => i.ref);
  if (items.length === 1 && is(items[0], "roundFace")) return { feature: { op: "axis", mode: "cylinder", refs: refs(items[0]) } };
  if (items.length === 1 && is(items[0], "line", "circle")) return { feature: { op: "axis", mode: "edge", refs: refs(items[0]) } };
  const g = groups(items, { plane: PLANE_LIKE, point: POINT_LIKE });
  if (g && counts(g, { plane: 2 })) return { feature: { op: "axis", mode: "twoPlanes", refs: refs(...g.plane) } };
  if (g && counts(g, { point: 2 })) return { feature: { op: "axis", mode: "twoPoints", refs: refs(...g.point) } };
  if (g && counts(g, { point: 1, plane: 1 })) return { feature: { op: "axis", mode: "pointNormal", refs: refs(g.point[0], g.plane[0]) } };
  return fallback("That selection doesn't say which axis.");
}

/** The point the selection means. */
export function pointFromSelection(sel: Selection, view: RebuildView | null, kindOf: (id: string) => DatumKind | undefined): Proposal {
  const items = itemsOf(sel, view, kindOf);
  const fallback = (why?: string): Proposal => ({
    feature: { op: "point", mode: "coords", at: [0, 0, 0] },
    notice: `${why ? `${why} ` : ""}Made a point at 0, 0, 0: set where in its properties. ${POINT_HELP}`,
  });
  if (typeof items === "string") return { feature: {}, error: items };
  if (!items.length) return fallback();
  const refs = (...list: Item[]) => list.map((i) => i.ref);
  if (items.length === 1) {
    const [item] = items;
    if (is(item, "circle")) return { feature: { op: "point", mode: "center", refs: refs(item) } };
    if (is(item, "planarFace", "roundFace", "otherFace")) return { feature: { op: "point", mode: "center", refs: refs(item) } };
    if (is(item, "line", "curve")) return { feature: { op: "point", mode: "onEdge", refs: refs(item), t: 0.5 } };
    // A vertex: the end of its edge, so it stays on the corner when the part changes.
    if (is(item, "vertex") && "edge" in item.ref) return { feature: { op: "point", mode: "onEdge", refs: [{ edge: item.ref.edge }], t: item.ref.at === "end" ? 1 : 0 } };
  }
  const g = groups(items, { axis: [...AXIS_LIKE, "roundFace"], plane: PLANE_LIKE });
  if (g && counts(g, { axis: 1, plane: 1 })) return { feature: { op: "point", mode: "intersection", refs: refs(g.axis[0], g.plane[0]) } };
  return fallback("That selection doesn't say which point.");
}
