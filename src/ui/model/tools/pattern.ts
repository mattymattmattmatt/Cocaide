// Linear, circular and sketch-driven patterns of the feature selected in the
// tree, in the Pattern menu. An edge (or axis) selected in the view gives a
// linear pattern its direction and a circular one its axis; a round face
// gives its axis too.

import { DOC_DEFS } from "../../../features/docIndex";
import { refFromSelection } from "../../props/datumRef";
import { selectionSize } from "../selection";
import type { Raw, ToolCtx, ToolDef, ToolMenuDef } from "../ToolContext";

/** The features a pattern or a mirror can repeat: the built-in ones and the registry ops marked patternable (revolve, …). */
export const PATTERNABLE = ["extrude", "cut", "hole", "member", ...DOC_DEFS.filter((d) => d.patternable).map((d) => d.op)];

/** "an extrude, cut, hole, member or revolve": what a pattern repeats, for messages. */
const PATTERNABLE_TEXT = `an ${PATTERNABLE.slice(0, -1).join(", ")} or ${PATTERNABLE.at(-1)}`;

const PATTERN_MENU: ToolMenuDef = {
  id: "pattern",
  label: "Pattern",
  icon: "pattern",
  title: "Repeat the selected feature in a row, around an axis or at a sketch's points",
  testId: "tool-pattern",
};

/** The new pattern of the selected feature, or what to select first. */
export function patternFeature(ctx: ToolCtx, op: "linearPattern" | "circularPattern"): Raw | string {
  const { selected } = ctx;
  if (!ctx.doc || !selected || !PATTERNABLE.includes(String(selected.op))) {
    return `Select ${PATTERNABLE_TEXT} in the feature tree, then Pattern.`;
  }
  const id = ctx.nextId(op === "linearPattern" ? "pattern" : "circular");
  // An edge, an axis or a round face selected in the view: the direction or the axis, by reference (so it follows the model).
  const picked = selectionSize(ctx.selection) > 0 && (ctx.selection.edges.length > 0 || ctx.selection.datums?.length || op === "circularPattern") ? refFromSelection(ctx.selection, ctx.view, ["axis"], ctx.resolved) : null;
  const along = picked?.ok ? picked.ref : null;
  return op === "linearPattern"
    ? { id, op, feature: selected.id, ...(along ? { along } : { direction: [1, 0, 0] }), spacing: 10, count: 3 }
    : { id, op, feature: selected.id, axis: along ? { ref: along } : { origin: [0, 0, 0], direction: [0, 0, 1] }, count: 4 };
}

/** The sketches with points (where copies go), latest first. */
function pointSketches(ctx: ToolCtx): Raw[] {
  return ctx.resolved.filter((f) => f.op === "sketch" && Array.isArray(f.entities) && (f.entities as Raw[]).filter((e) => e.type === "point").length >= 2).reverse();
}

/**
 * The new sketch-driven pattern of the selected feature: at the points of the
 * newest sketch that has two or more (the seed at the first), or what to do first.
 */
export function sketchPatternFeature(ctx: ToolCtx): Raw | string {
  const { selected } = ctx;
  if (!ctx.doc || !selected || !PATTERNABLE.includes(String(selected.op))) return `Select ${PATTERNABLE_TEXT} in the feature tree, then Sketch-driven pattern.`;
  const sketch = pointSketches(ctx)[0];
  if (!sketch) return "Sketch the places first: a sketch with a point (Point tool) at the seed and at each place a copy goes, then Sketch-driven pattern.";
  return { id: ctx.nextId("sketchPattern"), op: "sketchPattern", feature: selected.id, sketch: sketch.id };
}

const run = (op: "linearPattern" | "circularPattern" | "sketchPattern") => (ctx: ToolCtx) => {
  const f = op === "sketchPattern" ? sketchPatternFeature(ctx) : patternFeature(ctx, op);
  if (typeof f === "string") ctx.notice(f);
  else ctx.create(f);
};

export const tools: ToolDef[] = [
  {
    id: "tool.linearPattern",
    label: "Linear pattern",
    icon: "linearPattern",
    tab: "features",
    group: "pattern",
    menu: PATTERN_MENU,
    title: "Copies of the selected feature in a row (or a grid)",
    hint: "Copies in a row (or a grid)",
    testId: "tool-linear-pattern",
    run: run("linearPattern"),
  },
  {
    id: "tool.circularPattern",
    label: "Circular pattern",
    icon: "circularPattern",
    tab: "features",
    group: "pattern",
    menu: PATTERN_MENU,
    title: "Copies of the selected feature around an axis",
    hint: "Copies around an axis",
    testId: "tool-circular-pattern",
    run: run("circularPattern"),
  },
  {
    id: "tool.sketchPattern",
    label: "Sketch-driven pattern",
    icon: "sketchPattern",
    tab: "features",
    group: "pattern",
    menu: PATTERN_MENU,
    title: "Copies of the selected feature at the points of a sketch",
    hint: "Copies at a sketch's points",
    testId: "tool-sketch-pattern",
    run: run("sketchPattern"),
  },
];
