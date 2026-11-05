#!/usr/bin/env node
// A stand-in for Claude Code in the bridge tests. It answers --version and
// `auth status`, and for `-p` it reads the prompt on stdin, starts the MCP
// servers named by --mcp-config (the real Cocaide server), makes real tool
// calls through them, and prints stream-json events shaped like Claude
// Code's. What it does is picked by a word in the prompt:
//   SCENARIO:box (default)  sketch + extrude, with text deltas
//   SCENARIO:badjson        a line that is not JSON, then box
//   SCENARIO:toolfail       one refused call, then a good one
//   SCENARIO:login          "not logged in" result
//   SCENARIO:ratelimit      a rate limit event and a usage-limit result
//   SCENARIO:crash          stderr and exit code 3, no result
//   SCENARIO:slow           init, then waits (for abort / timeout tests)
// FAKE_CLAUDE_ARGS: a file the arguments and the prompt are written to.
// FAKE_CLAUDE_LOGGED_OUT=1: auth status says logged out.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("9.9.9 (Claude Code, test stand-in)");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_OUT !== "1", authMethod: "claude.ai" }));
  process.exit(process.env.FAKE_CLAUDE_LOGGED_OUT === "1" ? 1 : 0);
}

const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = readFileSync(0, "utf8");
if (process.env.FAKE_CLAUDE_ARGS) writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({ argv, prompt, cwd: process.cwd() }));
const scenario = /SCENARIO:(\w+)/.exec(prompt)?.[1] ?? "box";
const sessionId = opt("--resume") ?? randomUUID();
const out = (e) => process.stdout.write(JSON.stringify({ ...e, session_id: sessionId }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const config = JSON.parse(readFileSync(opt("--mcp-config"), "utf8"));
const names = Object.keys(config.mcpServers);

if (scenario === "crash") {
  process.stderr.write("fake claude: something broke\n");
  process.exit(3);
}

let client = null;
const tools = [];
if (scenario !== "login" && scenario !== "ratelimit") {
  const s = config.mcpServers.cocaide;
  client = new Client({ name: "fake-claude", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: s.command, args: s.args, stderr: "ignore" }));
  for (const t of (await client.listTools()).tools) tools.push(`mcp__cocaide__${t.name}`);
}
out({ type: "system", subtype: "init", cwd: process.cwd(), tools, mcp_servers: names.map((n) => ({ name: n, status: client ? "connected" : "failed" })), model: opt("--model") ?? "claude-test", permissionMode: "default" });

if (scenario === "login") {
  out({ type: "assistant", message: { id: "m0", role: "assistant", content: [{ type: "text", text: "Invalid API key · Please run /login" }], stop_reason: "end_turn" }, error: "authentication_failed" });
  out({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", duration_ms: 5, num_turns: 1, total_cost_usd: 0 });
  process.exit(1);
}
if (scenario === "ratelimit") {
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1893456000 } });
  out({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached. Your limit will reset at 5pm.", duration_ms: 5, num_turns: 1 });
  process.exit(1);
}
if (scenario === "slow") {
  await sleep(120_000);
  process.exit(0);
}
if (scenario === "badjson") process.stdout.write("this is not json {\n");

let n = 0;
async function call(name, input) {
  const id = `toolu_${++n}`;
  out({ type: "assistant", message: { id: `m${n}`, role: "assistant", content: [{ type: "tool_use", id, name: `mcp__cocaide__${name}`, input }], stop_reason: "tool_use" } });
  const r = await client.callTool({ name, arguments: input });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: r.content.filter((c) => c.type === "text"), ...(r.isError ? { is_error: true } : {}) }] } });
  await sleep(Number(process.env.FAKE_CLAUDE_STEP_MS ?? 50));
  return r;
}
const delta = (text) => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });

delta("Building ");
delta("a block.");
out({ type: "assistant", message: { id: "m-a", role: "assistant", content: [{ type: "text", text: "Building a block." }] } });
if (scenario === "toolfail") await call("updateFeature", { id: "no_such_feature", patch: { distance: 3 } });
await call("addFeature", { feature: { id: "sketch_1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 20 }] } });
await call("addFeature", { feature: { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: 10, direction: [0, 0, 1] } });
await call("partSummary", {});
delta("Done: a 40 × 20 × 10 block.");
out({ type: "assistant", message: { id: "m-z", role: "assistant", content: [{ type: "text", text: "Done: a 40 × 20 × 10 block." }], stop_reason: "end_turn" } });
await client.close();
out({ type: "result", subtype: "success", is_error: false, result: "Done: a 40 × 20 × 10 block.", duration_ms: 1234, num_turns: 4, total_cost_usd: 0.0123, usage: { input_tokens: 100, output_tokens: 50 } });
process.exit(0);
