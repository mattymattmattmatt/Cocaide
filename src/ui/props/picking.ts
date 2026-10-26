// Active selection fields (Phase P wave 2): while a feature is open in a
// session, its editor's selection fields (faces, edges, a face, a plane, axis
// or point, bodies, features, a sketch) are live. One of them is active; a
// click in the view goes into it, or comes out of it if it was in (no Ctrl
// needed); the view's selection filter follows what the active field takes;
// a feature clicked in the tree goes into a field of features. This module
// is the pure part: what each field kind takes, how a click changes a
// field's value (selectors re-made from what they now match), and which
// field is active by default. Vitest covers it in node.

import type { DatumRef, EdgeSelector, FaceSelector } from "../../doc/types";
import type { DatumKind } from "../../features/datum";
import { selectEdges, selectFaces } from "../../kernel/selectors";
import { edgesSelectorFor, faceSelectorFor } from "../../kernel/synthesize";
import type { EdgeInfo, FaceInfo } from "../../kernel/topology";
import type { RebuildView } from "../../worker/protocol";
import type { FilterKind } from "../evaluate/filter";
import { only, type PickTarget } from "../model/selection";
import { isDatum, refFromSelection } from "./datumRef";

type Raw = Record<string, unknown>;

/** What a selection field holds. */
export type PickKind = "faces" | "face" | "edges" | "datumRef" | "features" | "feature" | "sketch" | "bodies" | "point";

/**
 * A selection field the view's clicks can go to while its feature is open:
 * FeatureForm makes one for each selection field it shows, and a custom
 * editor may make its own (a hole's centres on its face).
 */
export interface PickField {
  /** The field's key ("edges", "neutral"): the active one is named by it. */
  key: string;
  /** Its label in the panel ("Edges"). */
  label: string;
  /** Its place in the panel: Tab goes through the fields in this order. */
  order: number;
  kind: PickKind;
  /** What a click in the view may pick for it: the selection filter while it is active. Empty: nothing in the view (a tree pick). */
  takes: FilterKind[];
  /** The ops of the features it takes from the tree (features to pattern, a sketch); undefined: none. */
  treeOps?: string[] | "any";
  /** How many items it holds. */
  count: number;
  /** It must hold something before OK (the feature needs it). */
  required: boolean;
  /** Its items on the part shown, to light up (faces, edges, vertices, planes by id). */
  items: PickTarget[];
  /** A click on the part: in if it isn't in, out if it is. The error says why not. */
  toggle(target: PickTarget): string | null;
  /** A box dragged over the view: each of these in (none taken out). */
  addAll?(targets: PickTarget[]): string | null;
  /** What a click on this would take in or out with it (an edge's tangency chain), for the preselection highlight; undefined: just itself. */
  reach?(target: PickTarget): PickTarget[];
  /** A feature clicked in the tree. */
  takeFeature?(id: string): string | null;
  /** What to pick, for the status line and the empty field: "Pick edges to fillet". */
  prompt: string;
  /** Active only when made so (a click on it, its button), never by default: a fillet's "new radius set". */
  onRequest?: boolean;
}

/** What the active field is about, for the app: the status line, the filter, the highlight. */
export interface ActiveFieldSummary {
  key: string;
  label: string;
  prompt: string;
  count: number;
  takes: FilterKind[];
  items: PickTarget[];
  treeOps?: string[] | "any";
}

export function summaryOf(f: PickField): ActiveFieldSummary {
  return { key: f.key, label: f.label, prompt: f.prompt, count: f.count, takes: f.takes, items: f.items, ...(f.treeOps ? { treeOps: f.treeOps } : {}) };
}

/** "Pick edges to fillet — 2 picked". */
export function promptLine(f: Pick<PickField, "prompt" | "count">): string {
  return f.count ? `${f.prompt} — ${f.count} picked` : f.prompt;
}

/**
 * The field that is active: the one named, if it is shown; else the first
 * empty one the feature needs; else the first that holds picks already (the
 * selection made before the tool went into it: more go there); else the first
 * empty one; else none.
 */
