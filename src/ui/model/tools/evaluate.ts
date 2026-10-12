// The Evaluate tab: Measure and Mass Properties (group "measure"), and the
// Section view (group "view"). Each opens its panel over the 3D view (or
// closes it again); the panels live in App, the numbers in src/ui/evaluate
// and the kernel.

import type { EvaluatePanel, ToolCtx, ToolDef } from "../ToolContext";

const open = (panel: EvaluatePanel) => (ctx: ToolCtx) => {
  if (!ctx.evaluate) return ctx.notice("The Evaluate panels are not available here.");
  ctx.evaluate(panel);
};

export const tools: ToolDef[] = [
  {
    id: "tool.measure",
    label: "Measure",
    icon: "measure",
    tab: "evaluate",
    group: "measure",
    title: "Measure what you click: one thing for its size, two for the distance and angle between them (stays open while you pick)",
    testId: "tool-measure",
    run: open("measure"),
  },
  {
    id: "tool.massProperties",
    label: "Mass Properties",
    icon: "massProperties",
    tab: "evaluate",
    group: "measure",
    title: "Mass, volume, area, centre of mass and moments of inertia of each body and the whole part, in their materials",
    testId: "tool-mass-properties",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "Mass Properties needs a solid: make one first" : undefined),
    run: open("mass"),
  },
  {
    id: "tool.section",
    label: "Section",
    icon: "section",
    tab: "evaluate",
    group: "view",
    title: "Section view: cut the part on a plane (Front, Top, Right, a plane feature or the selected flat face) to see inside it",
    testId: "tool-section",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "A section needs a solid to cut" : undefined),
    run: open("section"),
  },
];
