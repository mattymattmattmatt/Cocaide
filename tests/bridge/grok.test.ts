// Grok (xAI's Grok Build CLI) through the bridge, end to end with a stand-in
// for `grok` (tests/bridge/fake-grok.mjs) that reads the .mcp.json the bridge
// writes and calls the real Cocaide MCP server: the bridge finds it, says it
// is signed in, runs an "auto" ask on it when Claude Code is missing, keeps it
// to Cocaide's tools, and reads its output (Grok's tool names and wrapped
// results included).

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StreamReader } from "../../src/bridge/claude";
import { findGrok, grokArgs, grokSignedIn } from "../../src/bridge/grok";
import { serverFiles } from "../../src/bridge/main";
import { cocaideTool, pickEngine, type ServerMessage } from "../../src/bridge/protocol";
import { startBridge, type Bridge } from "../../src/bridge/server";
import { connect } from "./client";

const FAKE = fileURLToPath(new URL("./fake-grok.mjs", import.meta.url));
const EMPTY = JSON.stringify({ version: 1, units: "mm", name: "part", features: [] });
type Of<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
const is =
  <T extends ServerMessage["type"]>(type: T, id?: string) =>
  (m: ServerMessage): m is Of<T> =>
    m.type === type && (id === undefined || (m as { id?: string }).id === id);

describe("finding and checking Grok Build", () => {
  it("finds grok on PATH or in ~/.grok/bin (and grok.exe / grok.cmd on Windows)", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-find-"));
    mkdirSync(join(dir, ".grok", "bin"), { recursive: true });
    writeFileSync(join(dir, ".grok", "bin", "grok"), "");
    expect(findGrok(undefined, { PATH: "", HOME: dir }, "linux")?.command).toBe(join(dir, ".grok", "bin", "grok"));
    expect(findGrok(undefined, { PATH: "", HOME: join(dir, "nowhere") }, "linux")).toBeNull();
    writeFileSync(join(dir, "grok.cmd"), "");
    expect(findGrok(undefined, { Path: dir, USERPROFILE: join(dir, "x") }, "win32")).toMatchObject({ command: join(dir, "grok.cmd"), shell: true });
  });

  it("is signed in with grok login's ~/.grok/auth.json or XAI_API_KEY", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-auth-"));
    expect(grokSignedIn({ HOME: dir }).signedIn).toBe(false);
    mkdirSync(join(dir, ".grok"));
    writeFileSync(join(dir, ".grok", "auth.json"), JSON.stringify({ token: "x" }));
    expect(grokSignedIn({ HOME: dir })).toEqual({ signedIn: true, method: "grok login" });
    expect(grokSignedIn({ HOME: join(dir, "none"), XAI_API_KEY: "k" })).toEqual({ signedIn: true, method: "XAI_API_KEY" });
  });

  it("runs headless, asking nothing and allowing only Cocaide's tools; the prompt is -p's argument, last", () => {
    const a = grokArgs({ rules: "RULES", prompt: "Make a block", model: "grok-4.7", resume: "123e4567-e89b-12d3-a456-426614174000" });
    const after = (f: string) => a[a.indexOf(f) + 1];
    expect(after("--output-format")).toBe("streaming-messages-json");
    expect(after("--permission-mode")).toBe("dontAsk");
    expect(after("-m")).toBe("grok-4.7");
    expect(after("--rules")).toBe("RULES");
    expect(after("-r")).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(a.slice(-2)).toEqual(["-p", "Make a block"]);
    const allowed = a.flatMap((x, i) => (x === "--allow" ? [a[i + 1]] : []));
    const denied = a.flatMap((x, i) => (x === "--deny" ? [a[i + 1]] : []));
    expect(allowed).toEqual(["mcp__cocaide", "mcp__cocaide__*"]);
    expect(denied).toEqual(expect.arrayContaining(["run_terminal_command", "search_replace", "write_file"]));
    // A model name or session id that isn't one is left out.
    const b = grokArgs({ rules: "", prompt: "x", model: "bad name; rm", resume: "not-a-uuid" });
    expect(b).not.toContain("-m");
    expect(b).not.toContain("-r");
  });

  it("auto picks Claude Code when it is ready, else Grok Build", () => {
    const yes = { installed: true, loggedIn: true };
    const no = { installed: false, loggedIn: null };
    expect(pickEngine("auto", yes, yes)).toBe("claude");
    expect(pickEngine("auto", no, yes)).toBe("grok");
    expect(pickEngine("auto", { installed: true, loggedIn: false }, yes)).toBe("grok");
    expect(pickEngine("grok", yes, no)).toBe("grok");
    expect(pickEngine(undefined, yes, undefined)).toBe("claude");
  });

  it("reads Grok's spellings: cocaide__tool names and output wrapped as output_for_prompt", () => {
    expect(cocaideTool("cocaide__addFeature")).toBe("addFeature");
    expect(cocaideTool("mcp__cocaide__addFeature")).toBe("addFeature");
    expect(cocaideTool("run_terminal_command")).toBeNull();
    const r = new StreamReader("Grok Build");
    expect(r.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "cocaide__updateFeature", input: {} }] } }))).toEqual([{ kind: "tool", callId: "c1", name: "updateFeature", args: "" }]);
    const res = r.line(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", is_error: true, content: JSON.stringify({ output_for_prompt: JSON.stringify({ ok: false, error: "no feature x" }) }) }] } }));
    expect(res).toEqual([{ kind: "toolResult", callId: "c1", name: "updateFeature", ok: false, error: "no feature x", changed: false }]);
  });
});

