// Reading a drawing (spec 5.2): what the model finds on the sheet, as
// structured output: the views, the title block (units, material, number),
// the projection, notes, and the part itself as intent. Every field has a
// value, its evidence and a confidence.
//
// The review is the confirmation card. Its rules, in code:
// - Numbers must be printed on the drawing when it has a text layer.
// - Nothing is trusted from a drawing too blurry to read.
// - Under 0.8 confidence is a blank.
// - The card is always shown and the user confirms it before anything is built.
// - v1: one part per drawing, flat plates and discs, projection declared by
//   the user, material note stored and never simulated.

import { z } from "zod";
import { answerIntent, CONFIDENT, reviewIntent, type Review, type Row, type Source } from "./review";
import { Intent, SOURCES } from "./schema";

const text = z.object({ value: z.string().nullable(), evidence: z.string(), source: z.enum(SOURCES), confidence: z.number() });
const choice = <T extends [string, ...string[]]>(options: T) =>
  z.object({ value: z.enum(options).nullable(), evidence: z.string(), source: z.enum(SOURCES), confidence: z.number() });

export const VIEW_KINDS = ["top", "front", "side", "section", "detail", "isometric", "other"] as const;
export const PROJECTIONS = ["first-angle", "third-angle"] as const;

export const DrawingReading = z.object({
  /** How many distinct parts the sheet shows. v1 builds one. */
  partsShown: z.number(),
  views: z.array(z.object({ kind: z.enum(VIEW_KINDS), label: z.string(), evidence: z.string(), confidence: z.number() })),
  /** From the projection symbol or note in the title block. */
  projection: choice([...PROJECTIONS] as [string, ...string[]]),
  /** The title block's units: the numbers in `part` are in these. */
  units: choice(["mm", "in"]),
  title: text,
  drawingNumber: text,
  /** The material note, as written. Stored, never simulated. */
  material: text,
  /** Thickness notes and other notes, quoted ("PLATE 6 THK"). */
  notes: z.array(z.string()),
  /** The part, as intent. */
  part: Intent,
});
export type DrawingReading = z.infer<typeof DrawingReading>;

export interface DrawingReview extends Review {
  /** The views found, for the card. */
  views: string[];
  /** What the document stores about where the part came from. */
  source: { drawing: string; projection?: string; material?: string; units?: string; drawingNumber?: string };
  name: string | null;
}

/** The drawing's title-block and projection rows, then the part's rows. Paths: "drawing.units", "drawing.projection", ... */
export function reviewDrawing(reading: DrawingReading, src: Source & { drawing: { text: string; legible: boolean }; file: string }): DrawingReview {
  const confirmed = src.confirmed ?? new Set<string>();
  const rows: Row[] = [];
  const problems: string[] = [];

  /** A text field from the sheet: its evidence must be on it, the scan legible, the reading confident. */
  const sheetValue = (f: { value: string | null; evidence: string; source: string; confidence: number }, path: string): { value: string | null; why?: string } => {
    if (confirmed.has(path)) return { value: f.value };
    if (f.value === null || f.source === "missing") return { value: null, why: "not on the drawing" };
    if (!src.drawing.legible) return { value: null, why: "the drawing is too blurry to read this" };
    if (f.source !== "stated" || f.confidence < CONFIDENT) return { value: null, why: `read with low confidence (${Math.round(f.confidence * 100)}%)` };
    if (src.drawing.text && !onSheet(f.evidence, src.drawing.text)) return { value: null, why: `"${f.evidence}" is not printed on the drawing` };
    return { value: f.value };
  };
  const row = (path: string, label: string, f: DrawingReading["title"], kind: Row["kind"], required: boolean, options?: Row["options"]) => {
    const v = sheetValue(f, path);
    rows.push({
      path,
      label,
      kind,
      options,
      value: v.value,
      unit: "",
      evidence: f.evidence,
      source: confirmed.has(path) ? "entered" : f.source,
      confidence: f.confidence,
      blank: required && v.value === null,
      note: v.value === null ? (required ? v.why : "not given") : undefined,
    });
    return v.value;
  };

  const units = row("drawing.units", "Units (title block)", reading.units, "choice", true, [
    { value: "mm", label: "mm" },
    { value: "in", label: "inches" },
  ]);
  const projection = row("drawing.projection", "Projection", reading.projection, "choice", true, [
    { value: "third-angle", label: "third angle" },
    { value: "first-angle", label: "first angle" },
  ]);
  const name = row("drawing.title", "Part name", reading.title, "text", false);
  const number = row("drawing.drawingNumber", "Drawing number", reading.drawingNumber, "text", false);
  const material = row("drawing.material", "Material (a note: not simulated)", reading.material, "text", false);

  if (reading.partsShown > 1) problems.push(`This drawing shows ${reading.partsShown} parts. v1 reads one part per drawing.`);
  if (reading.views.length === 0) problems.push("No views were found on the drawing.");
  if (reading.part.kind === "other") {
    problems.push("From a drawing, v1 builds flat plates and discs: one outline with holes through it. Build this part by hand, or describe it.");
  }

  // The part's numbers are in the drawing's units; the planner converts once.
  const part = { ...reading.part, action: "create" as const, units: (units === "in" ? "in" : "mm") as "mm" | "in" };
  const geometry = reviewIntent(part, src);
  rows.push(...geometry.rows);
  // A part with no planner already has the drawing's own message above.
  problems.push(...(reading.part.kind === "other" ? [] : geometry.problems));
  const blanks = rows.filter((r) => r.blank);
  return {
    intent: geometry.intent,
    rows,
    blanks,
    problems,
    ready: blanks.length === 0 && problems.length === 0,
    views: reading.views.map((v) => `${v.kind}${v.label ? ` (${v.label})` : ""}`),
    source: {
      drawing: src.file,
      ...(projection ? { projection } : {}),
      ...(material ? { material } : {}),
      ...(units ? { units } : {}),
      ...(number ? { drawingNumber: number } : {}),
    },
    name,
  };
}

/** The user's answers from the card, for the sheet fields and the part. */
export function answerDrawing(reading: DrawingReading, answers: Record<string, unknown>): { reading: DrawingReading; confirmed: Set<string> } {
  const next = structuredClone(reading);
  const confirmed = new Set<string>();
  const partAnswers: Record<string, number | string | { x: number; y: number }[]> = {};
  for (const [path, value] of Object.entries(answers)) {
    const m = /^drawing\.(\w+)$/.exec(path);
    if (!m) {
      partAnswers[path] = value as number | string;
      continue;
    }
    const key = m[1] as "units" | "projection" | "title" | "drawingNumber" | "material";
    (next as Record<string, unknown>)[key] = { value: String(value), evidence: "entered in the card", source: "stated", confidence: 1 };
    confirmed.add(path);
  }
  const part = answerIntent(next.part, partAnswers);
  next.part = part.intent;
  for (const p of part.confirmed) confirmed.add(p);
  return { reading: next, confirmed };
}

/** The evidence, as printed on the sheet (spacing and case aside). */
function onSheet(evidence: string, sheet: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const e = norm(evidence);
  return e.length > 0 && norm(sheet).includes(e);
}
