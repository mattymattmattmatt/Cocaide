// Feature sessions (Phase P wave 2): running a feature tool, or editing a
// feature, opens a session. The property panel shows the feature with OK and
// Cancel; every change previews live; OK makes the whole session one undo step
// ("Add fillet_2", "Edit extrude_1"), Cancel leaves the document exactly as it
// was. The document side is a transaction (src/doc/history.ts, useDocument);
// this module holds the session's own state and its rules, pure, so Vitest
// covers them: names, what OK needs first, a new feature not complete yet
// (command-first: its picks come after the tool), and what a tree click does
// while a session is open.

import type { Command } from "../../doc/commands";

type Raw = Record<string, unknown>;

export type SessionKind = "create" | "edit";

/** The feature open in the property panel with OK and Cancel. */
export interface FeatureSession {
  /** The feature's id now (it follows a rename). */
  id: string;
  /** Its id when the session began: Cancel selects it again (an edit). */
  originalId: string;
  kind: SessionKind;
  op: string;
  /** The tool that made it: with the panel kept open, OK runs it again. */
  tool?: string;
  /**
   * A new feature not complete yet (its edges, faces or seed are still to be
   * picked): held here, shown in the panel, and put in the document as soon as
   * a change makes it complete.
   */
  pending?: Raw;
  /** Why the pending feature is not complete: what to pick. */
  pendingProblem?: string;
  /** The feature selected in the tree before (a new feature's Cancel goes back to it). */
  previous: string | null;
  /** The selection field to make active first (its key). */
  active?: string;
}

/** The session's name, and the name of the undo step it becomes. */
export function sessionLabel(s: Pick<FeatureSession, "kind" | "id">): string {
  return `${s.kind === "create" ? "Add" : "Edit"} ${s.id}`;
}

/** The feature as the panel shows it: the document's, or the pending one. */
export function sessionFeature(s: FeatureSession, features: readonly Raw[]): Raw | undefined {
  return features.find((f) => f.id === s.id) ?? s.pending;
}

/** A pending feature with a patch merged in (null removes a key), as updateFeature merges one. */
export function mergePatch(f: Raw, patch: Raw): Raw {
  const next: Raw = { ...f, ...structuredClone(patch) };
  for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
  return next;
}

/** The command that puts a pending feature into the document. */
export function addCommand(f: Raw): Command {
  return { type: "addFeature", feature: f };
}

/**
 * What the validator said about a pending feature, as guidance: its own id
 * and the command's words taken off ("edges: …" rather than "addFeature
 * rejected: fillet_2: edges: …").
 */
export function pendingWords(error: string, id: string): string {
  return error
    .replace(/^addFeature rejected: /, "")
    .split("; ")
    .map((e) => e.replace(new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `), ""))
    .join("; ");
}

/** Why OK can't keep the session yet (a new feature still missing what it needs), or null. */
export function okProblem(s: FeatureSession): string | null {
  if (!s.pending) return null;
  return `${s.id} isn't complete yet${s.pendingProblem ? ` (${s.pendingProblem})` : ""}: pick what it needs in the view, or Cancel it.`;
}

/** What a click on a feature in the tree does while a session is open. */
export type TreeClick = { kind: "same" } | { kind: "pick" } | { kind: "ask" };

/**
 * A tree click during a session: on the open feature, nothing; on a feature
 * the active field takes (a seed for a pattern, a sketch), it goes into it;
 * on anything else, ask to finish the session first.
 */
export function treeClick(s: FeatureSession, id: string, takes: boolean): TreeClick {
  if (id === s.id) return { kind: "same" };
  return takes ? { kind: "pick" } : { kind: "ask" };
}

/** The question asked before something that needs the session finished first. */
export interface SessionGuard {
  /** What is waiting: "select hole_1", "open Fillet". */
  what: string;
  /** Runs it once the session is finished. */
  then(): void;
  /** OK can't keep it: why (it is pending, or OK is refused). */
  noKeep?: string;
  /** The feature fails: keeping it keeps the error. */
  failing?: string;
}

/** The words of the question: "fillet_2 is open. OK keeps it, Cancel drops it; then open Fillet." */
export function guardText(s: FeatureSession, g: SessionGuard): string {
  const keep = g.noKeep ? "" : s.kind === "create" ? `OK keeps ${s.id}` : `OK keeps the changes to ${s.id}`;
  const drop = s.kind === "create" ? `Cancel drops it` : "Cancel puts it back as it was";
  const failing = g.failing ? ` It fails now: ${g.failing}.` : "";
  return `${sessionLabel(s)} is still open.${failing} ${[keep, drop].filter(Boolean).join(", ")}; then ${g.what}.`;
}
