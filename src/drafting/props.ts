// Property links in a drawing's text (Phase Q): a title-block field or a note
// may say $PRP:"partNumber" (the drawing's own properties first, then the
// part's: partNumber, description, revision, author, finish and the custom
// ones), $PRPMODEL:"mass" (measured on the rebuild: mass, material, volume,
// name) or $PRPSHEET:"scale" (the sheet's: scale, sheet, sheets, size,
// name). A link to nothing reads as empty, so a template's defaults never
// print a raw $PRP.

export interface PropContext {
  /** The drawing's own properties (Drawing.properties). */
  drawing: Record<string, string>;
  /** The part's properties (partNumber, description ... and custom ones by name). */
  part: Record<string, string>;
  /** Measured: mass ("1.23 kg"), material, volume, name. */
  model: Record<string, string>;
  /** The sheet's: scale, sheet (its number), sheets (how many), size, name. */
  sheet: Record<string, string>;
}

const LINK = /\$(PRP|PRPMODEL|PRPSHEET):"([^"]*)"/g;

/** The text with every link replaced by what it links to. */
export function resolveProps(text: string, ctx: PropContext): string {
  return text.replace(LINK, (_m, kind: string, name: string) => {
    if (kind === "PRPMODEL") return ctx.model[name] ?? "";
    if (kind === "PRPSHEET") return ctx.sheet[name] ?? "";
    return ctx.drawing[name] ?? ctx.part[name] ?? "";
  });
}

/** The names a text links, by kind: what a checker lists when one links to nothing. */
export function propLinks(text: string): { kind: "PRP" | "PRPMODEL" | "PRPSHEET"; name: string }[] {
  return [...text.matchAll(LINK)].map((m) => ({ kind: m[1] as "PRP" | "PRPMODEL" | "PRPSHEET", name: m[2] }));
}
