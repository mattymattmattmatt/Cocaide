// The app's feature session (Phase P wave 2): opening one (a tool's new
// feature, a new feature still waiting for its picks, Edit feature), OK and
// Cancel, the question asked before something that needs it finished, the
// panel kept open for another of the same, and the values kept for the next
// one. The document side is useDocument's transaction; the rules are pure, in
// session.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RebuildView } from "../../worker/protocol";
import type { DocumentState } from "../useDocument";
import { addCommand, guardText, mergePatch, okProblem, pendingWords, sessionLabel, type FeatureSession, type SessionGuard } from "./session";
import { loadToolMemory, rememberFrom, saveToolMemory, type ToolMemory } from "./toolMemory";

type Raw = Record<string, unknown>;

const PIN_KEY = "cocaide.sessionPin.v1";

function loadPin(): boolean {
  try {
    return localStorage.getItem(PIN_KEY) === "1";
  } catch {
    return false;
  }
}

export interface SessionDeps {
  d: DocumentState;
  /** The newest rebuild of the whole part (the feature's status). */
  view: RebuildView | null;
  selectedFeature: string | null;
  /** Selects a feature in the tree and shows its properties (null: none). */
  select(id: string | null): void;
  notice(kind: "info" | "error", text: string): void;
  clearSelection(): void;
  /** Runs a tool again (the panel kept open). */
  runTool(id: string): void;
  /** What a pending feature waits on, in the panel's words (its empty selection field's prompt: "Pick edges to fillet"), or null. */
  needs?: string | null;
  /** Cancel put the document back: the view may show the part as it was at once, before its rebuild comes. */
  restored?(): void;
}

export interface SessionApi {
  session: FeatureSession | null;
  /** A tool's new feature: into the document in a session. False when it couldn't open. */
  openCreate(feature: Raw, tool?: string): boolean;
  /** A tool's new feature still waiting for picks (command-first); `complete` settles its numbers once they are there. */
  openDraft(feature: Raw, opts?: { tool?: string; active?: string; complete?: (f: Raw) => Raw }): boolean;
  /** Edit feature: a session on a feature in the document. */
  openEdit(id: string): boolean;
  /** OK: keeps it as one undo step. `force`: even with its error. False when it can't yet (and says why). */
  ok(force?: boolean): boolean;
  /** Cancel: the part as it was. */
  cancel(): void;
  /**
   * Something that needs no session open (`what`: "open Fillet"): runs at once
   * when none is; else keeps the open one first when `keep` and it can be
   * kept quietly; else asks. True when `then` ran now.
   */
  finishFirst(what: string, then: () => void, keep?: boolean): boolean;
  /** The question asked, if any. */
  guard: SessionGuard | null;
  guardText: string;
  answer(choice: "ok" | "keepError" | "cancel" | "back"): void;
  /** A change to a pending feature. */
  onDraft(patch: Raw): string | null;
  onRenamed(from: string, to: string): void;
  keepOpen: boolean;
  setKeepOpen(on: boolean): void;
  memory: ToolMemory;
}

