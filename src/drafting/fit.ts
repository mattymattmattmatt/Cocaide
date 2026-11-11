// A sheet's scale is chosen once and kept (Phase Q wave Q4). New drawing and
// Fit views choose it — the largest standard scale at which the views, laid
// out afresh, fit the sheet — and store it on the sheet, with the scale of
// each view placed on its own that the layout drew smaller (an iso). After
// that only the user changes a scale: moving a view never does. A sheet
// stored without a scale (made before Q4) keeps the one it shows: the editor
// stores it on the first edit (keepScale), so nothing visibly jumps.

import type { Command } from "../doc/commands";
import { viewKind } from "../doc/drawing";
import type { Annotation, DrawingSheet, DrawingView, Vec2 } from "../doc/types";
import { composeSheet, scaleText, type ComposeContext, type ComposedAnnotation, type ComposedSheet } from "./compose";
import { placeFromFront } from "./views";
import type { TableCorner } from "./tables";

/** A view whose scale the layout may choose (an iso or other view placed on its own, at no scale of its own). */
function looseModel(view: DrawingView, projection: DrawingSheet["projection"]): boolean {
  return viewKind(view) === "model" && (!!view.orientation || !placeFromFront(view.look ?? "front", projection));
}

/**
 * What a sheet shows, as fields to store: its scale, and each view's that the
 * layout chose apart from the sheet's (an iso drawn a step smaller). Null when
 * the sheet has a scale already or nothing to judge it by.
 */
export function shownScales(sheetDoc: DrawingSheet, composed: ComposedSheet): { scale: string; views: { id: string; scale: string }[]; tables: { id: string; corner: TableCorner; at?: Vec2 }[] } | null {
  if (sheetDoc.scale || !sheetDoc.views.length || composed.id !== sheetDoc.id) return null;
  // Not while a view is still being projected: what the sheet shows then isn't what it will show.
  if (composed.views.length !== sheetDoc.views.length || composed.views.some((cv) => !cv.box)) return null;
  const views: { id: string; scale: string }[] = [];
  for (const view of sheetDoc.views) {
    const cv = composed.views.find((x) => x.id === view.id);
    if (!cv || view.scale || !looseModel(view, sheetDoc.projection) || Math.abs(cv.scale - composed.scale) < 1e-12) continue;
    views.push({ id: view.id, scale: cv.scaleText });
  }
  return { scale: composed.scaleText, views, tables: movedTables(sheetDoc, composed) };
}

/** The tables the layout moved from their usual corner (no anchor of their own) so the views fit: to store as their anchors. */
function movedTables(sheetDoc: DrawingSheet, composed: ComposedSheet): { id: string; corner: TableCorner; at?: Vec2 }[] {
  return Object.entries(composed.tableCorners ?? {})
    .filter(([id]) => (sheetDoc.tables ?? []).some((t) => t.id === id && !t.anchor) || sheetDoc.annotations.some((a) => a.id === id && a.type === "table" && !a.at))
    .map(([id, corner]) => ({ id, corner, ...tableTopLeft(composed, id) }));
}

/** Where a table annotation (Phase L) was drawn: its top left corner, which is what its `at` stores. */
function tableTopLeft(composed: ComposedSheet, id: string): { at?: Vec2 } {
  const box = composed.blocks.find((b) => b.id === id)?.box;
  return box ? { at: [box.min[0], box.max[1]] } : {};
}

/** setTable commands that anchor those tables where the layout put them. */
function anchorTables(sheetDoc: DrawingSheet, moved: { id: string; corner: TableCorner; at?: Vec2 }[]): Command[] {
  return moved.flatMap(({ id, corner, at }): Command[] => {
    const legacy = sheetDoc.annotations.find((a) => a.id === id && a.type === "table");
    if (legacy) return at ? [{ type: "editAnnotation", id, patch: { at } }] : [];
    const { id: _id, ...body } = (sheetDoc.tables ?? []).find((t) => t.id === id)!;
    void _id;
    return [{ type: "setTable", id, sheet: sheetDoc.id, table: { ...body, anchor: { corner } } }];
  });
}

/** The commands that store what a sheet shows (shownScales): to run with the first edit of a sheet stored without a scale. */
export function keepScale(sheetDoc: DrawingSheet, composed: ComposedSheet): Command[] {
  const shown = shownScales(sheetDoc, composed);
  if (!shown) return [];
  return [
    { type: "setSheet", sheet: sheetDoc.id, patch: { scale: shown.scale } },
    ...shown.views.map((v): Command => {
      const view = sheetDoc.views.find((x) => x.id === v.id)!;
      const { id, ...body } = view;
      return { type: "setView", id, sheet: sheetDoc.id, view: { ...body, scale: v.scale } };
    }),
    ...anchorTables(sheetDoc, shown.tables),
  ];
}

