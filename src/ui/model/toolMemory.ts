// The last values used for each kind of feature, in this browser (Phase P
// wave 2): when a feature session ends with OK, its numbers are kept, so the
// next fillet starts at the radius used last (when that suits the part; see
// smartDefaults.ts). Only plain numbers and choices are kept, never an
// expression (it may name a parameter another part does not have).

type Raw = Record<string, unknown>;

/** The values kept, by op. */
export type ToolMemory = Record<string, Record<string, number | string>>;

/** Which of each op's fields are kept. */
export const REMEMBERED: Readonly<Record<string, readonly string[]>> = {
  fillet: ["radius"],
  chamfer: ["distance"],
  shell: ["thickness"],
  draft: ["angle"],
  extrude: ["distance"],
  cut: ["distance"],
  hole: ["size", "kind", "fit"],
  linearPattern: ["count"],
  circularPattern: ["count"],
};

export const TOOL_MEMORY_KEY = "cocaide.toolMemory.v1";

/** The memory with the feature's kept fields (numbers and words, not expressions) in it. */
export function rememberFrom(memory: ToolMemory, f: Raw): ToolMemory {
  const op = String(f.op);
  const keys = REMEMBERED[op];
  if (!keys) return memory;
  const kept: Record<string, number | string> = { ...(memory[op] ?? {}) };
  let changed = false;
  for (const k of keys) {
    const v = f[k];
    if ((typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && !v.startsWith("="))) {
      if (kept[k] !== v) changed = true;
      kept[k] = v;
    }
  }
  return changed ? { ...memory, [op]: kept } : memory;
}

/** What was kept for an op's field, if anything. */
export function recalled(memory: ToolMemory | undefined, op: string, key: string): number | string | undefined {
  return memory?.[op]?.[key];
}

export function loadToolMemory(): ToolMemory {
  try {
    const raw = JSON.parse(localStorage.getItem(TOOL_MEMORY_KEY) ?? "null") as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ToolMemory) : {};
  } catch {
    return {};
  }
}

export function saveToolMemory(memory: ToolMemory): void {
  try {
    localStorage.setItem(TOOL_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // storage full or blocked: the defaults still read the part
  }
}
