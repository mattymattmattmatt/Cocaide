// The drawing toolbar's registry (Phase Q wave Q2B). Every slot of every tab
// is named here, in order, so the toolbar shows the whole toolset from the
// start: a slot whose tool is registered runs it; a slot still to come is
// shown greyed, "coming". A later wave fills a slot by registering a tool
// with that id (registerDrawingTool), or adds a new one to a tab's group; it
// never edits the toolbar itself.

import type { IconName } from "../../icons";
import type { MenuEntry } from "../../ContextMenu";
import type { DrawingTab, DrawingToolCtx, DrawingToolDef, SheetHit } from "./types";

/** A slot on the toolbar: the tool that will be there, as it is named before it exists. */
export interface ToolSlot {
  id: string;
  tab: DrawingTab;
  group: string;
  label: string;
  icon: IconName;
  title: string;
}

const slot = (tab: DrawingTab, group: string, id: string, label: string, icon: IconName, title: string): ToolSlot => ({ id, tab, group, label, icon, title });

/** Every slot, in toolbar order. */
export const TOOL_SLOTS: ToolSlot[] = [
  // View Layout
  slot("layout", "views", "view.standard3", "Standard 3 View", "examples", "Front, top and right views of the part, lined up (third or first angle, as the sheet projects)"),
  slot("layout", "views", "view.model", "Model View", "view", "A view of the part from a named orientation, iso, dimetric, trimetric or the 3D view's"),
  slot("layout", "views", "view.projected", "Projected View", "viewFront", "A view projected from another, lined up with it: pick the view, then the side"),
  slot("layout", "derived", "view.section", "Section View", "section", "Cut a view along a line you draw on it; place the section beside it"),
  slot("layout", "derived", "view.detail", "Detail View", "zoomArea", "Circle a part of a view; place it larger"),
  slot("layout", "derived", "view.auxiliary", "Auxiliary View", "viewIso", "A view looking square at a slanted edge: pick the edge, place the view"),
  slot("layout", "modify", "view.brokenOut", "Broken-out Section", "cut", "Draw a closed outline on a view: what is inside is cut away to a depth"),
  slot("layout", "modify", "view.break", "Break", "splitEntity", "Shorten a long view: pick it, then place the two break lines"),
  slot("layout", "modify", "view.crop", "Crop View", "rect", "Draw a closed outline on a view: only what is inside shows"),
  slot("layout", "modify", "view.alternate", "Alternate Position", "moveEntities", "A part drawn again in a second position, in phantom lines"),
  // Annotation
  slot("annotation", "dimension", "annotation.smartDimension", "Smart Dimension", "smartDimension", "Dimension what you pick: two points, an edge, a circle"),
  slot("annotation", "dimension", "annotation.modelItems", "Model Items", "drivenDimension", "Bring the model's sketch and feature dimensions into a view"),
  slot("annotation", "dimension", "annotation.autoDimension", "Auto Dimension", "fullyDefine", "Dimension the selected view: its overall size, its holes from its edges, centre marks"),
  slot("annotation", "notes", "annotation.note", "Note", "note", "Text on the sheet: click where it goes"),
  slot("annotation", "notes", "annotation.balloon", "Balloon", "balloon", "A balloon with the item number: click a member or body in a view"),
  slot("annotation", "notes", "annotation.autoBalloon", "Auto Balloon", "balloon", "A balloon for every cut list item that has none"),
  slot("annotation", "notes", "annotation.hole", "Hole Callout", "hole", "Call out a hole: click its circle in a view"),
  slot("annotation", "marks", "annotation.centerMark", "Centre Mark", "plus", "A centre mark on a circle or arc: click it"),
  slot("annotation", "marks", "annotation.centerline", "Centreline", "centerline", "A centre line between two edges or through two centres: click them"),
  slot("annotation", "symbols", "annotation.surface", "Surface Finish", "check", "A surface texture symbol on an edge"),
  slot("annotation", "symbols", "annotation.weld", "Weld Symbol", "joint", "The weld symbol of a weld from the weld table: click where its bodies meet"),
  slot("annotation", "symbols", "annotation.gdt", "Geometric Tolerance", "grid", "A feature control frame: characteristic, tolerance zone, datums"),
  slot("annotation", "symbols", "annotation.datum", "Datum Feature", "datumPoint", "A datum feature symbol (A, B, C) on an edge"),
  // Sketch
  slot("sketch", "draw", "sketch.line", "Line", "line", "A line drawn on the sheet"),
  slot("sketch", "draw", "sketch.rectangle", "Rectangle", "rect", "A rectangle drawn on the sheet"),
  slot("sketch", "draw", "sketch.circle", "Circle", "circle", "A circle drawn on the sheet"),
  slot("sketch", "draw", "sketch.arc", "Arc", "arc", "An arc drawn on the sheet"),
  slot("sketch", "text", "sketch.text", "Text", "sketchText", "Text on the sheet: click where it goes"),
  // Tables
  slot("tables", "tables", "table.cutList", "Cut List", "grid", "The weldment's cut list: item, quantity, profile, length, angles, mass"),
  slot("tables", "tables", "table.bom", "Bill of Materials", "grid", "The parts list: item, quantity, part, description, material"),
  slot("tables", "tables", "table.holes", "Hole Table", "hole", "Every hole a view looks into, tagged, X and Y from an origin"),
  slot("tables", "tables", "table.welds", "Weld Table", "joint", "Every weld: type, size, length, process"),
  slot("tables", "tables", "table.revisions", "Revision Table", "history", "The drawing's revisions"),
  slot("tables", "tables", "table.general", "General Table", "grid", "A table you type into"),
  // Sheet format
  slot("format", "format", "format.template", "Sheet Format", "drawing", "The sheet's size, orientation and template, and the title block"),
  slot("format", "format", "format.titleBlock", "Title Block", "properties", "Edit the title block's fields, and the properties they link to"),
  slot("format", "format", "format.properties", "Drawing Properties", "settings", "Standard, units, general tolerance, custom properties, revisions"),
  slot("format", "format", "format.scale", "Sheet Scale", "ruler", "The scale every view takes unless it has its own"),
  slot("format", "format", "format.standard", "Standard", "check", "Draw to ISO or ASME: arrowheads, text, symbols, the projection's default"),
];

