// The AI history: every request made on a document, kept in this browser per
// document (by its name), so a conversation does not vanish after Accept or
// Close. Each entry holds the prompt, the attachments' names, what the
// assistant said, its tool calls and the changes it proposed as readable
// lines, the outcome and whether the change was accepted or discarded.
// "Follow up" starts a new request carrying the earlier ones of its thread.
//
// It is not saved in the document file: prompts and replies would make every
// part file larger and travel with it to whoever gets the part. "Download"
// gives the history as a JSON file to keep beside the part instead.
//
// Unsent drafts are kept here too, per document and target, so text typed in
// the AI window survives closing and reopening it.

import type { AskResult, Change, EarlierTurn } from "../../ask/agent";
import type { AskTarget } from "../../ask/packet";

export type HistoryStatus = "open" | "accepted" | "discarded" | "none";

export interface HistoryEntry {
  id: string;
  at: string;
  /** What was right-clicked ("hole_1", "this flat face", "the part"). */
  label: string;
  target: AskTarget;
  prompt: string;
  attachments: string[];
  model: string;
  outcome: AskResult["outcome"];
  /** What the assistant said. */
  reply: string;
  /** Its tool calls, one line each ("updateFeature ✓", "addFeature ✗ rolled back: …"). */
  calls: string[];
  /** The changes it proposed, one line each. */
  changes: string[];
  status: HistoryStatus;
  /** The entry this one follows up (a conversation is a chain of these). */
  followUpOf?: string;
  /** Claude Code's session (the bridge provider): a follow-up continues it. */
  bridgeSession?: string;
}

const KEY = "cocaide.ask.history.v1";
const DRAFTS = "cocaide.ask.drafts.v1";
/** Entries kept per document, and documents kept. */
const PER_DOC = 100;
const DOCS = 30;

type Store = Record<string, HistoryEntry[]>;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // storage full or disabled: the history lasts for this page
  }
}

/** The key a document's history is kept under: its name. */
export function docKey(doc: object | null | undefined): string {
  const name = (doc as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : "untitled";
}

export function historyOf(doc: string): HistoryEntry[] {
  return read<Store>(KEY, {})[doc] ?? [];
}

export function addHistory(doc: string, e: HistoryEntry) {
  const store = read<Store>(KEY, {});
  store[doc] = [...(store[doc] ?? []), e].slice(-PER_DOC);
  // The documents used least recently go first when there are too many.
  const keys = Object.keys(store);
  if (keys.length > DOCS) {
    const last = (k: string) => store[k].at(-1)?.at ?? "";
    for (const k of keys.sort((a, b) => last(a).localeCompare(last(b))).slice(0, keys.length - DOCS)) delete store[k];
  }
  write(KEY, store);
}

export function updateHistory(doc: string, id: string, patch: Partial<HistoryEntry>) {
  const store = read<Store>(KEY, {});
  if (!store[doc]) return;
  store[doc] = store[doc].map((e) => (e.id === id ? { ...e, ...patch } : e));
  write(KEY, store);
}

export function clearHistory(doc: string) {
  const store = read<Store>(KEY, {});
  delete store[doc];
  write(KEY, store);
}

/** The thread an entry belongs to, oldest first, ending with it. */
export function threadOf(entries: HistoryEntry[], id: string): HistoryEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: HistoryEntry[] = [];
  let e = byId.get(id);
  while (e && out.length < 20) {
    out.unshift(e);
    e = e.followUpOf ? byId.get(e.followUpOf) : undefined;
  }
  return out;
}

/** A thread as a follow-up carries it to the model. */
export function earlierOf(thread: HistoryEntry[]): EarlierTurn[] {
  return thread.map((e) => ({ prompt: e.prompt, reply: e.reply, changes: e.changes, status: e.status }));
}

/** A finished ask as a history entry. */
export function entryOf(r: AskResult, base: Pick<HistoryEntry, "id" | "at" | "label" | "target" | "prompt" | "attachments" | "followUpOf">): HistoryEntry {
  const changes = r.proposal ? (r.proposal.replace ? ["a new part, replacing the document"] : r.proposal.changes.flatMap(changeLines)) : [];
  return {
    ...base,
    model: r.model,
    outcome: r.outcome,
    reply: r.text,
    calls: r.calls.map((c) => `${c.tool} ${c.ok ? "✓" : `✗ ${c.error ?? ""}`}`.trim()),
    changes,
    status: r.proposal ? "open" : "none",
  };
}

/** A change as the panel shows it: "hole_1 diameter: 6.6 → 8", "+ fillet_1". */
export function changeLines(c: Change): string[] {
  const name = c.what ? `${c.what} ${c.id}` : c.id;
  if (c.kind === "added") return [`+ ${name}`];
  if (c.kind === "removed") return [`− ${name}`];
  return (c.fields ?? []).map((f) => `${name}${c.id === "parameters" ? ":" : ""} ${f.path}: ${short(f.before)} → ${short(f.after)}`);
}

function short(v: unknown): string {
  if (v === undefined) return "—";
  const s = JSON.stringify(v);
  return s.length > 48 ? `${s.slice(0, 45)}…` : s;
}

// ------------------------------------------------------------------ drafts

const draftKey = (doc: string, target: AskTarget) => `${doc}|${JSON.stringify(target)}`;

export function loadDraft(doc: string, target: AskTarget): string {
  return read<Record<string, string>>(DRAFTS, {})[draftKey(doc, target)] ?? "";
}

export function saveDraft(doc: string, target: AskTarget, text: string) {
  const all = read<Record<string, string>>(DRAFTS, {});
  const k = draftKey(doc, target);
  if (text.trim()) all[k] = text;
  else delete all[k];
  // A handful of drafts at most.
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - 20))) delete all[old];
  write(DRAFTS, all);
}
