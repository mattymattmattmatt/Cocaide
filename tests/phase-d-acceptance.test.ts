// Phase D acceptance against the real model. Runs only with ANTHROPIC_API_KEY
// set (COCAIDE_ASK_MODEL picks the model; default Claude Opus 5.5). The same
// three checks run without a key in tests/ask.test.ts (scripted model) and in
// e2e/ask.spec.ts (the browser, with the API answered by a script).

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal, runAsk } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { AnthropicModel, anthropicClient, DEFAULT_MODEL } from "../src/ask/model";
import { WRITE_TOOL_NAMES } from "../src/ask/prompt";
import type { RawDocument } from "../src/doc/commands";
import { getOC, loadOC } from "../src/kernel";

const key = process.env.ANTHROPIC_API_KEY;
const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;

describe.skipIf(!key)("Phase D acceptance (live model)", () => {
  let kernel: LocalKernel;
  const model = () => new AnthropicModel(anthropicClient({ apiKey: key }), process.env.COCAIDE_ASK_MODEL ?? DEFAULT_MODEL, "low");
  beforeAll(async () => {
    await loadOC();
    kernel = new LocalKernel(getOC);
  });

  it('right-click hole_1, "make it 8 mm": changes that diameter only', async () => {
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model: model(), kernel });
    expect(r.outcome, r.text).toBe("proposal");
    expect(r.proposal!.changes).toEqual([{ id: "hole_1", kind: "changed", fields: [{ path: "diameter", before: 6.6, after: 8 }] }]);
    const accepted = applyProposal(bracket, r.proposal!);
    expect(accepted.ok && accepted.doc.features).toEqual([...bracket.features.slice(0, 2), { ...bracket.features[2], diameter: 8 }]);
  }, 180_000);

  it('right-click a sketch entity, "pattern the part": refused as out of scope', async () => {
    const r = await runAsk({ doc: bracket, target: { kind: "entity", sketch: "sketch_1", entity: "r1" }, text: "pattern the part", model: model(), kernel });
    expect(r.outcome, r.text).toBe("refused");
    expect(r.proposal).toBeNull();
    expect(r.text.length).toBeGreaterThan(0);
  }, 180_000);

  it('"what is this face" returns text and does not write', async () => {
    const t = (await kernel.topology(bracket))!;
    const top = t.faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99);
    const r = await runAsk({ doc: bracket, target: { kind: "face", index: top }, text: "What is this face?", model: model(), kernel });
    expect(r.outcome, r.text).toBe("answer");
    expect(r.proposal).toBeNull();
    expect(r.calls.filter((c) => WRITE_TOOL_NAMES.has(c.tool))).toEqual([]);
    expect(r.text.length).toBeGreaterThan(0);
  }, 180_000);
});
