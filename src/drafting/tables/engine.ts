// The table engine (Phase Q): a DrawingTable and what the part says → rows
// (columns from the kind's catalogue, sorted, grouped, totalled) → a layout
// (column widths fitted to the text, rows split into blocks of at most
// maxRows, header at the top or the bottom) → placed on the sheet at its
// anchor → display-list primitives (src/drafting/sheet.ts), the same lines
// and text the views and annotations are drawn with, so a table looks the
// same in the app, the SVG, the PDF and the DXF.
//
// Line weights after ISO 128 / ISO 7200: the frame and the header rule 0.5,
// the rest 0.25; lettering 2.5 mm (font 3.5) in 6 mm rows, the title 3 mm.

import type { Vec2, Weld } from "../../doc/types";
import { cellText, cutColumn } from "../../weldment/columns";
import type { CutItem, CutListResult } from "../../weldment/items";
import type { NestResult } from "../../weldment/nesting";
import { boxOf, type Box, type Prim } from "../sheet";
import { CAP, LINE, textWidth } from "../text";
import { DEFAULT_COLUMNS, DEFAULT_CORNERS, DEFAULT_TITLES, tableColumn, type TableColumnDef } from "./catalogue";
import type { HoleTableRow } from "./holes";
import type { DrawingTable, RevisionRow, TableCorner } from "./types";

/** What a table reads from the part. Give what the drawing has; a table whose source is missing says so in `problems`. */
export interface TableContext {
  cutList?: CutListResult | null;
  welds?: Weld[];
  revisions?: RevisionRow[];
  /** A hole table's rows, worked out for its view and origin (src/drafting/tables/holes.ts holesInView + holeTable). */
  holes?: HoleTableRow[] | null;
  /** A cutting plan's nesting (src/weldment/nesting.ts nestCutList). */
  nesting?: NestResult[] | null;
}

export interface TableRow {
  kind: "data" | "group";
  /** The texts, one per column (a group row: one). */
  cells: string[];
  /** The values sorted by: numbers stay numbers. */
  values: (string | number)[];
  /** The item number (cut list, BOM) or tag (holes) the row stands for: balloons and hole tags link to it. */
  ref?: number | string;
  /** The value it is grouped by, when the table groups by a column it doesn't show. */
  group?: string;
}

export interface TableData {
  title: string | null;
  columns: TableColumnDef[];
  rows: TableRow[];
  totals: string[] | null;
  footer: string | null;
  /** Unknown columns, a missing source: the table is drawn with what it has. */
  problems: string[];
}

export const TABLE_STYLE = { textSize: 3.5, rowHeight: 6, titleSize: 4.2, pad: 1.5, minWidth: 8, maxWidth: 90 } as const;

/** To `digits` places, halves rounded up (0.15 → "0.2", where toFixed would write the binary "0.1"). */
const num = (x: number, digits: number) => (Number.isFinite(x) ? (Math.round(x * 10 ** digits + 1e-9) / 10 ** digits).toFixed(digits) : "");
/** "12", "12.5", "12.25": up to two places, no trailing zeros. */
const short = (x: number) => String(Math.round(x * 100) / 100 + 0);

// ------------------------------------------------------------------- rows

