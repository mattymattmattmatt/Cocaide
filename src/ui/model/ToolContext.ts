// The model tools' registry types. A tool is a ToolDef: plain data plus a
// run(ctx) that reads the ToolCtx App builds on every render (the document,
// the last rebuild, the viewport selection) and acts through it (create a
// feature, start a sketch, say what to click first). The CommandManager's
// tabs, the shortcut bar (S), the keyboard, Enter (repeat) and the right-click
// menus all read the one list in tools/index.ts.

import type { LibraryEntry } from "../../weldment/library";
import type { Command, RawDocument } from "../../doc/commands";
import type { PlaneSpec } from "../../doc/types";
import type { RebuildView } from "../../worker/protocol";
import type { FlatQuery, FlatResult } from "../../kernel/flat";
import type { IconName } from "../icons";
import type { Selection } from "./selection";
import type { ToolMemory } from "./toolMemory";

/** A feature as JSON: the document's own shape, before validation. */
export type Raw = Record<string, unknown>;

/** The right column's tabs. */
export type RightTab = "properties" | "sections" | "cutlist" | "document";

/**
 * Everything a tool may read and do. Built by App from its state on every
 * render, so it is always current; a tool never keeps it.
 */
export interface ToolCtx {
  /** The document (null while its JSON does not parse). */
  doc: RawDocument | null;
  /** The last rebuild: faces, edges, bodies, measurements. The selection's indices point into it. */
  view: RebuildView | null;
  /** What is selected in the 3D view: face and edge indices, and where the last face was clicked. */
  selection: Selection;
  /** The feature selected in the tree, its expressions evaluated. */
  selected: Raw | undefined;
  /** Every feature, expressions evaluated ("=plate_t" is a number here): compute with these. */
  resolved: Raw[];
  /** Every feature as the document holds it: edit with these. */
  features: Raw[];
  /** The section library (weldment profiles) in this browser. */
  library: LibraryEntry[];
  /** Runs one document command as one undo step. Shows the error and returns it, or null. */
  run(cmd: Command): string | null;
  /**
   * Adds a feature in a session (Phase P): it is selected in the tree, its
   * properties open with OK and Cancel, every change previews, and OK makes it
   * one undo step; Cancel leaves the part as it was.
   */
  create(feature: Raw): void;
  /**
   * Opens a session on a new feature that is not complete yet (command-first:
   * what it acts on is still to be picked). The panel shows it with the field
   * `active` (its key) ready for picks; it goes into the document with the
   * pick that completes it. Absent (tests, an older host): the tool says what
   * to select instead. `complete`, when given, settles the numbers that read
   * the part once the picks are there (a fillet's radius from the edges picked,
   * as selection-first would have it): it is given the feature as it is about
   * to go in, and leaves alone what the user has changed already.
   */
  draft?(feature: Raw, opts?: { active?: string; complete?: (f: Raw) => Raw }): void;
  /** The last values used for each kind of feature in this browser (src/ui/model/toolMemory.ts). */
  memory?: ToolMemory;
  /** Puts a whole new document in as one undo step (a tool that adds several things), then selects `select`. */
  replace(doc: RawDocument, select?: string): void;
  /** Tells the user something: what to click first ("error"), or what happened ("info"). */
  notice(text: string, kind?: "info" | "error"): void;
  clearNotice(): void;
  /** The first free id of the form `<prefix>_<n>`. */
  nextId(prefix: string): string;
  /** The bodies the document makes, in order (from validation, so before any rebuild). */
  bodies(): string[];
  /** The body a body tool works on: the clicked face's, else the newest. */
  pickedBody(): string | undefined;
  /** The sketch a sketch-based tool uses: the selected one, else the latest. */
  sketchFor(): Raw | undefined;
  /**
   * Opens the sketcher with a new sketch on a plane: written out, or by
   * reference ({ "type": "ref", "ref": { "datum": "Top" } }, a plane feature,
   * a face), which the new sketch keeps, so it follows what it stands on.
   */
  startSketch(plane: PlaneSpec): void;
  /** Opens the sketcher on the one selected flat face, or says to pick one. */
  sketchOnFace(): void;
  setSelection(sel: Selection): void;
  /** Selects a feature in the tree (null: none). */
  selectFeature(id: string | null): void;
  setRightTab(tab: RightTab): void;
  /** Opens (or, open, closes) an Evaluate panel over the view: Measure, Mass Properties, Section view. */
  evaluate?(panel: EvaluatePanel): void;
  /** Files in and out (STEP import, DXF export): App gives them; tools say so when they are absent. */
  files?: ToolFiles;
}

