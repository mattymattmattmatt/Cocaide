// The Ollama provider, against a SCRIPTED STAND-IN for the Ollama server
// (tests/ollama-standin.ts: the real wire formats of /api/chat, /api/tags,
// /api/show and /api/pull, scripted replies instead of a model): tool schema
// conversion, tool calls and results mapped both ways, malformed calls
// repaired or refused with the reason, the loop's limits, cancelling, a failed
// rebuild going back to the model, the write scope, and proposals staying
// proposals. The real kernel builds every edit.

import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runAsk } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { ScriptedModel, say } from "../src/ask/model";
import { OllamaClient, OllamaError, WINDOWS_ORIGINS_COMMAND, fixFor } from "../src/ask/ollama/client";
import { fitContext, noVisionMessage, OllamaModel, thinkValue, toOllamaMessages } from "../src/ask/ollama/model";
import { extractTextCalls, matchTool, parseLoose, repairCall, stripThinking } from "../src/ask/ollama/repair";
import { formatSchema, toOllamaTool, validateArgs } from "../src/ask/ollama/schema";
import { leanTools, SYSTEM, SYSTEM_COMPACT, toolsFor } from "../src/ask/prompt";
import { SCHEMAS } from "../src/ask/schemas";
import { getOC, loadOC } from "../src/kernel";
import { bracket, BRACKET_VOLUME, placesOf, type Places } from "./ollama-scenarios";
import { lastResults, OllamaStandIn, packetOf, QWEN } from "./ollama-standin";

let kernel: LocalKernel;
let at: Places;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
  at = await placesOf(kernel);
});

const ALL = toolsFor("edit", "part", { part: true, drawing: true, build: true });
const tool = (name: string) => ALL.find((t) => t.name === name)!;

function setup(
  opts: ConstructorParameters<typeof OllamaStandIn>[0] = {},
  model = QWEN.name,
  extra: Partial<ConstructorParameters<typeof OllamaModel>[1]> = {},
) {
  const server = new OllamaStandIn(opts);
  const m = new OllamaModel(new OllamaClient("http://localhost:11434", { fetch: server.fetch, origin: "https://mattymattmattmatt.github.io" }), {
    model,
    numCtx: 16384,
    ...extra,
  });
  return { server, model: m };
}

/** Every key used anywhere in a schema. */
function keysIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysIn(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      if (k === "properties") Object.values(x as object).forEach((p) => keysIn(p, out));
      else keysIn(x, out);
    }
  return out;
}

