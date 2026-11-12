// Export body, on the Bodies tab: a STEP export of the selected bodies (else
// every body), kept in the tree; its bodies, origin, up and front are then in
// Properties, picked in the view, with Export STEP there.

import type { Raw, ToolCtx, ToolDef } from "../ToolContext";

/** The bodies the selection touches, in the part's order. */
export function selectedBodies(ctx: Pick<ToolCtx, "view" | "selection">): string[] {
  const v = ctx.view;
  if (!v) return [];
  const first = v.bodies[0]?.name;
  const names = new Set<string>();
  for (const i of ctx.selection.faces) names.add(v.faces[i]?.body ?? first ?? "");
  for (const i of ctx.selection.edges) names.add(v.edges[i]?.body ?? first ?? "");
  for (const x of ctx.selection.vertices ?? []) names.add(v.edges[x.edge]?.body ?? first ?? "");
  return v.bodies.map((b) => b.name).filter((n) => names.has(n));
}

export function exportBodyFeature(ctx: ToolCtx, bodies?: string[]): Raw | string {
  const all = ctx.view?.bodies ?? [];
  if (!ctx.doc || all.length === 0) return "Export body needs a solid: make one first.";
  const picked = bodies ?? selectedBodies(ctx);
  const feature: Raw = { id: ctx.nextId("export"), op: "exportBody" };
  if (picked.length && picked.length < all.length) feature.bodies = picked;
  return feature;
}

export const tools: ToolDef[] = [
  {
    id: "tool.exportBody",
    label: "Export body",
    icon: "export",
    tab: "bodies",
    group: "files",
    title: "Export the selected bodies (or all) as STEP, with a new origin and the up and front directions if you want; set them in Properties, then Export STEP",
    hint: "Bodies as STEP, re-placed if you want",
    testId: "tool-export-body",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "There is no solid yet" : undefined),
    run: (ctx) => {
      const f = exportBodyFeature(ctx);
      if (typeof f === "string") ctx.notice(f);
      else ctx.create(f);
    },
  },
];
