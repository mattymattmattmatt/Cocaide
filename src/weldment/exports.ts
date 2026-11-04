// The cut list out of the app (Phase Q): CSV with the chosen columns, an
// XLSX workbook (cut list, stock buy list, cutting plan, plates, welds) and a
// print-friendly cutting plan page. Pure: strings and bytes.

import type { Weld } from "../doc/types";
import { cellText, cutColumn, type CutColumn } from "./columns";
import type { CutListResult } from "./items";
import type { NestResult } from "./nesting";
import { writeXlsx, type XlsxCell, type XlsxSheet, type XlsxStyle } from "./xlsx";

export interface ExportMeta {
  /** The part's name, number, description, revision: the header rows (src/doc/properties.ts csvHeaderRows). */
  header?: string[][];
  title?: string;
  author?: string;
  date?: Date;
}

function columnsOf(keys: string[]): CutColumn[] {
  return keys.map(cutColumn).filter((c): c is CutColumn => !!c);
}

/** The cut list as CSV: header rows, a blank row, then the chosen columns and a totals row. */
export function cutListCsvV2(list: CutListResult, keys: string[], meta: ExportMeta = {}): string {
  const cols = columnsOf(keys);
  const header = meta.header ?? [];
  const rows: string[][] = [...header, ...(header.length ? [[]] : []), cols.map((c) => c.label)];
  for (const i of list.items) rows.push(cols.map((c) => cellText(c, c.value(i))));
  rows.push(cols.map((c) => totalCell(list, c)));
  return csv(rows);
}

/** A totals row's cell: the quantity, the mass and the paint area added up; "Total" under the first text column. */
function totalCell(list: CutListResult, c: CutColumn): string {
  if (c.key === "quantity") return String(list.totals.quantity);
  if (c.key === "massTotal") return list.totals.massKg.toFixed(2);
  if (c.key === "areaTotal") return list.totals.paintArea.toFixed(3);
  if (c.key === "item") return "Total";
  return "";
}

