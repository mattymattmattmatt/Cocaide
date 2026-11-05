// Annotation styles (Phase Q wave Q3A): what the Format Painter copies from
// one annotation to others of its kind (a dimension's tolerance, decimals,
// arrows, dual units, inspection; a note's height and weight; a balloon's
// shape), the dimension favourites ("±0.1", "H7", saved by the user), and
// the ISO 286 classes the fit editor offers, with their deviations at the
// size being dimensioned. Pure.

import type { Annotation, DimensionAnnotation } from "../../../doc/types";
import { classDeviations, fitOf, parseFit, type FitType } from "../../../drafting/fits";
import { deviationText, numberText, toleranceProblem, type Tolerance } from "../../../drafting/tolerance";

// ------------------------------------------------------------ the format painter

/** The keys a kind's style is made of: what the painter copies. */
export const STYLE_KEYS: Partial<Record<Annotation["type"], string[]>> = {
  dimension: ["tolerance", "precision", "arrows", "dual", "inspection"],
  hole: ["tolerance"],
  note: ["height", "bold", "italic", "underline", "frame"],
  text: ["height", "bold"],
  balloon: ["shape", "size", "arrow", "quantity"],
  leader: ["arrow", "spline"],
  centerMark: ["style", "extend"],
  centerline: ["extend"],
  surface: ["symbol", "values", "process", "lay"],
  datum: ["open"],
};

/** An annotation's style: its kind and the values of its style keys (absent ones as null, so painting removes them). */
export function styleOf(a: Annotation | Record<string, unknown>): { type: string; values: Record<string, unknown> } | null {
  const type = String((a as { type: unknown }).type);
  const keys = STYLE_KEYS[type as Annotation["type"]];
  if (!keys) return null;
  const values: Record<string, unknown> = {};
  for (const k of keys) values[k] = (a as Record<string, unknown>)[k] ?? null;
  return { type, values };
}

/**
 * The patch that paints a style onto an annotation (null removes a key), or
 * why it can't: another kind, or a value the target can't take (a fit on an
 * angle). A dimension's tolerance goes onto a hole callout's bore too.
 */
export function paintPatch(target: Annotation | Record<string, unknown>, style: { type: string; values: Record<string, unknown> }): Record<string, unknown> | string {
  const type = String((target as { type: unknown }).type);
  const keys = STYLE_KEYS[type as Annotation["type"]];
  if (!keys) return `A ${type} has no style to paint`;
  const cross = style.type === "dimension" && type === "hole";
  if (style.type !== type && !cross) return `The style is a ${style.type}'s: paint it onto a ${style.type}`;
  const patch: Record<string, unknown> = {};
  for (const k of keys) if (k in style.values) patch[k] = style.values[k];
  if (type === "dimension") {
    const kind = (target as DimensionAnnotation).kind ?? "linear";
    const t = patch.tolerance as Tolerance | null | undefined;
    if (t && kind === "angular" && (t.kind === "fit" || t.kind === "fitWithTol" || t.kind === "fitLimits")) delete patch.tolerance;
  }
  return patch;
}

// ------------------------------------------------------------ favourites

/** A saved dimension style: a name and the fields it sets (only those; the rest stay). */
export interface DimFavourite {
  name: string;
  style: Partial<Pick<DimensionAnnotation, "tolerance" | "precision" | "typ" | "dual" | "inspection" | "arrows" | "prefix" | "suffix" | "count">>;
  builtIn?: boolean;
}

export const BUILT_IN_FAVOURITES: DimFavourite[] = [
  { name: "±0.1", style: { tolerance: { kind: "symmetric", plus: 0.1 } }, builtIn: true },
  { name: "±0.05", style: { tolerance: { kind: "symmetric", plus: 0.05 } }, builtIn: true },
  { name: "+0.1/0", style: { tolerance: { kind: "bilateral", plus: 0.1, minus: 0 } }, builtIn: true },
  { name: "H7", style: { tolerance: { kind: "fitWithTol", fit: "H7" } }, builtIn: true },
  { name: "h6", style: { tolerance: { kind: "fitWithTol", fit: "h6" } }, builtIn: true },
  { name: "H7/g6", style: { tolerance: { kind: "fit", fit: "H7/g6" } }, builtIn: true },
  { name: "Basic", style: { tolerance: { kind: "basic" } }, builtIn: true },
  { name: "Reference", style: { tolerance: { kind: "reference" } }, builtIn: true },
  { name: "2 decimals", style: { precision: 2 }, builtIn: true },
];

const FAV_KEY = "cocaide.dimensionFavourites.v1";

/** The user's saved favourites (browser storage; empty when it can't be read). */
export function loadFavourites(): DimFavourite[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((f): f is DimFavourite => !!f && typeof f.name === "string" && typeof f.style === "object") : [];
  } catch {
    return [];
  }
}