/** The table's rows from the part. */
export function tableData(table: DrawingTable, ctx: TableContext): TableData {
  const problems: string[] = [];
  const title = table.title === undefined ? DEFAULT_TITLES[table.kind] : table.title;
  let columns: TableColumnDef[];
  if (table.kind === "general") {
    const n = Math.max(table.header?.length ?? 0, ...(table.rows ?? []).map((r) => r.length), 1);
    const keys = table.columns?.length ? table.columns : Array.from({ length: n }, (_, i) => `c${i + 1}`);
    columns = keys.map((k) => {
      const i = Number(k.slice(1)) - 1;
      return { key: k, header: table.header?.[i] ?? "", align: "left" as const, help: "" };
    });
  } else {
    const keys = table.columns?.length ? table.columns : DEFAULT_COLUMNS[table.kind];
    columns = [];
    for (const k of keys) {
      const c = tableColumn(table.kind, k);
      if (c) columns.push(c);
      else problems.push(`${table.id}: no column "${k}" in a ${table.kind} table`);
    }
  }
  let rows: TableRow[] = [];
  let totals: string[] | null = null;
  const wantTotals = table.totals ?? (table.kind === "cutList" || table.kind === "bom");
  switch (table.kind) {
    case "cutList":
    case "bom": {
      const list = ctx.cutList;
      if (!list) {
        problems.push(`${table.id}: the part has no cut list yet (rebuild it)`);
        break;
      }
      const only = table.only?.length ? new Set(table.only.map(String)) : null;
      const items = list.items.filter((i) => !only || only.has(String(i.item)) || i.bodies.some((b) => only.has(b)));
      rows = items.map((i) => {
        const values = columns.map((c) => itemValue(table.kind as "cutList" | "bom", c.key, i));
        const g = table.group ? cutColumn(table.group) : null;
        return { kind: "data", cells: values.map((v, k) => itemText(table.kind as "cutList" | "bom", columns[k].key, v)), values, ref: i.item, ...(g ? { group: String(g.value(i)) } : {}) };
      });
      if (wantTotals && items.length) {
        totals = columns.map((c, k) => {
          if (c.key === "quantity") return String(items.reduce((n, i) => n + i.quantity, 0));
          if (c.key === "massTotal") return num(items.reduce((n, i) => n + i.massTotal, 0), 2);
          if (c.key === "areaTotal") return num(items.reduce((n, i) => n + i.areaTotal, 0) / 1e6, 3);
          return k === 0 ? "TOTAL" : "";
        });
        // "TOTAL" under the first text column (the description, usually): the item column is too narrow for it.
        const added = ["item", "quantity", "massTotal", "areaTotal", "massEach", "areaEach", "length", "width", "thickness", "plateArea"];
        const text = columns.findIndex((c) => !added.includes(c.key));
        const first = text >= 0 ? text : columns.findIndex((c) => !["quantity", "massTotal", "areaTotal"].includes(c.key));
        totals = totals.map((t) => (t === "TOTAL" ? "" : t));
        if (first >= 0) totals[first] = "TOTAL";
      }
      break;
    }
    case "holes": {
      if (!ctx.holes) {
        problems.push(`${table.id}: ${table.view ? `view "${table.view}" shows no holes as circles` : "a hole table names its view"}`);
        break;
      }
      rows = ctx.holes.map((h) => {
        const values: (string | number)[] = columns.map((c) => (c.key === "tag" ? h.tag : c.key === "x" ? h.x : c.key === "y" ? h.y : h.size));
        return { kind: "data", cells: values.map((v) => (typeof v === "number" ? short(v) : v)), values, ref: h.tag };
      });
      break;
    }
    case "welds": {
      rows = (ctx.welds ?? []).map((w) => {
        const values: (string | number)[] = columns.map((c) => weldValue(c.key, w));
        return { kind: "data", cells: values.map((v, k) => (typeof v === "number" ? (columns[k].key === "count" ? String(v) : short(v)) : v)), values, ref: w.id };
      });
      break;
    }
    case "revisions": {
      rows = (ctx.revisions ?? []).map((r) => {
        const values = columns.map((c) => String((r as unknown as Record<string, unknown>)[c.key] ?? ""));
        return { kind: "data", cells: values, values, ref: r.rev };
      });
      break;
    }
    case "stock": {
      if (!ctx.nesting) {
        problems.push(`${table.id}: the part has no members to nest`);
        break;
      }
      // Bars cut alike are one row with their count.
      for (const n of ctx.nesting) {
        const alike = new Map<string, { bar: NestResult["bars"][number]; count: number }>();
        for (const b of n.bars) {
          const key = `${b.stock}|${b.pieces.map((p) => `${p.item}:${p.length}`).join(",")}`;
          const e = alike.get(key);
          if (e) e.count++;
          else alike.set(key, { bar: b, count: 1 });
        }
        for (const { bar, count } of alike.values()) {
          const pieces = new Map<string, number>();
          for (const p of bar.pieces) pieces.set(`${p.item}|${p.length}`, (pieces.get(`${p.item}|${p.length}`) ?? 0) + 1);
          const cut = [...pieces].map(([k, q]) => {
            const [item, length] = k.split("|");
            return `${q > 1 ? `${q}× ` : ""}#${item} ${short(Number(length))}`;
          });
          const values: (string | number)[] = columns.map((c) => {
            switch (c.key) {
              case "size":
                return n.designation;
              case "stock":
                return bar.stock;
              case "bars":
                return count;
              case "cut":
                return cut.join(", ");
              case "used":
                return bar.used;
              case "offcut":
                return bar.offcut;
              default:
                return bar.wastePct;
            }
          });
          const cells = values.map((v, k) => {
            const key = columns[k].key;
            if (key === "offcut") return bar.offcut > 0 ? `${short(bar.offcut)}${bar.kept ? " KEEP" : ""}` : "-";
            if (key === "waste") return num(bar.wastePct, 1);
            return typeof v === "number" ? short(v) : v;
          });
          rows.push({ kind: "data", cells, values });
        }
      }
      if (table.totals ?? true) {
        const bars = ctx.nesting.reduce((a, n) => a + n.bars.length, 0);
        const bought = ctx.nesting.reduce((a, n) => a + n.bought, 0);
        const used = ctx.nesting.reduce((a, n) => a + n.used, 0);
        totals = columns.map((c) => (c.key === "bars" ? String(bars) : c.key === "used" ? short(used) : c.key === "waste" ? num(bought ? (ctx.nesting!.reduce((a, n) => a + n.scrap, 0) / bought) * 100 : 0, 1) : c.key === "cut" ? `BUY ${ctx.nesting!.flatMap((n) => n.buy.map((b) => `${b.count}× ${n.designation} ${b.stock}`)).join(", ")}` : ""));
      }
      break;
    }
    case "general": {
      rows = (table.rows ?? []).map((r) => {
        const values = columns.map((c) => r[Number(c.key.slice(1)) - 1] ?? "");
        return { kind: "data", cells: values, values };
      });
      break;
    }
  }
  rows = sortRows(table, columns, rows, problems);
  rows = groupRows(table, columns, rows, problems);
  return { title, columns, rows, totals, footer: table.footer ?? null, problems };
}

