// The drawing checks (Phase L; Phase Q: every sheet): what a checker asks of
// a fabrication drawing before it goes to the workshop. Read from the
// composed sheets, so they judge what is drawn, in the app, in the critic and
// over MCP alike.

import type { DrawingGeometry } from "../ask/kernel";
import { allAnnotations } from "../doc/drawing";
import { validateDocument } from "../doc/validate";
import type { Check } from "../intent/critic";
import type { Measurements } from "../kernel/measure";
import type { ComposedDrawing, ComposedSheet } from "./compose";
import { fmt } from "./compose";
import { holeSignature } from "./autodim";
import { inside, overlaps, type Box } from "./sheet";

const AXES = ["x", "y", "z"] as const;

/** The checks of one sheet, or of every sheet of a drawing together. */
export function drawingChecks(sheets: ComposedSheet | ComposedSheet[] | ComposedDrawing, doc: unknown, m: Measurements | null, geometry: DrawingGeometry | null): Check[] {
  const list = Array.isArray(sheets) ? sheets : "sheets" in sheets ? sheets.sheets : [sheets];
  const checks: Check[] = [];
  const add = (label: string, ok: boolean, expected: string, actual: string) => checks.push({ label, ok, expected, actual });
  const views = list.flatMap((s) => s.views);
  const annotations = list.flatMap((s) => s.annotations);
  const drawn = annotations.filter((a) => !a.problem && a.box);
  const cut = list[0]?.cutList ?? [];

  const empty = views.filter((v) => !v.outline).map((v) => v.id);
  add("Every view shows the part", empty.length === 0 && views.length > 0, "every view", views.length === 0 ? "no views" : empty.length ? `${empty.join(", ")} show${empty.length === 1 ? "s" : ""} nothing` : `${views.map((v) => v.id).join(", ")}`);

  const loose = annotations.filter((a) => a.problem);
  add("Every annotation is attached", loose.length === 0, "all", loose.length ? loose.map((a) => `${a.id}: ${a.problem}`).join("; ") : `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`);

  if (cut.length) {
    const ballooned = new Set(drawn.filter((a) => a.type === "balloon").map((a) => a.item));
    const missing = cut.filter((i) => !ballooned.has(i.item));
    add(
      "Every cut list item has a balloon",
      missing.length === 0,
      `items 1–${cut.length}`,
      missing.length ? `no balloon for ${missing.map((i) => `item ${i.item} (${i.members.join(", ")})`).join(", ")}` : `${cut.length} of ${cut.length}`,
    );
  }

  const bb = m?.boundingBox;
  if (bb) {
    const dims = drawn.filter((a) => a.type === "dimension" && a.value !== undefined && a.along);
    // A round part's diameter is its size across both ways it is seen round.
    const diameters = drawn.filter((a) => a.type === "dimension" && a.value !== undefined && a.text.includes("Ø"));
    const missing = AXES.filter((_, i) => bb.size[i] > 1e-6 && !dims.some((d) => Math.abs(d.along![i]) > 0.999 && Math.abs(d.value! - bb.size[i]) < 0.05) && !diameters.some((d) => Math.abs(d.value! - bb.size[i]) < 0.05));
    add(
      "The overall size is dimensioned",
      missing.length === 0,
      bb.size.map(fmt).join(" × "),
      missing.length ? `no dimension of ${missing.map((a) => `${fmt(bb.size[AXES.indexOf(a)])} (${a})`).join(", ")}` : "length, width and height",
    );
  }

  const v = validateDocument(doc);
  const attached = (type: string) => (v.drawing ? allAnnotations(v.drawing) : []).filter((a) => a.type === type && drawn.some((d) => d.id === a.id));

  const holes = geometry?.holes ?? [];
  if (holes.length) {
    const called = new Set(attached("hole").map((a) => (a.type === "hole" ? a.hole : "")));
    // A callout of several alike holes ("4×") calls out the features it counts.
    const groups = attached("hole").filter((a) => a.type === "hole" && a.count !== undefined).map((a) => (a.type === "hole" ? holes.find((h) => h.feature === a.hole) : undefined)).filter((h): h is NonNullable<typeof h> => !!h).map(holeSignature);
    const missing = holes.filter((h) => !called.has(h.feature) && !groups.includes(holeSignature(h))).map((h) => h.feature);
    add("Every hole is called out", missing.length === 0, `${holes.length}`, missing.length ? `no callout for ${missing.join(", ")}` : `${holes.length} of ${holes.length}`);
  }

  if (v.welds.length) {
    const symbols = new Set(attached("weld").map((a) => (a.type === "weld" ? a.weld : "")));
    const missing = v.welds.filter((w) => !symbols.has(w.id)).map((w) => w.id);
    add("Every weld has a symbol", missing.length === 0, `${v.welds.length}`, missing.length ? `no symbol for ${missing.join(", ")}` : `${v.welds.length} of ${v.welds.length}`);
  }

  const clashes = list.flatMap((s) => layoutProblems(s).map((p) => (list.length > 1 ? `${s.name}: ${p}` : p)));
  add("Nothing overlaps or runs off the sheet", clashes.length === 0, "clear", clashes.length ? clashes.join("; ") : "clear");
  return checks;
}

/** Views, tables, notes and the title block that overlap, and anything off the sheet. */
export function layoutProblems(sheet: ComposedSheet): string[] {
  const placed: { name: string; box: Box }[] = [
    ...sheet.views.filter((v) => v.box).map((v) => ({ name: `view ${v.id}`, box: v.box! })),
    ...sheet.blocks.map((b) => ({ name: b.id, box: b.box })),
    { name: "the title block", box: sheet.titleBlock },
    ...(sheet.revisionBlock ? [{ name: "the revision block", box: sheet.revisionBlock }] : []),
  ];
  const out: string[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) if (overlaps(placed[i].box, placed[j].box)) out.push(`${placed[i].name} overlaps ${placed[j].name}`);
  }
  const all = [...placed, ...sheet.annotations.filter((a) => a.box).map((a) => ({ name: a.id, box: a.box! }))];
  for (const p of all) if (!inside(p.box, sheet.frame)) out.push(`${p.name} runs off the sheet`);
  return out;
}
