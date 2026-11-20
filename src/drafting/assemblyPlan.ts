// A sheet for the document's assembly: the assembly from the front and the
// top, an iso of it exploded (when it has explode steps; else assembled), its
// BOM above the title block and a balloon per BOM item on the iso. Laid out
// and scaled by the composer as any sheet. Pure.

import { parseScale, STANDARD_SCALES } from "../doc/drawing";
import type { Annotation, Drawing, DrawingSheet, DrawingView, SheetFormat, Vec2 } from "../doc/types";
import { paperSize } from "./formats";
import type { Command } from "../doc/commands";
import type { DrawingTable } from "./tables/types";
import type { CutListResult } from "../weldment/items";

/** The ids the drawing uses (views, annotations, tables are one namespace). */
function used(d: Drawing | undefined): Set<string> {
  return new Set((d?.sheets ?? []).flatMap((s) => [s.id, ...s.views.map((v) => v.id), ...s.annotations.map((a) => a.id), ...(s.tables ?? []).map((t) => t.id)]));
}

function fresh(taken: Set<string>, want: string): string {
  let id = want;
  for (let n = 2; taken.has(id); n++) id = `${want}${n}`;
  taken.add(id);
  return id;
}

export interface AssemblySheetPlan {
  /** The assembly's orthographic views; then its iso (exploded when it has explode steps) with the BOM and balloons. */
  sheets: DrawingSheet[];
  /** The iso view the balloons are on. */
  iso: string;
}

/**
 * The assembly's sheets. `format`: the paper and title block (the drawing's
 * first sheet's, or what New drawing would choose); `bom`: the items
 * ballooned (each on its first component); `exploded`: whether the iso is.
 * The iso has a sheet of its own so it is drawn large, as the sheet a parts
 * list and its balloons are read from.
 */
export function planAssemblySheet(drawing: Drawing | undefined, format: SheetFormat, projection: DrawingSheet["projection"], bom: CutListResult | null, exploded: boolean, title?: string, hidden: string[] = []): AssemblySheetPlan {
  const taken = used(drawing);
  const n = drawing?.sheets.length ?? 0;
  const first = fresh(taken, `sheet${n + 1}`);
  const second = fresh(taken, `sheet${n + 2}`);
  const front = fresh(taken, "asm_front");
  const top = fresh(taken, "asm_top");
  const right = fresh(taken, "asm_right");
  const iso = fresh(taken, exploded ? "asm_exploded" : "asm_iso");
  const fmt = { ...format, ...(title ? { title } : {}) };
  const views: DrawingView[] = [
    { id: front, look: "front", source: "assembly" },
    { id: top, kind: "projected", parent: front, direction: "up" },
    { id: right, kind: "projected", parent: front, direction: "right" },
  ];
  const isoView: DrawingView = { id: iso, look: "iso", source: "assembly", ...(exploded ? { exploded: true } : {}), display: "shadedEdges" };
  const tables: DrawingTable[] = [{ id: fresh(taken, "bom"), kind: "bom", anchor: { corner: "aboveTitleBlock" } }];
  // Each item's balloon on its first component the view shows (a hidden one isn't drawn).
  const annotations: Annotation[] = (bom?.items ?? []).flatMap((i) => {
    const body = i.bodies.find((b) => !hidden.includes(b));
    return body ? [{ id: fresh(taken, `b${i.item}`), type: "balloon", view: iso, body } as Annotation] : [];
  });
  return {
    sheets: [
      { id: first, name: "Assembly", format: fmt, projection, views, annotations: [] },
      { id: second, name: exploded ? "Exploded view" : "Assembly iso", format: fmt, projection, views: [isoView], annotations, tables },
    ],
    iso,
  };
}

