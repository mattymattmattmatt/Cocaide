// The sketch tool registry's types. A drawing tool is a SketchToolDef: plain
// data (its command, name, icon, flyout, clicks, options) plus pure functions
// that turn the clicks placed so far into a rubber-band preview and, once
// all are placed, into entities and the relations that hold them in shape.
// SketchCanvas drives every tool the same way: it snaps each click (to a
// point, a line's middle, onto a curve, level or plumb, the grid), draws the
// preview, and turns what each click snapped to into a relation. Tools never
// touch React or the document; tests call them directly.

import type { Constraint, SketchEntity, Vec2 } from "../../../doc/types";
import type { IconName } from "../../icons";

/** A placed point: where it landed and what it inferred there. */
export interface Click {
  p: Vec2;
  /** The point it landed on ("l1.end", "origin"): the point the tool puts here is made coincident with it. */
  ref: string | null;
  /** A line's middle, or a line, circle or arc it landed on. */
  on?: { type: "midpoint" | "pointOn"; entity: string };
  /** Level with or plumb above the click it is drawn from (alignTo), or for a polygon a side level or plumb. */
  orient?: "horizontal" | "vertical";
}

/**
 * What the new geometry has at a click, so what the click snapped to becomes
 * a relation: a point of it sits there (coincident with the point snapped to,
 * on the curve or at the middle of the line it landed on), the new entity
 * passes through it (a point snapped to goes on it), or the click is the
 * middle of a new line (a point snapped to becomes its midpoint).
 */
export type ClickRole = { point: string } | { on: string } | { middle: string } | null;

/** What a tool makes from its clicks. */
export interface Built {
  entities: SketchEntity[];
  /** The relations that make it the shape it is (four lines into a rectangle). Always kept. */
  relations: Constraint[];
  /** One per click: what the new geometry has there (see ClickRole). */
  roles: ClickRole[];
  /** Relations inferred while drawing (a line drawn level is horizontal): dropped if the sketch already says as much. */
  inferred?: Constraint[];
  /** A chain tool's next start: the end it carries on from. */
  next?: Click;
}

/** Fresh entity ids: the first free id with the prefix, never one handed out before. */
export type IdMaker = (prefix: string) => string;

/** What a tool may read besides its clicks. */
export interface ToolContext {
  /** The sketch as it is: a tangent arc reads what it starts from. */
  entities: SketchEntity[];
  /** Where the pointer went since the last click, oldest first, in sketch mm: an arc bends the way it was drawn. */
  trail?: Vec2[];
  /** Millimetres per screen pixel, for "the pointer has moved" (0 when unknown). */
  px?: number;
}

export type OptionValue = number | string;
export type ToolOptions = Record<string, OptionValue>;

export type ToolOption =
  | { kind: "number"; key: string; label: string; title: string; default: number; min: number; max: number; integer?: boolean }
  | { kind: "choice"; key: string; label: string; title: string; default: string; choices: { value: string; label: string; title: string }[] };

/** A toolbar flyout: tools that share one button, which shows and runs the one used last (Line ▾: Line, Centreline, Midpoint line). */
export interface FlyoutDef {
  id: string;
  /** The button's label, whichever of its tools it shows. */
  label: string;
}

export interface SketchToolDef {
  /** Its command in COMMANDS (src/ui/input.ts): "sketch.line". The keyboard and Settings go through it. */
  id: string;
  /** For test ids: tool-<name> on the toolbar, flyout-<name> in its flyout, bar-<name> on the shortcut bar, ctx-tool-<name> in the menu. */
  name: string;
  label: string;
  icon: IconName;
  /** The tooltip: what it draws and what to click. */
  title: string;
  /** The flyout it shares a button with; the first tool listed for a flyout is its default. */
  flyout?: FlyoutDef;
  /** Points to place. */
  clicks: number;
  /** What each click places, shown while drawing ("Click the centre"). */
  prompts: string[];
  /** Keeps drawing from the last end: double-click, Esc or clicking where the chain started ends it. */
  chain?: boolean;
  options?: ToolOption[];
  /** A click it cannot use (a tangent arc must start at an end): why, shown to the user; null takes it. */
  accept?(click: Click, index: number, ctx: ToolContext): string | null;
  /** The point the next click is inferred level with or plumb above (a line's end, from its start). */
  alignTo?(pts: Vec2[]): Vec2 | undefined;
  /** Its own inference for the next click, before the grid (a polygon turned so a side is level). */
  snap?(pts: Vec2[], p: Vec2, tol: number, options: ToolOptions): { p: Vec2; orient?: "horizontal" | "vertical" } | null;
  /** The rubber band: what the clicks so far and the pointer (the last click) would make. Default: the build, once all clicks are there. */
  preview?(clicks: Click[], options: ToolOptions, ids: IdMaker, ctx: ToolContext): SketchEntity[];
  /** The geometry and its relations from every click; null when they make nothing (a zero-length line). Pure. */
  build(clicks: Click[], options: ToolOptions, ids: IdMaker, ctx: ToolContext): Built | null;
}
