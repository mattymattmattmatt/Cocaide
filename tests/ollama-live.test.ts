// LIVE: the ten scenarios against a real Ollama (and, with ANTHROPIC_API_KEY
// also set, the same prompts through Claude), on the real kernel, each judged
// by rebuilding its result. Skipped unless OLLAMA_URL is set:
//
//   OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5:9b [OLLAMA_NUM_CTX=16384] [ANTHROPIC_API_KEY=...] \
//     npx vitest run tests/ollama-live.test.ts
//
// It prints a comparison table (success, tool calls, failed calls, time) and fails only when Ollama cannot be
// reached or the model is missing: how well a given model does is the report, not a pass/fail.

import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { AnthropicModel, anthropicClient, DEFAULT_MODEL, type AskModel } from "../src/ask/model";
import { OllamaClient } from "../src/ask/ollama/client";
import { OllamaModel, type ThinkSetting } from "../src/ask/ollama/model";
import { getOC, loadOC } from "../src/kernel";
import { placesOf, SCENARIOS, type Places } from "./ollama-scenarios";

const URL_ = process.env.OLLAMA_URL;
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
const KEY = process.env.ANTHROPIC_API_KEY;

interface Row {
  provider: string;
  scenario: string;
  ok: boolean;
  calls: number;
  failed: number;
  seconds: number;
  detail: string;
}

describe.skipIf(!URL_)("LIVE: the ten scenarios against a real Ollama", () => {
  let kernel: LocalKernel;
  let at: Places;
  const rows: Row[] = [];

  beforeAll(async () => {
    await loadOC();
    kernel = new LocalKernel(getOC);
    at = await placesOf(kernel);
  });

  async function runAll(label: string, model: AskModel) {
    for (const s of SCENARIOS) {
      const t0 = Date.now();
      let row: Row;
      try {
        const run = await s.run(model, kernel, at);
        const o = await s.check(run, kernel);
        row = {
          provider: label,
          scenario: s.name,
          ok: o.ok,
          calls: run.calls.length,
          failed: run.calls.filter((c) => c.endsWith("✗")).length,
          seconds: (Date.now() - t0) / 1000,
          detail: o.detail,
        };
      } catch (e) {
        row = {
          provider: label,
          scenario: s.name,
          ok: false,
          calls: 0,
          failed: 0,
          seconds: (Date.now() - t0) / 1000,
          detail: `threw: ${(e as Error).message}`,
        };
      }
      rows.push(row);
      console.log(
        `${label} | ${row.scenario} | ${row.ok ? "ok" : "FAIL"} | ${row.calls} calls (${row.failed} failed) | ${row.seconds.toFixed(1)} s | ${row.detail}`,
      );
    }
  }

  it(`Ollama ${MODEL}`, { timeout: 4 * 60 * 60_000 }, async () => {
    const client = new OllamaClient(URL_);
    const conn = await client.connect();
    expect(conn, conn.message).toMatchObject({ ok: true });
    const installed = (await client.tags()).models.map((m) => m.name);
    expect(installed, `${MODEL} is not installed: ollama pull ${MODEL}`).toContain(MODEL.includes(":") ? MODEL : `${MODEL}:latest`);
    const model = new OllamaModel(client, {
      model: MODEL,
      numCtx: Number(process.env.OLLAMA_NUM_CTX ?? 16384),
      think: (process.env.OLLAMA_THINK as ThinkSetting) ?? "off",
      keepAlive: "30m",
      temperature: 0.2,
    });
    console.log(`Ollama ${conn.version}, ${MODEL}:`, await model.capabilities());
    await runAll(`ollama/${MODEL}`, model);
  });

  it.skipIf(!KEY)("Claude, the same prompts, for comparison", { timeout: 60 * 60_000 }, async () => {
    await runAll(DEFAULT_MODEL, new AnthropicModel(anthropicClient({ apiKey: KEY }), DEFAULT_MODEL, "low"));
  });

  it("the comparison table", () => {
    const providers = [...new Set(rows.map((r) => r.provider))];
    const lines = [
      "| scenario | " + providers.map((p) => `${p}: result, calls (failed), time`).join(" | ") + " |",
      "|---|" + providers.map(() => "---|").join(""),
    ];
    for (const s of SCENARIOS) {
      const cells = providers.map((p) => {
        const r = rows.find((x) => x.provider === p && x.scenario === s.name);
        return r ? `${r.ok ? "ok" : "FAIL"}, ${r.calls} (${r.failed}), ${r.seconds.toFixed(1)} s` : "-";
      });
      lines.push(`| ${s.name} | ${cells.join(" | ")} |`);
    }
    for (const p of providers) lines.push(`| **total ${p}** | ${rows.filter((r) => r.provider === p && r.ok).length} / ${SCENARIOS.length} |`);
    console.log(`\n${lines.join("\n")}\n`);
  });
});
