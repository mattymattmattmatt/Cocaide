// A sheet as DXF (Phase Q), through the shared writer (src/io/dxf.ts): R2000
// by default, R12 for old readers, mm. Each kind of line on its own layer, so
// a CAD program can turn them on and off or recolour them: VISIBLE, HIDDEN
// (dashed), TANGENT (phantom), CENTER (centre lines and marks), HATCH,
// SECTION (cutting lines, their arrows and letters), THREAD, BREAK,
// DIMENSION, ANNOTATION (callouts, balloons, weld symbols, notes), TABLE,
// TEXT (view labels), BORDER and TITLE (the title block). Shading is left out:
// DXF lines can't carry it.

import { writeDxf, type DxfEntity, type DxfLayer } from "../io/dxf";
import type { ComposedSheet } from "./compose";
import { CAP, CENTER_DASH, HIDDEN_DASH, PHANTOM_DASH, textWidth } from "./text";

export const DXF_LAYERS: DxfLayer[] = [
  { name: "VISIBLE", color: 7 },
  { name: "HIDDEN", color: 2, lineType: "DASHED" },
  { name: "TANGENT", color: 8, lineType: "PHANTOM" },
  { name: "CENTER", color: 1, lineType: "CENTER" },
  { name: "HATCH", color: 8 },
  { name: "SECTION", color: 4 },
  { name: "THREAD", color: 5 },
  { name: "BREAK", color: 8 },
  { name: "DIMENSION", color: 3 },
  { name: "ANNOTATION", color: 6 },
  { name: "TABLE", color: 7 },
  { name: "TEXT", color: 7 },
  { name: "BORDER", color: 7 },
  { name: "TITLE", color: 7 },
];

const same = (a: number[] | undefined, b: number[]) => !!a && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

/** The layer a primitive goes on: its own, else by what owns it and how it is drawn. */
function layerOf(p: ComposedSheet["prims"][number]): string {
  if (p.layer) return p.layer;
  if (p.owner === "sheet") return "BORDER";
  if (p.owner === "titleBlock") return "TITLE";
  if (p.k === "line" || p.k === "circle") {
    if (same(p.dash, HIDDEN_DASH)) return "HIDDEN";
    if (same(p.dash, CENTER_DASH)) return "CENTER";
    if (same(p.dash, PHANTOM_DASH)) return "TANGENT";
  }
  return p.k === "text" ? "TEXT" : "VISIBLE";
}

export interface SheetDxfOptions {
  version?: "R2000" | "R12";
}

/** The sheet's lines, circles and text as a DXF drawing, mm, origin at the sheet's lower left. */
export function sheetDXF(sheet: ComposedSheet, opts: SheetDxfOptions = {}): string {
  const entities: DxfEntity[] = [];
  for (const p of sheet.prims) {
    const layer = layerOf(p);
    if (p.k === "line") {
      if (p.pts.length < 2) continue;
      if (p.pts.length === 2 && !p.closed && !p.fill) entities.push({ type: "line", a: p.pts[0], b: p.pts[1], layer });
      else entities.push({ type: "polyline", points: p.pts, ...(p.closed || p.fill ? { closed: true } : {}), layer });
    } else if (p.k === "circle") entities.push({ type: "circle", c: p.c, r: p.r, layer });
    else if (p.k === "text") {
      // DXF text height is the capitals' height; text set from its end starts its width before.
      const a = ((p.angle ?? 0) * Math.PI) / 180;
      const w = p.anchor === "end" ? textWidth(p.text, p.size, p.bold) : 0;
      const at: [number, number] = [p.at[0] - w * Math.cos(a), p.at[1] - w * Math.sin(a)];
      entities.push({ type: "text", at, height: p.size * CAP, text: p.text, ...(p.angle ? { rotation: p.angle } : {}), ...(p.anchor === "middle" ? { align: "center" as const } : {}), layer });
    }
  }
  const used = new Set(entities.map((e) => e.layer));
  return writeDxf({ entities, layers: DXF_LAYERS.filter((l) => used.has(l.name)) }, { version: opts.version ?? "R2000" });
}
