// Undo is a stack of document snapshots. The solid is a function of the
// document, so restoring a snapshot restores the solid.
//
// A transaction (a feature session: a tool's new feature, or Edit feature)
// gathers many changes into one step. While it is open, every change records
// inside it, undo and redo step through its changes, and it ends one of two
// ways: commit makes the whole of it one undo step named for what it did
// ("Add fillet_2"), or none when nothing changed; rollback puts the document
// back exactly as it was when it began, with no undo step at all.

export interface History {
  past: string[];
  present: string;
  future: string[];
  /** What each undo step did ("Add fillet_2"), parallel to `past` ("" when it has no name). */
  pastLabels?: string[];
  /** What each redo step does, parallel to `future`. */
  futureLabels?: string[];
  /** The transaction open now, if any. */
  tx?: Transaction;
}

/** The changes of one feature session, on their way to becoming one undo step. */
export interface Transaction {
  /** The name of the step it becomes: "Add fillet_2", "Edit extrude_1". */
  label: string;
  /** The document before it began: what rollback puts back. */
  base: string;
  /** The state it opened with (the base, or the base with the new feature in it): undo inside it stops here. */
  floor: string;
  /** The states between the floor and the present, oldest first: undo inside it steps back through them. */
  steps: string[];
  /** Redo inside it, next first. */
  redo: string[];
}

const LIMIT = 200;
/**
 * Undo keeps whole documents, and a part holding an imported STEP file is
 * megabytes each: past this many characters in all, the oldest go (at least
 * MIN_KEEP stay), so a big import doesn't run the page out of memory. A few
 * steps are always kept: at the 50 MB a part may hold, that is 150 MB.
 */
export const HISTORY_CHARS = 200 * 1024 * 1024;
const MIN_KEEP = 3;

export function createHistory(present: string): History {
  return { past: [], present, future: [] };
}

/** The labels of the past and the future, as long as they are ("" where none was given). */
function labels(h: History): { past: string[]; future: string[] } {
  const pad = (list: string[] | undefined, n: number) => Array.from({ length: n }, (_, i) => list?.[i] ?? "");
  return { past: pad(h.pastLabels, h.past.length), future: pad(h.futureLabels, h.future.length) };
}

/** A new step on the past (the oldest go past LIMIT or the character budget); redo is cleared. */
function pushPast(h: History, before: string, next: string, label: string, budget: number): History {
  const past = [...h.past, before];
  const names = [...labels(h).past, label];
  while (past.length > LIMIT) {
    past.shift();
    names.shift();
  }
  let total = past.reduce((n, t) => n + t.length, 0);
  while (past.length > MIN_KEEP && total > budget) {
    total -= past.shift()!.length;
    names.shift();
  }
  const { tx: _tx, ...rest } = h;
  return { ...rest, past, pastLabels: names, present: next, future: [], futureLabels: [] };
}

/**
 * Records a new state. Identical text is not a new state. Outside a
 * transaction it is a new undo step (named `label`) and redo is cleared;
 * inside one it is a change within it.
 */
export function record(h: History, next: string, budget = HISTORY_CHARS, label = ""): History {
  if (next === h.present) return h;
  if (h.tx) return { ...h, present: next, tx: { ...h.tx, steps: [...h.tx.steps, h.present].slice(-LIMIT), redo: [] } };
  return pushPast(h, h.present, next, label, budget);
}

/** One step back: inside a transaction, its last change (none at its floor); else the last undo step. */
export function undo(h: History): History {
  if (h.tx) {
    const { steps, redo } = h.tx;
    if (steps.length === 0) return h;
    return { ...h, present: steps[steps.length - 1], tx: { ...h.tx, steps: steps.slice(0, -1), redo: [h.present, ...redo] } };
  }
  if (h.past.length === 0) return h;
  const l = labels(h);
  return {
    ...h,
    past: h.past.slice(0, -1),
    pastLabels: l.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [h.present, ...h.future],
    futureLabels: [l.past[l.past.length - 1], ...l.future],
  };
}

/** One step forward: inside a transaction, the change it undid last; else the last undo step undone. */
export function redo(h: History): History {
  if (h.tx) {
    const [next, ...rest] = h.tx.redo;
    if (next === undefined) return h;
    return { ...h, present: next, tx: { ...h.tx, steps: [...h.tx.steps, h.present], redo: rest } };
  }
  if (h.future.length === 0) return h;
  const l = labels(h);
  return {
    ...h,
    past: [...h.past, h.present],
    pastLabels: [...l.past, l.future[0]],
    present: h.future[0],
    future: h.future.slice(1),
    futureLabels: l.future.slice(1),
  };
}

/** Is there something undo() would step back to (inside a transaction: a change within it)? */
export const canUndo = (h: History) => (h.tx ? h.tx.steps.length > 0 : h.past.length > 0);
/** Is there something redo() would bring back? */
export const canRedo = (h: History) => (h.tx ? h.tx.redo.length > 0 : h.future.length > 0);

/** The name of the step undo would take back ("" when it has none, or there is none). */
export function undoLabel(h: History): string {
  if (h.tx) return h.tx.label;
  return labels(h).past.at(-1) ?? "";
}

/** The name of the step redo would bring back. */
export function redoLabel(h: History): string {
  if (h.tx) return "";
  return labels(h).future[0] ?? "";
}

/** Is a transaction open? */
export const inTransaction = (h: History) => h.tx !== undefined;

/**
 * Opens a transaction named `label`. `opening`, when given, is the state it
 * opens with (the document with the new feature added): it is part of the
 * transaction (rollback takes it away), but undo inside it does not. One
 * transaction at a time: opening a second while one is open is refused.
 */
export function beginTransaction(h: History, label: string, opening?: string): History {
  if (h.tx) throw new Error(`"${h.tx.label}" is still open: finish it (OK or Cancel) before starting another`);
  const floor = opening ?? h.present;
  return { ...h, present: floor, tx: { label, base: h.present, floor, steps: [], redo: [] } };
}

/** Renames the open transaction (the feature it adds was renamed: "Add boss"). */
export function relabelTransaction(h: History, label: string): History {
  return h.tx ? { ...h, tx: { ...h.tx, label } } : h;
}

/**
 * Closes the transaction as one undo step named `label` (default: its own
 * name) from the document as it was before it to the document now. Nothing
 * changed: no step. Redo, as with any new step, is cleared then.
 */
export function commitTransaction(h: History, label?: string, budget = HISTORY_CHARS): History {
  if (!h.tx) return h;
  const { tx, ...rest } = h;
  if (h.present === tx.base) return rest;
  return pushPast(h, tx.base, h.present, label ?? tx.label, budget);
}

/** Closes the transaction with the document exactly as it was before it began: no undo step, and redo kept. */
export function rollbackTransaction(h: History): History {
  if (!h.tx) return h;
  const { tx, ...rest } = h;
  return { ...rest, present: tx.base };
}

/**
 * Undo at a transaction's floor (nothing left to step back inside it) closes
 * it: a transaction that changed the document becomes its one undo step and
 * that step is undone at once (so the document is as it was, and redo brings
 * the whole of it back); one that changed nothing simply closes.
 */
export function undoOutOf(h: History, budget = HISTORY_CHARS): History {
  if (!h.tx) return h;
  if (h.present === h.tx.base) return rollbackTransaction(h);
  return undo(commitTransaction(h, undefined, budget));
}

/** Has the open transaction changed the document (is there anything Cancel would put back)? */
export const transactionChanged = (h: History) => !!h.tx && h.present !== h.tx.base;
