// What the sketcher remembers between sketches in this browser, as SOLIDWORKS
// does: the tool each flyout button shows (the one used last) and each tool's
// options (a polygon's sides). A convenience only: anything missing, stale or
// unreadable falls back to the defaults.

import type { SketchToolDef, ToolOptions } from "./types";

export interface ToolMemory {
  /** Flyout id -> the name of the tool it shows. */
  flyouts: Record<string, string>;
  /** Tool name -> its options. */
  options: Record<string, ToolOptions>;
}

const KEY = "cocaide.sketchTools.v1";

export function loadMemory(): ToolMemory {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null") as Partial<ToolMemory> | null;
    const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    return { flyouts: obj(raw?.flyouts) as ToolMemory["flyouts"], options: obj(raw?.options) as ToolMemory["options"] };
  } catch {
    return { flyouts: {}, options: {} };
  }
}

export function saveMemory(m: ToolMemory): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(m));
  } catch {
    // Private windows may refuse: the choice still holds until the page closes.
  }
}

/** The tool a flyout shows: the one remembered if it is still one of its tools, else its first. */
export function flyoutChoice(m: ToolMemory, flyout: string, tools: SketchToolDef[]): SketchToolDef {
  const mine = tools.filter((t) => t.flyout?.id === flyout);
  return mine.find((t) => t.name === m.flyouts[flyout]) ?? mine[0];
}

/** The memory after a tool is picked: its flyout shows it from now on. */
export function remember(m: ToolMemory, tool: SketchToolDef): ToolMemory {
  return tool.flyout ? { ...m, flyouts: { ...m.flyouts, [tool.flyout.id]: tool.name } } : m;
}