export function useFeatureSession(deps: SessionDeps): SessionApi {
  const [session, setSessionState] = useState<FeatureSession | null>(null);
  const [guard, setGuard] = useState<SessionGuard | null>(null);
  const [keepOpen, setKeepOpenState] = useState(loadPin);
  const [memory, setMemory] = useState<ToolMemory>(loadToolMemory);
  // Handlers read the newest state (they run from listeners made earlier).
  const live = useRef({ session, deps, memory, keepOpen, guard });
  live.current = { session, deps, memory, keepOpen, guard };
  const setSession = (s: FeatureSession | null) => {
    live.current.session = s;
    setSessionState(s);
  };
  const { d } = deps;

  // The session ends with its transaction: an undo past its start, a new document.
  useEffect(() => {
    if (session && !d.transaction) {
      setSession(null);
      setGuard(null);
    }
  }, [session, d.transaction]);

  const start = (s: FeatureSession, opening?: Parameters<DocumentState["begin"]>[1]): boolean => {
    const { deps } = live.current;
    const problem = deps.d.begin(sessionLabel(s), opening);
    if (problem) {
      deps.notice("error", problem);
      return false;
    }
    setSession(s);
    deps.select(s.id);
    deps.clearSelection();
    return true;
  };

  const openCreate = (feature: Raw, tool?: string) => {
    const id = String(feature.id);
    return start({ id, originalId: id, kind: "create", op: String(feature.op), tool, previous: live.current.deps.selectedFeature }, addCommand(feature));
  };

  const openDraft = (feature: Raw, opts: { tool?: string; active?: string; complete?: (f: Raw) => Raw } = {}) => {
    const id = String(feature.id);
    // It may be complete after all (the tool's defaults are enough): then it goes in at once.
    return start({ id, originalId: id, kind: "create", op: String(feature.op), tool: opts.tool, previous: live.current.deps.selectedFeature, pending: feature, active: opts.active, complete: opts.complete });
  };

  const openEdit = (id: string) => {
    const f = live.current.deps.d.doc?.features.find((g) => g.id === id);
    if (!f) return false;
    return start({ id, originalId: id, kind: "edit", op: String(f.op), previous: id });
  };

  const close = () => {
    setSession(null);
    setGuard(null);
    // At once, not at the next render: what runs straight after OK or Cancel (the action that asked to finish first) sees no session.
    live.current = { ...live.current, session: null };
  };

  const ok = (force = false): boolean => {
    const { session: s, deps } = live.current;
    if (!s) return false;
    const why = okProblem(s, deps.needs);
    if (why) {
      deps.notice("error", why);
      return false;
    }
    const failing = deps.view?.features.find((f) => f.id === s.id)?.error;
    if (failing && !force) {
      setGuard({ what: "carry on", then: () => undefined, failing: failing.replace(`${s.id}: `, ""), onOk: true });
      return false;
    }
    const kept = deps.d.doc?.features.find((f) => f.id === s.id);
    deps.d.commit(sessionLabel(s));
    close();
    if (kept) {
      const next = rememberFrom(live.current.memory, kept);
      if (next !== live.current.memory) {
        setMemory(next);
        saveToolMemory(next);
      }
    }
    // The panel kept open: the same tool again, for the next one.
    if (live.current.keepOpen && s.kind === "create" && s.tool) {
      const tool = s.tool;
      setTimeout(() => live.current.deps.runTool(tool), 0);
    }
    return true;
  };

  const cancel = () => {
    const { session: s, deps } = live.current;
    if (!s) return;
    deps.d.rollback();
    close();
    deps.restored?.();
    deps.select(s.kind === "create" ? s.previous : s.originalId);
  };

  const finishFirst = (what: string, then: () => void, keep = false): boolean => {
    const { session: s, deps } = live.current;
    if (!s) {
      then();
      return true;
    }
    // A feature opened to look at and left as it was (nothing changed): it simply closes, nothing to ask.
    if (s.kind === "edit" && deps.d.transaction && !deps.d.transaction.changed) {
      deps.d.commit();
      close();
      then();
      return true;
    }
    const failing = deps.view?.features.find((f) => f.id === s.id)?.error;
    const noKeep = okProblem(s, deps.needs) ?? undefined;
    if (keep && !noKeep && !failing) {
      ok();
      then();
      return true;
    }
    setGuard({ what, then, noKeep, failing: failing?.replace(`${s.id}: `, "") });
    return false;
  };

  const answer = (choice: "ok" | "keepError" | "cancel" | "back") => {
    const g = live.current.guard;
    setGuard(null);
    if (!g || choice === "back") return;
    if (choice === "cancel") cancel();
    else if (!ok(choice === "keepError")) return;
    g.then();
  };

  const onDraft = (patch: Raw): string | null => {
    const { session: s, deps } = live.current;
    if (!s?.pending) return null;
    const next = mergePatch(s.pending, patch);
    const id = String(next.id);
    // The numbers that read the part settle with the picks that complete it (as selection-first has them); kept pending, it stays as typed.
    const problem = deps.d.open(addCommand(s.complete ? s.complete(next) : next));
    if (!problem) {
      setSession({ ...s, id, pending: undefined, pendingProblem: undefined });
      if (id !== s.id) {
        deps.d.relabel(sessionLabel({ kind: s.kind, id }));
        deps.select(id);
      }
      return null;
    }
    setSession({ ...s, id, pending: next, pendingProblem: pendingWords(problem, id) });
    if (id !== s.id) deps.select(id);
    return null;
  };

  const onRenamed = (from: string, to: string) => {
    const s = live.current.session;
    if (!s || s.id !== from) return;
    setSession({ ...s, id: to });
    live.current.deps.d.relabel(sessionLabel({ kind: s.kind, id: to }));
  };

  const setKeepOpen = useCallback((on: boolean) => {
    setKeepOpenState(on);
    try {
      localStorage.setItem(PIN_KEY, on ? "1" : "0");
    } catch {
      // not kept: fine
    }
  }, []);

  // A draft that is complete already (the tool's defaults are enough) goes in at once.
  useEffect(() => {
    if (session?.pending && !session.pendingProblem) onDraft({});
  }, [session?.pending]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    session,
    openCreate,
    openDraft,
    openEdit,
    ok,
    cancel,
    finishFirst,
    guard,
    guardText: session && guard ? guardText(session, guard) : "",
    answer,
    onDraft,
    onRenamed,
    keepOpen,
    setKeepOpen,
    memory,
  };
}