function itemValue(kind: "cutList" | "bom", key: string, i: CutItem): string | number {
  if (kind === "bom") {
    if (key === "part") return i.bodies.length === 1 ? i.bodies[0] : i.description;
    const c = cutColumn(key);
    return c ? c.value(i) : "";
  }
  const c = cutColumn(key);
  return c ? c.value(i) : "";
}

function itemText(kind: "cutList" | "bom", key: string, v: string | number): string {
  if (kind === "bom" && key === "part") return String(v);
  const c = cutColumn(key);
  if (!c) return String(v);
  // Lengths on a drawing: "1200", "862.5" (no ".0" on a whole number).
  if (typeof v === "number" && c.digits === 1) return short(v);
  return cellText(c, v);
}

function weldValue(key: string, w: Weld): string | number {
  switch (key) {
    case "id":
      return w.id;
    case "type":
      return w.type.toUpperCase();
    case "size":
      return w.size;
    case "length":
      return w.allRound ? "ALL ROUND" : w.length;
    case "count":
      return w.count ?? 1;
    case "side":
      return w.side === "arrow" ? "ARROW" : w.side === "other" ? "OTHER" : w.side === "both" ? "BOTH" : "";
    case "process":
      return w.process ?? "";
    case "between":
      return w.between.join(" + ");
    case "note":
      return w.note ?? "";
    default:
      return "";
  }
}

const compare = (a: string | number, b: string | number) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));

function sortRows(table: DrawingTable, columns: TableColumnDef[], rows: TableRow[], problems: string[]): TableRow[] {
  const sort = table.sort ?? [];
  const keys = sort.map((s) => ({ s, k: columns.findIndex((c) => c.key === s.column) }));
  for (const { s, k } of keys) if (k < 0) problems.push(`${table.id}: sorts by "${s.column}", which is not one of its columns`);
  const usable = keys.filter((x) => x.k >= 0);
  if (!usable.length) return rows;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      for (const { s, k } of usable) {
        const d = compare(a.r.values[k], b.r.values[k]);
        if (d) return s.descending ? -d : d;
      }
      return a.i - b.i;
    })
    .map((x) => x.r);
}

