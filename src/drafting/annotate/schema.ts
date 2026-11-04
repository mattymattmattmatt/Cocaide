// Each annotation kind's properties, described for a generic property panel
// (Phase Q; the sheet editor renders these, the AI reference lists them):
// the field, its label, what it holds (text, a number, a switch, one of a
// list, a GeoRef, a tolerance ...), its choices, and when it applies.

import { ARROW_PLACES, ARROW_STYLES, BALLOON_SHAPES, DIMENSION_DIRECTIONS, DIMENSION_KINDS, LAY_SYMBOLS, SKETCH_LINES, SURFACE_SYMBOLS, WELD_CONTOURS, WELD_SYMBOLS, type Annotation, type AnnotationType } from "../../doc/types";
import { PREFERRED_FITS } from "../fits";
import { GDT_CHARACTERISTICS } from "../symbols/glyphs";
import { TOLERANCE_KINDS } from "../tolerance";
import { CHARACTERISTIC_INFO } from "./gdt";

export type FieldKind = "text" | "richText" | "number" | "integer" | "boolean" | "enum" | "georef" | "georefs" | "point" | "points" | "tolerance" | "gdtRows" | "weldSide" | "leaders" | "items" | "id";

export interface FieldSchema {
  key: string;
  label: string;
  kind: FieldKind;
  /** For enums: the values and what each is called. */
  options?: { value: string; label: string }[];
  /** mm, °, ... */
  unit?: string;
  help?: string;
  /** Shown only when this holds of the annotation. */
  when?: (a: Annotation) => boolean;
  required?: boolean;
}

const opts = (values: readonly string[], labels: Record<string, string> = {}) => values.map((value) => ({ value, label: labels[value] ?? value }));
const dimKind = (...k: string[]) => (a: Annotation) => a.type === "dimension" && k.includes(a.kind ?? "linear");

/** The tolerance editor's own fields (inside a "tolerance" field). */
export const TOLERANCE_SCHEMA: FieldSchema[] = [
  { key: "kind", label: "Tolerance", kind: "enum", options: opts(TOLERANCE_KINDS, { symmetric: "± symmetric", bilateral: "+/− bilateral", limit: "Limits (max/min)", fit: "Fit (H7)", fitWithTol: "Fit with deviations", fitLimits: "Fit with limits", basic: "Basic (boxed)", reference: "Reference (in brackets)", min: "MIN", max: "MAX" }), required: true },
  { key: "plus", label: "Plus", kind: "number", unit: "mm", help: "how far over the size it may be" },
  { key: "minus", label: "Minus", kind: "number", unit: "mm", help: "how far under the size it may be" },
  { key: "fit", label: "Fit", kind: "enum", options: [...new Set(PREFERRED_FITS.flatMap((f) => [f.fit, ...f.fit.split("/")]))].map((v) => ({ value: v, label: v })), help: 'ISO 286: "H7", "g6", "H7/g6" (any class may be typed)' },
  { key: "precision", label: "Decimals", kind: "integer" },
];

