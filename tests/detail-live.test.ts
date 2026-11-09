// LIVE: "Fully detail this drawing" on the bracket, flange and table frame
// with a real model, on the real kernel. Skipped unless ANTHROPIC_API_KEY
// (Claude) or OLLAMA_URL (a local model, OLLAMA_MODEL, default qwen3.5:9b)
// is set:
//
//   ANTHROPIC_API_KEY=... npx vitest run tests/detail-live.test.ts
//   OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5:9b npx vitest run tests/detail-live.test.ts
//
// Each result must be a proposal; it prints what the critic still finds on
// it (the report), and fails only when the ask fails or adds nothing.

import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal, runAsk } from "../src/ask/agent";
import { findingsOf } from "../src/ask/detail/auto";
import { detailState } from "../src/ask/detail/execute";
import { LocalKernel } from "../src/ask/kernel";
import { AnthropicModel, anthropicClient, DEFAULT_MODEL, type AskModel } from "../src/ask/model";
import { OllamaClient } from "../src/ask/ollama/client";
import { OllamaModel } from "../src/ask/ollama/model";
import { DETAIL_PROMPT } from "../src/ask/prompt";
import { apply, type RawDocument } from "../src/doc/commands";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { getOC, loadOC } from "../src/kernel";
import { example } from "./detail-fixtures";

const KEY = process.env.ANTHROPIC_API_KEY;
const OLLAMA = process.env.OLLAMA_URL;

const models: { name: string; make: () => AskModel }[] = [
  ...(KEY ? [{ name: "claude", make: () => new AnthropicModel(anthropicClient({ apiKey: KEY }), DEFAULT_MODEL, "low") }] : []),
  ...(OLLAMA ? [{ name: "ollama", make: () => new OllamaModel(new OllamaClient(OLLAMA), { model: process.env.OLLAMA_MODEL ?? "qwen3.5:9b", numCtx: Number(process.env.OLLAMA_NUM_CTX ?? 16384) }) }] : []),
];

describe.skipIf(!models.length)("LIVE: detailing with a real model", () => {
  let kernel: LocalKernel;
  beforeAll(async () => {
    await loadOC();
    kernel = new LocalKernel(getOC);
  });

  for (const m of models) {
    for (const name of ["bracket", "flange", "table-frame"]) {
      it(`${m.name}: ${name}`, { timeout: 600_000 }, async () => {
        let doc: RawDocument = example(name);
        const c = await kernel.check(doc);
        const d = apply(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS)) });
        if (!d.ok) throw new Error(d.error);
        doc = d.doc;
        const r = await runAsk({ doc, target: { kind: "drawing" }, text: DETAIL_PROMPT, model: m.make(), kernel });
        expect(r.outcome, r.text).toBe("proposal");
        const after = applyProposal(doc, r.proposal!);
        if (!after.ok) throw new Error(after.error);
        const findings = findingsOf(await detailState(after.doc, kernel));
        console.log(`${m.name} ${name}: ${r.calls.length} calls (${r.calls.filter((x) => !x.ok).length} failed), ${r.turns} turns; critic: ${findings.length ? findings.map((f) => `${f.severity} ${f.message}`).join(" | ") : "clean"}\n${r.text}`);
        expect(r.proposal!.changes.length).toBeGreaterThan(0);
      });
    }
  }
});
