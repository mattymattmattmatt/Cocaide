// Mirror: the selected feature about the part's middle, or the clicked body
// beside itself.

import { bodyBox, yzPlane } from "./bodies";
import { PATTERNABLE } from "./pattern";
import type { Raw, ToolCtx, ToolDef } from "../ToolContext";

export function mirrorFeature(ctx: ToolCtx): Raw | string {
  const bb = ctx.view?.measurements?.boundingBox;
  if (!ctx.doc || !bb) return "Mirror needs a part to mirror.";
  const { selected } = ctx;
  if (selected && PATTERNABLE.includes(String(selected.op))) {
    return { id: ctx.nextId("mirror"), op: "mirror", plane: yzPlane((bb.min[0] + bb.max[0]) / 2), feature: selected.id };
  }
  const body = ctx.pickedBody();
  const box = body ? bodyBox(ctx, body) : null;
  if (!body || !box) return "Select a feature in the tree, or click a body, then Mirror.";
  return { id: ctx.nextId("mirror"), op: "mirror", plane: yzPlane(box.max[0]), bodies: [body] };
}

export const tools: ToolDef[] = [
  {
    id: "tool.mirror",
    label: "Mirror",
    icon: "mirror",
    tab: "features",
    group: "pattern",
    title: "Mirror the selected feature, or the clicked body, about a plane",
    testId: "tool-mirror",
    run: (ctx) => {
      const f = mirrorFeature(ctx);
      if (typeof f === "string") ctx.notice(f);
      else ctx.create(f);
    },
  },
];
