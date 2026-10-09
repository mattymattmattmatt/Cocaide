// Hole: drilled where a flat face was clicked, square to it.

import { facePlaneFrame, to2D } from "../../../geom/frame";
import { faceSelectorFor } from "../../../kernel/synthesize";
import { round3 } from "../names";
import type { Raw, ToolCtx, ToolDef } from "../ToolContext";

/** The new hole at the clicked point of the one selected face, or what to click first. */
export function holeFeature(ctx: ToolCtx): Raw | string {
  const { view, selection } = ctx;
  const f = view?.faces[selection.faces[0]];
  if (!ctx.doc || !view || selection.faces.length !== 1 || !f || !selection.point) return "Click a flat face where the hole goes, then Hole.";
  const s = faceSelectorFor(view.faces, selection.faces[0]);
  if (!s.ok || f.type !== "plane") return s.ok ? "A hole needs a flat face." : s.error;
  const frame = facePlaneFrame(f.normal!, f.point!);
  const c = to2D(frame, selection.point).map(round3) as [number, number];
  // In a part of several bodies, the hole drills the body that was clicked.
  return { id: ctx.nextId("hole"), op: "hole", face: s.selector, center: c, diameter: 5, depth: "through", ...(f.body ? { bodies: [f.body] } : {}) };
}

export const tools: ToolDef[] = [
  {
    id: "tool.hole",
    label: "Hole",
    icon: "hole",
    tab: "features",
    group: "dress",
    title: "Click a flat face, then Hole",
    testId: "tool-hole",
    run: (ctx) => {
      const f = holeFeature(ctx);
      if (typeof f === "string") ctx.notice(f);
      else ctx.create(f);
    },
    contextOn: "face",
    contextLabel: "Hole here",
    contextWhen: (ctx, t) => t.kind === "face" && ctx.view?.faces[t.index]?.type === "plane",
  },
];