/** The commands that put a planned sheet into an existing drawing: the empty sheet, then its views, table and balloons. */
export function sheetCommands(sheet: DrawingSheet): Command[] {
  const { id, views, annotations, tables, ...rest } = sheet;
  const cmds: Command[] = [{ type: "addSheet", id, sheet: rest as unknown as Record<string, unknown> }];
  for (const v of views) {
    const { id: vid, ...body } = v;
    cmds.push({ type: "setView", id: vid, view: body as Record<string, unknown>, sheet: id });
  }
  for (const t of tables ?? []) {
    const { id: tid, ...body } = t;
    cmds.push({ type: "setTable", id: tid, table: body as unknown as Record<string, unknown>, sheet: id });
  }
  for (const a of annotations) {
    const { id: aid, ...body } = a as Annotation & { id: string };
    cmds.push({ type: "setAnnotation", id: aid, annotation: body as Record<string, unknown>, sheet: id });
  }
  return cmds;
}

/**
 * Where a sheet's one big view goes, and at what scale: the largest standard
 * scale at which its outline (view mm), with room round it for balloons,
 * fits the paper beside the title block and the parts list (`listRows` rows
 * above the title block) — beside them or above them, whichever lets it be
 * larger — centred there.
 */
export function heroPlacement(format: SheetFormat, outline: { min: Vec2; max: Vec2 }, listRows: number): { scale: string; at: Vec2 } | null {
  const [W, H] = paperSize(format);
  const frame = { min: [20, 10] as Vec2, max: [W - 10, H - 10] as Vec2 };
  const tb: Vec2 = [180, 39];
  const list = listRows > 0 ? 7 + 6 * (listRows + 2) : 0;
  const regions = [
    // Left of the title block's column.
    { min: frame.min, max: [frame.max[0] - tb[0] - 6, frame.max[1]] as Vec2 },
    // Above the title block and the list.
    { min: [frame.min[0], frame.min[1] + tb[1] + list + 6] as Vec2, max: frame.max },
  ];
  const w = outline.max[0] - outline.min[0];
  const h = outline.max[1] - outline.min[1];
  if (!(w > 0 && h > 0)) return null;
  const room = 22; // balloons and their leaders, the label under it
  let best: { scale: number; fit: number; text: string; at: Vec2 } | null = null;
  for (const r of regions) {
    const rw = r.max[0] - r.min[0] - 2 * room;
    const rh = r.max[1] - r.min[1] - 2 * room;
    if (rw <= 0 || rh <= 0) continue;
    const fit = Math.min(rw / w, rh / h);
    const text = STANDARD_SCALES.find((s) => (parseScale(s) ?? 0) <= fit + 1e-12);
    if (!text) continue;
    const scale = parseScale(text)!;
    // The larger scale; at the same scale, the roomier place.
    if (!best || scale > best.scale + 1e-12 || (Math.abs(scale - best.scale) < 1e-12 && fit > best.fit)) best = { scale, fit, text, at: [(r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2 + 4] };
  }
  return best ? { scale: best.text, at: [Math.round(best.at[0] * 10) / 10, Math.round(best.at[1] * 10) / 10] } : null;
}

/** The commands that draw an iso sheet's one view large and centred (heroPlacement), at the sheet's own scale, labelled. */
export function heroCommands(sheet: DrawingSheet, projected: { edges: { pts: Vec2[] }[] } | undefined, listRows: number): Command[] {
  const view = sheet.views[0];
  const pts = (projected?.edges ?? []).flatMap((e) => e.pts);
  if (!view || !pts.length) return [];
  const outline = { min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))] as Vec2, max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] as Vec2 };
  const place = heroPlacement(sheet.format, outline, listRows);
  if (!place) return [];
  // At the sheet's scale (a scale of its own, an iso's a step smaller, let go).
  const { id, scale: _own, ...body } = view;
  void _own;
  return [
    { type: "setSheet", sheet: sheet.id, patch: { scale: place.scale } },
    { type: "setView", id, sheet: sheet.id, view: { ...body, at: place.at, showLabel: true } as Record<string, unknown> },
  ];
}
