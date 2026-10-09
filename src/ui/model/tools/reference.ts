// The Reference tab: Plane, Axis and Point. Each looks at what is selected and
// makes the reference it means (src/ui/model/referenceFromSelection.ts): a
// face → a plane offset from it, an edge in a plane → a plane at an angle,
// three vertices → a plane through them, a round face → its axis, a circular
// edge → its centre. Nothing usable selected: a sensible default, and a
// notice saying what to select. Right-clicks offer the same, worded for what
// was clicked ("Plane from this face", "Axis of this cylinder").

import { axisFromSelection, datumKinds, planeFromSelection, pointFromSelection, type Proposal } from "../referenceFromSelection";
import { datumKindOf } from "../selection";
import type { ContextTarget, ToolCtx, ToolDef, ToolItem } from "../ToolContext";

/** Adds the proposed feature (selected, its properties open), then says what was guessed, if anything. */
function make(ctx: ToolCtx, p: Proposal, prefix: string): void {
  if (p.error) return ctx.notice(p.error);
  ctx.create({ id: ctx.nextId(prefix), ...p.feature });
  if (p.notice) ctx.notice(p.notice, "info");
}

const kinds = (ctx: ToolCtx) => datumKinds(ctx.features, ctx.view);

const plane = (ctx: ToolCtx) => make(ctx, planeFromSelection(ctx.selection, ctx.view, kinds(ctx)), "plane");
const axis = (ctx: ToolCtx) => make(ctx, axisFromSelection(ctx.selection, ctx.view, kinds(ctx)), "axis");
const point = (ctx: ToolCtx) => make(ctx, pointFromSelection(ctx.selection, ctx.view, kinds(ctx)), "point");

/** A right-click entry that runs `run` on what was right-clicked (the right-click selected it). */
const entry = (label: string, testId: string, icon: ToolItem["icon"], run: (c: ToolCtx) => void): ToolItem => ({ label, testId, icon, run });

function face(ctx: ToolCtx, t: ContextTarget) {
  return t.kind === "face" ? ctx.view?.faces[t.index] : undefined;
}
function edge(ctx: ToolCtx, t: ContextTarget) {
  return t.kind === "edge" ? ctx.view?.edges[t.index] : undefined;
}
function datumKind(ctx: ToolCtx, t: ContextTarget) {
  return t.kind === "datum" ? (datumKindOf(t.id, ctx.view?.datums ?? {}) ?? kinds(ctx)(t.id)) : undefined;
}

export const tools: ToolDef[] = [
  {
    id: "tool.plane",
    label: "Plane",
    icon: "plane",
    tab: "reference",
    group: "datum",
    title:
      "A reference plane from what is selected: a face or plane (offset), a plane and an edge in it (at an angle), three vertices, two faces (mid-plane), an edge (square to it), a plane and a vertex (parallel through it)",
    testId: "tool-plane",
    run: plane,
    contextItems: (ctx, t) => {
      if (face(ctx, t)?.type === "plane") return [entry("Plane from this face", "ctx-plane-face", "plane", plane)];
      if (edge(ctx, t)) return [entry("Plane normal to this edge", "ctx-plane-edge", "plane", plane)];
      if (datumKind(ctx, t) === "plane") return [entry("Offset plane from this", "ctx-plane-offset", "plane", plane)];
      return [];
    },
  },
  {
    id: "tool.axis",
    label: "Axis",
    icon: "axis",
    tab: "reference",
    group: "datum",
    title: "A reference axis from what is selected: a round face (its axis), an edge (along it), two planes (where they meet), two vertices, or a vertex and a plane (square to it)",
    testId: "tool-axis",
    run: axis,
    contextItems: (ctx, t) => {
      const f = face(ctx, t);
      if (f?.type === "cylinder" || f?.type === "cone") return [entry("Axis of this cylinder", "ctx-axis-cylinder", "axis", axis)];
      const e = edge(ctx, t);
      if (e?.kind === "line") return [entry("Axis along this edge", "ctx-axis-edge", "axis", axis)];
      if (e?.kind === "circle") return [entry("Axis of this circle", "ctx-axis-edge", "axis", axis)];
      return [];
    },
  },
  {
    id: "tool.point",
    label: "Point",
    icon: "datumPoint",
    tab: "reference",
    group: "datum",
    title: "A reference point from what is selected: a circular edge (its centre), a face (its centre), an edge (its middle), a vertex, or an axis and a plane (where they cross)",
    testId: "tool-point",
    run: point,
    contextItems: (ctx, t) => {
      if (t.kind === "vertex") return [entry("Point at this vertex", "ctx-point-vertex", "datumPoint", point)];
      if (edge(ctx, t)?.kind === "circle") return [entry("Point at its centre", "ctx-point-center", "datumPoint", point)];
      return [];
    },
  },
];
