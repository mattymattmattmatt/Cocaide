// The command palette (Ctrl+K): every tool and command by name, ranked as
// you type. Pure ranking, so Vitest covers it; the panel is CommandPalette.tsx.

export interface PaletteEntry {
  /** The command id ("tool.fillet", "view.top"): its test id is palette-<id>. */
  id: string;
  label: string;
  /** Where it lives: "Features", "View", "General"… */
  group: string;
  /** Other words it answers to ("round" for Fillet). */
  keywords?: string;
  /** Its key, shown beside it. */
  key?: string | null;
  /** Why it can't run now (shown, and it is skipped by Enter), or undefined. */
  disabled?: string;
  run(): void;
}

/** How well `text` answers `query` (higher is better; 0: not at all). */
export function score(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 60;
  // Every word of the query starts a word of the text ("hid lin" → Hidden lines).
  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => words.some((w) => w.startsWith(p)))) return 50;
  if (t.includes(q)) return 40;
  // The query's letters in order ("fllt" → Fillet).
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 10 : 0;
}

/** The entries that answer the query, best first; ties keep their order. */
export function searchPalette(entries: PaletteEntry[], query: string, limit = 40): PaletteEntry[] {
  return entries
    .map((e, i) => ({ e, i, s: Math.max(score(e.label, query), Math.max(...(e.keywords ?? "").split(",").map((k) => (k.trim() ? score(k.trim(), query) - 5 : 0)), 0), score(`${e.group} ${e.label}`, query) - 20) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}
