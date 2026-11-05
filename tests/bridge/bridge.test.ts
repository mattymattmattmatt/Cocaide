// The Claude Code bridge, end to end with a stand-in for `claude`
// (tests/bridge/fake-claude.mjs) that calls the real Cocaide MCP server, so
// the session's working file really changes and is pushed to the client.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverFiles } from "../../src/bridge/main";
import type { ServerMessage } from "../../src/bridge/protocol";
import { pairingToken, startBridge, type Bridge } from "../../src/bridge/server";
import { connect, type TestClient } from "./client";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const EMPTY = JSON.stringify({ version: 1, units: "mm", name: "part", features: [] });
type Of<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
const is =
  <T extends ServerMessage["type"]>(type: T, id?: string) =>
  (m: ServerMessage): m is Of<T> =>
    m.type === type && (id === undefined || (m as { id?: string }).id === id);

let bridge: Bridge;
let dir: string;
const argsFile = () => join(dir, "args.json");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cocaide-bridge-"));
  process.env.FAKE_CLAUDE_ARGS = join(dir, "args.json");
  bridge = await startBridge({ port: 0, dataDir: join(dir, "data"), claudePath: FAKE, ...serverFiles(), idleMs: 60_000 });
});
afterAll(async () => {
  await bridge?.close();
  delete process.env.FAKE_CLAUDE_ARGS;
});

async function paired(): Promise<TestClient> {
  const c = await connect(bridge.port);
  c.send({ type: "hello", token: bridge.token });
  await c.waitFor(is("welcome"));
  return c;
}

