// The app's Claude Code provider (src/ask/bridge): the client, the ask with
// its live states, the proposal it makes, follow-ups and cancelling. Runs
// against the real bridge with the stand-in claude (fake-claude.mjs), and
// the real kernel.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyProposal, conflictsWith } from "../../src/ask/agent";
import { BridgeClient, BridgeError, socketUrl } from "../../src/ask/bridge/client";
import { bridgeAttachments, bridgeProposal, bridgeScope, contextText, runBridgeAsk, type LiveState } from "../../src/ask/bridge/run";
import { LocalKernel } from "../../src/ask/kernel";
import { serverFiles } from "../../src/bridge/main";
import { originAllowed, shortArgs, cocaideTool } from "../../src/bridge/protocol";
import { startBridge, type Bridge } from "../../src/bridge/server";
import type { RawDocument } from "../../src/doc/commands";
import { getOC, loadOC } from "../../src/kernel";
import { canAsk, loadSettings, BRIDGE_DEFAULTS, type AskSettings } from "../../src/ui/ask/settings";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const EMPTY: RawDocument = { version: 1, units: "mm", name: "part", features: [] } as RawDocument;
const bracket = JSON.parse(readFileSync(new URL("../../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;

/** A browser-like WebSocket: Node's, sending the page's Origin. */
const PageSocket = class extends WebSocket {
  constructor(url: string) {
    super(url, { headers: { origin: "https://mattymattmattmatt.github.io" } } as unknown as string[]);
  }
} as unknown as new (url: string) => WebSocket;

let bridge: Bridge;
let kernel: LocalKernel;
let dir: string;
const settings = () => ({ url: `http://127.0.0.1:${bridge.port}`, token: bridge.token, model: "opus" as const });
const client = () => new BridgeClient(settings().url, bridge.token, PageSocket);

beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
  dir = mkdtempSync(join(tmpdir(), "cocaide-provider-"));
  process.env.FAKE_CLAUDE_ARGS = join(dir, "args.json");
  bridge = await startBridge({ port: 0, dataDir: join(dir, "data"), claudePath: FAKE, ...serverFiles() });
});
afterAll(async () => {
  await bridge?.close();
  delete process.env.FAKE_CLAUDE_ARGS;
});

describe("protocol and settings", () => {
  it("allows the hosted app and localhost only", () => {
    expect(originAllowed("https://mattymattmattmatt.github.io")).toBe(true);
    expect(originAllowed("http://localhost:4196")).toBe(true);
    expect(originAllowed("http://127.0.0.1:5173")).toBe(true);
    expect(originAllowed("http://localhost")).toBe(true);
    expect(originAllowed("https://localhost:5173")).toBe(false);
    expect(originAllowed("https://mattymattmattmatt.github.io.evil.example")).toBe(false);
    expect(originAllowed("http://localhost.evil.example")).toBe(false);
    expect(originAllowed("null")).toBe(false);
    expect(originAllowed(undefined)).toBe(false);
  });

  it("shortens tool arguments and names Cocaide's tools", () => {
    expect(shortArgs({})).toBe("");
    expect(shortArgs({ id: "hole_1" })).toBe('{"id":"hole_1"}');
    expect(shortArgs({ text: "x".repeat(500) }, 20)).toHaveLength(20);
    expect(cocaideTool("mcp__cocaide__addFeature")).toBe("addFeature");
    expect(cocaideTool("Read")).toBeNull();
  });

  it("turns the address into the socket URL", () => {
    expect(socketUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/ws");
    expect(socketUrl("127.0.0.1:9000/")).toBe("ws://127.0.0.1:9000/ws");
    expect(() => socketUrl("https://example.com")).toThrow(BridgeError);
  });

  it("needs an address and a token, no key", () => {
    const s = { ...loadSettings(), provider: "claude-code" } as AskSettings;
    expect(s.bridge).toEqual(BRIDGE_DEFAULTS);
    expect(canAsk(s)).toBe(false);
    expect(canAsk({ ...s, bridge: { ...s.bridge, token: "abc" } })).toBe(true);
  });

  it("sends images and PDFs as files and text as text", () => {
    expect(
      bridgeAttachments([
        { id: "1", name: "a.png", kind: "image", mediaType: "image/png", size: 3, data: "AAA" },
        { id: "2", name: "b.pdf", kind: "pdf", mediaType: "application/pdf", size: 3, data: "BBB", text: "pdf text" },
        { id: "3", name: "c.dxf", kind: "cad", mediaType: "text/plain", size: 3, text: "DXF summary" },
      ]),
    ).toEqual([
      { name: "a.png", mediaType: "image/png", data: "AAA" },
      { name: "b.pdf", mediaType: "application/pdf", data: "BBB" },
      { name: "c.dxf", mediaType: "text/plain", text: "DXF summary" },
    ]);
  });

  it("scopes a target ask like the other providers, and a whole-part one to anything", () => {
    expect(bridgeScope(bracket, { kind: "feature", id: "hole_1" }, "target")).toEqual(["hole_1"]);
    expect(bridgeScope(bracket, { kind: "feature", id: "hole_1" }, "part")).toEqual(["*"]);
    expect(bridgeScope(bracket, { kind: "part" })).toEqual(["*"]);
    expect(contextText(null, [{ prompt: "make a box", reply: "done", changes: ["+ ext_1"], status: "accepted" }])).toContain("1. The user asked: make a box");
  });
});

describe("the proposal", () => {
  it("lists the changes, replays as the whole new document, and is dropped by any later edit", () => {
    const after = structuredClone(bracket);
    (after.features.find((f) => f.id === "hole_1") as Record<string, unknown>).diameter = 8;
    const p = bridgeProposal(bracket, after, { before: 1, after: 2 });
    expect(p).toMatchObject({ replace: true, bridge: true, volumeBefore: 1, volumeAfter: 2 });
    expect(p.changes).toEqual([{ id: "hole_1", kind: "changed", fields: [{ path: "diameter", before: 6.6, after: 8 }] }]);
    const r = applyProposal(bracket, p);
    expect(r.ok && r.doc).toEqual(after);
    expect(conflictsWith(p, bracket)).toEqual([]);
    const edited = structuredClone(bracket);
    edited.name = "renamed";
    expect(conflictsWith(p, edited)).toEqual(["the part"]);
  });
});

describe("the client", () => {
  it("pairs and reports Claude Code's status", async () => {
    const c = client();
    expect(await c.connect()).toMatchObject({ installed: true, loggedIn: true });
    expect(c.versionNote).toBeNull();
    c.close();
  });

  it("says what to do about a wrong token, no token and no bridge", async () => {
    await expect(new BridgeClient(settings().url, "wrong-token-123456789", PageSocket).connect()).rejects.toMatchObject({ problem: "unauthorized" });
    await expect(new BridgeClient(settings().url, "", PageSocket).connect()).rejects.toMatchObject({ problem: "no-token" });
    const e = await new BridgeClient("http://127.0.0.1:1", "t", PageSocket).connect(3000).then(() => null as unknown as BridgeError, (x: BridgeError) => x);
    expect(e.problem).toBe("unreachable");
    expect(e.message).toContain("npm run bridge");
  });
});

describe("an ask through the bridge", () => {
  it("shows each step and each new version of the part live, and ends with a proposal", async () => {
    const states: LiveState[] = [];
    const r = await runBridgeAsk({ doc: EMPTY, target: { kind: "part" }, text: "a block", kernel, bridge: settings(), client: client(), onLive: (s) => states.push(s) });
    expect(r.outcome).toBe("proposal");
    expect(r.text).toBe("Done: a 40 × 20 × 10 block.");
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.model).toContain("Claude Code (opus)");
    expect(r.calls.map((c) => `${c.tool} ${c.ok}`)).toEqual(["addFeature true", "addFeature true", "partSummary true"]);
    expect(r.proposal!.bridge).toBe(true);
    expect(r.proposal!.changes.map((c) => `${c.kind} ${c.id}`)).toEqual(["added block_sketch", "added block"]);
    expect(r.proposal!.volumeBefore).toBeNull();
    expect(r.proposal!.volumeAfter).toBeCloseTo(40 * 20 * 10, 3);
    expect(states[0].phase).toBe("connecting");
    // The view got the sketch on its own first, then the block.
    const docs = states.map((s) => s.doc?.features.map((f) => f.id).join(",") ?? "");
    expect(docs).toContain("block_sketch");
    expect(docs.at(-1)).toBe("block_sketch,block");
    const running = states.find((s) => s.steps.some((x) => x.status === "running"))!;
    expect(running.steps.at(-1)!.status).toBe("running");
    expect(states.some((s) => s.text.includes("Building a block."))).toBe(true);
  });

  it("continues Claude Code's session on a follow-up and sends the packet the first time", async () => {
    await runBridgeAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, reach: "target", text: "bigger", kernel, bridge: settings(), client: client() });
    let sent = JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as { argv: string[]; prompt: string };
    expect(sent.prompt).toContain('"writeScope":["hole_1"]');
    expect(sent.argv).not.toContain("--resume");
    await runBridgeAsk({ doc: bracket, target: { kind: "part" }, text: "again", kernel, bridge: settings(), client: client(), resume: "abc-session" });
    sent = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
    expect(sent.argv[sent.argv.indexOf("--resume") + 1]).toBe("abc-session");
  });

  it("reports a login problem as a failure with the fix, and changes nothing", async () => {
    const r = await runBridgeAsk({ doc: EMPTY, target: { kind: "part" }, text: "SCENARIO:login", kernel, bridge: settings(), client: client() });
    expect(r.outcome).toBe("failed");
    expect(r.text).toContain("log in with your Claude subscription");
    expect(r.proposal).toBeNull();
  });

  it("cancels: the bridge stops Claude Code and nothing is proposed", async () => {
    const ctl = new AbortController();
    const r = await runBridgeAsk({
      doc: EMPTY,
      target: { kind: "part" },
      text: "SCENARIO:slow",
      kernel,
      bridge: settings(),
      client: client(),
      signal: ctl.signal,
      onLive: (s) => s.phase === "running" && ctl.abort(),
    });
    expect(r.text).toBe("Cancelled.");
    expect(r.proposal).toBeNull();
  });

  it("says how to start the bridge when it is not running", async () => {
    const r = await runBridgeAsk({ doc: EMPTY, target: { kind: "part" }, text: "x", kernel, bridge: { url: "http://127.0.0.1:1", token: "t", model: "default" }, client: new BridgeClient("http://127.0.0.1:1", "t", PageSocket) });
    expect(r.outcome).toBe("failed");
    expect(r.text).toContain("npm run bridge");
  });
});
