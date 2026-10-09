// Scale, on the Bodies tab: the clicked body (or, with one body, the part)
// made bigger or smaller about its own centroid; factor, fixed point and
// bodies are then in Properties.

import type { Raw, ToolCtx, ToolDef } from "../ToolContext";

/** The new scale: the body of the clicked face in a part of several bodies, else every body; 2 about the centroid. */
export function scaleFeature(ctx: ToolCtx): Raw | string {
  const bodies = ctx.view?.bodies ?? [];
  if (!ctx.doc || bodies.length === 0) return "Scale needs a solid: make one first.";
  const picked = ctx.selection.faces.length ? ctx.view?.faces[ctx.selection.faces[0]]?.body : undefined;
  const feature: Raw = { id: ctx.nextId("scale"), op: "scale", factor: 2, about: "centroid" };
  if (bodies.length > 1 && picked) feature.bodies = [picked];
  return feature;
}

export const tools: ToolDef[] = [
  {
    id: "tool.scale",
    label: "Scale",
    icon: "scaleBody",
    tab: "bodies",
    group: "bodies",
    title: "Make the clicked body (or the part) bigger or smaller by a factor",
    testId: "tool-scale",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "Scale needs a solid" : undefined),
    run: (ctx) => {
      const f = scaleFeature(ctx);
      if (typeof f === "string") ctx.notice(f);
      else ctx.create(f);
    },
  },
];
