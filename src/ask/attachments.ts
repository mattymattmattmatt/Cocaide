// Files attached to an AI request: reference images, PDFs, text files, and
// DXF/STEP files summarised as text. Pure: what is accepted and how big, how
// a file is described to the model, and the content blocks it becomes. The
// browser side (reading the file, scaling an image, rendering a PDF's pages)
// is src/ui/ask/attach.ts.
//
// How each kind reaches the model:
//   image  -> an image block (Anthropic) / "images" (Ollama, vision models; others are told it isn't shown)
//   pdf    -> a document block for a provider that reads PDFs (Anthropic); otherwise its text layer as text and
//             its first pages rendered as images (the drawing rasteriser's pages)
//   text   -> text (TXT, MD, CSV), cut at TEXT_LIMIT characters
//   cad    -> a text summary (DXF: units, layers, entity counts, extents; STEP: the header and product names)

import type Anthropic from "@anthropic-ai/sdk";
import { boundsOf } from "../io/dxfGeom";
import { readDxf } from "../io/dxf";

export type AttachmentKind = "image" | "pdf" | "text" | "cad";

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** The media type sent with it ("image/png", "application/pdf", "text/csv"). */
  mediaType: string;
  /** The file's size in bytes, as dropped. */
  size: number;
  /** Base64 (no data: prefix): the image, or the PDF itself. */
  data?: string;
  /** The text: a text file's contents, a PDF's text layer, a DXF or STEP summary. */
  text?: string;
  /** A PDF's first pages rendered (PNG, base64), for a provider that does not read PDFs. */
  pages?: string[];
  /** The text was cut to fit. */
  truncated?: boolean;
}

export const MAX_ATTACHMENTS = 6;
/** Per file, as dropped. Images larger than the model takes are scaled down first (attach.ts). */
export const MAX_BYTES: Record<AttachmentKind, number> = { image: 10 * 2 ** 20, pdf: 20 * 2 ** 20, text: 2 * 2 ** 20, cad: 20 * 2 ** 20 };
/** All attachments of one request together, as sent. */
export const MAX_TOTAL_BYTES = 30 * 2 ** 20;
/** Characters of one text attachment (about 25k tokens). */
export const TEXT_LIMIT = 100_000;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_EXT = ["txt", "md", "markdown", "csv"];
const CAD_EXT = ["dxf", "step", "stp"];

export const ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.markdown,.csv,.dxf,.step,.stp,image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown,text/csv";

const ext = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

/** What kind of attachment a file is, or why it can't be one. */
export function attachmentKind(file: { name: string; type: string; size: number }): AttachmentKind | string {
  const e = ext(file.name);
  const kind: AttachmentKind | null = IMAGE_TYPES.includes(file.type) || ["png", "jpg", "jpeg", "webp", "gif"].includes(e)
    ? "image"
    : file.type === "application/pdf" || e === "pdf"
      ? "pdf"
      : CAD_EXT.includes(e)
        ? "cad"
        : TEXT_EXT.includes(e) || file.type.startsWith("text/")
          ? "text"
          : null;
  if (!kind) return `${file.name}: attach images (PNG, JPG, WebP), PDFs, text files (TXT, MD, CSV) or DXF/STEP files`;
  if (file.size > MAX_BYTES[kind]) return `${file.name} is ${sizeText(file.size)}; the most for ${kind === "cad" ? "a DXF or STEP file" : `a${kind === "image" ? "n image" : kind === "pdf" ? " PDF" : " text file"}`} is ${sizeText(MAX_BYTES[kind])}`;
  return kind;
}

/** Whether one more attachment fits with those already there. */
export function canAdd(current: Attachment[], next: Attachment): string | null {
  if (current.length >= MAX_ATTACHMENTS) return `at most ${MAX_ATTACHMENTS} attachments per request`;
  const total = [...current, next].reduce((n, a) => n + sentBytes(a), 0);
  if (total > MAX_TOTAL_BYTES) return `the attachments would be ${sizeText(total)} together; the most is ${sizeText(MAX_TOTAL_BYTES)}`;
  return null;
}

/** About how many bytes an attachment sends. */
export function sentBytes(a: Attachment): number {
  return Math.round(((a.data?.length ?? 0) + (a.pages ?? []).reduce((n, p) => n + p.length, 0)) * 0.75) + (a.text?.length ?? 0);
}

export function sizeText(bytes: number): string {
  return bytes >= 2 ** 20 ? `${(bytes / 2 ** 20).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} kB` : `${bytes} B`;
}

/** A text file's contents, cut to the limit. */
export function textAttachment(id: string, name: string, size: number, text: string, mediaType = "text/plain"): Attachment {
  const truncated = text.length > TEXT_LIMIT;
  return { id, name, kind: "text", mediaType, size, text: truncated ? text.slice(0, TEXT_LIMIT) : text, ...(truncated ? { truncated } : {}) };
}

