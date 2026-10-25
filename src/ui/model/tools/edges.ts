// Fillet and Chamfer: on the edges and faces picked in the view; with nothing
// picked, a session opens with its edge field ready for picks (command-first).
// The radius or distance reads the part: about a tenth of the narrowest face
// beside the edges, or the one used last when that still suits them.

import { edgesSelectorFor, facesSelectorFor } from "../../../kernel/synthesize";
import { edgeLimit, filletRadiusFor, suits } from "../smartDefaults";
import { recalled } from "../toolMemory";
import type { Raw, ToolCtx, ToolDef } from "../ToolContext";

/** The edges a fillet or chamfer on this selection treats: the edges picked and every edge of the faces picked. */
function treatedEdges(ctx: ToolCtx): number[] {
  const { view, selection } = ctx;
  if (!view) return [];
  const fromFaces = view.edges.filter((e) => !e.seam && e.faces.some((f) => selection.faces.includes(f))).map((e) => e.index);
  return [...new Set([...selection.edges, ...fromFaces])];
}

/** The radius (fillet) or distance (chamfer) a new one starts with on these edges: the last used if it suits them, else a tenth of the narrowest face beside them. */
export function edgeSize(ctx: ToolCtx, op: "fillet" | "chamfer", edges: number[]): number {
  const key = op === "fillet" ? "radius" : "distance";
  const last = recalled(ctx.memory, op, key);
  if (!ctx.view || !edges.length) return suits(last) ? last : 1;
  if (suits(last, edgeLimit(ctx.view, edges))) return last;
  return filletRadiusFor(ctx.view, edges);
}

/**
 * The new fillet or chamfer on the selected edges and (as CAD users expect) every
 * edge of the selected faces; or what to click first.
 */
export function edgeFeature(ctx: ToolCtx, op: "fillet" | "chamfer"): Raw | string {
  const { view, selection } = ctx;
  if (!ctx.doc || !view || (selection.edges.length === 0 && selection.faces.length === 0)) {
    return `Click one or more edges (shift-click for more), or faces to treat all their edges, then ${op === "fillet" ? "Fillet" : "Chamfer"}.`;
  }
  const out: Raw = { id: ctx.nextId(op), op };
  if (selection.edges.length) {
    const s = edgesSelectorFor(view.edges, view.faces, selection.edges);
    if (!s.ok) return s.error;
    out.edges = s.selector;
  }
  if (selection.faces.length) {
    const s = facesSelectorFor(view.faces, selection.faces);
    if (!s.ok) return s.error;
    out.faces = s.selector;
  }
  const size = edgeSize(ctx, op, treatedEdges(ctx));
  return { ...out, ...(op === "fillet" ? { radius: size } : { distance: size }) };
}

/** A new fillet or chamfer with nothing picked yet: its session opens with the edges field waiting for picks. */
export function edgeDraft(ctx: ToolCtx, op: "fillet" | "chamfer"): Raw {
  const size = edgeSize(ctx, op, []);
  return { id: ctx.nextId(op), op, ...(op === "fillet" ? { radius: size } : { distance: size }) };
}

const run = (op: "fillet" | "chamfer") => (ctx: ToolCtx) => {
  const f = edgeFeature(ctx, op);
  if (typeof f !== "string") return ctx.create(f);
  // Command-first: open it, the edges to come.
  if (ctx.draft && ctx.doc && ctx.view && ctx.view.bodies.length) return ctx.draft(edgeDraft(ctx, op), { active: "edges" });
  ctx.notice(f);
};

export const tools: ToolDef[] = [
  {
    id: "tool.fillet",
    label: "Fillet",
    icon: "fillet",
    tab: "features",
    group: "dress",
    title: "Round edges: click edges (Ctrl- or shift-click for more), then Fillet; or Fillet first, then click the edges",
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
    title: "Bevel edges: click edges (Ctrl- or shift-click for more), then Chamfer; or Chamfer first, then click the edges",
    testId: "tool-chamfer",
    run: run("chamfer"),
    contextOn: "edge",
  },
];
