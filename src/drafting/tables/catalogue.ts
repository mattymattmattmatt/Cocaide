// Each table kind's columns (Phase Q): what a column is called on the sheet,
// how it is aligned, and the kind's standard columns, title and place. The
// cut list's come from the cut list's own catalogue (src/weldment/columns.ts)
// so the panel, the exports and the sheet agree.

import { CUT_COLUMNS, cutColumn, DEFAULT_SHEET_CUT_COLUMNS } from "../../weldment/columns";
import type { TableCorner, TableKind } from "./types";

export interface TableColumnDef {
  key: string;
  /** The heading on the sheet. */
  header: string;
  align: "left" | "right" | "center";
  /** What it shows, for the reference and the column picker. */
  help: string;
}

const col = (key: string, header: string, align: TableColumnDef["align"], help: string): TableColumnDef => ({ key, header, align, help });

/** Centred: the item number and the end angles ("45°", "square"). */
const CENTRED = new Set(["item", "angle1", "angle2"]);
const cutListColumns: TableColumnDef[] = CUT_COLUMNS.map((c) => col(c.key, c.header, CENTRED.has(c.key) ? "center" : c.numeric ? "right" : "left", c.help));

export const TABLE_COLUMNS: Record<TableKind, TableColumnDef[]> = {
  cutList: cutListColumns,
  bom: [
    col("item", "ITEM", "center", "the item number (the cut list's numbering: balloons show it)"),
    col("quantity", "QTY", "right", "how many"),
    col("part", "PART", "left", "the body's name (or the bodies')"),
    col("description", "DESCRIPTION", "left", "the cut list item's description"),
    col("material", "MATERIAL", "left", "the material"),
    col("grade", "GRADE", "left", "the material's grade"),
    col("finish", "FINISH", "left", "the finish"),
    col("massEach", "KG EA", "right", "mass of one, kg"),
    col("massTotal", "KG", "right", "mass of all, kg"),
    col("notes", "NOTES", "left", "notes"),
  ],
  holes: [
    col("tag", "TAG", "center", "A1, A2 ... by size, smallest first"),
    col("x", "X", "right", "from the origin, along the view"),
    col("y", "Y", "right", "from the origin, up the view"),
    col("size", "SIZE", "left", "from the hole feature: Ø6.6 THRU, M6×1 - 6H"),
  ],
  welds: [
    col("id", "WELD", "center", "the weld's id"),
    col("type", "TYPE", "left", "fillet, butt, plug"),
    col("size", "SIZE", "right", "leg or throat, mm"),
    col("length", "LENGTH", "right", "mm (ALL ROUND when welded all round)"),
    col("count", "QTY", "right", "how many alike welds"),
    col("side", "SIDE", "left", "arrow side, other side, both"),
    col("process", "PROCESS", "left", "135 MAG, 141 TIG ..."),
    col("between", "BETWEEN", "left", "the bodies it joins"),
    col("note", "NOTE", "left", "the weld's note"),
  ],
  revisions: [
    col("rev", "REV", "center", "the revision letter or number"),
    col("zone", "ZONE", "center", "where on the sheet"),
    col("description", "DESCRIPTION", "left", "what changed"),
    col("date", "DATE", "center", "when"),
    col("by", "BY", "center", "who made it"),
    col("approved", "APPD", "center", "who approved it"),
  ],
  general: [],
  stock: [
    col("size", "SIZE", "left", "the profile size"),
    col("stock", "BAR", "right", "the stock bar's length, mm"),
    col("bars", "QTY", "right", "how many bars are cut this way"),
    col("cut", "CUT", "left", "the pieces, by item and length: 1×1200, 2×860"),
    col("used", "USED", "right", "the pieces' length, mm"),
    col("offcut", "OFFCUT", "right", "what is left, mm (KEEP when long enough to keep)"),
    col("waste", "WASTE %", "right", "scrap as a share of the bar"),
  ],
};

export const DEFAULT_COLUMNS: Record<TableKind, string[]> = {
  cutList: DEFAULT_SHEET_CUT_COLUMNS,
  bom: ["item", "quantity", "part", "description", "material", "massTotal"],
  holes: ["tag", "x", "y", "size"],
  welds: ["id", "type", "size", "length", "count", "process"],
  revisions: ["rev", "description", "date", "by", "approved"],
  general: [],
  stock: ["size", "stock", "bars", "cut", "offcut", "waste"],
};

export const DEFAULT_TITLES: Record<TableKind, string | null> = {
  cutList: "CUT LIST",
  bom: "PARTS LIST",
  holes: "HOLE TABLE",
  welds: "WELD TABLE",
  revisions: "REVISIONS",
  general: null,
  stock: "CUTTING PLAN",
};

/** Where each kind goes when its table names no anchor. */
export const DEFAULT_CORNERS: Record<TableKind, TableCorner> = {
  cutList: "aboveTitleBlock",
  bom: "aboveTitleBlock",
  holes: "topLeft",
  welds: "leftOfTitleBlock",
  revisions: "topRight",
  general: "topLeft",
  stock: "topLeft",
};

/** A column of a kind by key, custom property columns included ("prop:Supplier" on a cut list or BOM). Null when the kind has no such column. */
export function tableColumn(kind: TableKind, key: string): TableColumnDef | null {
  if (key.startsWith("prop:") && (kind === "cutList" || kind === "bom")) {
    const c = cutColumn(key);
    return c ? col(key, c.header, "left", c.help) : null;
  }
  if (kind === "general") return /^c\d+$/.test(key) ? col(key, "", "left", "a typed column") : null;
  return TABLE_COLUMNS[kind].find((c) => c.key === key) ?? null;
}
