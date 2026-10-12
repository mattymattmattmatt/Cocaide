// The extrude and cut editors' rules, pure: the end conditions each direction
// offers, the patch a change of end condition sends (it fills in what the new
// one needs and drops what it does not, so the document stays valid), where
// the feature starts, the thin and draft switches, and the sketch's regions
// for "Selected contours". FeatureForm declarations in ExtrudeForm.tsx use
// these; Vitest checks them in node.

import type { DatumRef, Vec2, Vec3 } from "../../doc/types";
import { DATUM_OPS, DEFAULT_DATUMS, type DatumKind } from "../../features/datum";
import { contourAt, contours, type Contour } from "../../features/extrude/regions";
import { buildProfile } from "../../geom/profile";
import { faceSelectorFor } from "../../kernel/synthesize";
import { refFromSelection } from "./datumRef";
import type { FormContext, Raw } from "./spec";

/** The end conditions, in the usual CAD words. */
export const END_LABELS: Record<string, string> = {
  blind: "Blind",
  throughAll: "Through all",
  throughAllBoth: "Through all, both ways",
  upToNext: "Up to next",
  upToVertex: "Up to vertex",
  upToFace: "Up to surface",
  offsetFromFace: "Offset from surface",
  midplane: "Mid plane",
};

/** What each direction offers: direction 1 all; direction 2 not the two-way ones. */
export function endOptions(which: 1 | 2): [string, string][] {
  const ids = which === 1 ? ["blind", "throughAll", "throughAllBoth", "upToNext", "upToVertex", "upToFace", "offsetFromFace", "midplane"] : ["blind", "throughAll", "upToNext", "upToVertex", "upToFace", "offsetFromFace"];
  return ids.map((id) => [id, END_LABELS[id]]);
}

/** Does this end condition end at a face, a plane or a point (and so need `upTo`)? */
export const needsUpTo = (extent: unknown) => extent === "upToFace" || extent === "upToVertex" || extent === "offsetFromFace";
/** Does it take a depth? */
export const needsDepth = (extent: unknown) => extent === undefined || extent === "blind" || extent === "midplane";

/** What a reference is: a plane (a flat face, a plane), an axis, a point, or a face that may be curved. */
export function refKind(ref: unknown, before: Raw[]): DatumKind | "face" | null {
  if (typeof ref !== "object" || ref === null) return null;
  const r = ref as Raw;
  if (r.face) return "face";
  if (r.point) return "point";
  if (r.edge) return r.at ? "point" : "axis";
  if (typeof r.datum === "string") {
    const d = (DEFAULT_DATUMS as Record<string, { kind: DatumKind }>)[r.datum];
    if (d) return d.kind;
    const op = before.find((g) => g.id === r.datum)?.op;
    return typeof op === "string" && Object.hasOwn(DATUM_OPS, op) ? DATUM_OPS[op] : null;
  }
  return null;
}

/**
 * What an end condition goes up to, from what is selected in the view: a
 * point for up to vertex; a face (flat or curved) or a plane for the others.
 * Throws an Error that says what to select.
 */
export function upToFromSelection(extent: string, c: Pick<FormContext, "selection" | "view" | "before">, then = `choose ${END_LABELS[extent]} again`): DatumRef {
  if (extent !== "upToVertex" && c.selection.faces.length === 1 && c.view && !(c.selection.edges.length || c.selection.vertices?.length || c.selection.datums?.length)) {
    // Any face will do for up to surface (a curved one too); offset from surface needs a flat one, which the kernel says.
    const s = faceSelectorFor(c.view.faces, c.selection.faces[0]);
    if (!s.ok) throw new Error(s.error);
    return { face: s.selector };
  }
  const r = refFromSelection(c.selection, c.view, [extent === "upToVertex" ? "point" : "plane"], c.before);
  if (r.ok) return r.ref;
  const what = extent === "upToVertex" ? "a vertex or a point" : "a face or a plane";
  throw new Error(`${END_LABELS[extent]} needs ${what} to go up to: click it in the view first, then ${then}. (${r.error})`);
}

/**
 * The patch that changes one direction's end condition to `extent`: a depth
 * for blind and mid plane (the one there was, else 10 mm), what it goes up to
 * for the up-to ones (kept when it suits, else what is selected), an offset
 * for offset from surface; and nothing the new one does not take. Direction 1
 * going mid plane or both ways drops direction 2.
 */
