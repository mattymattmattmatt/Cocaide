// The Tables and Sheet Format tools (Phase Q wave Q2B): each opens its
// dialog in the workspace — insert a table of a kind (its columns from the
// table engine's catalogue, custom property columns, where it goes), the
// sheet's format and title block, the drawing's properties and revisions.

import { TABLE_KINDS, type TableKind } from "../../../drafting/tables";
import type { IconName } from "../../icons";
import { registerDrawingTool } from "./registry";
import type { DrawingToolCtx } from "./types";

const TABLE_TOOLS: [TableKind, string, IconName, string][] = [
  ["cutList", "Cut List", "grid", "The weldment's cut list: item, quantity, profile, length, end angles, mass"],
  ["bom", "Bill of Materials", "grid", "The parts list: item, quantity, part, description, material"],
  ["holes", "Hole Table", "hole", "Every hole a view looks into, tagged A1, A2…, with X and Y from an origin"],
  ["welds", "Weld Table", "joint", "Every weld: type, size, length, process"],
  ["revisions", "Revision Table", "history", "The drawing's revisions (Drawing Properties: Revisions)"],
  ["general", "General Table", "grid", "A table you type into: double-click a cell to edit it"],
];

const why = (kind: TableKind) => (c: DrawingToolCtx) => {
  if (kind === "cutList" && !c.measurements?.members.length) return "The cut list is a weldment's: this part has no members";
  if (kind === "welds" && !(c.doc as { welds?: unknown[] }).welds?.length) return "The part has no welds (Weldments: Weld)";
  if (kind === "holes" && !c.sheetDoc.views.length) return "Add a view first: a hole table lists a view's holes";
  return undefined;
};

for (const [kind, label, icon, title] of TABLE_TOOLS) {
  if (!TABLE_KINDS.includes(kind)) continue;
  registerDrawingTool({ id: `table.${kind}`, tab: "tables", group: "tables", label, icon, title, testId: `tool-table-${kind}`, disabled: why(kind), run: (get) => get().dialog("table", kind) });
}

registerDrawingTool({ id: "format.template", tab: "format", group: "format", label: "Sheet Format", icon: "drawing", title: "The sheet's size, orientation, template, scale and projection", testId: "tool-format-template", run: (get) => get().dialog("format") });
registerDrawingTool({ id: "format.titleBlock", tab: "format", group: "format", label: "Title Block", icon: "properties", title: "Edit the title block's fields and see the properties they link to (or double-click the title block)", testId: "tool-format-title-block", run: (get) => get().dialog("titleBlock") });
registerDrawingTool({ id: "format.properties", tab: "format", group: "format", label: "Drawing Properties", icon: "settings", title: "Standard, units, general tolerance, custom properties and the revisions list", testId: "tool-format-properties", run: (get) => get().dialog("properties") });
registerDrawingTool({ id: "format.scale", tab: "format", group: "format", label: "Sheet Scale", icon: "ruler", title: "The scale every view takes unless it has its own", testId: "tool-format-scale", run: (get) => get().dialog("format", "scale") });
registerDrawingTool({ id: "format.standard", tab: "format", group: "format", label: "Standard", icon: "check", title: "Draw to ISO or ASME: arrowheads, text, symbols, the projection's default", testId: "tool-format-standard", run: (get) => get().dialog("properties", "standard") });
