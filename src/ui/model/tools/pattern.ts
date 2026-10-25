// Linear, circular and sketch-driven patterns of the feature selected in the
// tree, in the Pattern menu. An edge (or axis) selected in the view gives a
// linear pattern its direction and a circular one its axis; a round face
// gives its axis too.

import { DOC_DEFS } from "../../../features/docIndex";
import { refFromSelection } from "../../props/datumRef";
import type { Vec3 } from "../../../doc/types";
import { wizardSpec } from "../../../features/hole/wizard";
import { selectionSize } from "../selection";
import { patternSpacingFor, widthAlong } from "../smartDefaults";
import { recalled } from "../toolMemory";
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

/**
 * How wide the seed is along `dir` (mm): a hole its widest diameter (the
 * counterbore's or countersink's), an extrude or cut its sketch's outline
 * along the direction; NaN when it can't be told.
 */
export function seedWidth(ctx: ToolCtx, seed: Raw, dir: Vec3): number {
  if (seed.op === "hole") {
    const spec = wizardSpec(seed);
    if (typeof spec === "string") return typeof seed.diameter === "number" ? seed.diameter : NaN;
    return Math.max(spec.diameter, spec.counterbore?.diameter ?? 0, spec.countersink?.diameter ?? 0);
  }
  if ((seed.op === "extrude" || seed.op === "cut") && typeof seed.sketch === "string") {
    const sk = ctx.view?.sketches.find((s) => s.id === seed.sketch);
    const pts = sk ? sk.polylines.filter((p) => !p.construction && !p.reference).flatMap((p) => p.points) : [];
    return pts.length ? widthAlong(pts, dir) : NaN;
  }
  return NaN;
}

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
  const count = (fallback: number) => {
    const last = recalled(ctx.memory, op, "count");
    return typeof last === "number" && Number.isInteger(last) && last >= 2 && last <= 50 ? last : fallback;
  };
  if (op === "linearPattern") {
    // Spaced half as much again as the seed is wide along the row (an edge picked: along it; else +X).
    const edge = ctx.view && ctx.selection.edges.length === 1 ? ctx.view.edges[ctx.selection.edges[0]] : undefined;
    const dir: Vec3 = edge?.kind === "line" && edge.direction ? edge.direction : [1, 0, 0];
    return { id, op, feature: selected.id, ...(along ? { along } : { direction: [1, 0, 0] }), spacing: patternSpacingFor(seedWidth(ctx, selected, dir)), count: count(3) };
  }
  return { id, op, feature: selected.id, axis: along ? { ref: along } : { origin: [0, 0, 0], direction: [0, 0, 1] }, count: count(4) };
}

/** A new pattern with no seed picked yet: its session opens with the features field waiting for a click in the tree. */
export function patternDraft(ctx: ToolCtx, op: "linearPattern" | "circularPattern"): Raw {
  const id = ctx.nextId(op === "linearPattern" ? "pattern" : "circular");
  return op === "linearPattern" ? { id, op, direction: [1, 0, 0], spacing: 10, count: 3 } : { id, op, axis: { ref: { datum: "Z" } }, count: 4 };
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
  if (typeof f !== "string") return ctx.create(f);
  // Command-first: open it, the features to repeat picked in the tree.
  const seeds = ctx.resolved.some((g) => PATTERNABLE.includes(String(g.op)));
  if (op !== "sketchPattern" && ctx.draft && seeds && (!ctx.selected || !PATTERNABLE.includes(String(ctx.selected.op)))) return ctx.draft(patternDraft(ctx, op), { active: "features" });
  ctx.notice(f);
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