/** A DXF or STEP file as a short text summary (the model gets the summary, not the file). */
export function cadAttachment(id: string, name: string, size: number, text: string): Attachment {
  return { id, name, kind: "cad", mediaType: "text/plain", size, text: ext(name) === "dxf" ? dxfSummary(text) : stepSummary(text) };
}

export function dxfSummary(text: string): string {
  try {
    const r = readDxf(text);
    const counts: Record<string, number> = {};
    for (const e of r.entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const box = boundsOf(r.entities);
    const round = (v: number) => Math.round(v * 1000) / 1000;
    return [
      `DXF${r.version ? ` ${r.version}` : ""}, units: ${r.units.name}${r.units.assumed ? " (not stated; read as millimetres)" : ""}; read into mm.`,
      `Entities: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}.`,
      box ? `Extents: x ${round(box.min[0])} to ${round(box.max[0])}, y ${round(box.min[1])} to ${round(box.max[1])} (${round(box.max[0] - box.min[0])} × ${round(box.max[1] - box.min[1])} mm).` : "",
      `Layers: ${r.layers.map((l) => `${l.name} (${l.count})`).join(", ") || "none"}.`,
      Object.keys(r.skipped).length ? `Not read: ${Object.entries(r.skipped).map(([k, n]) => `${n} ${k}`).join(", ")}.` : "",
      ...r.warnings.slice(0, 5),
      "To use its geometry in the part, the user imports it into a sketch (File → Import DXF).",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (e) {
    return `A DXF file that could not be read: ${(e as Error).message}`;
  }
}

/** A STEP file's header (name, description, the program that wrote it) and its product names. Its shape is not read here. */
export function stepSummary(text: string): string {
  if (!/ISO-10303-21/.test(text.slice(0, 2000))) return "This does not look like a STEP file (no ISO-10303-21 header).";
  const head = text.slice(0, 20000);
  const field = (re: RegExp) => re.exec(head)?.[1]?.trim();
  const name = field(/FILE_NAME\s*\(\s*'([^']*)'/);
  const desc = field(/FILE_DESCRIPTION\s*\(\s*\(\s*'([^']*)'/);
  const schema = field(/FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/);
  const system = field(/FILE_NAME\s*\([^;]*?'[^']*'\s*,\s*'[^']*'\s*,\s*\([^)]*\)\s*,\s*\([^)]*\)\s*,\s*'([^']*)'/);
  const products = [...text.matchAll(/=\s*PRODUCT\s*\(\s*'([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  const solids = (text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length;
  return [
    `STEP file${schema ? ` (${schema})` : ""}${name ? `, named ${name}` : ""}${system ? `, written by ${system}` : ""}.`,
    desc ? `Description: ${desc}.` : "",
    products.length ? `Products: ${[...new Set(products)].slice(0, 20).join(", ")}.` : "",
    `${solids} solid bod${solids === 1 ? "y" : "ies"}.`,
    "Only the header is summarised here; to use the shape, the user imports it (File → Import STEP).",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The content blocks for a request's attachments. `documents`: the provider reads PDF document blocks
 * (Anthropic); otherwise a PDF goes as its text and rendered pages.
 */
export function attachmentBlocks(atts: Attachment[], opts: { documents: boolean }): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const a of atts) {
    if (a.kind === "image" && a.data) {
      blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType as "image/png", data: a.data } });
    } else if (a.kind === "pdf") {
      if (opts.documents && a.data) blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data }, title: a.name });
      else {
        for (const p of a.pages ?? []) blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: p } });
        blocks.push({ type: "text", text: `Attached PDF ${a.name}${a.pages?.length ? ` (its first ${a.pages.length} page${a.pages.length === 1 ? "" : "s"} shown above as images)` : ""}. Its text layer:\n${a.text?.trim() || "(none: a scan; read it from the page images)"}` });
      }
    } else if (a.text !== undefined) {
      blocks.push({ type: "text", text: `Attached ${a.kind === "cad" ? "CAD file" : "file"} ${a.name}${a.truncated ? ` (cut to its first ${TEXT_LIMIT} characters)` : ""}:\n${a.text}` });
    }
  }
  return blocks;
}

/** One line for the prompt: what is attached, in order. */
export function attachmentNote(atts: Attachment[]): string {
  if (!atts.length) return "";
  return `The user attached ${atts.length} file${atts.length === 1 ? "" : "s"} for reference: ${atts.map((a) => `${a.name} (${a.kind === "cad" ? "summary" : a.kind})`).join(", ")}. Use them as references for the request; sizes in a picture are not measurements unless the user says so.`;
}
