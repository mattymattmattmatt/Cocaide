// A sheet's scale is chosen once and kept (Phase Q wave Q4). New drawing and
// Fit views choose it — the largest standard scale at which the views, laid
// out afresh, fit the sheet — and store it on the sheet, with the scale of
// each view placed on its own that the layout drew smaller (an iso). After
// that only the user changes a scale: moving a view never does. A sheet
// stored without a scale (made before Q4) keeps the one it shows: the editor
// stores it on the first edit (keepScale), so nothing visibly jumps.

import type { Command } from "../doc/commands";
import { viewKind } from "../doc/drawing";
import type { DrawingSheet, DrawingView, Vec2 } from "../doc/types";
import { composeSheet, scaleText, type ComposeContext, type ComposedSheet } from "./compose";
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
  const composed = composeSheet(trial, ctx, sheetDoc.id);
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
