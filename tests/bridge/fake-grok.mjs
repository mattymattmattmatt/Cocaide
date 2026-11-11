#!/usr/bin/env node
// A stand-in for xAI's Grok Build CLI in the bridge tests. It answers
// --version, and for a headless run (-p <prompt>) it reads the MCP servers
// from the .mcp.json in the folder it runs in (as Grok Build does), makes real
// calls to Cocaide's server, and prints "streaming-messages-json" (Claude
// Code's stream-json) with Grok's own spellings: MCP tools named
// "cocaide__<tool>" and tool output wrapped as {"output_for_prompt": ...}.
//   SCENARIO:box (default)  sketch + extrude
//   SCENARIO:notools        no .mcp.json servers loaded (init lists none)
// FAKE_GROK_ARGS: a file the arguments and the folder are written to.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("Grok Build 9.9.9 (test stand-in)");
  process.exit(0);
}
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = opt("-p") ?? "";
if (process.env.FAKE_GROK_ARGS) writeFileSync(process.env.FAKE_GROK_ARGS, JSON.stringify({ argv, cwd: process.cwd(), mcpJson: existsSync(".mcp.json") ? readFileSync(".mcp.json", "utf8") : null }));
const scenario = /SCENARIO:(\w+)/.exec(prompt)?.[1] ?? "box";
const sessionId = opt("-r") ?? randomUUID();
const out = (e) => process.stdout.write(JSON.stringify({ ...e, session_id: sessionId }) + "\n");

const config = existsSync(join(process.cwd(), ".mcp.json")) ? JSON.parse(readFileSync(".mcp.json", "utf8")) : { mcpServers: {} };
const tools = ["run_terminal_command", "read_file", "search_replace"];
let client = null;
if (scenario !== "notools" && config.mcpServers.cocaide) {
  const s = config.mcpServers.cocaide;
  client = new Client({ name: "fake-grok", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: s.command, args: s.args, stderr: "ignore" }));
  for (const t of (await client.listTools()).tools) tools.push(`cocaide__${t.name}`);
}
out({ type: "system", subtype: "init", cwd: process.cwd(), tools, model: opt("-m") ?? "grok-4.7", permissionMode: opt("--permission-mode"), apiKeySource: "oauth" });
if (!client) {
  out({ type: "result", subtype: "success", is_error: false, result: "I can't see any Cocaide tools.", duration_ms: 3, num_turns: 1 });
  process.exit(0);
}
let n = 0;
async function call(name, input) {
  const id = `call_${++n}`;
  out({ type: "assistant", message: { id: `m${n}`, role: "assistant", content: [{ type: "tool_use", id, name: `cocaide__${name}`, input }], stop_reason: "tool_use" } });
  const r = await client.callTool({ name, arguments: input });
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify({ output_for_prompt: text }), ...(r.isError ? { is_error: true } : {}) }] } });
  return r;
}
out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Building a block with Grok." } } });
await call("addFeature", { feature: { id: "block_sketch", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 20 }] } });
await call("addFeature", { feature: { id: "block", op: "extrude", sketch: "block_sketch", distance: 10, direction: [0, 0, 1] } });
await client.close();
out({ type: "result", subtype: "success", is_error: false, result: "Done with Grok: a 40 × 20 × 10 block.", duration_ms: 900, num_turns: 3, total_cost_usd: 0 });
process.exit(0);