describe("an ask on Grok Build through the bridge", () => {
  let bridge: Bridge;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cocaide-grok-"));
    process.env.FAKE_GROK_ARGS = join(dir, "args.json");
    process.env.XAI_API_KEY = "test-key";
    // No Claude Code here: "auto" runs on Grok.
    bridge = await startBridge({ port: 0, dataDir: join(dir, "data"), claudePath: join(dir, "no-claude"), grokPath: FAKE, ...serverFiles(), idleMs: 60_000 });
  });
  afterAll(async () => {
    await bridge?.close();
    delete process.env.FAKE_GROK_ARGS;
    delete process.env.XAI_API_KEY;
  });

  it("says Grok Build is there and signed in, runs the ask on it, and the part changes live", async () => {
    const c = await connect(bridge.port);
    c.send({ type: "hello", token: bridge.token });
    const welcome = await c.waitFor(is("welcome"));
    expect(welcome.grok).toMatchObject({ installed: true, loggedIn: true, authMethod: "XAI_API_KEY" });
    expect(welcome.grok?.version).toBe("9.9.9 (test stand-in)");
    c.send({ type: "ask", id: "g1", prompt: "Make a block", doc: EMPTY, scope: ["*"], context: "PACKET-TEXT", engine: "auto", grokModel: "grok-4.7" });
    const done = await c.waitFor(is("done", "g1"), 90_000);
    expect(done).toMatchObject({ ok: true, text: "Done with Grok: a 40 × 20 × 10 block." });
    expect(c.messages.find(is("started", "g1"))).toMatchObject({ engine: "grok" });
    expect(c.messages.find(is("init", "g1"))!.tools).toBeGreaterThan(50);
    expect(c.messages.filter(is("tool", "g1")).map((t) => t.name)).toEqual(["addFeature", "addFeature"]);
    expect(c.messages.filter(is("toolResult", "g1")).every((r) => r.ok)).toBe(true);
    expect(JSON.parse(done.doc!).features.map((f: { id: string }) => f.id)).toEqual(["block_sketch", "block"]);
    // How it was started: in its own folder, whose .mcp.json names Cocaide's server on this ask's document.
    const { argv, cwd, mcpJson } = JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as { argv: string[]; cwd: string; mcpJson: string };
    expect(cwd).toBe(join(dir, "data", "work-grok"));
    expect(Object.keys(JSON.parse(mcpJson).mcpServers)).toEqual(["cocaide"]);
    expect(argv[argv.indexOf("-m") + 1]).toBe("grok-4.7");
    expect(argv[argv.indexOf("-p") + 1]).toContain("PACKET-TEXT");
    c.close();
  }, 120_000);

  it("says so when Grok Build started without Cocaide's tools", async () => {
    const c = await connect(bridge.port);
    c.send({ type: "hello", token: bridge.token });
    await c.waitFor(is("welcome"));
    c.send({ type: "ask", id: "g2", prompt: "SCENARIO:notools", doc: EMPTY, scope: ["*"], context: "", engine: "grok" });
    await c.waitFor(is("done", "g2"), 60_000);
    expect(c.messages.filter(is("notice", "g2")).map((n) => n.text).join(" ")).toMatch(/without Cocaide's tools.*trust the folder/);
    c.close();
  }, 90_000);
});
