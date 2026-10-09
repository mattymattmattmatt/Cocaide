// References to planes, axes and points in a property editor (DESIGN §2.1):
// what a datumRef field offers (the default planes, axes and origin, and the
// reference features before this one), how a reference reads ("the planar
// face normal +Z"), and "Use selected", which turns the face or edge picked in
// the view into a reference that follows it through rebuilds (a selector,
// never an index). Pure.

import type { EdgeSelector, FaceSelector, Vec3 } from "../../doc/types";
import { formatDirection } from "../../geom/vec";
import { describeEdgeSelector, describeWanted } from "../../kernel/selectors";
import { edgeSelectorFor, faceSelectorFor } from "../../kernel/synthesize";
import type { RebuildView } from "../../worker/protocol";
import type { Selection } from "../model/selection";

type Raw = Record<string, unknown>;

/**
 * Anything that can serve as a plane, an axis or a point (DESIGN §2.1). The
 * document layer defines the same shape; resolution happens in the kernel.
 */
export type DatumRef =
  | { datum: string }
  | { face: FaceSelector }
  | { edge: EdgeSelector; at?: "start" | "end" | "mid" | "center" }
  | { point: Vec3 };

export type DatumKind = "plane" | "axis" | "point";

export interface DatumChoice {
  /** The id a { datum } reference names. */
  id: string;
  kind: DatumKind;
  label: string;
}

/** The default planes (Z up), the origin and the axes: always there, ids reserved. */
export const DEFAULT_DATUMS: DatumChoice[] = [
  { id: "Top", kind: "plane", label: "Top plane (XY)" },
  { id: "Front", kind: "plane", label: "Front plane (XZ)" },
  { id: "Right", kind: "plane", label: "Right plane (YZ)" },
  { id: "Origin", kind: "point", label: "Origin" },
  { id: "X", kind: "axis", label: "X axis" },
  { id: "Y", kind: "axis", label: "Y axis" },
  { id: "Z", kind: "axis", label: "Z axis" },
];

/** What each default reference is, in words, for its chip. */
const DEFAULT_DETAIL: Record<string, string> = {
  Top: "the XY plane, normal +Z",
  Front: "the XZ plane, normal -Y",
  Right: "the YZ plane, normal +X",
  Origin: "the point 0, 0, 0",
  X: "through the origin along +X",
  Y: "through the origin along +Y",
  Z: "through the origin along +Z",
};

/** The reference feature ops, and what each makes. */
export const DATUM_OPS: Record<string, DatumKind> = { plane: "plane", axis: "axis", point: "point" };

/** "a plane", "a plane or an axis". */
export function kindsText(kinds: DatumKind[]): string {
  const a = (k: DatumKind) => `${k === "axis" ? "an" : "a"} ${k}`;
  return kinds.length <= 1 ? a(kinds[0] ?? "plane") : `${kinds.slice(0, -1).map(a).join(", ")} or ${a(kinds.at(-1)!)}`;
}

/** What a datumRef field offers: the defaults of the kinds it takes, then the reference features before this one. */
export function datumChoices(before: Raw[], accepts: DatumKind[]): DatumChoice[] {
  const features = before
    .filter((g) => DATUM_OPS[String(g.op)] && accepts.includes(DATUM_OPS[String(g.op)]))
    .map((g): DatumChoice => ({ id: String(g.id), kind: DATUM_OPS[String(g.op)], label: `${String(g.id)} (${DATUM_OPS[String(g.op)]})` }));
  return [...DEFAULT_DATUMS.filter((d) => accepts.includes(d.kind)), ...features];
}

/** Is it a { datum } reference (a default or a reference feature), rather than picked geometry? */
export function isDatum(ref: unknown): ref is { datum: string } {
  return typeof ref === "object" && ref !== null && typeof (ref as { datum?: unknown }).datum === "string";
}

const AT_TEXT = { start: "its start", end: "its end", mid: "its midpoint", center: "its centre" } as const;