export function activeField(fields: readonly PickField[], wanted: string | null | undefined): PickField | null {
  const sorted = [...fields].sort((a, b) => a.order - b.order);
  if (wanted !== undefined && wanted !== null) {
    const named = sorted.find((f) => f.key === wanted);
    if (named) return named;
  }
  if (wanted === null) return null;
  const picks = (f: PickField) => f.takes.length > 0;
  sorted.splice(0, sorted.length, ...sorted.filter((f) => !f.onRequest));
  // Every field filled, and none takes picks in the view (an extrude's sketch): none is active; a sketch clicked in the tree still goes in.
  return sorted.find((f) => f.required && f.count === 0) ?? sorted.find((f) => f.count > 0 && picks(f)) ?? sorted.find((f) => f.count === 0) ?? null;
}

/** The next field after `key` (Tab), or before it (Shift+Tab), round the list. */
export function nextField(fields: readonly PickField[], key: string | null, back = false): PickField | null {
  const sorted = [...fields].filter((f) => !f.onRequest || f.key === key).sort((a, b) => a.order - b.order);
  if (!sorted.length) return null;
  const i = sorted.findIndex((f) => f.key === key);
  if (i < 0) return sorted[back ? sorted.length - 1 : 0];
  return sorted[(i + (back ? sorted.length - 1 : 1)) % sorted.length];
}

/** The filter kinds a reference of these kinds can be picked from. */
export function takesForKinds(kinds: readonly DatumKind[]): FilterKind[] {
  const out = new Set<FilterKind>(["planes"]);
  if (kinds.includes("plane")) out.add("faces");
  if (kinds.includes("axis")) {
    out.add("edges");
    out.add("faces");
  }
  if (kinds.includes("point")) {
    out.add("vertices");
    out.add("edges");
  }
  return [...out];
}

/** May the field take this click (by the kinds it takes)? */
export function fieldTakes(f: Pick<PickField, "takes">, target: PickTarget): boolean {
  const kind: FilterKind = target.kind === "face" ? "faces" : target.kind === "edge" ? "edges" : target.kind === "vertex" ? "vertices" : "planes";
  return f.takes.includes(kind);
}

// ------------------------------------------------------------ faces

/** A list of face selectors, each with the faces it matches on the part shown. */
export function resolveFaces(list: readonly FaceSelector[], faces: FaceInfo[]): number[][] {
  return list.map((s) => selectFaces(faces, s).matches.map((f) => f.index));
}

/**
 * The face list after a click on face `index`: in, as a selector that finds
 * it alone; or, if a selector already matches it, out (a selector that
 * matched others too keeps them, each as a selector of its own).
 */
export function toggleFace(list: readonly FaceSelector[], faces: FaceInfo[], index: number): FaceSelector[] | string {
  const per = resolveFaces(list, faces);
  const at = per.findIndex((m) => m.includes(index));
  if (at < 0) {
    const s = faceSelectorFor(faces, index);
    return s.ok ? [...list, s.selector] : s.error;
  }
  const rest: FaceSelector[] = [];
  for (const i of per[at]) {
    if (i === index) continue;
    const s = faceSelectorFor(faces, i);
    if (!s.ok) return s.error;
    rest.push(s.selector);
  }
  return [...list.slice(0, at), ...rest, ...list.slice(at + 1)];
}

// ------------------------------------------------------------ edges

/** A field's edge value as a list (one selector or several). */
export function edgeList(v: unknown): EdgeSelector[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? (v as EdgeSelector[]) : [v as EdgeSelector];
}

/** The edges an edge value matches on the part shown, and the selectors that match none (kept as they are). */
export function resolveEdges(v: unknown, edges: EdgeInfo[], faces: FaceInfo[]): { indices: number[]; unresolved: EdgeSelector[] } {
  const indices = new Set<number>();
  const unresolved: EdgeSelector[] = [];
  for (const s of edgeList(v)) {
    const r = selectEdges(edges, faces, s);
    if (r.error || r.matches.length === 0) unresolved.push(s);
    else for (const m of r.matches) indices.add(m.index);
  }
  return { indices: [...indices].sort((a, b) => a - b), unresolved };
}

/**
 * The edge value after a click on an edge (`chain`: the edges that go with it,
 * itself first: its tangency chain with propagation on): all of them in, or,
 * when the clicked one is in already, all of them out. The selectors are
 * made again from the edges now picked, one selector for the lot where one
 * finds exactly them. Null: none left.
 */