const tools = new Map<string, DrawingToolDef>();
const listeners = new Set<() => void>();

/** Puts a tool on the toolbar: in its slot when one has its id (replacing what was there), else at the end of its tab's group. */
export function registerDrawingTool(def: DrawingToolDef): void {
  tools.set(def.id, def);
  for (const l of listeners) l();
}

/** Takes a tool off the toolbar (its slot, if any, shows "coming" again). */
export function unregisterDrawingTool(id: string): void {
  tools.delete(id);
  for (const l of listeners) l();
}

export function drawingTool(id: string): DrawingToolDef | undefined {
  return tools.get(id);
}

export function allDrawingTools(): DrawingToolDef[] {
  return [...tools.values()];
}

/** Called when a tool is registered or taken away (the toolbar redraws). */
export function onToolsChanged(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** A tab's entries in groups, in order: each a registered tool, or a slot still to come. */
export type ToolEntry = { kind: "tool"; tool: DrawingToolDef } | { kind: "coming"; slot: ToolSlot };

export function toolGroups(tab: DrawingTab): ToolEntry[][] {
  const groups = new Map<string, ToolEntry[]>();
  const add = (group: string, e: ToolEntry) => groups.set(group, [...(groups.get(group) ?? []), e]);
  for (const s of TOOL_SLOTS) {
    if (s.tab !== tab) continue;
    const t = tools.get(s.id);
    add(s.group, t && t.tab === tab ? { kind: "tool", tool: t } : { kind: "coming", slot: s });
  }
  for (const t of tools.values()) if (t.tab === tab && !TOOL_SLOTS.some((s) => s.id === t.id)) add(t.group, { kind: "tool", tool: t });
  return [...groups.values()];
}

/** The tool a key runs on the sheet ("D" → Smart Dimension), when one is registered with it. */
export function toolForKey(key: string): DrawingToolDef | undefined {
  const k = key.toUpperCase();
  return [...tools.values()].find((t) => t.key?.toUpperCase() === k);
}

// ------------------------------------------------------------ right-click entries (wave Q3B)

/** Entries a module adds to the sheet's right-click menu for what was hit (a view, an annotation ...). */
export type MenuContribution = (hit: SheetHit, ctx: DrawingToolCtx) => MenuEntry[];
const contributions = new Map<string, MenuContribution>();

/** Adds (or, by the same key, replaces) right-click entries. */
export function registerMenuEntries(key: string, f: MenuContribution): void {
  contributions.set(key, f);
}

/** Every module's entries for a hit, in the order they registered. */
export function menuEntriesFor(hit: SheetHit, ctx: DrawingToolCtx): MenuEntry[] {
  return [...contributions.values()].flatMap((f) => f(hit, ctx));
}