export function csv(rows: string[][]): string {
  return rows.map((r) => r.map((f) => (/[",\n\r]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(",")).join("\r\n") + "\r\n";
}

const styleFor = (c: CutColumn): XlsxStyle | undefined => (c.digits === 0 ? "int" : c.digits === 1 ? "dec1" : c.digits === 2 ? "dec2" : c.digits !== undefined ? "dec3" : undefined);

/** The workbook: Cut list, Stock (buy list), Cutting plan, Plates, Welds. */
export function cutListXlsx(list: CutListResult, nesting: NestResult[], welds: Weld[], keys: string[], meta: ExportMeta = {}): Uint8Array {
  const cols = columnsOf(keys);
  const header = meta.header ?? [];
  const top: XlsxCell[][] = [[{ v: meta.title ?? "Cut list", style: "title" }], ...header.map((r) => r.map((x, k) => (k === 0 ? { v: x, style: "bold" as const } : x))), []];
  const cutRows: XlsxCell[][] = [
    ...top,
    cols.map((c) => ({ v: c.label, style: "header" as const })),
    ...list.items.map((i) =>
      cols.map((c): XlsxCell => {
        const v = c.value(i);
        const s = styleFor(c);
        return typeof v === "number" && s ? { v, style: s } : v;
      }),
    ),
    cols.map((c) => {
      const t = totalCell(list, c);
      if (!t) return { v: "", style: "total" as const };
      return c.key === "item" ? { v: t, style: "total" as const } : { v: Number(t), style: c.key === "areaTotal" ? ("totalDec3" as const) : c.key === "massTotal" ? ("totalDec2" as const) : ("total" as const) };
    }),
  ];
  const widths = cols.map((c) => Math.max(c.label.length + 2, ...list.items.map((i) => cellText(c, c.value(i)).length + 1), c.numeric ? 8 : 10));
  const sheets: XlsxSheet[] = [{ name: "Cut list", rows: cutRows, widths, freeze: top.length + 1 }];

  const buy: XlsxCell[][] = [
    [{ v: "Stock buy list", style: "title" }],
    [],
    ["Size", "Stock length (mm)", "Bars", "Pieces", "Bought (m)", "Used (m)", "Offcuts kept (m)", "Scrap %", "Kerf (mm)"].map((v) => ({ v, style: "header" as const })),
  ];
  for (const r of nesting) {
    for (const b of r.buy) {
      const pieces = r.bars.filter((x) => x.stock === b.stock).reduce((n, x) => n + x.pieces.length, 0);
      const used = r.bars.filter((x) => x.stock === b.stock).reduce((n, x) => n + x.used, 0);
      const kept = r.bars.filter((x) => x.stock === b.stock && x.kept).reduce((n, x) => n + x.offcut, 0);
      const bought = b.stock * b.count;
      buy.push([r.designation, { v: b.stock, style: "int" }, { v: b.count, style: "int" }, { v: pieces, style: "int" }, { v: bought / 1000, style: "dec3" }, { v: used / 1000, style: "dec3" }, { v: kept / 1000, style: "dec3" }, { v: bought ? ((bought - used - kept) / bought) * 100 : 0, style: "dec1" }, { v: r.options.kerf, style: "dec1" }]);
    }
    for (const p of r.tooLong) buy.push([r.designation, "too long for any bar", "", "", "", "", "", "", "", `item ${p.item}: ${p.length} mm`]);
  }
  sheets.push({ name: "Stock", rows: buy, widths: [22, 18, 8, 8, 12, 12, 16, 10, 10, 30], freeze: 3 });

  const plan: XlsxCell[][] = [[{ v: "Cutting plan", style: "title" }], [], ["Size", "Bar", "Stock (mm)", "Cut (item × length)", "Pieces (mm)", "Offcut (mm)", "Offcut", "Waste %"].map((v) => ({ v, style: "header" as const }))];
  for (const r of nesting) {
    r.bars.forEach((b, k) => {
      plan.push([r.designation, { v: k + 1, style: "int" }, { v: b.stock, style: "int" }, b.pieces.map((p) => `#${p.item} ${trim1(p.length)}`).join(" | "), { v: b.used, style: "dec1" }, { v: b.offcut, style: "dec1" }, b.kept ? "keep" : b.offcut > 0 ? "scrap" : "", { v: b.wastePct, style: "dec1" }]);
    });
  }
  sheets.push({ name: "Cutting plan", rows: plan, widths: [22, 6, 12, 60, 12, 12, 8, 10], freeze: 3 });

  if (list.totals.plates.length) {
    const plates: XlsxCell[][] = [[{ v: "Plates", style: "title" }], [], ["Thickness (mm)", "Material", "Pieces", "Area (m²)", "kg"].map((v) => ({ v, style: "header" as const }))];
    for (const p of list.totals.plates) plates.push([{ v: p.thickness, style: "dec1" }, p.material, { v: p.pieces, style: "int" }, { v: p.area / 1e6, style: "dec3" }, { v: p.massKg, style: "dec2" }]);
    sheets.push({ name: "Plates", rows: plates, widths: [16, 30, 8, 12, 10], freeze: 3 });
  }
  if (welds.length) {
    const rows: XlsxCell[][] = [[{ v: "Welds", style: "title" }], [], ["Weld", "Between", "Type", "Size (mm)", "Length (mm)", "Count", "Side", "Process", "All round", "Note"].map((v) => ({ v, style: "header" as const }))];
    for (const w of welds) rows.push([w.id, w.between.join(" + "), w.type, { v: w.size, style: "dec1" }, { v: w.length, style: "dec1" }, { v: w.count ?? 1, style: "int" }, w.side ?? "", w.process ?? "", w.allRound ? "yes" : "", w.note ?? ""]);
    sheets.push({ name: "Welds", rows, widths: [8, 30, 10, 10, 12, 8, 8, 14, 10, 30], freeze: 3 });
  }
  return writeXlsx(sheets, { title: meta.title, author: meta.author, date: meta.date });
}

const trim1 = (x: number) => String(Math.round(x * 10) / 10);

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A print-friendly cutting plan: a page with the stock buy list and, per
 * size, each bar drawn to scale with its pieces (item and length), kerfs,
 * the offcut and the waste. Opened in a new window and printed.
 */
export function cuttingPlanHtml(list: CutListResult, nesting: NestResult[], meta: ExportMeta = {}): string {
  const head = (meta.header ?? []).map((r) => `<div><b>${esc(r[0] ?? "")}</b> ${esc(r.slice(1).join(" "))}</div>`).join("");
  const sizes = nesting
    .map((r) => {
      const bars = r.bars.map((b, k) => `<div class="bar"><div class="bar-head"><b>Bar ${k + 1}</b> · ${b.stock} mm · ${b.pieces.length} piece${b.pieces.length === 1 ? "" : "s"} · offcut ${trim1(b.offcut)} mm${b.kept ? " (keep)" : ""} · waste ${b.wastePct.toFixed(1)}%</div>${barSvg(b.stock, b.pieces, r.options.kerf, r.options.trim, b.offcut, b.kept)}</div>`).join("");
      const tooLong = r.tooLong.length ? `<p class="warn">Too long for any bar: ${r.tooLong.map((p) => `item ${p.item} (${trim1(p.length)} mm)`).join(", ")}</p>` : "";
      return `<section><h2>${esc(r.designation)}</h2><p class="muted">Buy ${r.buy.map((b) => `${b.count} × ${b.stock} mm`).join(" + ")} · kerf ${r.options.kerf} mm${r.options.trim ? ` · trim ${r.options.trim} mm each end` : ""} · waste ${r.wastePct.toFixed(1)}%</p>${tooLong}${bars}</section>`;
    })
    .join("");
  const buyRows = nesting.flatMap((r) => r.buy.map((b) => `<tr><td>${esc(r.designation)}</td><td class="num">${b.stock}</td><td class="num">${b.count}</td></tr>`)).join("");
  const items = list.items
    .filter((i) => i.kind === "member")
    .map((i) => `<tr><td class="num">${i.item}</td><td class="num">${i.quantity}</td><td>${esc(i.description)}</td><td class="num">${trim1(i.length)}</td><td>${esc(i.endsText)}</td></tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.title ?? "Cutting plan")}</title><style>
body{font:12px/1.4 Helvetica,Arial,sans-serif;color:#111;margin:16mm}h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 2px;border-bottom:1.5px solid #222;padding-bottom:2px}
.muted{color:#555;margin:2px 0 8px}.warn{color:#b00}table{border-collapse:collapse;margin:6px 0 10px}td,th{border:0.6px solid #888;padding:2px 6px;text-align:left}th{background:#eef1f4}.num{text-align:right;font-variant-numeric:tabular-nums}
.bar{margin:4px 0 10px;break-inside:avoid}.bar-head{font-size:11px;margin-bottom:2px}.head{display:flex;gap:24px;margin-bottom:8px}.cols{display:flex;gap:28px;align-items:flex-start}
@media print{body{margin:10mm}button{display:none}}</style></head><body><button onclick="print()" style="float:right">Print</button><h1>${esc(meta.title ?? "Cutting plan")}</h1><div class="head">${head}</div>
<div class="cols"><div><h2>Stock buy list</h2><table><tr><th>Size</th><th>Length (mm)</th><th>Bars</th></tr>${buyRows}</table></div><div><h2>Pieces</h2><table><tr><th>Item</th><th>Qty</th><th>Description</th><th>Length</th><th>Ends</th></tr>${items}</table></div></div>${sizes}</body></html>`;
}

/** One bar to scale as SVG: pieces labelled with item and length, kerf gaps, the offcut hatched (kept) or grey (scrap). */
export function barSvg(stock: number, pieces: { item: number; length: number }[], kerf: number, trim: number, offcut: number, kept: boolean, width = 680, fluid = false): string {
  const k = width / stock;
  const h = 26;
  const parts: string[] = [];
  let x = trim;
  if (trim > 0) parts.push(`<rect x="0" y="0" width="${(trim * k).toFixed(2)}" height="${h}" fill="#bbb"/>`);
  const colours = ["#dbe7f5", "#e3f0dc", "#f6e7d3", "#eadcf2", "#f3dde1", "#d9f0ee"];
  pieces.forEach((p, i) => {
    const w = p.length * k;
    parts.push(`<rect x="${(x * k).toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${h}" fill="${colours[p.item % colours.length]}" stroke="#333" stroke-width="0.8"/>`);
    if (w > 46) parts.push(`<text x="${(x * k + w / 2).toFixed(2)}" y="11" text-anchor="middle" font-size="10" font-weight="bold">#${p.item}</text><text x="${(x * k + w / 2).toFixed(2)}" y="22" text-anchor="middle" font-size="9.5">${trim1(p.length)}</text>`);
    else if (w > 16) parts.push(`<text x="${(x * k + w / 2).toFixed(2)}" y="17" text-anchor="middle" font-size="9" font-weight="bold">${p.item}</text>`);
    x += p.length + (i < pieces.length - 1 || offcut > 0 ? kerf : 0);
  });
  if (offcut > 0) {
    const ox = (stock - trim - offcut) * k;
    const w = offcut * k;
    parts.push(`<rect x="${ox.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${h}" fill="${kept ? "url(#keep)" : "#e2e2e2"}" stroke="#777" stroke-width="0.6" stroke-dasharray="3 2"/>`);
    if (w > 40) parts.push(`<text x="${(ox + w / 2).toFixed(2)}" y="17" text-anchor="middle" font-size="9" fill="#444">${trim1(offcut)}${kept ? " keep" : ""}</text>`);
  }
  if (trim > 0) parts.push(`<rect x="${((stock - trim) * k).toFixed(2)}" y="0" width="${(trim * k).toFixed(2)}" height="${h}" fill="#bbb"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" ${fluid ? `width="100%"` : `width="${width}" height="${h + 1}"`} viewBox="0 0 ${width} ${h + 1}" font-family="Helvetica, Arial, sans-serif"><defs><pattern id="keep" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#f4f4f4"/><line x1="0" y1="0" x2="0" y2="6" stroke="#9aa" stroke-width="2"/></pattern></defs><rect x="0.5" y="0.5" width="${width - 1}" height="${h}" fill="none" stroke="#222" stroke-width="1"/>${parts.join("")}</svg>`;
}