export function toggleEdges(v: unknown, edges: EdgeInfo[], faces: FaceInfo[], chain: readonly number[]): EdgeSelector | EdgeSelector[] | null | string {
  if (!chain.length) return edgeList(v).length ? (v as EdgeSelector | EdgeSelector[]) : null;
  const { indices, unresolved } = resolveEdges(v, edges, faces);
  const set = new Set(indices);
  const out = set.has(chain[0]);
  for (const i of chain) {
    if (out) set.delete(i);
    else set.add(i);
  }
  return remake([...set], unresolved, edges, faces);
}

/** Several edges in at once (a box). */
export function addEdges(v: unknown, edges: EdgeInfo[], faces: FaceInfo[], add: readonly number[]): EdgeSelector | EdgeSelector[] | null | string {
  const { indices, unresolved } = resolveEdges(v, edges, faces);
  return remake([...new Set([...indices, ...add])], unresolved, edges, faces);
}

function remake(list: number[], unresolved: EdgeSelector[], edges: EdgeInfo[], faces: FaceInfo[]): EdgeSelector | EdgeSelector[] | null | string {
  if (!list.length) return unresolved.length === 0 ? null : unresolved.length === 1 ? unresolved[0] : unresolved;
  const s = edgesSelectorFor(edges, faces, list);
  if (!s.ok) return s.error;
  if (!unresolved.length) return s.selector;
  return [...edgeList(s.selector), ...unresolved];
}

// ------------------------------------------------------------ references

/** The part's faces and edges a reference stands on, as targets to light up. */
export function refTargets(ref: unknown, view: RebuildView | null): PickTarget[] {
  if (!ref || typeof ref !== "object" || !view) return [];
  if (isDatum(ref)) return [{ kind: "datum", id: ref.datum, point: [0, 0, 0] }];
  const r = ref as { face?: FaceSelector; edge?: EdgeSelector; at?: "start" | "end" | "mid" | "center" };
  if (r.face) return selectFaces(view.faces, r.face).matches.map((f) => ({ kind: "face" as const, index: f.index, point: f.centroid }));
  if (r.edge) {
    const m = selectEdges(view.edges, view.faces, r.edge).matches;
    if (r.at === "start" || r.at === "end") return m.map((e) => ({ kind: "vertex" as const, edge: e.index, at: r.at as "start" | "end", point: r.at === "start" ? e.start : e.end }));
    return m.map((e) => ({ kind: "edge" as const, index: e.index, point: e.mid }));
  }
  return [];
}

const sameTarget = (a: PickTarget, b: PickTarget) =>
  a.kind === b.kind &&
  (a.kind === "datum" ? a.id === (b as typeof a).id : a.kind === "vertex" ? a.edge === (b as typeof a).edge && a.at === (b as typeof a).at : a.index === (b as typeof a).index);

/** Is the target among these items? */
export function holds(items: readonly PickTarget[], target: PickTarget): boolean {
  return items.some((i) => sameTarget(i, target));
}

/**
 * A reference field after a click: the thing clicked as a reference of a kind
 * it takes; clicked again (it is what the field holds), cleared when the
 * field may be empty. The error says what is needed instead.
 */
export function toggleRef(current: unknown, target: PickTarget, view: RebuildView | null, accepts: DatumKind[], before: Raw[], optional: boolean): DatumRef | null | string {
  if (current && holds(refTargets(current, view), target)) return optional ? null : (current as DatumRef);
  const r = refFromSelection(only(target), view, accepts, before);
  if (!r.ok) return r.error.replace(/, then Use selected\.?$/, ".").replace(/ then Use selected/, "");
  return r.ref;
}

// ------------------------------------------------------------ lists of ids

/** A list of ids with one in, or out if it was in, kept in `order`'s order (the ones not in it at the end). */
export function toggleId(list: readonly string[], id: string, order: readonly string[]): string[] {
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  return [...order.filter((x) => next.includes(x)), ...next.filter((x) => !order.includes(x))];
}

/** The ops a field of features takes from the tree accepts this feature? */
export function treeTakes(ops: string[] | "any" | undefined, op: unknown): boolean {
  return ops === "any" || (!!ops && ops.includes(String(op)));
}