function get(path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: bridge.port, path, headers: { Host: `127.0.0.1:${bridge.port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

describe("bridge: who may connect", () => {
  it("keeps one pairing token in its data folder", () => {
    const d = join(dir, "tok");
    const a = pairingToken(d);
    expect(a.length).toBeGreaterThanOrEqual(20);
    expect(pairingToken(d)).toBe(a);
    expect(pairingToken(d, true)).not.toBe(a);
  });

  it("answers /health for the hosted app and localhost, with the private-network header, and refuses other sites", async () => {
    const ok = await get("/health", { Origin: "https://mattymattmattmatt.github.io" });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).name).toBe("cocaide-bridge");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://mattymattmattmatt.github.io");
    expect(ok.headers["access-control-allow-private-network"]).toBe("true");
    expect((await get("/health", { Origin: "http://localhost:4196" })).status).toBe(200);
    expect((await get("/health", { Origin: "https://evil.example" })).status).toBe(403);
    expect((await get("/health", { Origin: "http://localhost.evil.example" })).status).toBe(403);
    // A page reaching the bridge through another host name (DNS rebinding) is refused.
    expect((await get("/health", { Host: "evil.example:8787" })).status).toBe(403);
  });

  it("refuses a WebSocket from another origin or without one", async () => {
    await expect(connect(bridge.port, "https://evil.example")).rejects.toThrow("403");
    await expect(connect(bridge.port, null)).rejects.toThrow("403");
  });

  it("closes a connection whose hello has the wrong token, and runs nothing before a good hello", async () => {
    const c = await connect(bridge.port, "https://mattymattmattmatt.github.io");
    c.send({ type: "ask", id: "x", prompt: "hi", doc: EMPTY, scope: ["*"], context: "" });
    const e = await c.waitFor(is("error"));
    expect(e.code).toBe("unauthorized");
    await c.closed;
    const d = await connect(bridge.port);
    d.send({ type: "hello", token: "wrong" + bridge.token.slice(5) });
    expect((await d.waitFor(is("error"))).code).toBe("unauthorized");
    await d.closed;
  });

  it("welcomes the right token with Claude Code's status", async () => {
    const c = await connect(bridge.port);
    c.send({ type: "hello", token: bridge.token });
    const w = await c.waitFor(is("welcome"));
    expect(w.claude).toMatchObject({ installed: true, loggedIn: true });
    expect(w.claude.version).toContain("9.9.9");
    c.close();
  });
});

describe("bridge: an ask", () => {
  it("streams text, tool calls and each new document, and ends with the session id", async () => {
    const c = await paired();
    c.send({ type: "ask", id: "a1", prompt: "Make a block", doc: EMPTY, scope: ["*"], context: "PACKET-TEXT", model: "sonnet" });
    const done = await c.waitFor(is("done", "a1"), 90_000);
    expect(done).toMatchObject({ ok: true, text: "Done: a 40 × 20 × 10 block.", costUsd: 0.0123, turns: 4 });
    expect(done.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const types = c.messages.filter((m) => (m as { id?: string }).id === "a1").map((m) => m.type);
    expect(types[0]).toBe("started");
    expect(types).toContain("init");
    const init = c.messages.find(is("init", "a1"))!;
    expect(init.tools).toBeGreaterThan(50);
    expect(init.mcp).toBe("connected");
    expect(c.messages.filter(is("text", "a1")).map((m) => m.text).join("")).toBe("Building a block.Done: a 40 × 20 × 10 block.");
    const tools = c.messages.filter(is("tool", "a1"));
    expect(tools.map((t) => t.name)).toEqual(["addFeature", "addFeature", "partSummary"]);
    expect(tools[1].args).toContain('"op":"extrude"');
    expect(c.messages.filter(is("toolResult", "a1")).every((r) => r.ok)).toBe(true);
    // The document after each kept change: first the sketch alone, last the extrude.
    const docs = c.messages.filter(is("doc", "a1")).map((m) => JSON.parse(m.text) as { features: { id: string }[] });
    expect(docs.length).toBeGreaterThanOrEqual(2);
    expect(docs[0].features.map((f) => f.id)).toEqual(["sketch_1"]);
    expect(docs.at(-1)!.features.map((f) => f.id)).toEqual(["sketch_1", "ext_1"]);
    expect(JSON.parse(done.doc!).features.map((f: { id: string }) => f.id)).toEqual(["sketch_1", "ext_1"]);
    // Each doc arrives before the result of the call after the one that made it.
    expect(c.messages.indexOf(c.messages.find(is("doc", "a1"))!)).toBeLessThan(c.messages.indexOf(done));

    // What Claude Code was started with: only Cocaide's tools, the prompt on stdin with the packet.
    const { argv, prompt } = JSON.parse(readFileSync(argsFile(), "utf8")) as { argv: string[]; prompt: string };
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv).toContain("-p");
    expect(after("--output-format")).toBe("stream-json");
    expect(argv).toContain("--strict-mcp-config");
    expect(after("--tools")).toBe("");
    expect(after("--allowedTools")).toBe("mcp__cocaide,mcp__cocaide__*");
    expect(after("--disallowedTools")).toContain("Bash");
    expect(after("--model")).toBe("sonnet");
    expect(argv).not.toContain("--resume");
    expect(prompt).toContain("Make a block");
    expect(prompt).toContain("PACKET-TEXT");
    const config = JSON.parse(readFileSync(after("--mcp-config"), "utf8"));
    expect(config.mcpServers.cocaide.command).toBe(process.execPath);
    expect(config.mcpServers.cocaide.args[0]).toBe("--import");
    expect(config.mcpServers.cocaide.args[1]).toMatch(/^file:/);
    c.close();
  });

  it("continues a session with --resume, saves attachments for Read and allows Read only there", async () => {
    const c = await paired();
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    c.send({
      type: "ask",
      id: "a2",
      prompt: "Now again",
      doc: EMPTY,
      scope: ["hole_1", "+"],
      context: "",
      resume: "11111111-2222-3333-4444-555555555555",
      attachments: [
        { name: "../../sketch.png", mediaType: "image/png", data: png },
        { name: "notes.txt", mediaType: "text/plain", text: "NOTE-TEXT" },
      ],
    });
    const done = await c.waitFor(is("done", "a2"), 90_000);
    expect(done.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    const { argv, prompt } = JSON.parse(readFileSync(argsFile(), "utf8")) as { argv: string[]; prompt: string };
    expect(argv[argv.indexOf("--resume") + 1]).toBe("11111111-2222-3333-4444-555555555555");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read");
    const allowed = argv[argv.indexOf("--allowedTools") + 1];
    expect(allowed).toMatch(/Read\(\/\/.*attachments\/\*\*\)/);
    expect(prompt).toContain("NOTE-TEXT");
    expect(prompt).toContain("Write scope: hole_1, +.");
    const file = /^(.*sketch\.png)$/m.exec(prompt)![1];
    expect(file).toContain("attachments");
    expect(file).not.toContain("..");
    expect(readFileSync(file).toString("hex")).toBe("89504e470d0a1a0a");
    const config = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));
    expect(config.mcpServers.cocaide.args).toContain("hole_1,+");
    c.close();
  });

  it("skips a line that is not JSON and carries on", async () => {
    const c = await paired();
    c.send({ type: "ask", id: "a3", prompt: "SCENARIO:badjson", doc: EMPTY, scope: ["*"], context: "" });
    expect((await c.waitFor(is("done", "a3"), 90_000)).ok).toBe(true);
    c.close();
  });

  it("reports a refused tool call as an error step", async () => {
    const c = await paired();
    c.send({ type: "ask", id: "a4", prompt: "SCENARIO:toolfail", doc: EMPTY, scope: ["*"], context: "" });
    await c.waitFor(is("done", "a4"), 90_000);
    const first = c.messages.find(is("toolResult", "a4"))!;
    expect(first.ok).toBe(false);
    expect(first.error).toMatch(/no_such_feature/);
    c.close();
  });

  it("says plainly when Claude Code is not logged in", async () => {
    const c = await paired();
    c.send({ type: "ask", id: "l", prompt: "SCENARIO:login", doc: EMPTY, scope: ["*"], context: "" });
    const done = await c.waitFor(is("done", "l"));
    expect(done).toMatchObject({ ok: false, errorKind: "login" });
    expect(done.text).toContain("Please run /login");
    expect(done.text).toContain("log in with your Claude subscription");
    c.close();
  });

  it("passes a usage limit on verbatim", async () => {
    const c = await paired();
    c.send({ type: "ask", id: "r", prompt: "SCENARIO:ratelimit", doc: EMPTY, scope: ["*"], context: "" });
    const done = await c.waitFor(is("done", "r"));
    expect(done).toMatchObject({ ok: false, errorKind: "rate-limit", text: "Claude AI usage limit reached. Your limit will reset at 5pm." });
    expect(c.messages.find(is("notice", "r"))!.text).toContain("rejected");
    c.close();
  });

  it("reports a crash with what Claude Code printed", async () => {
    const c = await paired();
    c.send({ type: "ask", id: "c", prompt: "SCENARIO:crash", doc: EMPTY, scope: ["*"], context: "" });
    const done = await c.waitFor(is("done", "c"));
    expect(done).toMatchObject({ ok: false, errorKind: "crash" });
    expect(done.text).toContain("exit code 3");
    expect(done.text).toContain("something broke");
    c.close();
  });

  it("stops a run on abort (the process tree too), and is free for the next ask", async () => {
    const c = await paired();
    c.send({ type: "ask", id: "s", prompt: "SCENARIO:slow", doc: EMPTY, scope: ["*"], context: "" });
    await c.waitFor(is("init", "s"), 60_000);
    c.send({ type: "ask", id: "s2", prompt: "x", doc: EMPTY, scope: ["*"], context: "" });
    expect((await c.waitFor(is("error", "s2"))).code).toBe("busy");
    const t0 = Date.now();
    c.send({ type: "abort", id: "s" });
    const done = await c.waitFor(is("done", "s"), 10_000);
    expect(done).toMatchObject({ ok: false, errorKind: "aborted" });
    expect(Date.now() - t0).toBeLessThan(5000);
    c.send({ type: "ask", id: "s3", prompt: "SCENARIO:login", doc: EMPTY, scope: ["*"], context: "" });
    expect((await c.waitFor(is("done", "s3"))).errorKind).toBe("login");
    c.close();
  });

  it("refuses a document that is not JSON", async () => {
    const c = await paired();
    c.send({ type: "ask", id: "j", prompt: "x", doc: "{nope", scope: ["*"], context: "" });
    expect((await c.waitFor(is("done", "j"))).text).toContain("not valid JSON");
    c.close();
  });
});

describe("bridge: timeouts and a missing claude", () => {
  it("stops a run that goes quiet for too long", async () => {
    const b = await startBridge({ port: 0, dataDir: join(dir, "data2"), token: "t".repeat(24), claudePath: FAKE, ...serverFiles(), idleMs: 1500 });
    try {
      const c = await connect(b.port);
      c.send({ type: "hello", token: "t".repeat(24) });
      await c.waitFor(is("welcome"));
      c.send({ type: "ask", id: "t", prompt: "SCENARIO:slow", doc: EMPTY, scope: ["*"], context: "" });
      const done = await c.waitFor(is("done", "t"), 60_000);
      expect(done.errorKind).toBe("timeout");
      c.close();
    } finally {
      await b.close();
    }
  });

  it("says how to install Claude Code when it is not there", async () => {
    const missing = join(dir, "no-such-claude");
    const b = await startBridge({ port: 0, dataDir: join(dir, "data3"), token: "u".repeat(24), claudePath: missing, ...serverFiles() });
    try {
      const c = await connect(b.port);
      c.send({ type: "hello", token: "u".repeat(24) });
      const w = await c.waitFor(is("welcome"));
      expect(w.claude.installed).toBe(false);
      expect(w.claude.problem).toContain("npm install -g @anthropic-ai/claude-code");
      c.send({ type: "ask", id: "m", prompt: "x", doc: EMPTY, scope: ["*"], context: "" });
      const done = await c.waitFor(is("done", "m"));
      expect(done.errorKind).toBe("not-installed");
      c.close();
    } finally {
      await b.close();
    }
  });
});

describe("bridge: Live link", () => {
  it("pushes a followed file's changes and stops when told", async () => {
    const c = await paired();
    const file = join(dir, "followed.cocaide.json");
    writeFileSync(file, EMPTY);
    c.send({ type: "follow", path: file });
    const first = await c.waitFor(is("follow"));
    expect(first.text).toBe(EMPTY);
    const next = JSON.stringify({ version: 1, units: "mm", name: "part", features: [{ id: "sketch_1", op: "sketch" }] });
    writeFileSync(file, next);
    await c.waitFor((m) => m.type === "follow" && m.text === next, 5000);
    c.send({ type: "unfollow" });
    await new Promise((r) => setTimeout(r, 100));
    const count = c.messages.filter(is("follow")).length;
    writeFileSync(file, EMPTY);
    await new Promise((r) => setTimeout(r, 700));
    expect(c.messages.filter(is("follow")).length).toBe(count);
    c.close();
  });

  it("only follows .json files given by full path", async () => {
    const c = await paired();
    c.send({ type: "follow", path: "/etc/passwd" });
    expect((await c.waitFor(is("followError"))).message).toContain(".cocaide.json");
    c.send({ type: "follow", path: "relative.cocaide.json" });
    await c.waitFor((m) => m.type === "followError" && m.path === "relative.cocaide.json");
    c.send({ type: "follow", path: join(dir, "missing.cocaide.json") });
    expect((await c.waitFor((m) => m.type === "followError" && m.path.endsWith("missing.cocaide.json"))).type).toBe("followError");
    c.close();
  });
});
