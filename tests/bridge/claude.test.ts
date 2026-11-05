// Finding Claude Code (also the Windows npm layout), the arguments of a run,
// permission-rule paths, and reading stream-json.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeArgs, errorKindOf, findClaude, mcpConfig, rulePath, spawnSpec, StreamReader } from "../../src/bridge/claude";

describe("finding claude", () => {
  it("runs npm's claude.cmd as node <cli.js> on Windows, prefers claude.exe, and finds the native install in ~/.local/bin", () => {
    const root = mkdtempSync(join(tmpdir(), "find-claude-"));
    const npm = join(root, "npm");
    mkdirSync(join(npm, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });
    writeFileSync(join(npm, "claude.cmd"), "@echo off");
    writeFileSync(join(npm, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), "");
    const found = findClaude(undefined, { PATH: `${join(root, "nothing")};${npm}` }, "win32")!;
    expect(found).toEqual({ command: process.execPath, prefix: [join(npm, "node_modules", "@anthropic-ai", "claude-code", "cli.js")] });
    // A .cmd whose script is elsewhere: through cmd.exe, quoted.
    const bare = join(root, "bare");
    mkdirSync(bare);
    writeFileSync(join(bare, "claude.cmd"), "");
    expect(findClaude(undefined, { PATH: bare }, "win32")).toEqual({ command: join(bare, "claude.cmd"), prefix: [], shell: true });
    const home = join(root, "home");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "claude.exe"), "");
    expect(findClaude(undefined, { PATH: "", USERPROFILE: home }, "win32")!.command).toBe(join(home, ".local", "bin", "claude.exe"));
    expect(findClaude(undefined, { PATH: "" }, "win32")).toBeNull();
    expect(findClaude("/x/fake.mjs")).toEqual({ command: process.execPath, prefix: ["/x/fake.mjs"] });
  });

  it("quotes for cmd.exe only in the fallback, on one line", () => {
    const s = spawnSpec({ command: "C:\\Program Files\\npm\\claude.cmd", prefix: [], shell: true }, ["--tools", "", "--append-system-prompt", 'a "b"\nc']);
    expect(s).toEqual({ command: '"C:\\Program Files\\npm\\claude.cmd"', args: ["--tools", '""', "--append-system-prompt", '"a ""b"" c"'], shell: true });
    expect(spawnSpec({ command: "/usr/bin/claude", prefix: [] }, ["--tools", ""]).args).toEqual(["--tools", ""]);
  });
});

describe("a run's arguments", () => {
  it("offers no built-in tools, allows only Cocaide's, denies the rest", () => {
    const a = claudeArgs({ mcpConfig: "C:\\Users\\Me Too\\cfg.json", appendSystem: "S" });
    const after = (f: string) => a[a.indexOf(f) + 1];
    expect(a.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(after("--mcp-config")).toBe("C:\\Users\\Me Too\\cfg.json");
    expect(after("--tools")).toBe("");
    expect(after("--allowedTools")).toBe("mcp__cocaide,mcp__cocaide__*");
    expect(after("--disallowedTools").split(",")).toEqual(expect.arrayContaining(["Bash", "PowerShell", "Edit", "Write", "WebFetch"]));
    expect(a).not.toContain("--model");
    const b = claudeArgs({ mcpConfig: "c", appendSystem: "S", model: "opus", resume: "id-1", attachDir: "G:\\Cocaide Parts\\s\\attachments" });
    expect(b[b.indexOf("--tools") + 1]).toBe("Read");
    expect(b[b.indexOf("--allowedTools") + 1]).toBe("mcp__cocaide,mcp__cocaide__*,Read(//g/Cocaide Parts/s/attachments/**)");
    expect(b.slice(-4)).toEqual(["--model", "opus", "--resume", "id-1"]);
  });

  it("writes permission paths as Claude Code reads absolute ones", () => {
    expect(rulePath("/home/me/x/")).toBe("//home/me/x");
    expect(rulePath("C:\\Users\\me\\x")).toBe("//c/Users/me/x");
  });

  it("starts the MCP server with this Node and the tsx loader, on the session file and scope", () => {
    const c = mcpConfig({ serverPath: "S.ts", tsxLoader: "file:///L.mjs", docPath: "D.json", scope: [], outDir: "O" });
    expect(c.mcpServers.cocaide).toEqual({ type: "stdio", command: process.execPath, args: ["--import", "file:///L.mjs", "S.ts", "--doc", "D.json", "--scope", "*", "--out", "O"] });
  });
});

describe("reading stream-json", () => {
  it("turns Claude Code's events into the bridge's", () => {
    const r = new StreamReader();
    expect(r.line("")).toEqual([]);
    expect(r.line("garbage")[0].kind).toBe("skip");
    expect(r.line(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: ["Read", "mcp__cocaide__addFeature", "mcp__cocaide__undo"], mcp_servers: [{ name: "cocaide", status: "connected" }], model: "m" }))).toEqual([
      { kind: "init", sessionId: "s1", model: "m", tools: 2, mcp: "connected" },
    ]);
    // Whole text blocks count when no deltas came; after deltas, the whole block is not repeated.
    expect(r.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } }))).toEqual([{ kind: "text", text: "Hi" }]);
    expect(r.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Yo" } } }))).toEqual([{ kind: "text", text: "Yo" }]);
    expect(r.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Yo" }, { type: "tool_use", id: "t1", name: "mcp__cocaide__updateFeature", input: { id: "h", patch: { d: 8 } } }], stop_reason: "tool_use" } }))).toEqual([
      { kind: "tool", callId: "t1", name: "updateFeature", args: '{"id":"h","patch":{"d":8}}' },
    ]);
    expect(r.line(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"ok":true,"changed":true,"revision":1}' }] }] } }))).toEqual([
      { kind: "toolResult", callId: "t1", name: "updateFeature", ok: true, changed: true },
    ]);
    expect(r.line(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: '{"ok":false,"error":"writeScope: no"}' }] } }))[0]).toMatchObject({ ok: false, error: "writeScope: no" });
    expect(r.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done", session_id: "s1", total_cost_usd: 0.5, num_turns: 3, duration_ms: 9, usage: { input_tokens: 5, server_tool_use: {} } }))).toEqual([
      { kind: "result", ok: true, text: "Done", sessionId: "s1", costUsd: 0.5, durationMs: 9, turns: 3, usage: { input_tokens: 5 } },
    ]);
    expect(r.line(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }))[0]).toMatchObject({ ok: false, text: "Claude Code stopped: error_max_turns", errorKind: "error" });
    expect(r.line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }))).toEqual([]);
    expect(r.sessionId).toBe("s1");
  });

  it("tells login trouble and limits apart", () => {
    expect(errorKindOf("Invalid API key · Please run /login")).toBe("login");
    expect(errorKindOf("Claude AI usage limit reached|1730000000")).toBe("rate-limit");
    expect(errorKindOf("API Error: 529 overloaded")).toBe("rate-limit");
    expect(errorKindOf("something else")).toBe("error");
  });
});