export const ANNOTATION_SCHEMAS: Record<AnnotationType, FieldSchema[]> = {
  dimension: [
    { key: "kind", label: "Kind", kind: "enum", options: opts(DIMENSION_KINDS, { arcLength: "arc length", pathLength: "path length" }) },
    { key: "refs", label: "Measures", kind: "georefs", when: (a) => a.type === "dimension" && !!a.refs },
    { key: "from", label: "From", kind: "georef", when: (a) => a.type === "dimension" && a.from !== undefined },
    { key: "to", label: "To", kind: "georef", when: (a) => a.type === "dimension" && a.to !== undefined },
    { key: "origin", label: "Origin", kind: "georef", when: dimKind("ordinate", "baseline", "chain") },
    { key: "points", label: "Points", kind: "georefs", when: dimKind("ordinate", "baseline", "chain") },
    { key: "direction", label: "Direction", kind: "enum", options: opts(DIMENSION_DIRECTIONS), when: dimKind("linear", "ordinate", "baseline", "chain", "diameter") },
    { key: "tolerance", label: "Tolerance", kind: "tolerance" },
    { key: "precision", label: "Decimals", kind: "integer" },
    { key: "prefix", label: "Prefix", kind: "richText", help: 'before the value: "SR", "<MOD-DIAM>"' },
    { key: "suffix", label: "Suffix", kind: "richText", help: 'after it: "THRU"' },
    { key: "count", label: "Count (n×)", kind: "integer" },
    { key: "typ", label: "TYP", kind: "boolean" },
    { key: "inspection", label: "Inspection", kind: "boolean", help: "in an oval" },
    { key: "dual", label: "Dual units", kind: "boolean" },
    { key: "arrows", label: "Arrows", kind: "enum", options: opts(ARROW_PLACES) },
    { key: "flip", label: "Flip", kind: "boolean" },
    { key: "major", label: "Reflex angle", kind: "boolean", when: dimKind("angular") },
    { key: "jog", label: "Jogged", kind: "boolean", when: dimKind("radius") },
    { key: "offset", label: "Offset", kind: "number", unit: "mm" },
    { key: "at", label: "Text at", kind: "point" },
  ],
  hole: [
    { key: "hole", label: "Hole feature", kind: "id", required: true },
    { key: "on", label: "Points at", kind: "georef" },
    { key: "count", label: "Count", kind: "integer" },
    { key: "pattern", label: "EQ SP on PCD", kind: "boolean" },
    { key: "tolerance", label: "Bore tolerance", kind: "tolerance" },
    { key: "prefix", label: "Prefix", kind: "richText" },
    { key: "suffix", label: "Suffix", kind: "richText" },
    { key: "at", label: "Text at", kind: "point" },
  ],
  balloon: [
    { key: "member", label: "Member", kind: "id" },
    { key: "body", label: "Body", kind: "text" },
    { key: "item", label: "Item", kind: "integer" },
    { key: "shape", label: "Shape", kind: "enum", options: opts(BALLOON_SHAPES) },
    { key: "size", label: "Size", kind: "number", unit: "mm" },
    { key: "quantity", label: "Quantity", kind: "boolean", help: "true: the item's count; or a number" },
    { key: "stack", label: "Stacked items", kind: "items" },
    { key: "arrow", label: "Leader end", kind: "enum", options: opts(ARROW_STYLES) },
    { key: "at", label: "At", kind: "point" },
  ],
  weld: [
    { key: "weld", label: "Weld (table)", kind: "id" },
    { key: "on", label: "Arrow to", kind: "georef" },
    { key: "arrowSide", label: "Arrow side", kind: "weldSide" },
    { key: "otherSide", label: "Other side", kind: "weldSide" },
    { key: "staggered", label: "Staggered", kind: "boolean" },
    { key: "allAround", label: "All around", kind: "boolean" },
    { key: "field", label: "Field weld", kind: "boolean" },
    { key: "process", label: "Process", kind: "text", help: 'ISO 4063 "135", AWS "GMAW"' },
    { key: "reference", label: "Reference", kind: "text" },
    { key: "at", label: "At", kind: "point" },
  ],
  table: [{ key: "at", label: "At", kind: "point" }],
  note: [
    { key: "text", label: "Text", kind: "richText", required: true, help: '**bold**, *italic*, __underline__, <MOD-DIAM> symbols, $PRP:"name" links' },
    { key: "height", label: "Height", kind: "number", unit: "mm" },
    { key: "numbered", label: "Numbered", kind: "boolean" },
    { key: "title", label: "Title", kind: "text" },
    { key: "bold", label: "Bold", kind: "boolean" },
    { key: "italic", label: "Italic", kind: "boolean" },
    { key: "underline", label: "Underline", kind: "boolean" },
    { key: "frame", label: "Box", kind: "boolean" },
    { key: "angle", label: "Angle", kind: "number", unit: "°" },
    { key: "leaders", label: "Leaders", kind: "leaders" },
    { key: "at", label: "At", kind: "point", required: true },
  ],
  centerMark: [
    { key: "at", label: "Circle", kind: "georef", required: true },
    { key: "style", label: "Style", kind: "enum", options: opts(["lines", "cross", "pitch"]) },
    { key: "extend", label: "Extension", kind: "number", unit: "mm" },
  ],
  centerline: [
    { key: "between", label: "Between", kind: "georefs", required: true },
    { key: "extend", label: "Extension", kind: "number", unit: "mm" },
  ],
  gdt: [
    { key: "rows", label: "Rows", kind: "gdtRows", required: true, options: GDT_CHARACTERISTICS.map((c) => ({ value: c, label: CHARACTERISTIC_INFO[c].label })) },
    { key: "composite", label: "Composite", kind: "boolean" },
    { key: "on", label: "Feature", kind: "georef" },
    { key: "dimension", label: "Under dimension", kind: "id" },
    { key: "count", label: "Count (n×)", kind: "integer" },
    { key: "above", label: "Above", kind: "richText" },
    { key: "below", label: "Below", kind: "richText" },
    { key: "at", label: "At", kind: "point" },
  ],
  datum: [
    { key: "label", label: "Letter", kind: "text", required: true },
    { key: "on", label: "Feature", kind: "georef" },
    { key: "dimension", label: "Dimension", kind: "id" },
    { key: "gdt", label: "Frame", kind: "id" },
    { key: "open", label: "Open triangle", kind: "boolean" },
    { key: "at", label: "At", kind: "point" },
  ],
  datumTarget: [
    { key: "label", label: "Label", kind: "text", required: true },
    { key: "target", label: "Target", kind: "enum", options: opts(["point", "line", "area"]), required: true },
    { key: "on", label: "On", kind: "georef", required: true },
    { key: "size", label: "Area size", kind: "number", unit: "mm" },
    { key: "at", label: "At", kind: "point" },
  ],
  surface: [
    { key: "symbol", label: "Symbol", kind: "enum", options: opts(SURFACE_SYMBOLS, { basic: "basic", removal: "material removal required", noRemoval: "no material removal" }) },
    { key: "values", label: "Requirements", kind: "items", help: '"Ra 1.6", "Rz 6.3"' },
    { key: "process", label: "Process", kind: "text" },
    { key: "lay", label: "Lay", kind: "enum", options: opts(LAY_SYMBOLS) },
    { key: "allowance", label: "Machining allowance", kind: "number", unit: "mm" },
    { key: "allAround", label: "All around", kind: "boolean" },
    { key: "general", label: "General requirement", kind: "boolean" },
    { key: "on", label: "Surface", kind: "georef" },
    { key: "at", label: "At", kind: "point" },
  ],
  cosmeticThread: [
    { key: "hole", label: "Thread", kind: "id", required: true },
    { key: "on", label: "On", kind: "georef" },
    { key: "at", label: "At", kind: "point" },
  ],
  revisionCloud: [
    { key: "pts", label: "Outline", kind: "points", required: true },
    { key: "rev", label: "Revision", kind: "text" },
    { key: "arc", label: "Arc size", kind: "number", unit: "mm" },
    { key: "at", label: "Triangle at", kind: "point" },
  ],
  leader: [
    { key: "to", label: "Points at", kind: "georef", required: true },
    { key: "text", label: "Text", kind: "richText" },
    { key: "arrow", label: "End", kind: "enum", options: opts(ARROW_STYLES) },
    { key: "spline", label: "Smooth", kind: "boolean" },
    { key: "at", label: "At", kind: "point" },
  ],
  text: [
    { key: "text", label: "Text", kind: "richText", required: true },
    { key: "height", label: "Height", kind: "number", unit: "mm" },
    { key: "angle", label: "Angle", kind: "number", unit: "°" },
    { key: "anchor", label: "Anchor", kind: "enum", options: opts(["start", "middle", "end"]) },
    { key: "bold", label: "Bold", kind: "boolean" },
    { key: "at", label: "At", kind: "point", required: true },
  ],
  line: [
    { key: "pts", label: "Ends", kind: "points", required: true },
    { key: "line", label: "Line", kind: "enum", options: opts(SKETCH_LINES) },
  ],
  sketch: [{ key: "items", label: "Items", kind: "items", required: true }],
};

/** A weld side's fields (inside a "weldSide" field). */
export const WELD_SIDE_SCHEMA: FieldSchema[] = [
  { key: "symbol", label: "Symbol", kind: "enum", options: opts(WELD_SYMBOLS, { v: "V butt", u: "U butt", j: "J butt", flareV: "flare V", flareBevel: "flare bevel", backWeld: "back weld" }), required: true },
  { key: "size", label: "Size", kind: "text", help: '"a5" throat, "z7" leg, or mm' },
  { key: "length", label: "Length", kind: "number", unit: "mm" },
  { key: "count", label: "Count", kind: "integer" },
  { key: "pitch", label: "Pitch", kind: "number", unit: "mm" },
  { key: "angle", label: "Groove angle", kind: "number", unit: "°" },
  { key: "root", label: "Root opening", kind: "number", unit: "mm" },
  { key: "contour", label: "Contour", kind: "enum", options: opts(WELD_CONTOURS) },
  { key: "finish", label: "Finish", kind: "text" },
];

/** The fields that apply to this annotation. */
export function schemaFor(a: Annotation): FieldSchema[] {
  return ANNOTATION_SCHEMAS[a.type].filter((f) => !f.when || f.when(a));
}
