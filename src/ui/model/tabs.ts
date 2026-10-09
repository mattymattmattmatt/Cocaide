// The CommandManager's tabs, as SOLIDWORKS has them, and the order of the
// tool groups on each. A tool names its tab and group (ToolDef.tab, .group);
// a group not listed here goes after the listed ones. A tab with no tools is
// not shown.

import type { ToolTab } from "./ToolContext";

export interface TabDef {
  id: ToolTab;
  label: string;
  /** Group order on the tab, left to right; a separator between groups. */
  groups: string[];
}

export const TABS: TabDef[] = [
  // shape: extrude, cut, revolve, sweep, loft · dress: hole, fillet, chamfer, shell, draft, rib · pattern: patterns, mirror
  { id: "features", label: "Features", groups: ["shape", "dress", "pattern"] },
  // datum: planes, axes, points
  { id: "reference", label: "Reference", groups: ["datum"] },
  // bodies: combine, split, move, scale, delete
  { id: "bodies", label: "Bodies", groups: ["bodies"] },
  { id: "weldments", label: "Weldments", groups: ["members"] },
  // measure: measure, mass properties · view: section view
  { id: "evaluate", label: "Evaluate", groups: ["measure", "view"] },
];