describe("tool schemas for Ollama", () => {
  it("every tool converts to a function definition Ollama's types take: one type per property, no anyOf or additionalProperties", () => {
    for (const t of ALL) {
      const o = toOllamaTool(t);
      expect(o.type).toBe("function");
      expect(o.function.name).toBe(t.name);
      expect(o.function.parameters.type).toBe("object");
      const keys = keysIn(o.function.parameters);
      for (const bad of ["anyOf", "oneOf", "additionalProperties", "$schema", "minItems", "maxItems"])
        expect(keys.has(bad), `${t.name} keeps ${bad}`).toBe(false);
      const types: unknown[] = [];
      const walk = (s: Record<string, unknown>) => {
        if ("type" in s) types.push(s.type);
        for (const p of Object.values((s.properties ?? {}) as Record<string, Record<string, unknown>>)) walk(p);
        if (s.items) walk(s.items as Record<string, unknown>);
      };
      walk(o.function.parameters as unknown as Record<string, unknown>);
      expect(
        types.every((x) => typeof x === "string"),
        `${t.name}: ${JSON.stringify(types)}`,
      ).toBe(true);
    }
  });

  it("keeps enums and required, and names the other types of a union in the description", () => {
    const lf = toOllamaTool(tool("listFaces")).function.parameters;
    expect(lf.properties!.type.enum).toEqual(["plane", "cylinder", "cone", "other"]);
    const sp = toOllamaTool(tool("setParameter")).function.parameters;
    expect(sp.required).toEqual(["name", "value"]);
    expect(sp.properties!.value).toMatchObject({ type: "number", description: "(number or string)" });
    const sn = toOllamaTool(tool("setNode")).function.parameters;
    expect(sn.properties!.at).toMatchObject({ type: "array", description: "(or null)" });
    const mb = toOllamaTool(tool("measureBetween")).function.parameters;
    expect(mb.properties!.a.description).toMatch(/^\(array or object\) A face or edge selector/);
  });

  it("structured output schemas keep unions, enums and required, and drop what the grammar can't take", () => {
    for (const s of Object.values(SCHEMAS)) {
      const f = formatSchema(z.toJSONSchema(s as z.ZodType));
      const keys = keysIn(f);
      expect(keys.has("$schema")).toBe(false);
      expect(keys.has("required")).toBe(true);
    }
    const intent = formatSchema(z.toJSONSchema(SCHEMAS.intent)) as Record<string, Record<string, Record<string, unknown>>>;
    expect(intent.properties.kind.enum).toEqual(["plate", "disc", "frame", "other"]);
    expect(formatSchema({ type: "object", oneOf: [{ type: "string", pattern: "x", minLength: 2 }], additionalProperties: {} })).toEqual({
      type: "object",
      anyOf: [{ type: "string" }],
    });
  });

  it("validates arguments against the original schema with the exact problem", () => {
    const s = tool("updateFeature").input_schema;
    expect(validateArgs(s, { id: "hole_1", patch: { diameter: 8 } })).toBeNull();
    expect(validateArgs(s, { id: "hole_1" })).toBe('"patch" is required');
    expect(validateArgs(s, { id: "hole_1", patch: {}, extra: 1 })).toBe('arguments: unknown argument "extra" (allowed: id, patch)');
    expect(validateArgs(s, { id: 5, patch: {} })).toBe("id: expected string, got a number");
    expect(validateArgs(tool("listFaces").input_schema, { type: "flat" })).toBe('type: must be one of "plane", "cylinder", "cone", "other", got "flat"');
    expect(validateArgs(tool("measureBetween").input_schema, { a: [1, 2], b: [0, 0, 0] })).toBe("a: needs at least 3 items, got 2");
    expect(validateArgs(tool("setParameter").input_schema, { name: "t", value: true })).toBe("value: expected number or string, got boolean");
  });

  it("the lean list for a small context drops only rare edits, which stay batch steps", () => {
    const lean = leanTools(ALL);
    const dropped = ALL.filter((t) => !lean.includes(t)).map((t) => t.name);
    expect(dropped).toEqual(expect.arrayContaining(["setFolder", "reorderFeature", "setCutList"]));
    for (const keep of [
      "batch",
      "addFeature",
      "updateFeature",
      "holes",
      "sketchProfile",
      "listFaces",
      "listEdges",
      "partSummary",
      "plan",
      "setParameter",
      "screenshot",
      "reference",
    ])
      expect(lean.map((t) => t.name)).toContain(keep);
    // Without batch (a question) the list is not cut.
    const read = toolsFor("explain", "feature");
    expect(leanTools(read)).toEqual(read);
    expect(SYSTEM_COMPACT.length).toBeLessThan(SYSTEM.length * 0.7);
    expect(SYSTEM_COMPACT).toContain("batch step");
  });
});

