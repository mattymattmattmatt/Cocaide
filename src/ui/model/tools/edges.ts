// Fillet and Chamfer: on the edges picked in the view.

import { edgesSelectorFor, facesSelectorFor } from "../../../kernel/synthesize";
import type { Raw, ToolCtx, ToolDef } from "../ToolContext";

/**
 * The new fillet or chamfer on the selected edges, or (SOLIDWORKS-like) on
 * every edge of the selected faces when only faces are selected; or what to
 * click first.
 */
export function edgeFeature(ctx: ToolCtx, op: "fillet" | "chamfer"): Raw | string {
  const { view, selection } = ctx;
  const size: Raw = op === "fillet" ? { radius: 1 } : { distance: 1 };
  if (ctx.doc && view && selection.edges.length === 0 && selection.faces.length > 0) {
    const s = facesSelectorFor(view.faces, selection.faces);
    if (!s.ok) return s.error;
    return { id: ctx.nextId(op), op, faces: s.selector, ...size };
  }
  if (!ctx.doc || !view || selection.edges.length === 0) {
    return `Click one or more edges (shift-click for more), or faces to treat all their edges, then ${op === "fillet" ? "Fillet" : "Chamfer"}.`;
  }
  const s = edgesSelectorFor(view.edges, view.faces, selection.edges);
  if (!s.ok) return s.error;
  return { id: ctx.nextId(op), op, edges: s.selector, ...size };
}

const run = (op: "fillet" | "chamfer") => (ctx: ToolCtx) => {
  const f = edgeFeature(ctx, op);
  if (typeof f === "string") ctx.notice(f);
  else ctx.create(f);
};

export const tools: ToolDef[] = [
  {
    id: "tool.fillet",
    label: "Fillet",
    icon: "fillet",
    tab: "features",
    group: "dress",
    title: "Round edges: click edges (Ctrl- or shift-click for more), then Fillet",
    testId: "tool-fillet",
    run: run("fillet"),
    contextOn: "edge",
  },
  {
    id: "tool.chamfer",
    label: "Chamfer",
    icon: "chamfer",
    tab: "features",
    group: "dress",
    title: "Bevel edges: click edges (Ctrl- or shift-click for more), then Chamfer",
    testId: "tool-chamfer",
    run: run("chamfer"),
    contextOn: "edge",
  },
];
