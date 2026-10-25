// The document as the UI holds it: the editor text, an undo history of
// committed snapshots, and dispatch(command) for every structured edit.
//
// Structured edits (tree, forms, sketcher) go through apply() and become a
// history entry at once. Typing in the JSON editor becomes one entry when the
// text parses and the typing pauses.
//
// A feature session (a tool's new feature, Edit feature) is a transaction
// (src/doc/history.ts): begin() opens it, every edit and every pause in the
// JSON editor's typing until then is a change inside it (undo and redo step
// through them), and commit() makes it one undo step named for it, or
// rollback() puts the document back exactly as it was.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { apply, type Command, type RawDocument } from "../doc/commands";
import { formatDocument, parseDocumentText, type ParseResult } from "../doc/format";
import {
  beginTransaction,
  canRedo,
  canUndo,
  commitTransaction,
  createHistory,
  record,
  redo as redoHistory,
  redoLabel,
  relabelTransaction,
  rollbackTransaction,
  transactionChanged,
  undo as undoHistory,
  undoLabel,
  undoOutOf,
  HISTORY_CHARS,
} from "../doc/history";

const TYPING_COMMIT_MS = 800;

/** What undo did: stepped back inside the session, closed the session (it is undone whole), stepped back in the history, or nothing. */
export type UndoResult = "within" | "closed" | "history" | "none";

/** The open feature session, as the document sees it. */
export interface DocTransaction {
  /** Its name, and the name of the undo step it becomes: "Add fillet_2". */
  label: string;
  /** Has it changed the document (would Cancel put anything back)? */
  changed: boolean;
  /** Can undo step back inside it (else undo closes it)? */
  canUndoWithin: boolean;
}

export interface DocumentState {
  text: string;
  parsed: ParseResult;
  /** The parsed document when it is a JSON object with a features array. */
  doc: RawDocument | null;
  savedText: string;
  canUndo: boolean;
  canRedo: boolean;
  /** What undo and redo would do, for their tooltips ("Add fillet_2"; "" when unnamed). */
  undoLabel: string;
  redoLabel: string;
  /** Apply a command. Returns the error text when it was rejected. */
  dispatch(cmd: Command): string | null;
  /** Replace the document with one already checked (an accepted proposal): one undo step. */
  replaceDoc(doc: RawDocument): void;
  /** Replace the whole text (typing in the JSON editor). */
  setText(text: string): void;
  /** Load a new document: resets history (and ends any session). */
  load(text: string): void;
  markSaved(text: string): void;
  undo(): UndoResult;
  redo(): void;
  /** The open session, or null. */
  transaction: DocTransaction | null;
  /**
   * Opens a session named `label`; `opening` is the command it opens with
   * (the new feature's addFeature), applied as part of it: when that is
   * refused, no session opens and the error is returned.
   */
  begin(label: string, opening?: Command): string | null;
  /** Closes the session as one undo step (named `label`, default its own), or none if nothing changed. */
  commit(label?: string): void;
  /** Closes the session with the document exactly as it was before it. */
  rollback(): void;
  /** Renames the open session (its feature was renamed). */
  relabel(label: string): void;
}

