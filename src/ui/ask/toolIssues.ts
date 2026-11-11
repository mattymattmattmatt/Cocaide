// The tool-issue log: every problem the AI ran into with Cocaide's tools,
// kept in this browser across parts and sessions, so the user can hand them
// to Cocaide's developers (or paste them into a coding assistant) as one
// report. Three kinds:
//   call    a tool call that failed (refused, an error, a rebuild it broke)
//   report  the assistant's own reportToolIssue (a bug, a misleading
//           description, a tool that is missing)
//   notice  something the bridge said went wrong (tools not loaded, a version
//           of the part that failed the checks, a skipped line)
// The report groups alike problems (same tool, same error with the numbers
// and names taken out) so a repeated failure is one line with a count.

import type { AskCall } from "../../ask/agent";

export type IssueKind = "call" | "report" | "notice";

export interface ToolIssue {
  id: string;
  at: string;
  kind: IssueKind;
  /** The tool ("addFeature"), "missing" for a tool the assistant wished existed; none for a notice. */
  tool?: string;
  /** What went wrong: the error, or the assistant's words. */
  problem: string;
  /** The assistant's suggestion (reports). */
  suggestion?: string;
  /** The call's arguments as JSON, cut short. */
  input?: string;
  /** Which assistant and model ("Claude Code (sonnet)", "qwen3.5:9b (local, Ollama)"). */
  model: string;
  /** The user's request, cut short, and what it was about. */
  prompt: string;
  target: string;
  /** The part's name. */
  part: string;
  askId: string;
}

const KEY = "cocaide.ask.toolIssues.v1";
const LIMIT = 500;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function readIssues(): ToolIssue[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as ToolIssue[]) : [];
  } catch {
    return [];
  }
}

function write(list: ToolIssue[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-LIMIT)));
  } catch {
    // storage full or disabled: the log is best effort
  }
}

export function clearIssues() {
  write([]);
}

/** A failed call's error that is the user's own setting doing its job, not a tool problem: not logged. */
function expected(error: string): boolean {
  return /outside (the )?write ?scope|not in writeScope|cancell?ed|stopped by the user|no more edits in this ask/i.test(error);
}

function json(v: unknown, n: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return cut(v, n);
  try {
    return cut(JSON.stringify(v), n);
  } catch {
    return undefined;
  }
}

export interface AskIssues {
  askId: string;
  at: string;
  model: string;
  prompt: string;
  target: string;
  part: string;
  calls: AskCall[];
  /** What the bridge noticed along the way. */
  notices?: string[];
}

/** The issues one ask produced: its failed calls, the assistant's reports, the bridge's notices. Recorded, and returned. */
export function issuesOf(a: AskIssues): ToolIssue[] {
  const base = { at: a.at, model: a.model, prompt: cut(a.prompt.trim(), 300), target: a.target, part: a.part, askId: a.askId };
  const out: ToolIssue[] = [];
  let n = 0;
  const id = () => `${a.askId}-${++n}`;
  for (const c of a.calls) {
    if (c.tool === "reportToolIssue") {
      const raw = typeof c.input === "string" ? safeParse(c.input) : c.input;
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const problem = typeof r.problem === "string" ? r.problem : typeof c.input === "string" ? c.input : "";
      if (!problem.trim()) continue;
      out.push({
        ...base,
        id: id(),
        kind: "report",
        tool: typeof r.tool === "string" && r.tool.trim() ? r.tool.trim() : "unknown",
        problem: cut(problem.trim(), 1500),
        ...(typeof r.suggestion === "string" && r.suggestion.trim() ? { suggestion: cut(r.suggestion.trim(), 1000) } : {}),
        ...(r.input !== undefined ? { input: json(r.input, 1500) } : {}),
      });
      continue;
    }
    if (c.ok || !c.error || expected(c.error)) continue;
    out.push({ ...base, id: id(), kind: "call", tool: c.tool, problem: cut(c.error, 1500), ...(c.input !== undefined ? { input: json(c.input, 1500) } : {}) });
  }
  for (const t of a.notices ?? []) {
    if (!t.trim() || /older than this app/.test(t)) continue;
    out.push({ ...base, id: id(), kind: "notice", problem: cut(t.trim(), 1000) });
  }
  return out;
}