/** A reference in words, for the chip under the field: "Top plane (XY): the XY plane, normal +Z". */
export function describeRef(ref: unknown, before: Raw[] = []): string {
  if (typeof ref !== "object" || ref === null) return "none";
  const r = ref as Partial<{ datum: string; face: FaceSelector; edge: EdgeSelector; at: keyof typeof AT_TEXT; point: Vec3 }>;
  if (typeof r.datum === "string") {
    const d = DEFAULT_DATUMS.find((x) => x.id === r.datum);
    if (d) return `${d.label}: ${DEFAULT_DETAIL[d.id]}`;
    const g = before.find((x) => x.id === r.datum);
    return g && DATUM_OPS[String(g.op)] ? `${r.datum}: a reference ${DATUM_OPS[String(g.op)]}` : `${r.datum}: no reference plane, axis or point of that id before this feature`;
  }
  if (r.face) return describeWanted(r.face, 1).replace(/^1 /, "the ");
  if (r.edge) return `the ${describeEdgeSelector(r.edge).replace(/ edges\b/, " edge").replace(/^edges\b/, "edge")}${r.at ? `, ${AT_TEXT[r.at]}` : ""}`;
  if (Array.isArray(r.point)) return `the point ${r.point.map((x) => Math.round(Number(x) * 1e4) / 1e4).join(", ")}`;
  return "a reference this editor can't read";
}

/** What a picked face or edge can serve as. */
function pickedKinds(view: RebuildView, sel: Selection): { what: string; kinds: DatumKind[] } | null {
  if (sel.faces.length === 1 && sel.edges.length === 0) {
    const f = view.faces[sel.faces[0]];
    if (f?.type === "plane") return { what: `The face (normal ${formatDirection(f.normal!)})`, kinds: ["plane"] };
    if (f?.type === "cylinder") return { what: "A round face", kinds: ["axis"] };
    return { what: `A ${f?.type === "cone" ? "conical" : "freeform"} face`, kinds: [] };
  }
  if (sel.edges.length === 1 && sel.faces.length === 0) {
    const e = view.edges[sel.edges[0]];
    if (e?.kind === "line") return { what: "A straight edge", kinds: ["axis", "point"] };
    if (e?.kind === "circle") return { what: "A circular edge", kinds: ["axis", "point"] };
    return { what: "A curved edge", kinds: ["point"] };
  }
  return null;
}

export type RefSynthesis = { ok: true; ref: DatumRef } | { ok: false; error: string };

/**
 * "Use selected": the one face or edge selected, as a reference of a kind the
 * field takes. A flat face is a plane; a round face, its axis; a straight
 * edge, an axis (or, where only a point will do, its midpoint); a circular
 * edge, its axis (or its centre); any other edge, a point on it.
 */
export function refFromSelection(sel: Selection, view: RebuildView | null, accepts: DatumKind[]): RefSynthesis {
  if (!view) return { ok: false, error: "The part has not rebuilt yet: wait for it, then Use selected." };
  const picked = pickedKinds(view, sel);
  if (!picked) return { ok: false, error: `Click one face or one edge in the view (${kindsText(accepts)} is needed here), then Use selected.` };
  const usable = picked.kinds.filter((k) => accepts.includes(k));
  if (!usable.length) {
    const is = picked.kinds.length ? `is ${kindsText(picked.kinds)}` : "can't be used as a reference";
    return { ok: false, error: `${picked.what} ${is}, but ${kindsText(accepts)} is needed here.` };
  }
  if (sel.faces.length === 1) {
    const s = faceSelectorFor(view.faces, sel.faces[0]);
    return s.ok ? { ok: true, ref: { face: s.selector } } : { ok: false, error: s.error };
  }
  const e = view.edges[sel.edges[0]];
  const s = edgeSelectorFor(view.edges, view.faces, sel.edges[0]);
  if (!s.ok) return { ok: false, error: s.error };
  // An axis wherever one will do; a point only where nothing else will.
  if (usable.includes("axis")) return { ok: true, ref: { edge: s.selector } };
  return { ok: true, ref: e.kind === "circle" ? { edge: s.selector, at: "center" } : { edge: s.selector, at: "mid" } };
}
