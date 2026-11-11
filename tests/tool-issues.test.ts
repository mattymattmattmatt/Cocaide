// The tool-issue log: failed calls, the AI's own reports and the bridge's
// notices, grouped so a repeated problem is one line, and written out as a
// report to paste into a chat with whoever fixes Cocaide.

import { beforeEach, describe, expect, it } from "vitest";
import type { AskCall } from "../src/ask/agent";
import { clearIssues, groupIssues, issuesOf, issuesReport, readIssues, recordAskIssues } from "../src/ui/ask/toolIssues";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

const call = (tool: string, ok: boolean, error?: string, input: unknown = {}): AskCall => ({ tool, input, ok, ...(error ? { error } : {}), revision: 0, hash: "" });
const ask = (askId: string, calls: AskCall[], notices?: string[]) => ({ askId, at: `2026-11-12T10:0${askId.length}:00Z`, model: "Claude Code (sonnet)", prompt: "Make a bench 1.5 m wide", target: "the part", part: "bench", calls, ...(notices ? { notices } : {}) });

describe("the tool-issue log", () => {
  it("keeps failed calls and the AI's reports, not good calls nor the user's own limits", () => {
    const found = issuesOf(
      ask("a", [
        call("addFeature", true),
        call("updateFeature", false, 'no feature "rail_9"', { id: "rail_9" }),
        call("updateFeature", false, "outside the write scope: rail_1"),
        call("reportToolIssue", true, undefined, { tool: "missing", problem: "No tool trims a member to a face", suggestion: "a trim op" }),
      ], ["Cocaide's tools: failed"]),
    );
    expect(found.map((i) => [i.kind, i.tool, i.problem])).toEqual([
      ["call", "updateFeature", 'no feature "rail_9"'],
      ["report", "missing", "No tool trims a member to a face"],
      ["notice", undefined, "Cocaide's tools: failed"],
    ]);
    expect(found[0].input).toBe('{"id":"rail_9"}');
    expect(found[1].suggestion).toBe("a trim op");
  });

  it("reads a bridge's report given as JSON text", () => {
    const found = issuesOf(ask("b", [call("reportToolIssue", true, undefined, JSON.stringify({ tool: "joint", problem: "mitre left a gap" }))]));
    expect(found[0]).toMatchObject({ kind: "report", tool: "joint", problem: "mitre left a gap" });
  });

  it("groups alike problems (names and numbers taken out), the AI's reports first", () => {
    recordAskIssues(ask("a", [call("updateFeature", false, 'no feature "rail_9"')]));
    recordAskIssues(ask("bb", [call("updateFeature", false, 'no feature "leg_2"'), call("reportToolIssue", true, undefined, { tool: "gusset", problem: "size 100 too big" })]));
    // An ask recorded again (a follow-up turn) replaces its own entries.
    recordAskIssues(ask("bb", [call("updateFeature", false, 'no feature "leg_2"'), call("reportToolIssue", true, undefined, { tool: "gusset", problem: "size 100 too big" })]));
    expect(readIssues()).toHaveLength(3);
    const groups = groupIssues(readIssues());
    expect(groups.map((g) => [g.kind, g.tool, g.count])).toEqual([
      ["report", "gusset", 1],
      ["call", "updateFeature", 2],
    ]);
    const report = issuesReport(readIssues());
    expect(report).toMatch(/^# Cocaide tool-issue report/);
    expect(report).toContain("## Reported by the AI");
    expect(report).toContain("`updateFeature`");
    expect(report).toContain("Seen 2 times");
    expect(report).toContain('request "Make a bench 1.5 m wide"');
    clearIssues();
    expect(readIssues()).toEqual([]);
  });
});
