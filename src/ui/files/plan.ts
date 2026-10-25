// What a file opened or dropped becomes (Phase P): a part (.cocaide.json), a
// STEP file (a new part holding one import, or a body added to this part), a
// DXF drawing (a new part with a sketch on Top holding it, or a sketch added
// to this part, or entities inserted into the sketch being edited), or a
// drawing to read (PDF, image). Pure: the App asks and dispatches.

import { nextId, type RawDocument } from "../../doc/commands";
import { BODY_NAME } from "../../doc/types";
import { validateDocument } from "../../doc/validate";
import { importBodies, importSolidCount, sizeText } from "../../features/import/doc";
import { MAX_STEP_CHARS, stepProblem, WARN_STEP_CHARS } from "../../features/import/stepText";
import { DxfError, readDxf, type DxfRead } from "../../io/dxf";
import { dxfToSketch, type InsertOptions } from "../../io/dxfSketch";

export type FileKind = "part" | "step" | "dxf" | "drawing" | "other";

const DRAWING = /\.(pdf|png|jpe?g|webp|gif)$/i;

/** What a file is, by its name (and its first bytes when the name says nothing). */
export function fileKind(name: string, head = ""): FileKind {
  const n = name.toLowerCase();
  if (n.endsWith(".step") || n.endsWith(".stp")) return "step";
  if (n.endsWith(".dxf")) return "dxf";
  if (n.endsWith(".json")) return "part";
  if (DRAWING.test(n)) return "drawing";
  const h = head.replace(/^﻿/, "").trimStart();
  if (h.startsWith("ISO-10303-21;")) return "step";
  if (h.startsWith("{")) return "part";
  if (/^0\s*\r?\n\s*SECTION/.test(h) || /^999\s*\r?\n/.test(h)) return "dxf";
  return "other";
}

/** The file's name without its extension, as a part or body name ("Bracket v2.step" → "Bracket v2"). */
export function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "part";
}

/** A body name from a file name: letters, digits, _ and -, starting with a letter or _ ("2 Bracket.step" → "_2_Bracket"). */
export function bodyNameFor(fileName: string): string {
  let n = baseName(fileName).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!n) n = "imported";
  if (!/^[A-Za-z_]/.test(n)) n = `_${n}`;
  return BODY_NAME.test(n) ? n : "imported";
}

/** Too big to keep, or big enough to warn about: what the person is told before the file goes into the part. */
export function stepSizeProblem(chars: number): { refuse?: string; warn?: string } {
  if (chars > MAX_STEP_CHARS) return { refuse: `The STEP file is ${sizeText(chars)}: a part holds at most ${sizeText(MAX_STEP_CHARS)}. Simplify the model (fewer, simpler faces) or import it in parts.` };
  if (chars > WARN_STEP_CHARS) return { warn: `The STEP file is ${sizeText(chars)}: the part holds the whole file, so saving, undo and rebuilds get slower. Keep imports to a few MB where you can, and Save the part to keep it (it is too big for this browser to keep between visits).` };
  if (chars > KEEP_CHARS) return { warn: `The STEP file is ${sizeText(chars)}: too big for this browser to keep between visits. Save the part (.cocaide.json) to keep it.` };
  return {};
}

/** About what this browser keeps of the working part between visits (its local storage holds the text twice). */
const KEEP_CHARS = 2 * 1024 * 1024;

/**
 * The import feature for a STEP file added to `doc`: its bodies named after
 * the file (made unique against the part's bodies), at the origin. A string
 * says why it can't be (not STEP, too big).
 */
export function importFeature(doc: RawDocument | null, fileName: string, text: string): { feature: Record<string, unknown>; warning?: string } | string {
  const size = stepSizeProblem(text.length);
  if (size.refuse) return size.refuse;
  const problem = stepProblem(text);
  if (problem) return `${fileName} ${problem}.`;
  const taken = new Set(doc ? validateDocument(doc).madeBodies : []);
  const id = nextId(doc, "import");
  const count = importSolidCount({ data: text });
  const base = bodyNameFor(fileName);
  let newBody = base;
  // A second import of the same file: bracket2, bracket3 ... (bracket_2 would read as the first one's second solid).
  for (let k = 2; importBodies({ id, newBody }, count).some((n) => taken.has(n)); k++) newBody = `${base}${k}`;
  return { feature: { id, op: "import", format: "step", fileName: fileName.replace(/^.*[\\/]/, ""), data: text, newBody }, ...(size.warn ? { warning: size.warn } : {}) };
}

/** A new part named after the STEP file, holding one import of it. */
export function stepPart(fileName: string, text: string): { doc: RawDocument; warning?: string } | string {
  const made = importFeature(null, fileName, text);
  if (typeof made === "string") return made;
  return { doc: { version: 1, units: "mm", name: baseName(fileName), features: [made.feature] }, ...(made.warning ? { warning: made.warning } : {}) };
}

/** Reads a DXF, or says why it can't be read. */
export function readDxfFile(fileName: string, text: string): DxfRead | string {
  try {
    const r = readDxf(text);
    if (r.entities.filter((e) => e.type !== "text").length === 0) return `${fileName} has no lines, arcs or curves to insert${Object.keys(r.skipped).length ? ` (only ${Object.entries(r.skipped).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}.`;
    return r;
  } catch (e) {
    if (e instanceof DxfError) return `${fileName}: ${e.message}.`;
    throw e;
  }
}

/** A sketch on Top holding the DXF (added to `doc`, or the first feature of a new part). */
export function dxfSketch(doc: RawDocument | null, read: DxfRead, opts: InsertOptions = {}): { feature: Record<string, unknown>; report: string } {
  const made = dxfToSketch(read, [], opts);
  const id = nextId(doc, "sketch");
  return {
    feature: { id, op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: made.entities, ...(made.constraints.length ? { constraints: made.constraints } : {}) },
    report: made.report,
  };
}

/** A new part named after the DXF file, with a sketch on Top holding it. */
export function dxfPart(fileName: string, read: DxfRead, opts: InsertOptions = {}): { doc: RawDocument; report: string } {
  const { feature, report } = dxfSketch(null, read, opts);
  return { doc: { version: 1, units: "mm", name: baseName(fileName), features: [feature] }, report };
}
