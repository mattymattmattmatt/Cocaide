// Undo is a stack of document snapshots. The solid is a function of the
// document, so restoring a snapshot restores the solid.

export interface History {
  past: string[];
  present: string;
  future: string[];
}

const LIMIT = 200;
/**
 * Undo keeps whole documents, and a part holding an imported STEP file is
 * megabytes each: past this many characters in all, the oldest go (at least
 * MIN_KEEP stay), so a big import doesn't run the page out of memory.
 */
export const HISTORY_CHARS = 200 * 1024 * 1024;
const MIN_KEEP = 10;

export function createHistory(present: string): History {
  return { past: [], present, future: [] };
}

/** Records a new state. Identical text is not a new state. Redo is cleared. */
export function record(h: History, next: string, budget = HISTORY_CHARS): History {
  if (next === h.present) return h;
  const past = [...h.past, h.present].slice(-LIMIT);
  let total = past.reduce((n, t) => n + t.length, 0);
  while (past.length > MIN_KEEP && total > budget) total -= past.shift()!.length;
  return { past, present: next, future: [] };
}

export function undo(h: History): History {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

export const canUndo = (h: History) => h.past.length > 0;
export const canRedo = (h: History) => h.future.length > 0;
