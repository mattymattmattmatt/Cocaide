// Undo is a stack of document snapshots. The solid is a function of the
// document, so restoring a snapshot restores the solid.

export interface History {
  past: string[];
  present: string;
  future: string[];
}

const LIMIT = 200;

export function createHistory(present: string): History {
  return { past: [], present, future: [] };
}

/** Records a new state. Identical text is not a new state. Redo is cleared. */
export function record(h: History, next: string): History {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-LIMIT), present: next, future: [] };
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
