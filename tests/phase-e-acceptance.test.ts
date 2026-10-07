// Phase E acceptance against the real model. Runs only with ANTHROPIC_API_KEY
// set (COCAIDE_ASK_MODEL picks the model; default Claude Opus 5.5). The same
// checks run without a key in tests/part-ask.test.ts (scripted readings) and
// e2e/part.spec.ts (the browser, with the API answered by a script).

import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { AnthropicModel, anthropicClient, DEFAULT_MODEL } from "../src/ask/model";
import { runPartAsk } from "../src/ask/part";
import type { RawDocument } from "../src/doc/commands";
import { getOC, loadOC, rebuild } from "../src/kernel";

const key = process.env.ANTHROPIC_API_KEY;
const EMPTY: RawDocument = { version: 1, units: "mm", name: "part", features: [] };

describe.skipIf(!key)("Phase E acceptance (live model)", () => {
  let kernel: LocalKernel;
  const model = () => new AnthropicModel(anthropicClient({ apiKey: key }), process.env.COCAIDE_ASK_MODEL ?? DEFAULT_MODEL, "low");
  beforeAll(async () => {
    await loadOC();
    kernel = new LocalKernel(getOC);
  });

  it('"80 x 40 x 6 plate, four 6.6 holes 8 mm from corners" produces the plate without a human fix', async () => {
    const r = await runPartAsk({ doc: EMPTY, text: "80 x 40 x 6 plate, four 6.6 holes 8 mm from corners", model: model(), kernel });
    expect(r.outcome, `${r.text}\n${JSON.stringify(r.review?.blanks)}`).toBe("proposal");
    expect(r.critique!.ok, r.critique!.findings.join("\n")).toBe(true);
    const accepted = applyProposal(EMPTY, r.proposal!);
    if (!accepted.ok) throw new Error(accepted.error);
    const built = rebuild(accepted.doc, getOC());
    const m = built.measurements!;
    expect(built.errors).toEqual([]);
    expect(m.boundingBox!.size).toEqual([80, 40, 6]);
    expect(m.holeDiameters).toEqual([6.6, 6.6, 6.6, 6.6]);
    const centers = m.holes.map((h) => h.axisPoint.slice(0, 2).map((v) => Math.round(v * 1e6) / 1e6)).sort();
    expect(centers).toEqual([
      [-32, -12],
      [-32, 12],
      [32, -12],
      [32, 12],
    ]);
    built.dispose();
  }, 180_000);

  it('"a plate with some holes" asks instead of guessing', async () => {
    const r = await runPartAsk({ doc: EMPTY, text: "a plate with some holes", model: model(), kernel });
    expect(r.outcome, r.text).toBe("questions");
    expect(r.proposal).toBeNull();
    const blanks = r.review!.blanks.map((b) => b.path);
    expect(blanks).toContain("thickness");
    expect(blanks).toContain("holes[0].diameter");
  }, 180_000);
});
