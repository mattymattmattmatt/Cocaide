// Every ask is logged next to the document revisions it produced (spec 8),
// so a bad run can be looked at and replayed: the target, the prompt, each
// tool call with the sandbox revision and hash after it, and whether the
// user accepted the proposal (and the hash of what was accepted).

import type { AskResult } from "../../ask/agent";
import type { AskTarget } from "../../ask/packet";

export interface AskRecord {
  id: string;
  at: string;
  target: AskTarget;
  label: string;
  prompt: string;
  model: string;
  mode: string;
  outcome: AskResult["outcome"];
  text: string;
  /** Hash of the document the ask started from. */
  baseHash: string;
  calls: AskResult["calls"];
  accepted?: { at: string; hash: string };
  /** A drawing the ask read: which, and how legible it measured. */
  drawing?: { name: string; pages: number; dpi: number | null; textLayer: boolean; legibility: number };
  /** A photo the ask read: which, and its size in pixels. */
  photo?: { name: string; sha256: string; width: number; height: number };
  /** Numbers the user gave in the confirmation card. */
  answers?: Record<string, unknown>;
  discarded?: { at: string; reason?: string };
}

const KEY = "cocaide.ask.log.v1";
const LIMIT = 50;

export function readLog(): AskRecord[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

function write(records: AskRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(records.slice(-LIMIT)));
  } catch {
    // storage full or disabled: the log is best effort
  }
}

export function logAsk(r: AskRecord) {
  write([...readLog(), r]);
}

export function updateAsk(id: string, patch: Partial<AskRecord>) {
  write(readLog().map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

/** The log as JSON Lines, for download. */
export function logText(): string {
  return readLog()
    .map((r) => JSON.stringify(r))
    .join("\n");
}
