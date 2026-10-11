// The sketch edit tools' interface. A drawing tool (../tools) turns clicks
// into new geometry; an edit tool changes what is there: trim, extend and
// split act on each click (and trim on a drag, SOLIDWORKS's power trim);
// fillet, chamfer, offset, mirror, the patterns and move/copy/rotate/scale
// collect picks (entities, corners, a mirror line, a base point) with their
// options in the strip, show what they would do, and apply on Apply or
// Enter. Every tool is plain data plus pure functions over the sketch and
// the picks, like the drawing tools: SketchMode and SketchCanvas drive them
// all the same way, and the unit tests call them directly. Each applied edit
// is one sketch undo step.

import type { SketchEntity, Vec2 } from "../../../doc/types";
import type { Edit, SketchState } from "../../../geom/sketchEdit/relations";
import type { IconName } from "../../icons";
import type { SketchItem } from "../draft";
import type { FlyoutDef, ToolOption, ToolOptions } from "../tools/types";

/** A point placed in space (a move's base point, a rotation's centre): where, and the sketch point it snapped to. */
export interface Place {
  p: Vec2;
  ref: string | null;
}

/** What a collecting tool has gathered so far. */
export interface EditPicks {
  /** Entities picked: to fillet between, offset, mirror, pattern, move. */
  entities: string[];
  /** Points picked: corners to fillet or chamfer, a pattern's centre. */
  points: string[];
  /** The line to mirror about. */
  about?: string;
  /** Points placed: a move's base and destination, a rotation's or scale's centre. */
  places: Place[];
  /** Pattern instances left out (the seed is 1). */
  skip?: number[];
  /** Picking the entities still (true), or the next thing (the mirror line, the base point). */
  picking?: boolean;
}

export const NO_PICKS: EditPicks = { entities: [], points: [], places: [] };

/** Where the pointer is and what is under it. */
export interface EditInput {
  /** The pointer, in sketch mm; snapped (to a point, the grid) when the tool places a point. */
  p: Vec2;
  /** The sketch point or entity under it (sketch points first). */
  item: SketchItem | null;
  /** The point the place snapped to, when the tool places one. */
  ref: string | null;
  /** How near counts, mm. */
  tol: number;
  /** Ctrl or Shift held: a collecting tool adds and drops picks instead of moving on. */
  additive?: boolean;
}

/** What a click did: more picks, an edit to apply, or why not. */
export type EditStep = { picks: EditPicks } | { edit: Edit | string } | { message: string };

/** What the tool would do, drawn over the sketch: geometry it adds or moves, and pieces it takes away. */
export interface EditPreview {
  add?: SketchEntity[];
  remove?: SketchEntity[];
  /** Places it marks (a pattern's instances, which a click skips). */
  marks?: { at: Vec2; label?: string; off?: boolean }[];
}

export interface EditToolDef {
  /** Its command in COMMANDS (src/ui/input.ts): "sketch.trim". */
  id: string;
  /** For test ids: tool-<name>, flyout-<name>, bar-<name>, ctx-tool-<name>. */
  name: string;
  label: string;
  icon: IconName;
  title: string;
  flyout?: FlyoutDef;
  options?: ToolOption[];
  /** "click": each click (or drag) edits at once. "collect": clicks gather picks; Apply (Enter) edits. */
  kind: "click" | "collect";
  /** What it starts with from the selection made before it was picked. */
  start?(selection: SketchItem[], state: SketchState): EditPicks;
  /** What to do next, for the strip. */
  prompt(picks: EditPicks, options: ToolOptions): string;
  /** Does the next click place a point (snapped), rather than pick something? */
  places?(picks: EditPicks, options: ToolOptions): boolean;
  click(state: SketchState, picks: EditPicks, input: EditInput, options: ToolOptions): EditStep;
  /** A drag across the sketch, along `path` (power trim). */
  drag?(state: SketchState, path: Vec2[], options: ToolOptions): Edit | string | null;
  /** What it would do now (with the pointer at `hover` for a click tool). */
  preview?(state: SketchState, picks: EditPicks, options: ToolOptions, hover: EditInput | null): EditPreview;
  /** The edit Apply makes: null while there is not enough to make it. */
  apply?(state: SketchState, picks: EditPicks, options: ToolOptions): Edit | string | null;
}
