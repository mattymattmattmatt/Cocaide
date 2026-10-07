// The document as the UI holds it: the editor text, an undo history of
// committed snapshots, and dispatch(command) for every structured edit.
//
// Structured edits (tree, forms, sketcher) go through apply() and become a
// history entry at once. Typing in the JSON editor becomes one entry when the
// text parses and the typing pauses.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { apply, type Command, type RawDocument } from "../doc/commands";
import { formatDocument, parseDocumentText, type ParseResult } from "../doc/format";
import { canRedo, canUndo, createHistory, record, redo as redoHistory, undo as undoHistory } from "../doc/history";

const TYPING_COMMIT_MS = 800;

export interface DocumentState {
  text: string;
  parsed: ParseResult;
  /** The parsed document when it is a JSON object with a features array. */
  doc: RawDocument | null;
  savedText: string;
  canUndo: boolean;
  canRedo: boolean;
  /** Apply a command. Returns the error text when it was rejected. */
  dispatch(cmd: Command): string | null;
  /** Replace the document with one already checked (an accepted proposal): one undo step. */
  replaceDoc(doc: RawDocument): void;
  /** Replace the whole text (typing in the JSON editor). */
  setText(text: string): void;
  /** Load a new document: resets history. */
  load(text: string): void;
  markSaved(text: string): void;
  undo(): void;
  redo(): void;
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
  /** Record the current text as a history state if it parses. */
  const commitTyping = useCallback(() => {
    cancelPending();
    if (parseDocumentText(textRef.current).ok) history.current = record(history.current, textRef.current);
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
      history.current = record(history.current, next);
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

  const undo = useCallback(() => {
    commitTyping();
    history.current = undoHistory(history.current);
    show(history.current.present);
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

  const typedSinceCommit = text !== history.current.present && parsed.ok;
  return {
    text,
    parsed,
    doc,
    savedText,
    canUndo: canUndo(history.current) || typedSinceCommit,
    canRedo: canRedo(history.current) && !typedSinceCommit,
    dispatch,
    replaceDoc,
    setText,
    load,
    markSaved: setSavedText,
    undo,
    redo,
  };
}

function isDoc(v: unknown): v is RawDocument {
  return typeof v === "object" && v !== null && Array.isArray((v as { features?: unknown }).features);
}
