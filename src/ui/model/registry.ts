// Reading the model tool registry: a tool by id, the toolbar laid out tab by
// tab, and the tools a right-click offers. Pure, so its rules are tested in node.

import { TABS, type TabDef } from "./tabs";
import type { ContextKind, ContextTarget, ToolCtx, ToolDef, ToolItem, ToolMenuDef, ToolTab } from "./ToolContext";
import { MODEL_TOOLS } from "./tools";

export { MODEL_TOOLS };

export function toolById(id: string, tools: ToolDef[] = MODEL_TOOLS): ToolDef | undefined {
  return tools.find((t) => t.id === id);
}

/** One place on a toolbar: a tool's button, or a dropdown of the tools that share a menu. */
export type ToolbarEntry = { kind: "tool"; tool: ToolDef } | { kind: "menu"; menu: ToolMenuDef; tools: ToolDef[] };

/**
 * A tab's tools (or the pinned ones), group by group: the tab's own group
 * order first, then any other group in the order its first tool is listed.
 * Within a group, tools keep their registry order; tools that share a menu id
 * become one dropdown where the first of them is.
 */
export function toolbarGroups(tab: ToolTab | "pinned", tools: ToolDef[] = MODEL_TOOLS): ToolbarEntry[][] {
  const mine = tools.filter((t) => t.tab === tab);
  const order = TABS.find((t) => t.id === tab)?.groups ?? [];
  const listed = [...new Set(mine.map((t) => t.group ?? ""))];
  const rank = (g: string) => (order.includes(g) ? order.indexOf(g) : order.length + listed.indexOf(g));
  const names = [...listed].sort((a, b) => rank(a) - rank(b));
  return names.map((g) => {
    const entries: ToolbarEntry[] = [];
    for (const t of mine.filter((x) => (x.group ?? "") === g)) {
      const menu = t.menu ? entries.find((e): e is Extract<ToolbarEntry, { kind: "menu" }> => e.kind === "menu" && e.menu.id === t.menu!.id) : undefined;
      if (menu) menu.tools.push(t);
      else entries.push(t.menu ? { kind: "menu", menu: t.menu, tools: [t] } : { kind: "tool", tool: t });
    }
    return entries;
  });
}

/** The tabs that have tools, in TABS order. */
export function visibleTabs(tools: ToolDef[] = MODEL_TOOLS): TabDef[] {
  return TABS.filter((tab) => tools.some((t) => t.tab === tab.id));
}

/** The tools a right-click on this kind of thing offers, in registry order. */
export function contextTools(kind: ContextKind, tools: ToolDef[] = MODEL_TOOLS): ToolDef[] {
  return tools.filter((t) => (Array.isArray(t.contextOn) ? t.contextOn.includes(kind) : t.contextOn === kind));
}

/** Every tool's own right-click entries for this target (contextItems), in registry order, each with its tool. */
export function contextEntries(ctx: ToolCtx, target: ContextTarget, tools: ToolDef[] = MODEL_TOOLS): { tool: ToolDef; item: ToolItem }[] {
  return tools.flatMap((tool) => (tool.contextItems?.(ctx, target) ?? []).map((item) => ({ tool, item })));
}