/** A command, as the name of its undo step: "Add fillet_2", "Delete hole_1", "Edit extrude_1". */
export function commandLabel(cmd: Command): string {
  const c = cmd as { type: string; id?: unknown; feature?: { id?: unknown } };
  const id = typeof c.id === "string" ? c.id : typeof c.feature?.id === "string" ? c.feature.id : "";
  switch (c.type) {
    case "addFeature":
      return `Add ${id}`;
    case "deleteFeature":
      return `Delete ${id}`;
    case "updateFeature":
    case "replaceFeature":
      return `Edit ${id}`;
    case "suppressFeature":
      return `Suppress ${id}`;
    case "reorderFeature":
      return `Move ${id}`;
    case "setRollback":
      return "Move the rollback bar";
    default: {
      // "setParameter" → "Set parameter".
      const words = c.type.replace(/([A-Z])/g, " $1").toLowerCase();
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

export function useDocument(initial: { text: string; savedText: string }): DocumentState {
  // History and text live in refs so every handler sees the latest values;
  // a counter re-renders. No state updater has side effects.
  const history = useRef(createHistory(initial.text));
  const textRef = useRef(initial.text);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [savedText, setSavedText] = useState(initial.savedText);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const text = textRef.current;
  const parsed = useMemo(() => parseDocumentText(text), [text]);
  const doc = parsed.ok && isDoc(parsed.value) ? parsed.value : null;

  const cancelPending = () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
  };
  /** Record the current text as a history state if it parses (inside a session: a change within it). */
  const commitTyping = useCallback(() => {
    cancelPending();
    if (parseDocumentText(textRef.current).ok) history.current = record(history.current, textRef.current, HISTORY_CHARS, "Edit the JSON");
  }, []);
  useEffect(() => cancelPending, []);

  const show = (next: string) => {
    textRef.current = next;
    rerender();
  };

  const setText = useCallback(
    (next: string) => {
      show(next);
      cancelPending();
      pending.current = setTimeout(() => {
        commitTyping();
        rerender();
      }, TYPING_COMMIT_MS);
    },
    [commitTyping],
  );

  const dispatch = useCallback(
    (cmd: Command): string | null => {
      const current = parseDocumentText(textRef.current);
      if (!current.ok) return `fix the JSON first: ${current.error}`;
      // Everything dispatched here is the person at the app.
      const result = apply(current.value, cmd, { user: true });
      if (!result.ok) return result.error;
      commitTyping();
      const next = formatDocument(result.doc);
      history.current = record(history.current, next, HISTORY_CHARS, commandLabel(cmd));
      show(next);
      return null;
    },
    [commitTyping],
  );

  const replaceDoc = useCallback(
    (next: RawDocument) => {
      commitTyping();
      const text = formatDocument(next);
      history.current = record(history.current, text);
      show(text);
    },
    [commitTyping],
  );

  const undo = useCallback((): UndoResult => {
    commitTyping();
    const h = history.current;
    if (h.tx) {
      // Inside a session: its last change; at its start, the session closes (undone whole, so redo brings it back).
      if (canUndo(h)) {
        history.current = undoHistory(h);
        show(history.current.present);
        return "within";
      }
      history.current = undoOutOf(h);
      show(history.current.present);
      return "closed";
    }
    if (!canUndo(h)) return "none";
    history.current = undoHistory(h);
    show(history.current.present);
    return "history";
  }, [commitTyping]);

  const redo = useCallback(() => {
    commitTyping();
    history.current = redoHistory(history.current);
    show(history.current.present);
  }, [commitTyping]);

  const load = useCallback((next: string) => {
    cancelPending();
    history.current = createHistory(next);
    setSavedText(next);
    show(next);
  }, []);

  const begin = useCallback(
    (label: string, opening?: Command): string | null => {
      commitTyping();
      if (history.current.tx) return `"${history.current.tx.label}" is still open: OK or Cancel it first`;
      let open: string | undefined;
      if (opening) {
        const current = parseDocumentText(textRef.current);
        if (!current.ok) return `fix the JSON first: ${current.error}`;
        const result = apply(current.value, opening, { user: true });
        if (!result.ok) return result.error;
        open = formatDocument(result.doc);
      }
      history.current = beginTransaction(history.current, label, open);
      show(history.current.present);
      return null;
    },
    [commitTyping],
  );

  const commit = useCallback(
    (label?: string) => {
      commitTyping();
      history.current = commitTransaction(history.current, label);
      show(history.current.present);
    },
    [commitTyping],
  );

  const rollback = useCallback(() => {
    cancelPending();
    history.current = rollbackTransaction(history.current);
    show(history.current.present);
  }, []);

  const relabel = useCallback((label: string) => {
    history.current = relabelTransaction(history.current, label);
    rerender();
  }, []);

  const h = history.current;
  const typedSinceCommit = text !== h.present && parsed.ok;
  return {
    text,
    parsed,
    doc,
    savedText,
    // In a session undo always does something: steps back inside it, or closes it.
    canUndo: !!h.tx || canUndo(h) || typedSinceCommit,
    canRedo: canRedo(h) && !typedSinceCommit,
    undoLabel: undoLabel(h),
    redoLabel: redoLabel(h),
    dispatch,
    replaceDoc,
    setText,
    load,
    markSaved: setSavedText,
    undo,
    redo,
    transaction: h.tx ? { label: h.tx.label, changed: transactionChanged(h) || typedSinceCommit, canUndoWithin: canUndo(h) } : null,
    begin,
    commit,
    rollback,
    relabel,
  };
}

function isDoc(v: unknown): v is RawDocument {
  return typeof v === "object" && v !== null && Array.isArray((v as { features?: unknown }).features);
}