/** What tools that read or write files use. */
export interface ToolFiles {
  /** The browser's file chooser (accept: ".step,.stp"); null when the person cancels. */
  pick(accept: string): Promise<File | null>;
  /** Saves text or bytes as a download. */
  save(name: string, data: string | Uint8Array, type: string): void;
  /** Flat outlines from the kernel (a planar face, the flat plates), on the part as it is shown. */
  flat(query: FlatQuery): Promise<FlatResult>;
  /** The base of an export's file name: the part number (and revision), else the part's name. */
  base(): string;
  /** Fits the view to the part after the next rebuild (an import can be far bigger than what was there). */
  fit?(): void;
}

/** The Evaluate tab's panels. */
export type EvaluatePanel = "measure" | "mass" | "section";

/** The CommandManager's tabs (pinned tools sit left of them, always shown). */
export type ToolTab = "features" | "reference" | "bodies" | "weldments" | "evaluate";

/** What a right-click can be on, for a tool's entry in that menu. */
export type ContextKind = "face" | "edge" | "part";
export type ContextTarget =
  | { kind: "face" | "edge"; index: number }
  | { kind: "part" }
  /** A vertex: an end of an edge. */
  | { kind: "vertex"; edge: number; at: "start" | "end" }
  /** Reference geometry: a default plane, the origin, a plane, axis or point feature (in the view or the tree). */
  | { kind: "datum"; id: string };

/** A dropdown that groups several tools under one button (Pattern ▾: Linear, Circular). */
export interface ToolMenuDef {
  id: string;
  label: string;
  icon: IconName;
  title: string;
  testId: string;
}

/** One choice in a tool's own dropdown (Sketch ▾: on Top, Front, Right, or the selected face). */
export interface ToolItem {
  label: string;
  icon?: IconName;
  /** What it needs, as a tooltip. */
  hint?: string;
  testId?: string;
  disabled?: boolean;
  run(ctx: ToolCtx): void;
}

export interface ToolDef {
  /** The command id: also its key binding in Settings (it must be in COMMANDS, src/ui/input.ts). */
  id: `tool.${string}`;
  label: string;
  icon: IconName;
  /** The CommandManager tab it sits on; "pinned" sits left of the tabs, always shown (Sketch). */
  tab: ToolTab | "pinned";
  /** Tools of one group sit together on their tab; groups are ordered by TABS (src/ui/model/tabs.ts). */
  group?: string;
  /** Put it in this dropdown with the other tools that name the same menu id. */
  menu?: ToolMenuDef;
  /** Its own dropdown of variants on the toolbar (a key, the shortcut bar and Enter still run `run`). */
  items?(ctx: ToolCtx): ToolItem[];
  /** The toolbar tooltip: what it does and what to select first. */
  title: string;
  /** In a menu: what it makes, short ("Copies around an axis"). */
  hint?: string;
  /** The toolbar button's data-testid: tool-<kebab-case>. */
  testId: string;
  /** Why it can't run now (the button greys out and says so), or undefined. */
  disabled?(ctx: ToolCtx): string | undefined;
  run(ctx: ToolCtx): void;
  /** It is offered in the right-click menu on these. */
  contextOn?: ContextKind | ContextKind[];
  /** Its label in that menu, if not `label` ("Hole here"). */
  contextLabel?: string;
  /** Its data-testid in that menu, if not ctx-<id>. */
  contextTestId?: string;
  /** Only on some targets: a flat face, say. */
  contextWhen?(ctx: ToolCtx, target: ContextTarget): boolean;
  /**
   * Its own right-click entries, worded for what was right-clicked ("Plane
   * from this face", "Axis of this cylinder"); the right-click has selected
   * the target by the time an entry runs.
   */
  contextItems?(ctx: ToolCtx, target: ContextTarget): ToolItem[];
  /**
   * A tool with its own dropdown runs straight away when the selection says
   * what to do (Sketch on the selected plane or face):
   * the button's tooltip then, or undefined to open the dropdown.
   */
  direct?(ctx: ToolCtx): string | undefined;
}