/** The same, on a sheet as data (New drawing stores its scale this way). */
export function withShownScales(sheetDoc: DrawingSheet, composed: ComposedSheet): DrawingSheet {
  const shown = shownScales(sheetDoc, composed);
  if (!shown) return sheetDoc;
  const own = new Map(shown.views.map((v) => [v.id, v.scale]));
  const corner = new Map(shown.tables.map((t) => [t.id, t.corner]));
  const at = new Map(shown.tables.flatMap((t) => (t.at ? [[t.id, t.at] as const] : [])));
  return {
    ...sheetDoc,
    scale: shown.scale,
    views: sheetDoc.views.map((v) => (own.has(v.id) ? { ...v, scale: own.get(v.id)! } : v)),
    annotations: sheetDoc.annotations.map((a) => (a.type === "table" && at.has(a.id) ? { ...a, at: at.get(a.id)! } : a)),
    ...(sheetDoc.tables ? { tables: sheetDoc.tables.map((t) => (corner.has(t.id) ? { ...t, anchor: { corner: corner.get(t.id)! } } : t)) } : {}),
  };
}

/**
 * Fit views to sheet: the views laid out afresh (every place the user gave
 * them let go, an iso's scale chosen again) at the largest standard scale at
 * which they fit, stored. Views given a scale of their own other than those
 * keep it (a detail's, a section's). The commands, or a reason there are none.
 */
export function fitViews(doc: unknown, ctx: ComposeContext, sheetDoc: DrawingSheet): { commands: Command[]; scale: string } | { error: string } {
  if (sheetDoc.manual) return { error: "Fit views: this sheet is in manual mode, where nothing is laid out for you. Turn manual mode off to lay the views out afresh." };
  if (!sheetDoc.views.length) return { error: "Fit views: the sheet has no views." };
  const fresh: DrawingSheet = {
    ...sheetDoc,
    views: sheetDoc.views.map((v) => {
      const { at: _at, ...rest } = v;
      void _at;
      if (looseModel(v, sheetDoc.projection)) delete rest.scale;
      return rest;
    }),
  };
  delete fresh.scale;
  const drawing = (doc as { drawing?: { sheets?: DrawingSheet[] } }).drawing;
  if (!drawing?.sheets) return { error: "Fit views: there is no drawing." };
  const trial = { ...(doc as object), drawing: { ...drawing, sheets: drawing.sheets.map((s) => (s.id === sheetDoc.id ? fresh : s)) } };
  const composed = composeSheet(trial, { ...ctx, arrange: true }, sheetDoc.id);
  if (!composed) return { error: "Fit views: the drawing could not be composed." };
  const commands: Command[] = [{ type: "setSheet", sheet: sheetDoc.id, patch: { scale: scaleText(composed.scale) } }];
  for (const view of sheetDoc.views) {
    const cv = composed.views.find((x) => x.id === view.id);
    const { id, ...body } = view;
    const next: Omit<DrawingView, "id"> = { ...body };
    delete next.at;
    if (looseModel(view, sheetDoc.projection)) {
      delete next.scale;
      if (cv && Math.abs(cv.scale - composed.scale) > 1e-12) next.scale = cv.scaleText;
    }
    if (JSON.stringify(next) !== JSON.stringify(body)) commands.push({ type: "setView", id, sheet: sheetDoc.id, view: next });
  }
  commands.push(...anchorTables(sheetDoc, movedTables(sheetDoc, composed)));
  return { commands, scale: scaleText(composed.scale) };
}

/** The drawing edits that store a sheet's shown scale first on a sheet stored without one (the editor's, the AI's alike). */
export const DRAWING_EDITS = new Set<string>(["setSheet", "addSheet", "renameSheet", "moveSheet", "setDrawingOptions", "setView", "moveView", "setTable", "setAnnotation", "editAnnotation"]);

/** The sheets some commands edit: a command's own sheet, else the sheet holding what it names, else the first. */
export function sheetsTouched(doc: unknown, cmds: Command[]): string[] {
  const sheets = (doc as { drawing?: { sheets?: DrawingSheet[] } }).drawing?.sheets;
  if (!Array.isArray(sheets) || !sheets.length) return [];
  const out = new Set<string>();
  for (const c of cmds) {
    if (!DRAWING_EDITS.has(c.type) || c.type === "addSheet" || c.type === "setDrawingOptions") continue;
    const named = c as { sheet?: unknown; id?: unknown };
    if (c.type === "renameSheet" || c.type === "moveSheet") {
      if (typeof named.id === "string") out.add(named.id);
      continue;
    }
    if (typeof named.sheet === "string" && sheets.some((s) => s.id === named.sheet)) {
      out.add(named.sheet);
      continue;
    }
    const id = typeof named.id === "string" ? named.id : null;
    const holding = id ? sheets.find((s) => s.views?.some((v) => v.id === id) || s.annotations?.some((a) => a.id === id) || (s.tables ?? []).some((t) => t.id === id)) : undefined;
    out.add((holding ?? sheets[0]).id);
  }
  return [...out];
}