function groupRows(table: DrawingTable, columns: TableColumnDef[], rows: TableRow[], problems: string[]): TableRow[] {
  if (!table.group) return rows;
  const k = columns.findIndex((c) => c.key === table.group);
  // A cut list or BOM can group by any of its catalogue's columns, shown or not (the rows carry the value).
  if (k < 0 && !rows.every((r) => r.group !== undefined)) {
    problems.push(`${table.id}: groups by "${table.group}", which is not one of its columns`);
    return rows;
  }
  const labelOf = new Map<TableRow, string>();
  for (const r of rows) labelOf.set(r, r.group ?? String(r.values[k] ?? ""));
  const order: string[] = [];
  for (const r of rows) if (!order.includes(labelOf.get(r)!)) order.push(labelOf.get(r)!);
  const out: TableRow[] = [];
  for (const g of order) {
    out.push({ kind: "group", cells: [g || "(no group)"], values: [g] });
    out.push(...rows.filter((r) => labelOf.get(r) === g));
  }
  return out;
}

// ----------------------------------------------------------------- layout

export interface LayoutRow {
  kind: "title" | "header" | "group" | "data" | "totals" | "footer";
  cells: string[];
  ref?: number | string;
}

export interface TableBlock {
  /** Top to bottom as drawn. */
  rows: LayoutRow[];
  width: number;
  height: number;
}

export interface TableLayout {
  id: string;
  widths: number[];
  align: TableColumnDef["align"][];
  rowHeight: number;
  textSize: number;
  titleSize: number;
  boldHeader: boolean;
  rowLines: boolean;
  blocks: TableBlock[];
}

/** Column widths fitted to the text (within limits, or fixed by the table), rows split into blocks. */
export function layoutTable(table: DrawingTable, data: TableData): TableLayout {
  const textSize = table.style?.textSize ?? TABLE_STYLE.textSize;
  const rowHeight = Math.max(table.style?.rowHeight ?? TABLE_STYLE.rowHeight, textSize * 1.3);
  const titleSize = table.style?.titleSize ?? TABLE_STYLE.titleSize;
  const boldHeader = table.style?.boldHeader ?? true;
  const pad = TABLE_STYLE.pad;
  const n = Math.max(1, data.columns.length);
  const widths = Array.from({ length: n }, (_, k) => {
    const c = data.columns[k];
    const fixed = c && table.widths?.[c.key];
    if (fixed) return fixed;
    const texts = data.rows.filter((r) => r.kind === "data").map((r) => r.cells[k] ?? "");
    const w = Math.max(textWidth(c?.header ?? "", textSize, boldHeader), textWidth(data.totals?.[k] ?? "", textSize, true), ...texts.map((t) => textWidth(t, textSize))) + 2 * pad;
    return Math.min(TABLE_STYLE.maxWidth, Math.max(TABLE_STYLE.minWidth, Math.ceil(w * 2) / 2));
  });
  // The title and group rows and the footer span every column: widen the last column if one would not fit.
  const spanText = [data.title ? textWidth(data.title, titleSize, true) : 0, ...data.rows.filter((r) => r.kind === "group").map((r) => textWidth(r.cells[0], textSize, true)), data.footer ? textWidth(data.footer, textSize) : 0];
  const need = Math.max(...spanText) + 2 * pad;
  const total = widths.reduce((a, b) => a + b, 0);
  if (need > total) widths[widths.length - 1] += Math.ceil(need - total);
  const width = widths.reduce((a, b) => a + b, 0);
  const header: LayoutRow = { kind: "header", cells: data.columns.map((c) => c.header) };
  const per = table.maxRows && table.maxRows > 0 ? table.maxRows : Infinity;
  const chunks: TableRow[][] = [];
  for (let i = 0; i < data.rows.length; i += per === Infinity ? Math.max(1, data.rows.length) : per) chunks.push(data.rows.slice(i, i + (per === Infinity ? data.rows.length : per)));
  if (!chunks.length) chunks.push([]);
  const bottom = table.headerAt === "bottom";
  const blocks: TableBlock[] = chunks.map((chunk, b) => {
    const body: LayoutRow[] = chunk.map((r) => ({ kind: r.kind, cells: r.cells, ...(r.ref !== undefined ? { ref: r.ref } : {}) }));
    const last = b === chunks.length - 1;
    const totals: LayoutRow[] = last && data.totals ? [{ kind: "totals", cells: data.totals }] : [];
    const title: LayoutRow[] = b === 0 && data.title ? [{ kind: "title", cells: [data.title] }] : [];
    const footer: LayoutRow[] = last && data.footer ? [{ kind: "footer", cells: [data.footer] }] : [];
    // Header at the bottom: the rows read upward from it (item 1 just above the header).
    const rows = bottom ? [...title, ...totals, ...[...body].reverse(), header, ...footer] : [...title, header, ...body, ...totals, ...footer];
    const height = rows.reduce((h, r) => h + (r.kind === "title" ? Math.max(rowHeight, titleSize * 1.6) : rowHeight), 0);
    return { rows, width, height };
  });
  return { id: table.id, widths, align: data.columns.map((c) => c.align), rowHeight, textSize, titleSize, boldHeader, rowLines: table.style?.rowLines ?? true, blocks };
}

