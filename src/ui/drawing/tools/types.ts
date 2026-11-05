// The drawing tools' plug-in point (Phase Q wave Q2B): what a tool on the
// drawing's toolbar is, what it is given (the drawing, the sheet as composed,
// the snap index, the document's commands), and the session it opens. A
// session is the sheet's equivalent of a feature session in the 3D view: it
// says what to do next (the prompt over the sheet), takes the pointer (with
// the snap under it, a GeoRef), draws its rubber band and preview, shows its
// options in the property panel, and ends with OK (one undo step) or Cancel
// (the drawing exactly as it was). Later waves add annotation tools by
// registering a DrawingToolDef (src/ui/drawing/tools/registry.ts) and, for a
// new annotation kind, an AnnotationKindDef (src/ui/drawing/tools/kinds.ts):
// the toolbar, the shortcuts, the tree and the property panel pick them up.

import type { ReactNode } from "react";
import type { DrawingGeometry } from "../../../ask/kernel";
import type { Command, RawDocument } from "../../../doc/commands";
import type { Drawing, DrawingSheet, Vec2, Vec3 } from "../../../doc/types";
import type { ComposedSheet } from "../../../drafting/compose";
import type { Box, Prim } from "../../../drafting/sheet";
import type { ViewSpec } from "../../../kernel/drawingViews";
import type { Measurements } from "../../../kernel/measure";
import type { IconName } from "../../icons";
import type { SnapIndex, SnapKind, SnapTarget } from "../snap";

/** What is under the pointer besides geometry: a view, an annotation, a table, the title block. */
export type SheetHit = { kind: "view" | "annotation" | "table" | "titleBlock"; id: string };

/** The pointer on the sheet, as a session sees it. Sheet mm, y up. */
export interface SheetPointer {
  /** Where it is, snapped to the geometry under it when there is a snap. */
  at: Vec2;
  /** Where it is, not snapped. */
  raw: Vec2;
  snap: SnapTarget | null;
  /** The view whose box holds it (the innermost). */
  view: string | null;
  hit: SheetHit | null;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** Something a session draws over the sheet. Sheet mm; widths in screen pixels. */
export type OverlayShape =
  | { k: "line"; pts: Vec2[]; tone?: Tone; dash?: boolean; w?: number; closed?: boolean }
  | { k: "circle"; c: Vec2; r: number; tone?: Tone; dash?: boolean; w?: number }
  | { k: "rect"; box: Box; tone?: Tone; dash?: boolean; fill?: boolean }
  | { k: "dot"; at: Vec2; tone?: Tone }
  | { k: "label"; at: Vec2; text: string; tone?: Tone }
  /** A view or annotation drawn moved by delta (its group on the sheet, translated): a preview of a move. */
  | { k: "move"; id: string; delta: Vec2 }
  /** Sheet primitives as the engine lays them out (a tool's annotation before it is kept), drawn in the tone at their own weights. */
  | { k: "prims"; prims: Prim[]; tone?: Tone };
export type Tone = "accent" | "preview" | "warn" | "muted";

/** A drawing tool's open session. Every method reads the latest context through the getter it was made with. */
export interface DrawingSession {
  /** The tool that opened it. */
  readonly tool: string;
  /** Its name in the property panel and the undo step ("Section view B"). */
  title(): string;
  /** What to do now, over the sheet ("Click the cutting line's first point"). */
  prompt(): string;
  /** What the pointer snaps to now (default: nothing but views and annotations); `view` limits it to one view. */
  snaps?(): { kinds: SnapKind[]; view?: string | null } | null;
  /** The views it lets the pointer pick (hovered views are outlined): true for all. */
  picksViews?(): boolean | string[];
  move?(p: SheetPointer): void;
  click?(p: SheetPointer): void;
  doubleClick?(p: SheetPointer): void;
  /** A key while the pointer is on the sheet or nothing has the keyboard; true when it was taken. */
  key?(e: KeyboardEvent): boolean;
  overlay(): OverlayShape[];
  /** The options in the property panel, under the session's OK and Cancel. */
  panel?(): ReactNode;
  /** Why OK can't be pressed yet, or null. */
  blocked(): string | null;
  /** Keeps it: one undo step. Returns why not, or null. */
  ok(): string | null;
  /** Leaves the drawing as it was. */
  cancel(): void;
}

/** What a tool and its session are given: the latest, every time it is read. */
export interface DrawingToolCtx {
  doc: RawDocument;
  drawing: Drawing;
  /** The sheet shown, as stored and as composed. */
  sheetDoc: DrawingSheet;
  sheet: ComposedSheet | null;
  measurements: Measurements | null;
  snap: SnapIndex | null;
  /** Selected views, annotations and tables (ids). */
  selection: string[];
  /** A command now (one undo step); its error is shown and returned. */
  run(cmd: Command): string | null;
  /** Several commands as one undo step. */
  batch(cmds: Command[]): string | null;
  /** The session's own transaction: begin once, `live` commands inside it, then commit (OK) or rollback (Cancel). */
  begin(label: string): string | null;
  live(cmd: Command): string | null;
  commit(label?: string): void;
  rollback(): void;
  inTransaction(): boolean;
  /** A free id with this prefix across the drawing ("section_" → "section_2"). */
  nextId(prefix: string): string;
  select(ids: string[]): void;
  notice(text: string, kind?: "info" | "error"): void;
  /** Redraws the overlay and the panel after the session changed. */
  refresh(): void;
  /** Projects views of the part (thumbnails for the orientation palette). */
  project?(specs: ViewSpec[]): Promise<DrawingGeometry | null>;
  /** The 3D view's orientation as it was last left, model directions: eye (toward the viewer) and up. */
  camera?(): { eye: Vec3; up: Vec3 } | null;
  /** Sheet mm per screen pixel now. */
  mmPerPx(): number;
  /** Ends the session (after OK or Cancel). */
  end(): void;
  /** Opens a session made outside the toolbar (the format painter from a menu); cancels the one open. */
  startSession?(s: DrawingSession): void;
  /** Opens a dialog of the workspace (insert table, sheet format, drawing properties, title block, export). */
  dialog(name: DrawingDialog, arg?: string): void;
  /** Whole-drawing actions App owns: New drawing, Balloon every item. */
  actions: { newDrawing(): void; balloonAll(): void };
}

export type DrawingDialog = "table" | "format" | "properties" | "titleBlock" | "export";

/** The toolbar's tabs. */
export const DRAWING_TABS = [
  { id: "layout", label: "View Layout" },
  { id: "annotation", label: "Annotation" },
  { id: "sketch", label: "Sketch" },
  { id: "tables", label: "Tables" },
  { id: "format", label: "Sheet Format" },
] as const;
export type DrawingTab = (typeof DRAWING_TABS)[number]["id"];

/** A tool on the drawing's toolbar. */
export interface DrawingToolDef {
  /** "view.section", "annotation.note" ... (stable: a later wave replaces a tool by registering its id again). */
  id: string;
  tab: DrawingTab;
  /** Tools of a group sit together, groups split by a rule, in the order first seen. */
  group: string;
  label: string;
  icon: IconName;
  /** The tooltip: what it does. */
  title: string;
  /** Its key on the sheet ("D"). */
  key?: string;
  testId?: string;
  /** Why it can't run now (shown in its tooltip; it is greyed), or undefined. */
  disabled?(ctx: DrawingToolCtx): string | undefined;
  /** Runs it: a session to open, or nothing when it acted at once. */
  run(ctx: () => DrawingToolCtx): DrawingSession | void;
}
