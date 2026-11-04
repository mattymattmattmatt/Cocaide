// A sheet's tables, checked strictly (Phase Q): every field, with messages
// that say what the field must be. Wave Q1A calls this from the drawing's
// validation for DrawingSheet.tables; commands that add or change a table
// call it too.

import { TABLE_COLUMNS, tableColumn } from "./catalogue";
import { OUTLINE_ORIGINS } from "./holes";
import { TABLE_CORNERS, TABLE_KEYS, TABLE_KINDS, TABLE_STYLE_KEYS, type DrawingTable, type TableAnchor } from "./types";

const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const describe = (v: unknown) => (v === undefined ? "nothing" : JSON.stringify(v));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x));

export interface TableCheckContext {
  /** The views on the table's sheet (a hole table names one). */
  views?: string[];
}

/** One table. `path` prefixes each message ("drawing.sheets[0].tables[1]"). */
export function checkDrawingTable(raw: unknown, path: string, ctx: TableCheckContext = {}): { table: DrawingTable | null; errors: string[] } {
  const errors: string[] = [];
  const fail = (field: string, msg: string) => errors.push(`${path}${field ? `.${field}` : ""}: ${msg}`);
  if (!isObject(raw)) {
    fail("", `must be a table: { "id": "t1", "kind": "cutList" } (got ${describe(raw)})`);
    return { table: null, errors };
  }
  for (const k of Object.keys(raw)) if (!(TABLE_KEYS as readonly string[]).includes(k)) fail("", `unknown field "${k}" (allowed: ${TABLE_KEYS.join(", ")})`);
  if (typeof raw.id !== "string" || !ID.test(raw.id)) fail("id", `must be an identifier like "t1" (got ${describe(raw.id)})`);
  if (!TABLE_KINDS.includes(raw.kind as never)) {
    fail("kind", `must be ${TABLE_KINDS.map((k) => `"${k}"`).join(", ")} (got ${describe(raw.kind)})`);
    return { table: null, errors };
  }
  const kind = raw.kind as DrawingTable["kind"];
  if (raw.title !== undefined && raw.title !== null && (typeof raw.title !== "string" || raw.title.length > 120)) fail("title", `must be text up to 120 characters, or null for no title row (got ${describe(raw.title)})`);
  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns) || raw.columns.length === 0 || raw.columns.length > 30) fail("columns", `must list 1 to 30 column keys (got ${describe(raw.columns)})`);
    else
      raw.columns.forEach((c, i) => {
        if (typeof c !== "string" || !tableColumn(kind, c))
          fail(`columns[${i}]`, kind === "general" ? `must be "c1", "c2" ... (got ${describe(c)})` : `no column ${describe(c)} in a ${kind} table (columns: ${TABLE_COLUMNS[kind].map((x) => x.key).join(", ")}${kind === "cutList" || kind === "bom" ? `, or "prop:<name>" for a custom property` : ""})`);
      });
  }
  if (raw.widths !== undefined) {
    if (!isObject(raw.widths)) fail("widths", `must be an object of column key: width in mm (got ${describe(raw.widths)})`);
    else for (const [k, w] of Object.entries(raw.widths)) if (typeof w !== "number" || !(w >= 4 && w <= 200)) fail(`widths.${k}`, `must be 4 to 200 mm (got ${describe(w)})`);
  }
  if (raw.sort !== undefined) {
    if (!Array.isArray(raw.sort)) fail("sort", `must be a list like [{ "column": "length", "descending": true }] (got ${describe(raw.sort)})`);
    else
      raw.sort.forEach((s, i) => {
        if (!isObject(s) || typeof s.column !== "string" || !tableColumn(kind, s.column)) fail(`sort[${i}]`, `must be { "column": <one of the table's columns>, "descending"?: true } (got ${describe(s)})`);
        else {
          for (const k of Object.keys(s)) if (k !== "column" && k !== "descending") fail(`sort[${i}]`, `unknown field "${k}" (allowed: column, descending)`);
          if (s.descending !== undefined && typeof s.descending !== "boolean") fail(`sort[${i}].descending`, `must be true or false (got ${describe(s.descending)})`);
        }
      });
  }
  if (raw.group !== undefined && (typeof raw.group !== "string" || !tableColumn(kind, raw.group))) fail("group", `must be a column key of a ${kind} table (got ${describe(raw.group)})`);
  if (raw.maxRows !== undefined && (typeof raw.maxRows !== "number" || !Number.isInteger(raw.maxRows) || raw.maxRows < 1 || raw.maxRows > 200)) fail("maxRows", `must be a whole number from 1 to 200 (got ${describe(raw.maxRows)})`);
  if (raw.split !== undefined && raw.split !== "left" && raw.split !== "right") fail("split", `must be "left" or "right" (got ${describe(raw.split)})`);
  if (raw.headerAt !== undefined && raw.headerAt !== "top" && raw.headerAt !== "bottom") fail("headerAt", `must be "top" or "bottom" (got ${describe(raw.headerAt)})`);
  if (raw.totals !== undefined && typeof raw.totals !== "boolean") fail("totals", `must be true or false (got ${describe(raw.totals)})`);
  if (raw.footer !== undefined && (typeof raw.footer !== "string" || !raw.footer.trim() || raw.footer.length > 200)) fail("footer", `must be text, 1 to 200 characters (got ${describe(raw.footer)})`);
  if (raw.anchor !== undefined) checkAnchor(raw.anchor, fail);
  if (raw.style !== undefined) {
    if (!isObject(raw.style)) fail("style", `must be an object: ${TABLE_STYLE_KEYS.join(", ")} (got ${describe(raw.style)})`);
    else {
      const st = raw.style;
      for (const k of Object.keys(st)) if (!(TABLE_STYLE_KEYS as readonly string[]).includes(k)) fail("style", `unknown field "${k}" (allowed: ${TABLE_STYLE_KEYS.join(", ")})`);
      const range = (k: string, lo: number, hi: number) => st[k] !== undefined && (typeof st[k] !== "number" || !((st[k] as number) >= lo && (st[k] as number) <= hi)) && fail(`style.${k}`, `must be ${lo} to ${hi} mm (got ${describe(st[k])})`);
      range("textSize", 1.8, 10);
      range("rowHeight", 3, 20);
      range("titleSize", 1.8, 14);
      for (const k of ["boldHeader", "rowLines"]) if (st[k] !== undefined && typeof st[k] !== "boolean") fail(`style.${k}`, `must be true or false (got ${describe(st[k])})`);
    }
  }
  if (kind === "holes") {
    if (typeof raw.view !== "string" || !raw.view) fail("view", `a hole table names the view whose holes it lists (got ${describe(raw.view)})`);
    else if (ctx.views && !ctx.views.includes(raw.view)) fail("view", `no view "${raw.view}" on the sheet (views: ${ctx.views.join(", ") || "none"})`);
    if (raw.origin !== undefined && (typeof raw.origin !== "string" || !raw.origin)) fail("origin", `must be ${OUTLINE_ORIGINS.map((o) => `"${o}"`).join(", ")} or a point on the view (got ${describe(raw.origin)})`);
  } else {
    if (raw.view !== undefined) fail("view", `only a hole table names a view`);
    if (raw.origin !== undefined) fail("origin", `only a hole table has an origin`);
  }
  if (raw.only !== undefined) {
    if (kind !== "cutList" && kind !== "bom") fail("only", "only a cut list or BOM lists some items");
    else if (!Array.isArray(raw.only) || raw.only.length === 0 || raw.only.some((x) => !(typeof x === "string" ? x : Number.isInteger(x) && (x as number) > 0))) fail("only", `must list item numbers or body names (got ${describe(raw.only)})`);
  }
  if (kind === "general") {
    if (raw.header !== undefined && (!Array.isArray(raw.header) || raw.header.some((h) => typeof h !== "string") || raw.header.length > 30)) fail("header", `must be a list of up to 30 column headings (got ${describe(raw.header)})`);
    if (raw.rows === undefined || !Array.isArray(raw.rows) || raw.rows.some((r) => !Array.isArray(r) || r.some((c) => typeof c !== "string" || c.length > 200)) || raw.rows.length > 200)
      fail("rows", `a general table's cells: a list of up to 200 rows, each a list of texts (got ${describe(raw.rows)})`);
  } else {
    if (raw.header !== undefined) fail("header", "only a general table has typed headings; the others' come from their columns");
    if (raw.rows !== undefined) fail("rows", "only a general table has typed rows; the others' are read from the part");
  }
  return { table: errors.length ? null : (structuredClone(raw) as unknown as DrawingTable), errors };
}