// -------------------------------------------------------------- placement

/** The sheet a table is placed on: its drawing frame (inside the border) and title block. */
export interface SheetFrame {
  frame: Box;
  titleBlock: Box;
}

/** Each block's box on the sheet, from the table's anchor; blocks after the first go beside it (left or right) aligned on the anchored edge. */
export function placeTable(table: DrawingTable, layout: TableLayout, sheet: SheetFrame): Box[] {
  const a = table.anchor;
  const corner: TableCorner | null = a && "at" in a ? null : (a?.corner ?? DEFAULT_CORNERS[table.kind]);
  const off: Vec2 = a && "corner" in a && a.offset ? a.offset : [0, 0];
  const { frame: F, titleBlock: T } = sheet;
  // The anchor point and which corner of the first block sits on it.
  let x: number;
  let y: number;
  let fromRight: boolean;
  let fromTop: boolean;
  if (!corner) {
    [x, y] = (a as { at: Vec2 }).at;
    fromRight = false;
    fromTop = true;
  } else {
    ({ x, y, fromRight, fromTop } = cornerPoint(corner, F, T));
  }
  x += off[0];
  y += off[1];
  const leftward = table.split ? table.split === "left" : fromRight;
  const boxes: Box[] = [];
  let cursor = x;
  for (const b of layout.blocks) {
    const x0 = leftward ? cursor - b.width : cursor;
    // The first block hangs from the anchor; the rest line up with it on the anchored edge.
    const first = boxes.length === 0;
    const x0First = fromRight ? x - b.width : x;
    const bx = first ? x0First : x0;
    const top = fromTop ? y : y + b.height;
    boxes.push({ min: [bx, top - b.height], max: [bx + b.width, top] });
    cursor = leftward ? bx : bx + b.width;
  }
  return boxes;
}

function cornerPoint(corner: TableCorner, F: Box, T: Box): { x: number; y: number; fromRight: boolean; fromTop: boolean } {
  switch (corner) {
    case "topLeft":
      return { x: F.min[0], y: F.max[1], fromRight: false, fromTop: true };
    case "topRight":
      return { x: F.max[0], y: F.max[1], fromRight: true, fromTop: true };
    case "bottomLeft":
      return { x: F.min[0], y: F.min[1], fromRight: false, fromTop: false };
    case "bottomRight":
      return { x: F.max[0], y: F.min[1], fromRight: true, fromTop: false };
    case "aboveTitleBlock":
      return { x: T.max[0], y: T.max[1], fromRight: true, fromTop: false };
    case "leftOfTitleBlock":
      return { x: T.min[0], y: T.min[1], fromRight: true, fromTop: false };
  }
}

// ------------------------------------------------------------------ draw

