// The Ollama provider driving the real agent loop on the real kernel (the
// Node kernel port), with a SCRIPTED STAND-IN playing the Ollama server and
// its model (tests/ollama-standin.ts: it speaks the real /api/chat, /api/tags,
// /api/show and /api/pull wire formats; it is not a model). The ten scenarios
// of tests/ollama-scenarios.ts run here, each checked by rebuilding what the
// ask proposes; the live suite (tests/ollama-live.test.ts) runs the same ones
// against a real Ollama.

import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { OllamaClient } from "../src/ask/ollama/client";
import { OllamaModel } from "../src/ask/ollama/model";
import { getOC, loadOC } from "../src/kernel";
import { placesOf, SCENARIOS, type Places } from "./ollama-scenarios";
import { OllamaStandIn, QWEN } from "./ollama-standin";

let kernel: LocalKernel;
let at: Places;

beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
  at = await placesOf(kernel);
});

function setup() {
  const server = new OllamaStandIn();
  const model = new OllamaModel(new OllamaClient("http://localhost:11434", { fetch: server.fetch }), { model: QWEN.name, numCtx: 16384 });
  return { server, model };
}

describe("ten scenarios through the Ollama provider (scripted stand-in, real kernel)", () => {
  it("1. connect: version, the installed models, what the chosen one can do", async () => {
    const { server, model } = setup();
    const c = await model.client.connect();
    expect(c).toEqual({ ok: true, version: server.version });
    expect((await model.client.tags()).models.map((m) => m.name)).toEqual(["qwen3.5:9b"]);
    expect(await model.capabilities()).toMatchObject({ tools: true, vision: true, thinking: true, contextLength: 262144, quantization: "Q4_K_M" });
    // And a one-word chat through the whole loop.
    server.script(...SCENARIOS[0].script);
    const run = await SCENARIOS[0].run(model, kernel, at);
    expect(await SCENARIOS[0].check(run, kernel)).toMatchObject({ ok: true });
  });

  for (const s of SCENARIOS.slice(1)) {
    it(`${SCENARIOS.indexOf(s) + 1}. ${s.name}`, async () => {
      const { server, model } = setup();
      server.script(...s.script);
      const run = await s.run(model, kernel, at);
      const outcome = await s.check(run, kernel);
      expect(outcome, `${outcome.detail}\n${run.text}\ncalls: ${run.calls.join(", ")}`).toMatchObject({ ok: true });
      // Every scripted turn was used, and every request was a well-formed chat with the same tools semantics.
      expect(server.remaining).toBe(0);
      for (const chat of server.chats) {
        expect(chat.model).toBe("qwen3.5:9b");
        expect(chat.options?.num_ctx).toBe(16384);
        if (chat.format) continue; // the intent reading has no tools
        expect(chat.messages[0].role).toBe("system");
        expect(chat.tools!.length).toBeGreaterThan(0);
        // Thinking is off by default, and said so explicitly (Qwen models think unless told not to).
        expect(chat.think).toBe(false);
      }
    });
  }

  it("a proposal from a local model is still only a proposal: the document is untouched until accepted", async () => {
    const { server, model } = setup();
    const s = SCENARIOS.find((x) => x.name === "fillet")!;
    server.script(...s.script);
    const { bracket } = await import("./ollama-scenarios");
    const before = JSON.stringify(bracket);
    const run = await s.run(model, kernel, at);
    expect(run.result!.outcome).toBe("proposal");
    expect(JSON.stringify(bracket)).toBe(before);
    expect(run.result!.proposal!.commands.map((c) => c.type)).toEqual(["addFeature"]);
    expect(run.result!.model).toBe("ollama/qwen3.5:9b");
  });
});
