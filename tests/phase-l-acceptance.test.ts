// Phase L acceptance against the real model. Runs only with ANTHROPIC_API_KEY
// set (COCAIDE_ASK_MODEL picks the model; default Claude Opus 5.5). The same
// checks run without a key in tests/drafting-ask.test.ts (scripted model) and
// e2e/drafting.spec.ts (the browser, with the API answered by a script).

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal, runAsk } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { AnthropicModel, anthropicClient, DEFAULT_MODEL } from "../src/ask/model";
import { apply, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeSheet } from "../src/drafting/compose";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { getOC, loadOC } from "../src/kernel";

const key = process.env.ANTHROPIC_API_KEY;
const table = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8")) as RawDocument;

describe.skipIf(!key)("Phase L acceptance (live model)", () => {
  let kernel: LocalKernel;
  let drawn: RawDocument;
  const model = () => new AnthropicModel(anthropicClient({ apiKey: key }), process.env.COCAIDE_ASK_MODEL ?? DEFAULT_MODEL, "low");
  beforeAll(async () => {
    await loadOC();
    kernel = new LocalKernel(getOC);
    const c = await kernel.check(table);
    const r = apply(table, { type: "setDrawing", drawing: planDrawing(table, c.measurements, await kernel.project(table, DEFAULT_VIEWS)) });
    if (!r.ok) throw new Error(r.error);
    drawn = r.doc;
  });

  it("right-clicking the front view and asking for the leg height adds a dimension reading 860", async () => {
    const r = await runAsk({ doc: drawn, target: { kind: "view", id: "front" }, text: "Dimension the leg height", model: model(), kernel });
    expect(r.outcome, r.text).toBe("proposal");
    expect(r.proposal!.checks!.filter((c) => !c.ok), r.text).toEqual([]);
    const accepted = applyProposal(drawn, r.proposal!);
    expect(accepted.ok).toBe(true);
    const doc = (accepted as { doc: RawDocument }).doc;
    const views = validateDocument(doc).drawing!.views.map((v) => ({ id: v.id, look: v.look }));
    const c = await kernel.check(doc);
    const sheet = composeSheet(doc, { measurements: c.measurements, geometry: await kernel.project(doc, views) })!;
    const added = r.proposal!.changes.filter((x) => x.kind === "added").map((x) => sheet.annotations.find((a) => a.id === x.id));
    expect(added.map((a) => [a?.type, a?.view, a?.text])).toContainEqual(["dimension", "front", "860"]);
  }, 180_000);

  it("an edit to the part from the sheet is refused, not made", async () => {
    const r = await runAsk({ doc: drawn, target: { kind: "view", id: "front" }, text: "Make the legs SHS 50x50x3", model: model(), kernel });
    expect(r.proposal?.changes.some((x) => !x.what) ?? false).toBe(false);
    expect(["refused", "answer"]).toContain(r.outcome);
  }, 180_000);
});