describe("messages and tool calls, both ways", () => {
  it("tool_use and tool_result map to tool_calls and role tool with tool_name; a screenshot follows as an image", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "packet" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "a", name: "partSummary", input: {} },
          { type: "tool_use", id: "b", name: "screenshot", input: { view: "iso" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: '{"ok":true}' },
          {
            type: "tool_result",
            tool_use_id: "b",
            content: [
              { type: "text", text: '{"ok":true,"view":"iso"}' },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
            ],
          },
        ],
      },
    ];
    expect(toOllamaMessages("sys", messages, true)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "packet" },
      {
        role: "assistant",
        content: "Looking.",
        tool_calls: [{ function: { name: "partSummary", arguments: {} } }, { function: { name: "screenshot", arguments: { view: "iso" } } }],
      },
      { role: "tool", tool_name: "partSummary", content: '{"ok":true}' },
      { role: "tool", tool_name: "screenshot", content: '{"ok":true,"view":"iso"}' },
      { role: "user", content: "The picture from screenshot:", images: ["iVBORw0KGgo="] },
    ]);
    // Without vision the picture is described as not shown.
    const blind = toOllamaMessages("sys", messages, false, "qwen3:8b");
    expect(blind.find((m) => m.tool_name === "screenshot")!.content).toContain("not shown: qwen3:8b has no vision");
    expect(blind.some((m) => m.images)).toBe(false);
  });

  it("thinking is dropped from the answer; tool calls written as <tool_call> text are used", () => {
    expect(stripThinking("<think>let me see</think>\nThe hole is 6.6.")).toBe("The hole is 6.6.");
    expect(stripThinking("reasoning only</think>Answer")).toBe("Answer");
    const x = extractTextCalls('Sure.\n<tool_call>\n{"name": "getFeature", "arguments": {"id": "hole_1"}}\n</tool_call>');
    expect(x).toEqual({ calls: [{ name: "getFeature", arguments: { id: "hole_1" } }], text: "Sure." });
    expect(extractTextCalls('```json\n{"name": "partSummary", "arguments": {}}\n```').calls).toEqual([{ name: "partSummary", arguments: {} }]);
    expect(extractTextCalls('The JSON is {"a": 1}.').calls).toEqual([]);
  });

  it("repairs what it safely can, and refuses the rest with the reason", () => {
    expect(matchTool("functions.update_feature", ALL)!.name).toBe("updateFeature");
    expect(matchTool("UPDATEFEATURE", ALL)!.name).toBe("updateFeature");
    expect(parseLoose('{"id": "x"} and then some words')).toEqual({ id: "x" });

    const a = repairCall("UpdateFeature", '{"id": "hole_1", "patch": "{\\"diameter\\": 8}"} trailing', ALL);
    expect(a).toMatchObject({ name: "updateFeature", input: { id: "hole_1", patch: { diameter: 8 } }, problem: null });
    expect(a.repairs).toEqual(['name "UpdateFeature" → "updateFeature"', "arguments parsed from a string", "patch parsed from a string"]);
    expect(repairCall("setDimension", { sketch: "s", index: "2", value: 5 }, ALL)).toMatchObject({ input: { index: 2 }, problem: null });
    expect(repairCall("suppressFeature", { id: "x", suppressed: "true" }, ALL)).toMatchObject({ input: { suppressed: true }, problem: null });
    expect(repairCall("getFeature", { arguments: { id: "x" } }, ALL)).toMatchObject({ input: { id: "x" }, problem: null });
    // A number where the schema takes number or string stays as given.
    expect(repairCall("setParameter", { name: "t", value: "=w/2" }, ALL)).toMatchObject({ input: { value: "=w/2" }, problem: null });

    expect(repairCall("drillHole", {}, ALL).problem).toMatch(/^unknown tool "drillHole"\. The tools you can call: measure, getFeature/);
    expect(repairCall("updateFeature", "{id: hole_1", ALL).problem).toMatch(/^the arguments of updateFeature are not valid JSON/);
    expect(repairCall("updateFeature", [1], ALL).problem).toBe("the arguments of updateFeature must be a JSON object, got an array");
    expect(repairCall("updateFeature", { id: "hole_1" }, ALL).problem).toBe('updateFeature: "patch" is required. Fix the arguments and call it again.');
  });

  it("the oldest tool results are cut first when the conversation outgrows the context; the packet and the last round stay whole", () => {
    const big = "x".repeat(6000);
    const ms = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: `packet ${big}` },
      { role: "assistant" as const, content: "", tool_calls: [{ function: { name: "listFaces", arguments: {} } }] },
      { role: "tool" as const, tool_name: "listFaces", content: big },
      { role: "assistant" as const, content: "", tool_calls: [{ function: { name: "listEdges", arguments: {} } }] },
      { role: "tool" as const, tool_name: "listEdges", content: big },
    ];
    const fit = fitContext(ms, 5000);
    expect(fit[1].content.length).toBe(ms[1].content.length);
    expect(fit[3].content).toMatch(/trimmed to fit the context/);
    expect(fit[5].content).toBe(big);
    expect(fitContext(ms, 100000)).toBe(ms);
  });

  it("think: off is an explicit false, levels only for models that have them, nothing for models without thinking", () => {
    const qwen = { tools: true, vision: true, thinking: true };
    expect(thinkValue("off", qwen, "qwen3.5:9b")).toBe(false);
    expect(thinkValue("low", qwen, "qwen3.5:9b")).toBe(true);
    expect(thinkValue("low", qwen, "gpt-oss:20b")).toBe("low");
    expect(thinkValue("on", { ...qwen, thinking: false }, "llama3.2")).toBeUndefined();
  });
});

