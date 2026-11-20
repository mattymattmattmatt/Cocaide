// A drawing pack: an assembly's drawing (its assembly sheets, its own part's)
// and then the drawing of every part the assembly carries, in the parts
// list's order, numbered as one set of sheets ("SHEET 7 OF 15"). Each part's
// drawing is carried with the part (assembly.parts[key].drawing) and composed
// against its own part. Pure, given each document's measurements and
// projections.

import { assemblyBom } from "../assembly/bom";
import { SELF } from "../doc/assembly";
import type { Assembly } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { composeDrawing, type ComposeContext, type ComposedSheet } from "./compose";

export interface PackPart {
  /** The part's key in the assembly. */
  key: string;
  /** Its document, with its drawing. */
  doc: Record<string, unknown>;
}

/** The parts of the document's assembly that carry a drawing, in the parts list's order (this document's own part not among them: its drawing is the document's). */
export function packParts(doc: Record<string, unknown>): PackPart[] {
  const asm = doc.assembly as Assembly | undefined;
  const bom = assemblyBom(doc);
  if (!asm?.parts || !bom) return [];
  const order: string[] = [];
  for (const k of asm.components) if (!order.includes(k.part)) order.push(k.part);
  return order.filter((key) => key !== SELF && (asm.parts![key] as { drawing?: unknown } | undefined)?.drawing).map((key) => ({ key, doc: asm.parts![key] as Record<string, unknown> }));
}

/** How many sheets a document's drawing has (0: none, or not valid). */
export function sheetCount(doc: Record<string, unknown>): number {
  return validateDocument(doc).drawing?.sheets.length ?? 0;
}

/**
 * Every sheet of the pack, composed: the document's, then each part's, each
 * numbered in the pack. `ctxOf` gives a document's compose context (its
 * measurements and projections).
 */
export function composePack(doc: Record<string, unknown>, parts: PackPart[], ctxOf: (d: Record<string, unknown>) => ComposeContext): ComposedSheet[] {
  const docs = [doc, ...parts.map((p) => p.doc)];
  const counts = docs.map(sheetCount);
  const total = counts.reduce((a, b) => a + b, 0);
  const out: ComposedSheet[] = [];
  let first = 1;
  docs.forEach((d, i) => {
    if (!counts[i]) return;
    const c = composeDrawing(d, { ...ctxOf(d), pack: { first, total } });
    out.push(...(c?.sheets ?? []));
    first += counts[i];
  });
  return out;
}
