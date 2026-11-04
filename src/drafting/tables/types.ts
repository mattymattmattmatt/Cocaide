// Tables on a drawing sheet (Phase Q, wave Q1B): the data a table is stored
// as. A table lives on its sheet (DrawingSheet.tables, wave Q1A); what it
// lists is always read from the part — the cut list, the bodies, the holes
// in a view, the weld table, the drawing's revisions — except a "general"
// table, whose cells are typed. Every field but id and kind is optional:
// a bare { id, kind } is the kind's standard table, placed where that kind
// usually goes.

import type { Vec2 } from "../../doc/types";

/** "stock": the cutting plan — each bar pattern with its pieces, offcut and waste, and the bars to buy (src/weldment/nesting.ts). */
export const TABLE_KINDS = ["cutList", "bom", "holes", "welds", "revisions", "general", "stock"] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

/**
 * Where a table sits. A corner of the drawing frame (inside the border), or
 * against the title block: above it (its right edges in line) or to its left
 * (its bottom edges in line). `offset` moves it from there, mm (x right, y up).
 */
export const TABLE_CORNERS = ["topLeft", "topRight", "bottomLeft", "bottomRight", "aboveTitleBlock", "leftOfTitleBlock"] as const;
export type TableCorner = (typeof TABLE_CORNERS)[number];

/** A corner, or free: `at` is the table's top-left corner on the sheet (mm from the sheet's lower left, y up). */
export type TableAnchor = { corner: TableCorner; offset?: Vec2 } | { at: Vec2 };

export interface TableStyle {
  /** Font size of the cells, mm (default 3.5: ISO 3098 lettering 2.5 mm high). */
  textSize?: number;
  /** Row height, mm (default 6). */
  rowHeight?: number;
  /** Font size of the title row, mm (default 4.2). */
  titleSize?: number;
  /** Column headings in bold (default true). */
  boldHeader?: boolean;
  /** Draw a line under every row (default true); false draws only the frame, the header rule and column lines. */
  rowLines?: boolean;
}
export const TABLE_STYLE_KEYS = ["textSize", "rowHeight", "titleSize", "boldHeader", "rowLines"] as const;

export interface TableSort {
  column: string;
  descending?: boolean;
}

export interface DrawingTable {
  /** Unique on the drawing, like "t1" or "cutlist". */
  id: string;
  kind: TableKind;
  /** The title row ("CUT LIST"); null for none. Default: the kind's name in capitals. */
  title?: string | null;
  /** Column keys from the kind's catalogue (src/drafting/tables/catalogue.ts), in order; "prop:<name>" adds a custom property column (cut list, BOM). Default: the kind's standard columns. */
  columns?: string[];
  /** Fixed widths by column key, mm; others fit their contents. */
  widths?: Record<string, number>;
  /** Sort by these columns, first first. Default: by item number, tag, weld id or revision. */
  sort?: TableSort[];
  /** A column to group rows by: a heading row before each group ("Frame", "Bracing"). */
  group?: string;
  /** At most this many rows in one block; more continue in a second block beside it, with the header again. */
  maxRows?: number;
  /** Where further blocks go: "left" (default for tables on the right of the sheet) or "right". */
  split?: "left" | "right";
  /** Column headings at the top (default), or at the bottom with rows growing upward (a parts list above a title block, ISO 7200). */
  headerAt?: "top" | "bottom";
  /** A totals row: quantity, mass and paint area added up (cut list and BOM; default true for them). */
  totals?: boolean;
  /** A note row under the table ("ALL LENGTHS IN mm"). */
  footer?: string;
  anchor?: TableAnchor;
  style?: TableStyle;
  /** Holes: the view whose holes it lists (those it sees as circles). */
  view?: string;
  /** Holes: the point X and Y are measured from, a GeoRef on the view (wave Q1A) or one of the view outline's corners: "@lowerLeft" (default), "@upperLeft", "@lowerRight", "@upperRight". */
  origin?: string;
  /** Cut list and BOM: only these items (by number) or bodies. */
  only?: (number | string)[];
  /** General: the column headings and the cells, typed. */
  header?: string[];
  rows?: string[][];
}

export const TABLE_KEYS = ["id", "kind", "title", "columns", "widths", "sort", "group", "maxRows", "split", "headerAt", "totals", "footer", "anchor", "style", "view", "origin", "only", "header", "rows"] as const;

/** A revision as a revision table lists it. The drawing's revisions (Drawing.revisions, wave Q1A) read as these. */
export interface RevisionRow {
  rev: string;
  description?: string;
  date?: string;
  by?: string;
  approved?: string;
  zone?: string;
}
