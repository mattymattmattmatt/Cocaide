// Placeholder for the drawing's tables (wave Q1B replaces this file): a
// table on a sheet, by kind ("cutList", "bom", "holes", "welds",
// "revisions", "general" ...), with its anchor. The sheet keeps them in
// DrawingSheet.tables.

import type { Vec2 } from "../../doc/types";

export interface DrawingTable {
  id: string;
  kind: string;
  at?: Vec2;
  [k: string]: unknown;
}