/** The lines and text of a placed table. Every primitive is owned by the table's id (a click on it finds the table). */
export function tablePrims(layout: TableLayout, boxes: Box[]): Prim[] {
  const out: Prim[] = [];
  const owner = layout.id;
  const pad = TABLE_STYLE.pad;
  const line = (pts: Vec2[], w: number) => out.push({ k: "line", pts, w, owner });
  layout.blocks.forEach((b, bi) => {
    const box = boxes[bi];
    if (!box) return;
    const [x0, , x1] = [box.min[0], box.min[1], box.max[0]];
    let top = box.max[1];
    const colX = layout.widths.reduce<number[]>((xs, w) => [...xs, xs[xs.length - 1] + w], [x0]);
    b.rows.forEach((r, ri) => {
      const h = r.kind === "title" ? Math.max(layout.rowHeight, layout.titleSize * 1.6) : layout.rowHeight;
      const bottom = top - h;
      const next = b.rows[ri + 1];
      // The rule under this row: heavy under the title and around the header, light between rows.
      if (next) {
        const heavy = r.kind === "title" || r.kind === "header" || next.kind === "header" || next.kind === "totals" || r.kind === "totals";
        if (heavy || layout.rowLines || next.kind === "group" || r.kind === "group" || next.kind === "footer") line([[x0, bottom], [x1, bottom]], heavy ? LINE.visible : LINE.thin);
      }
      const size = r.kind === "title" ? layout.titleSize : layout.textSize;
      const base = bottom + (h - size * CAP) / 2;
      if (r.kind === "title" || r.kind === "group" || r.kind === "footer") {
        const text = clip(r.cells[0] ?? "", x1 - x0 - 2 * pad, size, r.kind !== "footer");
        out.push({ k: "text", at: [r.kind === "title" ? (x0 + x1) / 2 : x0 + pad, base], text, size, anchor: r.kind === "title" ? "middle" : "start", ...(r.kind === "footer" ? {} : { bold: true }), owner });
      } else {
        const bold = (r.kind === "header" && layout.boldHeader) || r.kind === "totals";
        r.cells.forEach((cell, k) => {
          if (k > 0 && (r.kind !== "totals" || cell || r.cells[k - 1])) line([[colX[k], top], [colX[k], bottom]], LINE.thin);
          if (!cell) return;
          const w = layout.widths[k];
          const align = r.kind === "header" ? "center" : layout.align[k];
          const text = clip(cell, w - 2 * pad, size, bold);
          const tx = align === "left" ? colX[k] + pad : align === "right" ? colX[k] + w - pad : colX[k] + w / 2;
          out.push({ k: "text", at: [tx, base], text, size, anchor: align === "left" ? "start" : align === "right" ? "end" : "middle", ...(bold ? { bold: true } : {}), owner });
        });
      }
      top = bottom;
    });
    // The frame last, heavy.
    line([box.min, [box.max[0], box.min[1]], box.max, [box.min[0], box.max[1]], box.min], LINE.visible);
  });
  return out;
}

function clip(text: string, width: number, size: number, bold = false): string {
  if (textWidth(text, size, bold) <= width) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}...`, size, bold) > width) t = t.slice(0, -1);
  return `${t}...`;
}

export interface RenderedTable {
  data: TableData;
  layout: TableLayout;
  /** One per block. */
  boxes: Box[];
  /** Around every block. */
  box: Box | null;
  prims: Prim[];
  problems: string[];
}

/** A table, start to finish: rows, layout, placement, primitives. */
export function renderTable(table: DrawingTable, ctx: TableContext, sheet: SheetFrame): RenderedTable {
  const data = tableData(table, ctx);
  const layout = layoutTable(table, data);
  const boxes = placeTable(table, layout, sheet);
  return { data, layout, boxes, box: boxOf(boxes.flatMap((b) => [b.min, b.max])), prims: tablePrims(layout, boxes), problems: data.problems };
}

/**
 * Several tables on one sheet: each in its place, and tables that would land
 * on the same anchor stacked — above the one before for anchors on the
 * bottom, below it for anchors on the top — so two default tables never
 * overlap.
 */
export function renderSheetTables(tables: DrawingTable[], ctx: TableContext, sheet: SheetFrame): RenderedTable[] {
  const used = new Map<string, number>();
  return tables.map((t) => {
    const a = t.anchor;
    if (a && "at" in a) return renderTable(t, ctx, sheet);
    const corner = a?.corner ?? DEFAULT_CORNERS[t.kind];
    const data = tableData(t, ctx);
    const layout = layoutTable(t, data);
    const shift = used.get(corner) ?? 0;
    const bottomAnchored = corner === "aboveTitleBlock" || corner === "leftOfTitleBlock" || corner === "bottomLeft" || corner === "bottomRight";
    const off: Vec2 = [a?.offset?.[0] ?? 0, (a?.offset?.[1] ?? 0) + (bottomAnchored ? shift : -shift)];
    const placed: DrawingTable = { ...t, anchor: { corner, offset: off } };
    const boxes = placeTable(placed, layout, sheet);
    const height = Math.max(...boxes.map((b) => b.max[1] - b.min[1]));
    used.set(corner, shift + height);
    return { data, layout, boxes, box: boxOf(boxes.flatMap((b) => [b.min, b.max])), prims: tablePrims(layout, boxes), problems: data.problems };
  });
}