/**
 * What the editor does on the first edit of a sheet stored without a scale
 * (made before Phase Q wave Q4), for any other editor (the AI agent session
 * behind MCP and the bridge, the in-app ask): the commands that store the
 * scale each sheet the edit touches shows, to run before it. `compose` gives
 * a sheet as it is shown now (null when it can't be composed).
 */
export function keepScales(doc: unknown, cmds: Command[], compose: (sheet: string) => ComposedSheet | null): Command[] {
  if (!cmds.some((c) => DRAWING_EDITS.has(c.type)) || cmds.some((c) => c.type === "setDrawing")) return [];
  const sheets = (doc as { drawing?: { sheets?: DrawingSheet[] } }).drawing?.sheets ?? [];
  const out: Command[] = [];
  for (const id of sheetsTouched(doc, cmds)) {
    const sheetDoc = sheets.find((s) => s.id === id);
    if (!sheetDoc || (sheetDoc.scale && !sheetDoc.manual) || !sheetDoc.views?.length) continue;
    if (cmds.some((c) => (c.type === "setSheet" && ("scale" in c.patch || "manual" in c.patch) && (c.sheet ?? sheets[0].id) === id) || (c.type === "deleteSheet" && c.id === id))) continue;
    const composed = compose(id);
    // A manual sheet: the views the layout placed are held where they are drawn too (and the tables), so the AI's edit moves nothing else.
    if (composed) out.push(...(sheetDoc.manual ? pinSheet(sheetDoc, composed) : keepScale(sheetDoc, composed)));
  }
  return out;
}

/** The commands that store where the layout moved tables with no anchor of their own (so the views fit): none when it moved none. */
export function anchorMovedTables(sheetDoc: DrawingSheet, composed: ComposedSheet): Command[] {
  return anchorTables(sheetDoc, movedTables(sheetDoc, composed));
}

// ------------------------------------------------------------ manual mode

/** What stores an annotation's place as drawn (the sheet editor's drag with no movement), or null when it follows its geometry. */
export type PinAnnotation = (a: Annotation, said: ComposedAnnotation, composed: ComposedSheet) => Record<string, unknown> | null;

/** Whether an annotation has a place of its own (a dimension's distance, anything's `at`). */
function hasPlace(a: Annotation): boolean {
  const r = a as unknown as Record<string, unknown>;
  return r.at !== undefined || r.offset !== undefined;
}

/**
 * Manual mode: the commands that hold everything the layout placed where it
 * is drawn now, so nothing moves when something else is added: the scale
 * (and an iso's), each view's centre, the tables the layout moved, and (given
 * `pin`) each annotation without a place of its own. Empty while a view is
 * still being projected, or when everything is held already.
 */
export function pinSheet(sheetDoc: DrawingSheet, composed: ComposedSheet, pin?: PinAnnotation): Command[] {
  if (composed.id !== sheetDoc.id) return [];
  if (composed.views.length !== sheetDoc.views.length || composed.views.some((cv) => !cv.box)) return [];
  const out: Command[] = sheetDoc.scale ? anchorMovedTables(sheetDoc, composed) : keepScale(sheetDoc, composed);
  const scaled = new Map<string, string>();
  for (const cmd of out) if (cmd.type === "setView" && typeof (cmd.view as DrawingView).scale === "string") scaled.set(cmd.id, (cmd.view as DrawingView).scale!);
  const views: Command[] = [];
  for (const view of sheetDoc.views) {
    if (view.at && !scaled.has(view.id)) continue;
    const cv = composed.views.find((x) => x.id === view.id);
    if (!cv) continue;
    const { id, ...body } = view;
    views.push({ type: "setView", id, sheet: sheetDoc.id, view: { ...body, ...(scaled.has(id) ? { scale: scaled.get(id)! } : {}), at: view.at ?? [Math.round(cv.centre[0] * 1000) / 1000, Math.round(cv.centre[1] * 1000) / 1000] } });
  }
  const kept = out.filter((c) => !(c.type === "setView" && views.some((v) => v.type === "setView" && v.id === c.id)));
  const notes: Command[] = [];
  if (pin) {
    for (const a of sheetDoc.annotations) {
      if (hasPlace(a)) continue;
      const said = composed.annotations.find((x) => x.id === a.id);
      if (!said || said.problem || said.dangling || said.hidden || !said.box) continue;
      const patch = pin(a, said, composed);
      if (patch && Object.keys(patch).length) notes.push({ type: "editAnnotation", id: a.id, patch });
    }
  }
  return [...kept, ...views, ...notes];
}

/** Turning manual mode on (or off) for a sheet: on, everything is held where it is drawn first; one undo step. */
export function setManual(sheetDoc: DrawingSheet, composed: ComposedSheet, on: boolean, pin?: PinAnnotation): Command[] {
  return [{ type: "setSheet", sheet: sheetDoc.id, patch: { manual: on ? true : null } }, ...(on ? pinSheet(sheetDoc, composed, pin) : [])];
}