export function endPatch(f: Raw, which: 1 | 2, extent: string, c: Pick<FormContext, "selection" | "view" | "before">): Raw {
  const at: Raw = which === 1 ? f : ((f.direction2 as Raw | undefined) ?? {});
  const out: Raw = {};
  out.distance = needsDepth(extent) ? (at.distance ?? (which === 1 ? (f.direction2 as Raw | undefined)?.distance : f.distance) ?? 10) : null;
  if (needsUpTo(extent)) {
    const kind = refKind(at.upTo, c.before);
    const suits = extent === "upToVertex" ? kind === "point" : kind === "plane" || kind === "face";
    out.upTo = suits ? at.upTo : upToFromSelection(extent, c);
  } else out.upTo = null;
  out.offset = extent === "offsetFromFace" ? (at.offset ?? 5) : null;
  if (which === 2) {
    const d2: Raw = { extent };
    for (const k of ["distance", "upTo", "offset"]) if (out[k] !== null && out[k] !== undefined) d2[k] = out[k];
    if (at.draft) d2.draft = at.draft;
    return { direction2: d2 };
  }
  return {
    extent: extent === "blind" ? null : extent,
    ...out,
    ...(extent === "midplane" || extent === "throughAllBoth" ? { direction2: null } : {}),
  };
}

/** Where the feature starts: the sketch plane, an offset of it, or a plane, face or point. */
export type StartKind = "sketch" | "offset" | "surface";

export function startKind(f: Raw): StartKind {
  return f.startOffset !== undefined && f.startOffset !== null ? "offset" : f.from ? "surface" : "sketch";
}

/** The patch for a new start. "surface" takes what is selected (a plane, a flat face or a point). */
export function startPatch(f: Raw, kind: StartKind, c: Pick<FormContext, "selection" | "view" | "before">): Raw {
  if (kind === "sketch") return { startOffset: null, from: null };
  if (kind === "offset") return { from: null, startOffset: f.startOffset ?? 5 };
  if (f.from) return { startOffset: null };
  const r = refFromSelection(c.selection, c.view, ["plane", "point"], c.before);
  if (!r.ok) throw new Error(`To start from a surface, click the flat face, plane or vertex in the view first, then choose it again. (${r.error})`);
  return { startOffset: null, from: r.ref };
}

/** Thin on or off: a thin feature has no draft (in either direction). */
export function thinPatch(f: Raw, on: boolean): Raw {
  if (!on) return { thin: null };
  const d2 = f.direction2 as Raw | undefined;
  const patch: Raw = { thin: { thickness: 1 }, draft: null };
  if (d2?.draft) {
    const { draft: _drop, ...rest } = d2;
    void _drop;
    patch.direction2 = rest;
  }
  return patch;
}

/** Direction 2 on (blind, the depth of direction 1) or off. */
export function direction2Patch(f: Raw, on: boolean): Raw {
  return { direction2: on ? { extent: "blind", distance: typeof f.distance === "number" || typeof f.distance === "string" ? f.distance : 10 } : null };
}

/** Is the direction the sketch normal reversed? */
export function isReversed(direction: unknown, normal: Vec3): boolean {
  return Array.isArray(direction) && direction.length === 3 && direction.every((v, i) => typeof v === "number" && Math.abs(v + normal[i]) < 1e-9);
}

/** The regions of a sketch the editor lists under "Selected contours", from its (solved) entities. */
export function sketchContours(entities: unknown): Contour[] {
  if (!Array.isArray(entities)) return [];
  const p = buildProfile(entities as never);
  return p.ok ? contours(p.regions) : [];
}

/** Which of the contours the feature's `regions` seeds pick (by index), or null when it uses them all. */
export function pickedContours(entities: unknown, regions: unknown): number[] | null {
  if (!Array.isArray(regions)) return null;
  const p = Array.isArray(entities) ? buildProfile(entities as never) : null;
  if (!p?.ok) return [];
  return [...new Set((regions as Vec2[]).map((pt) => contourAt(p.regions, pt)).filter((i) => i >= 0))];
}

/**
 * The patch after ticking or unticking contour `index`: the seeds of those
 * ticked. The sketch's own regions ticked (and only those) means no
 * `regions`; nothing ticked is refused (null: no change).
 */
export function contoursPatch(list: Contour[], picked: number[] | null, index: number, on: boolean): Raw | null {
  const now = new Set(picked ?? defaultContours(list));
  if (on) now.add(index);
  else now.delete(index);
  if (now.size === 0) return null;
  const usual = defaultContours(list);
  if (now.size === usual.length && usual.every((i) => now.has(i))) return { regions: null };
  return { regions: [...now].sort((a, b) => a - b).map((i) => list[i].seed) };
}

/** The contours used when none is picked: the sketch's regions (a hole's area is not one, until picked). */
export function defaultContours(list: Contour[]): number[] {
  return list.flatMap((c, i) => (c.inDefault ? [i] : []));
}

/** "r1 less c1 · 314.16 mm²". */
export function contourLabel(c: Contour): string {
  const area = Math.round(c.area * 100) / 100;
  return `${c.outer.join(", ")}${c.holes.length ? ` less ${c.holes.join(", ")}` : ""} · ${area} mm²`;
}