describe("the server: connection, models, pulling", () => {
  it("tells a refused origin (CORS) from nothing running, with the exact fix", async () => {
    expect(await setup({ allowOrigin: false }).model.client.connect()).toMatchObject({ ok: false, problem: "origin" });
    expect(await setup({ reachable: false }).model.client.connect()).toMatchObject({ ok: false, problem: "unreachable" });
    const fix = fixFor("origin", { baseUrl: "http://localhost:11434", origin: "https://mattymattmattmatt.github.io" });
    expect(fix.command).toBe('setx OLLAMA_ORIGINS "https://mattymattmattmatt.github.io,http://localhost:*"');
    expect(WINDOWS_ORIGINS_COMMAND).toBe(fix.command);
    expect(fix.text).toContain("quit Ollama from its tray icon");
  });

  it("an ask with Ollama refusing the origin fails with the fix in the message, and changes nothing", async () => {
    const { model } = setup({ allowOrigin: false });
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model, kernel });
    expect(r.outcome).toBe("failed");
    expect(r.text).toContain("could not reach Ollama at http://localhost:11434");
    expect(r.text).toContain('setx OLLAMA_ORIGINS "https://mattymattmattmatt.github.io,http://localhost:*"');
    expect(r.proposal).toBeNull();
  });

  it("a model that isn't installed says how to pull it; one without tools is refused before any turn", async () => {
    const missing = setup({}, "qwen3.5:27b");
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model: missing.model, kernel });
    expect(r.text).toMatch(/model "qwen3\.5:27b" not found in Ollama: pull it first \(ollama pull qwen3\.5:27b\)/);
    const plain = setup({ models: [{ name: "gemma:2b", capabilities: ["completion"] }] }, "gemma:2b");
    const r2 = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model: plain.model, kernel });
    expect(r2.text).toContain("gemma:2b cannot call tools");
    expect(plain.server.chats).toEqual([]);
  });

  it("pulls a model with progress, and reports a failed pull", async () => {
    const { server, model } = setup();
    const seen: string[] = [];
    await model.client.pull("qwen3.5:4b", (p) => seen.push(p.total ? `${p.status} ${p.completed}/${p.total}` : p.status));
    expect(seen[0]).toBe("pulling manifest");
    expect(seen).toContain("pulling 3e4cb1417446 3300000000/6600000000");
    expect(seen.at(-1)).toBe("success");
    expect(server.models.map((m) => m.name)).toContain("qwen3.5:4b");
    await expect(model.client.pull("nope:1b")).rejects.toMatchObject({ kind: "model-missing" });
  });
});