export function recordAskIssues(a: AskIssues): ToolIssue[] {
  const found = issuesOf(a);
  if (found.length) write([...readIssues().filter((i) => i.askId !== a.askId || i.kind === "notice"), ...found]);
  return found;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** An error with the particulars taken out, so alike failures group: numbers, quoted names, ids. */
export function issueKey(i: Pick<ToolIssue, "kind" | "tool" | "problem">): string {
  const shape = i.problem
    .toLowerCase()
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"')
    .replace(/-?\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, i.kind === "report" ? 80 : 160);
  return `${i.kind}|${i.tool ?? ""}|${shape}`;
}

export interface IssueGroup {
  key: string;
  kind: IssueKind;
  tool?: string;
  count: number;
  first: string;
  last: string;
  models: string[];
  /** Up to three examples, newest first. */
  examples: ToolIssue[];
}

export function groupIssues(list: ToolIssue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const i of list) {
    const key = issueKey(i);
    const g = groups.get(key) ?? { key, kind: i.kind, ...(i.tool ? { tool: i.tool } : {}), count: 0, first: i.at, last: i.at, models: [], examples: [] };
    g.count++;
    if (i.at < g.first) g.first = i.at;
    if (i.at > g.last) g.last = i.at;
    if (!g.models.includes(i.model)) g.models.push(i.model);
    g.examples = [i, ...g.examples].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
    groups.set(key, g);
  }
  // The assistant's own reports first, then the most frequent.
  const rank = (k: IssueKind) => (k === "report" ? 0 : k === "call" ? 1 : 2);
  return [...groups.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || b.count - a.count || b.last.localeCompare(a.last));
}

const KIND_TITLE: Record<IssueKind, string> = { report: "Reported by the AI", call: "Failed tool calls", notice: "Bridge notices" };

/** The log as one Markdown report to paste into a chat with a coding assistant (or an issue). */
export function issuesReport(list: ToolIssue[], meta: { app?: string; when?: string } = {}): string {
  const groups = groupIssues(list);
  const lines: string[] = [
    "# Cocaide tool-issue report",
    "",
    `${list.length} issue${list.length === 1 ? "" : "s"} in ${groups.length} group${groups.length === 1 ? "" : "s"}${list.length ? `, ${list[0].at.slice(0, 10)} to ${list[list.length - 1].at.slice(0, 10)}` : ""}.${meta.app ? ` App: ${meta.app}.` : ""}${meta.when ? ` Made ${meta.when}.` : ""}`,
    "",
    "Problems the in-app AI ran into while building with Cocaide's tools. Each group is one kind of problem; the examples show the call and the request it came from. Please look at the tools for bugs, misleading descriptions, or missing features these point to.",
  ];
  for (const kind of ["report", "call", "notice"] as const) {
    const gs = groups.filter((g) => g.kind === kind);
    if (!gs.length) continue;
    lines.push("", `## ${KIND_TITLE[kind]}`);
    gs.forEach((g, n) => {
      const ex = g.examples[0];
      lines.push("", `### ${n + 1}. ${g.tool ? `\`${g.tool}\`` : "bridge"}: ${cut(ex.problem.replace(/\s+/g, " "), 140)}`);
      lines.push(`- Seen ${g.count} time${g.count === 1 ? "" : "s"}${g.count > 1 ? `, ${g.first.slice(0, 10)} to ${g.last.slice(0, 10)}` : `, ${g.last.slice(0, 10)}`}; ${g.models.join(", ")}`);
      for (const e of g.examples) {
        lines.push(`- Example (${e.at.slice(0, 16).replace("T", " ")}, part "${e.part}", on ${e.target}): request "${cut(e.prompt.replace(/\s+/g, " "), 160)}"`);
        if (e.problem !== ex.problem || e === ex) lines.push(`  - Problem: ${e.problem.replace(/\s+/g, " ")}`);
        if (e.suggestion) lines.push(`  - Suggestion: ${e.suggestion.replace(/\s+/g, " ")}`);
        if (e.input) lines.push(`  - Input: \`${e.input.replace(/`/g, "'")}\``);
      }
    });
  }
  return lines.join("\n");
}