function checkAnchor(a: unknown, fail: (field: string, msg: string) => void): void {
  const want = `must be { "corner": ${TABLE_CORNERS.map((c) => `"${c}"`).join(" | ")}, "offset"?: [x, y] } or { "at": [x, y] } (the top-left corner on the sheet, mm)`;
  if (!isObject(a)) return fail("anchor", `${want} (got ${describe(a)})`);
  const x = a as Partial<Record<keyof TableAnchor | "corner" | "offset" | "at", unknown>>;
  if ("at" in x) {
    if (Object.keys(x).length !== 1 || !isPoint(x.at)) fail("anchor", `${want} (got ${describe(a)})`);
    return;
  }
  for (const k of Object.keys(x)) if (k !== "corner" && k !== "offset") fail("anchor", `unknown field "${k}" (allowed: corner, offset; or at)`);
  if (!TABLE_CORNERS.includes(x.corner as never)) fail("anchor.corner", `must be ${TABLE_CORNERS.map((c) => `"${c}"`).join(", ")} (got ${describe(x.corner)})`);
  if (x.offset !== undefined && !isPoint(x.offset)) fail("anchor.offset", `must be [x, y] in mm (got ${describe(x.offset)})`);
}

/** A sheet's tables: a list, each checked, ids unique. */
export function checkDrawingTables(raw: unknown, path: string, ctx: TableCheckContext = {}): { tables: DrawingTable[]; errors: string[] } {
  if (!Array.isArray(raw)) return { tables: [], errors: [`${path}: must be a list of tables (got ${describe(raw)})`] };
  const errors: string[] = [];
  const tables: DrawingTable[] = [];
  const ids = new Set<string>();
  raw.forEach((t, i) => {
    const r = checkDrawingTable(t, `${path}[${i}]`, ctx);
    errors.push(...r.errors);
    if (!r.table) return;
    if (ids.has(r.table.id)) errors.push(`${path}[${i}].id: duplicate table id "${r.table.id}"`);
    else {
      ids.add(r.table.id);
      tables.push(r.table);
    }
  });
  return { tables, errors };
}

/**
 * A table added, replaced or removed (null) by id: what a `setTable` command
 * does to a sheet's tables. Returns the new list or the reason it can't.
 */
export function setTableIn(tables: DrawingTable[], id: string, table: Record<string, unknown> | null, ctx: TableCheckContext = {}): { ok: true; tables: DrawingTable[] } | { ok: false; error: string } {
  const i = tables.findIndex((t) => t.id === id);
  if (table === null) {
    if (i < 0) return { ok: false, error: `no table "${id}" (tables: ${tables.map((t) => t.id).join(", ") || "none"})` };
    return { ok: true, tables: tables.filter((t) => t.id !== id) };
  }
  const r = checkDrawingTable({ ...table, id }, `table "${id}"`, ctx);
  if (!r.table) return { ok: false, error: r.errors.join("; ") };
  const next = [...tables];
  if (i < 0) next.push(r.table);
  else next[i] = r.table;
  return { ok: true, tables: next };
}
