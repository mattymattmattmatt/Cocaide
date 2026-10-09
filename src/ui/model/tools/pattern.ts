// Linear and circular patterns of the feature selected in the tree, in the
// Pattern menu.

import { DOC_DEFS } from "../../../features/docIndex";
import type { Raw, ToolCtx, ToolDef, ToolMenuDef } from "../ToolContext";

/** The features a pattern or a mirror can repeat: the built-in ones and the registry ops marked patternable (revolve, …). */
export const PATTERNABLE = ["extrude", "cut", "hole", "member", ...DOC_DEFS.filter((d) => d.patternable).map((d) => d.op)];

/** "an extrude, cut, hole, member or revolve": what a pattern repeats, for messages. */
const PATTERNABLE_TEXT = `an ${PATTERNABLE.slice(0, -1).join(", ")} or ${PATTERNABLE.at(-1)}`;

const PATTERN_MENU: ToolMenuDef = {
  id: "pattern",
  label: "Pattern",
  icon: "pattern",
  title: "Repeat the selected feature in a row or around an axis",
  testId: "tool-pattern",
};

/** The new pattern of the selected feature, or what to select first. */
export function patternFeature(ctx: ToolCtx, op: "linearPattern" | "circularPattern"): Raw | string {
  const { selected } = ctx;
  if (!ctx.doc || !selected || !PATTERNABLE.includes(String(selected.op))) {
    return `Select ${PATTERNABLE_TEXT} in the feature tree, then Pattern.`;
  }
  const id = ctx.nextId(op === "linearPattern" ? "pattern" : "circular");
  return op === "linearPattern"
    ? { id, op, feature: selected.id, direction: [1, 0, 0], spacing: 10, count: 3 }
    : { id, op, feature: selected.id, axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: 4 };
}

const run = (op: "linearPattern" | "circularPattern") => (ctx: ToolCtx) => {
  const f = patternFeature(ctx, op);
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
];
