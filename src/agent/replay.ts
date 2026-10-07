// Replays a session log: start from the document the log recorded, re-run
// every call that could edit it, and check each revision hash against the
// log. A run that went wrong can be stepped through, or stopped at any
// revision to inspect the document as it was.

import { AgentSession, EDIT_TOOLS, type LogCall, type LogEntry, type LogSession } from "./session";

export interface ReplayStep {
  seq: number;
  tool: string;
  ok: boolean;
  error?: string;
  revision: number;
  /** The hash matches the one the log recorded. */
  matches: boolean;
}

export interface ReplayResult {
  steps: ReplayStep[];
  /** First call whose outcome differs from the log, if any. */
  divergedAt?: number;
  /** The document after the last replayed call. */
  document: string;
  revision: number;
}

/** The sessions in a log file, in order. */
export function parseLog(text: string): { session: LogSession; calls: LogCall[] }[] {
  const out: { session: LogSession; calls: LogCall[] }[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch {
      throw new Error(`log line ${i + 1}: not JSON`);
    }
    if (entry.type === "session") out.push({ session: entry, calls: [] });
    else if (entry.type === "call") {
      if (!out.length) throw new Error(`log line ${i + 1}: a call before any session entry`);
      out[out.length - 1].calls.push(entry);
    }
  });
  return out;
}

export async function replay(
  run: { session: LogSession; calls: LogCall[] },
  opts: { untilRevision?: number; untilSeq?: number } = {},
): Promise<ReplayResult> {
  const session = await AgentSession.open({ doc: JSON.parse(run.session.document), writeScope: run.session.writeScope ?? undefined });
  const steps: ReplayStep[] = [];
  let divergedAt: number | undefined;
  try {
    if (session.hash !== run.session.hash) throw new Error("the logged starting document does not match its hash");
    for (const call of run.calls) {
      if (opts.untilSeq !== undefined && call.seq > opts.untilSeq) break;
      if (opts.untilRevision !== undefined && session.revision >= opts.untilRevision) break;
      if (!(EDIT_TOOLS as readonly string[]).includes(call.tool)) continue;
      const { result } = await session.call(call.tool, call.args);
      const step: ReplayStep = { seq: call.seq, tool: call.tool, ok: result.ok, revision: session.revision, matches: session.hash === call.hash && result.ok === call.ok };
      if (result.error) step.error = result.error;
      steps.push(step);
      if (!step.matches && divergedAt === undefined) divergedAt = call.seq;
    }
    return { steps, divergedAt, document: session.text, revision: session.revision };
  } finally {
    session.close();
  }
}