export function storeFavourites(list: DimFavourite[]): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(list.filter((f) => !f.builtIn)));
  } catch {
    // Storage refused (a private window): the favourite lasts this visit.
  }
}

/** A favourite made from a dimension: its tolerance, decimals, display and text. */
export function favouriteFrom(name: string, a: DimensionAnnotation): DimFavourite | string {
  const n = name.trim();
  if (!n) return "Name the favourite";
  const style: DimFavourite["style"] = {};
  for (const k of ["tolerance", "precision", "typ", "dual", "inspection", "arrows", "prefix", "suffix", "count"] as const) if (a[k] !== undefined) (style as Record<string, unknown>)[k] = a[k];
  if (!Object.keys(style).length) return "This dimension has no tolerance, decimals or text to keep: set some first";
  return { name: n, style };
}

/** The patch a favourite makes (only its own fields), or why it can't go on this dimension. */
export function applyFavourite(a: DimensionAnnotation, f: DimFavourite): Record<string, unknown> | string {
  const t = f.style.tolerance;
  if (t) {
    const p = toleranceProblem(t);
    if (p) return `${f.name}: ${p}`;
    if (a.kind === "angular" && (t.kind === "fit" || t.kind === "fitWithTol" || t.kind === "fitLimits")) return `${f.name} is a fit: an angle takes ± or limits, not a fit`;
  }
  return { ...f.style };
}

// ------------------------------------------------------------ ISO 286 classes for the fit editor

/** The hole classes the fit editor lists (ISO 286-2's common ones), basic hole H first. */
export const HOLE_CLASSES = ["H6", "H7", "H8", "H9", "H10", "H11", "G6", "G7", "F7", "F8", "E8", "E9", "D9", "D10", "C11", "JS6", "JS7", "K6", "K7", "M6", "M7", "N6", "N7", "P6", "P7", "R7", "S7", "U7"];
/** The shaft classes, basic shaft h first. */
export const SHAFT_CLASSES = ["h5", "h6", "h7", "h8", "h9", "h11", "g5", "g6", "f6", "f7", "e7", "e8", "d9", "d10", "c11", "js5", "js6", "k5", "k6", "m5", "m6", "n5", "n6", "p5", "p6", "r6", "s6", "u6"];
/** The fits offered as one click: ISO 286-2's preferred hole-basis fits. */
export const COMMON_FITS = ["H7/g6", "H7/h6", "H7/k6", "H7/m6", "H7/n6", "H7/p6", "H7/s6", "H8/f7", "H9/d9", "H11/c11"];

export interface ClassChoice {
  value: string;
  /** "H7  +0.021 / 0" at the size. */
  label: string;
  upper: number;
  lower: number;
}

/** A side's classes with their deviations at this size (the ones ISO 286 has there). */
export function classChoices(size: number, side: "hole" | "shaft"): ClassChoice[] {
  const out: ClassChoice[] = [];
  for (const c of side === "hole" ? HOLE_CLASSES : SHAFT_CLASSES) {
    const d = classDeviations(size, c);
    if (!d) continue;
    out.push({ value: c, label: `${c}  ${deviationText(d.upper, 3)} / ${deviationText(d.lower, 3)}`, upper: d.upper, lower: d.lower });
  }
  return out;
}

export interface FitSummary {
  /** One line each: the hole's limits, the shaft's, and the fit. */
  lines: string[];
  type?: FitType;
}

/** What a fit code means at a size, in words and numbers: "Hole Ø25 H7: 25.000 – 25.021". */
export function fitSummary(size: number, code: string, symbol = ""): FitSummary | null {
  const f = parseFit(code);
  if (!f) return null;
  const lines: string[] = [];
  const lim = (d: { upper: number; lower: number }) => `${numberText(size + d.lower, 3)} – ${numberText(size + d.upper, 3)}`;
  for (const side of ["hole", "shaft"] as const) {
    const c = f[side];
    if (!c) continue;
    const d = classDeviations(size, c);
    if (!d) return { lines: [`${c.letter}${c.grade} is not in ISO 286 at ${numberText(size)} mm`] };
    lines.push(`${side === "hole" ? "Hole" : "Shaft"} ${symbol}${numberText(size)} ${c.letter}${c.grade}: ${lim(d)} (${deviationText(d.upper, 3)} / ${deviationText(d.lower, 3)})`);
  }
  const pair = f.hole && f.shaft ? fitOf(size, f) : null;
  if (pair) {
    const what = (x: number) => (x >= 0 ? `clearance ${numberText(x, 3)}` : `interference ${numberText(-x, 3)}`);
    lines.push(`${pair.type[0].toUpperCase()}${pair.type.slice(1)} fit: ${what(pair.minClearance)} to ${what(pair.maxClearance)}`);
    return { lines, type: pair.type };
  }
  return { lines };
}