describe("the agent loop with a local model", () => {
  it("a malformed call is answered with its error (not thrown), and the model's fixed call goes through", async () => {
    const { server, model } = setup();
    server.script(
      // Embedded in the text, Qwen style, with the arguments broken: not JSON.
      { content: '<tool_call>{"name": "updateFeature", "arguments": "{id: hole_1"}</tool_call>' },
      (req) => {
        expect(lastResults(req)).toEqual([
          { tool: "updateFeature", result: { ok: false, error: expect.stringMatching(/^the arguments of updateFeature are not valid JSON/) } },
        ]);
        // An unknown tool next to a good call: one refused, one run.
        return {
          tool_calls: [
            { name: "resizeHole", arguments: { d: 8 } },
            { name: "updateFeature", arguments: { id: "hole_1", patch: { diameter: 8 } } },
          ],
        };
      },
      (req) => {
        const [bad, good] = lastResults(req);
        expect(bad.result.error).toMatch(/^unknown tool "resizeHole"/);
        expect(good.result).toMatchObject({ ok: true, features: [{ id: "hole_1", diameter: 8 }] });
        return { content: "hole_1 is now Ø8." };
      },
    );
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model, kernel });
    expect(r.outcome, r.text).toBe("proposal");
    expect(r.calls.map((c) => [c.tool, c.ok])).toEqual([
      ["updateFeature", false],
      ["resizeHole", false],
      ["updateFeature", true],
    ]);
    expect(r.proposal!.changes).toEqual([{ id: "hole_1", kind: "changed", fields: [{ path: "diameter", before: 6.6, after: 8 }] }]);
  });

  it("the same failing call made again and again ends the ask", async () => {
    const { server, model } = setup();
    const same = { tool_calls: [{ name: "updateFeature", arguments: { id: "hole_1", patch: { diameter: -5 } } }] };
    server.script(same, same, same, same, same);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it -5", model, kernel });
    expect(r.calls).toHaveLength(3);
    expect(r.calls.every((c) => !c.ok)).toBe(true);
    expect(r.text).toBe("(Stopped: updateFeature failed 3 times with the same arguments.)");
    expect(r.outcome).toBe("answer");
    expect(r.proposal).toBeNull();
    expect(server.remaining).toBe(2);
  });

  it("the turn limit holds: a model that never stops looking is stopped", async () => {
    const { server, model } = setup();
    for (let i = 0; i < 12; i++) server.script({ tool_calls: [{ name: "measure", arguments: {} }] });
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model, kernel });
    expect(r.turns).toBe(8); // the surgical budget
    expect(r.text).toContain("(Stopped after 8 steps.)");
  });

  it("cancelling aborts the request in flight", async () => {
    const { server, model } = setup();
    server.script({ content: "never", delayMs: 5000 });
    const ctl = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 50);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model, kernel, signal: ctl.signal });
    expect(r.text).toBe("Cancelled.");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a stalled model times out with what to check", async () => {
    const { server, model } = setup({}, QWEN.name, { idleTimeoutMs: 100 });
    server.script({ content: "late", delayMs: 3000 });
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model, kernel });
    expect(r.outcome).toBe("failed");
    expect(r.text).toContain("did not answer in time");
    expect(r.text).toContain("ollama ps");
  });

  it("a failed rebuild goes back to the model as the call's result, and nothing of it is kept", async () => {
    const { server, model } = setup();
    server.script(
      (req) => ({ tool_calls: [{ name: "addFeature", arguments: { feature: { op: "fillet", edges: packetOf(req).selection, radius: 45 } } }] }),
      (req) => {
        const [r] = lastResults(req);
        expect(r.result.ok).toBe(false);
        expect(String(r.result.error)).toMatch(/^addFeature rolled back: /);
        return { content: "That radius does not fit; nothing was changed." };
      },
    );
    const r = await runAsk({ doc: bracket, target: { kind: "edge", index: at.sideEdge }, text: "fillet 45", model, kernel });
    expect(r.outcome).toBe("answer");
    expect(r.proposal).toBeNull();
  });

  it("the write scope holds: an edit outside it is refused, and the ask ends refused", async () => {
    const { server, model } = setup();
    server.script(
      { tool_calls: [{ name: "updateFeature", arguments: { id: "ext_1", patch: { distance: 12 } } }] },
      { content: "I could not change the plate from here." },
    );
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make the plate 12 thick", model, kernel });
    expect(r.calls[0]).toMatchObject({ tool: "updateFeature", ok: false });
    expect(r.calls[0].error).toMatch(/^writeScope:/);
    expect(r.outcome).toBe("refused");
    expect(r.proposal).toBeNull();
  });

  it("a question gets no write tools; an edit attempt from it changes nothing", async () => {
    const { server, model } = setup();
    server.script({ tool_calls: [{ name: "updateFeature", arguments: { id: "hole_1", patch: { diameter: 8 } } }] }, { content: "It is 6.6." });
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "What diameter is this?", model, kernel });
    expect(server.chats[0].tools!.map((t) => t.function.name)).not.toContain("updateFeature");
    expect(r.calls[0]).toMatchObject({ ok: false });
    expect(r.calls[0].error).toMatch(/^unknown tool "updateFeature"/);
    expect(r.outcome).toBe("answer");
    expect(r.proposal).toBeNull();
  });

  it("confirmation is not bypassed: a local model's edit is a proposal; the document stays as it was", async () => {
    const { server, model } = setup();
    server.script({ tool_calls: [{ name: "updateFeature", arguments: { id: "hole_1", patch: { diameter: 8 } } }] }, { content: "Done." });
    const doc = structuredClone(bracket);
    const r = await runAsk({ doc, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(doc).toEqual(bracket);
    expect(r.proposal!.base).toEqual(bracket);
    expect(r.proposal!.volumeBefore).toBeCloseTo(BRACKET_VOLUME, 4);
  });

  it("a small context gets the compact prompt and the lean tools; Anthropic and the scripted model keep the full ones", async () => {
    const { server, model } = setup();
    server.script({ content: "ok" });
    await runAsk({ doc: bracket, target: { kind: "feature", id: "ext_1" }, text: "change it", model, kernel, reach: "part" });
    expect(server.chats[0].messages[0].content).toBe(SYSTEM_COMPACT);
    expect(server.chats[0].tools!.map((t) => t.function.name)).not.toContain("setFolder");
    const scripted = new ScriptedModel([() => [say("ok")]]);
    await runAsk({ doc: bracket, target: { kind: "feature", id: "ext_1" }, text: "change it", model: scripted, kernel, reach: "part" });
    expect(scripted.requests[0].system).toBe(SYSTEM);
    expect(scripted.requests[0].tools.map((t) => t.name)).toContain("setFolder");
    // A large context gets the full prompt from Ollama too.
    const big = setup({}, QWEN.name, { numCtx: 131072 });
    big.server.script({ content: "ok" });
    await runAsk({ doc: bracket, target: { kind: "feature", id: "ext_1" }, text: "change it", model: big.model, kernel, reach: "part" });
    expect(big.server.chats[0].messages[0].content).toBe(SYSTEM);
  });

  it("a visual ask sends the picture to a vision model; reading a drawing with a text-only model is refused clearly", async () => {
    const { server, model } = setup();
    server.script({ content: "It is the top face of the plate." });
    await runAsk({ doc: bracket, target: { kind: "face", index: at.topFace }, text: "What does this face look like?", model, kernel });
    const user = server.chats[0].messages[1];
    expect(user.images).toHaveLength(1);
    expect(user.images![0]).toMatch(/^iVBOR/); // a PNG, base64, no data: prefix

    const blind = setup({ models: [{ name: "qwen3:8b", capabilities: ["completion", "tools", "thinking"] }] }, "qwen3:8b");
    await expect(
      blind.model.readIntent({
        system: "read",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
          { type: "text", text: "the drawing" },
        ],
        schema: "drawing",
      }),
    ).rejects.toThrow(noVisionMessage("qwen3:8b"));
  });

  it("structured output: the schema goes as format, a reading that does not fit is asked again once", async () => {
    const { server, model } = setup();
    server.script(
      { content: '{"name": "SHS", "designations": "40x40x3"}' },
      {
        content:
          '<think>fix it</think>{"name": "SHS", "designations": ["SHS 40x40x3"], "tags": ["square"], "anchor": "centroid", "why": "A square hollow section."}',
      },
    );
    const out = await model.readIntent({ system: "name it", content: [{ type: "text", text: "facts" }], schema: "profile" });
    expect(SCHEMAS.profile.safeParse(out).success).toBe(true);
    expect(server.chats[0].format).toMatchObject({ type: "object", required: expect.any(Array) });
    expect(server.chats[0].think).toBe(false);
    expect(server.chats[1].messages.at(-1)!.content).toMatch(/^That does not match the schema/);
  });

  it("errors carry their kind", () => {
    expect(new OllamaError("origin", "x").kind).toBe("origin");
  });
});
