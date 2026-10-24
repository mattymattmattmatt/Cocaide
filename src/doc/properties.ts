// The part's properties (Phase P, DESIGN §2.9): what the title block, the cut
// list, STEP export and the export file names read. Pure, lenient readers of
// the raw document (validation is strict; these never throw).

import type { PartProperties } from "./types";

/** The named properties, in the order the Document tab and the agent's packet list them. */
export const PROPERTY_FIELDS = [
  ["partNumber", "Part number", "BR-1001"],
  ["description", "Description", "Base bracket, 10 mm plate"],
  ["revision", "Revision", "A"],
  ["author", "Author (drawn by)", "Your name"],
  ["finish", "Finish", "Hot-dip galvanised"],
] as const satisfies readonly [Exclude<keyof PartProperties, "custom">, string, string][];

export type PropertyKey = (typeof PROPERTY_FIELDS)[number][0];

/** The properties a raw document holds: its strings only (anything wrong is left out). */
export function partProperties(doc: unknown): PartProperties {
  const raw = doc && typeof doc === "object" ? (doc as { properties?: unknown }).properties : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const p = raw as Record<string, unknown>;
  const out: PartProperties = {};
  for (const [k] of PROPERTY_FIELDS) if (typeof p[k] === "string" && (p[k] as string).trim()) out[k] = p[k] as string;
  if (p.custom && typeof p.custom === "object" && !Array.isArray(p.custom)) {
    const custom = Object.fromEntries(Object.entries(p.custom as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));
    if (Object.keys(custom).length) out.custom = custom;
  }
  return out;
}

/** A name safe as a file name: letters, digits, dot, dash and underscore. */
export function safeFileName(name: string): string {
  return name.trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "part";
}

/**
 * The base of an export's file name: the part number (with its revision,
 * "BR-1001-revB") when the part has one, else the part's name.
 */
export function exportBase(doc: unknown, name?: string): string {
  const p = partProperties(doc);
  const docName = name ?? (doc && typeof doc === "object" && typeof (doc as { name?: unknown }).name === "string" ? (doc as { name: string }).name : "part");
  if (!p.partNumber) return safeFileName(docName);
  return safeFileName(p.revision ? `${p.partNumber}-rev${p.revision}` : p.partNumber);
}

/** What a STEP file calls the part: its product name (the part number, else the part's name) and description. */
export function stepProduct(doc: unknown, name: string): { name: string; description: string | null } {
  const p = partProperties(doc);
  return { name: p.partNumber ?? name, description: p.description ?? null };
}

/** The header lines a cut list CSV starts with: part number, description, revision, when the part has them. */
export function csvHeaderRows(doc: unknown, name: string): string[][] {
  const p = partProperties(doc);
  const rows: string[][] = [["Part", name]];
  if (p.partNumber) rows.push(["Part number", p.partNumber]);
  if (p.description) rows.push(["Description", p.description]);
  if (p.revision) rows.push(["Revision", p.revision]);
  return rows.length > 1 ? rows : [];
}
