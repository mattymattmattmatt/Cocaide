// The drawing checks (Phase L): what a checker asks of a fabrication drawing
// before it goes to the workshop. Read from the composed sheet, so they judge
// what is drawn, in the app, in the critic and over MCP alike.

import type { DrawingGeometry } from "../ask/kernel";
import { validateDocument } from "../doc/validate";
import type { Check } from "../intent/critic";
import type { Measurements } from "../kernel/measure";
import type { ComposedSheet } from "./compose";
import { fmt } from "./compose";
import { inside, overlaps, type Box } from "./sheet";

const AXES = ["x", "y", "z"] as const;

export function drawingChecks(sheet: ComposedSheet, doc: unknown, m: Measurements | null, geometry: DrawingGeometry | null): Check[] {
  const checks: Check[] = [];
  const add = (label: string, ok: boolean, expected: string, actual: string) => checks.push({ label, ok, expected, actual });
  const drawn = sheet.annotations.filter((a) => !a.problem && a.box);

  const empty = sheet.views.filter((v) => !v.outline).map((v) => v.id);
  add("Every view shows the part", empty.length === 0 && sheet.views.length > 0, "every view", sheet.views.length === 0 ? "no views" : empty.length ? `${empty.join(", ")} show${empty.length === 1 ? "s" : ""} nothing` : `${sheet.views.map((v) => v.id).join(", ")}`);

  const loose = sheet.annotations.filter((a) => a.problem);
  add("Every annotation is attached", loose.length === 0, "all", loose.length ? loose.map((a) => `${a.id}: ${a.problem}`).join("; ") : `${sheet.annotations.length} annotation${sheet.annotations.length === 1 ? "" : "s"}`);

  if (sheet.cutList.length) {
    const ballooned = new Set(drawn.filter((a) => a.type === "balloon").map((a) => a.item));
    const missing = sheet.cutList.filter((i) => !ballooned.has(i.item));
    add(
      "Every cut list item has a balloon",
      missing.length === 0,
      `items 1–${sheet.cutList.length}`,
      missing.length ? `no balloon for ${missing.map((i) => `item ${i.item} (${i.members.join(", ")})`).join(", ")}` : `${sheet.cutList.length} of ${sheet.cutList.length}`,
    );
  }

  const bb = m?.boundingBox;
  if (bb) {
    const dims = drawn.filter((a) => a.type === "dimension" && a.value !== undefined && a.along);
    const missing = AXES.filter((_, i) => bb.size[i] > 1e-6 && !dims.some((d) => Math.abs(d.along![i]) > 0.999 && Math.abs(d.value! - bb.size[i]) < 0.05));
    add(
      "The overall size is dimensioned",
      missing.length === 0,
      bb.size.map(fmt).join(" × "),
      missing.length ? `no dimension of ${missing.map((a) => `${fmt(bb.size[AXES.indexOf(a)])} (${a})`).join(", ")}` : "length, width and height",
    );
  }

  const v = validateDocument(doc);
  const attached = (type: string) => (v.drawing?.annotations ?? []).filter((a) => a.type === type && drawn.some((d) => d.id === a.id));

  const holes = geometry?.holes ?? [];
  if (holes.length) {
    const called = new Set(attached("hole").map((a) => (a.type === "hole" ? a.hole : "")));
    const missing = holes.filter((h) => !called.has(h.feature)).map((h) => h.feature);
    add("Every hole is called out", missing.length === 0, `${holes.length}`, missing.length ? `no callout for ${missing.join(", ")}` : `${holes.length} of ${holes.length}`);
  }

  if (v.welds.length) {
    const symbols = new Set(attached("weld").map((a) => (a.type === "weld" ? a.weld : "")));
    const missing = v.welds.filter((w) => !symbols.has(w.id)).map((w) => w.id);
    add("Every weld has a symbol", missing.length === 0, `${v.welds.length}`, missing.length ? `no symbol for ${missing.join(", ")}` : `${v.welds.length} of ${v.welds.length}`);
  }

  const clashes = layoutProblems(sheet);
  add("Nothing overlaps or runs off the sheet", clashes.length === 0, "clear", clashes.length ? clashes.join("; ") : "clear");
  return checks;
}

/** Views, tables, notes and the title block that overlap, and anything off the sheet. */
export function layoutProblems(sheet: ComposedSheet): string[] {
  const placed: { name: string; box: Box }[] = [
    ...sheet.views.filter((v) => v.box).map((v) => ({ name: `view ${v.id}`, box: v.box! })),
    ...sheet.blocks.map((b) => ({ name: b.id, box: b.box })),
    { name: "the title block", box: sheet.titleBlock },
  ];
  const out: string[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) if (overlaps(placed[i].box, placed[j].box)) out.push(`${placed[i].name} overlaps ${placed[j].name}`);
  }
  const all = [...placed, ...sheet.annotations.filter((a) => a.box).map((a) => ({ name: a.id, box: a.box! }))];
  for (const p of all) if (!inside(p.box, sheet.frame)) out.push(`${p.name} runs off the sheet`);
  return out;
}
