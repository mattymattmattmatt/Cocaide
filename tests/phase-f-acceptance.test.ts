// Phase F acceptance against the real model. Runs only with ANTHROPIC_API_KEY
// set (COCAIDE_ASK_MODEL picks the model; default Claude Opus 5.5). The same
// checks run without a key in tests/drawing.test.ts (scripted readings) and
// e2e/drawing.spec.ts (the browser: pdf.js rasterising the real PDF, with the
// API answered by a script).

import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { AnthropicModel, anthropicClient, DEFAULT_MODEL } from "../src/ask/model";
import { continuePartAsk, runPartAsk } from "../src/ask/part";
import type { RawDocument } from "../src/doc/commands";
import { getOC, loadOC, rebuild } from "../src/kernel";
import { drawingOf, SHEET } from "./drawings";

const key = process.env.ANTHROPIC_API_KEY;
const EMPTY: RawDocument = { version: 1, units: "mm", name: "part", features: [] };

describe.skipIf(!key)("Phase F acceptance (live model)", () => {
  let kernel: LocalKernel;
  const model = () => new AnthropicModel(anthropicClient({ apiKey: key }), process.env.COCAIDE_ASK_MODEL ?? DEFAULT_MODEL, "low");
  beforeAll(async () => {
    await loadOC();
    kernel = new LocalKernel(getOC);
  });

  it("a clean one-part dimensioned PDF of the bracket lands in the card with the right numbers, and builds after confirm", async () => {
    const drawing = await drawingOf("bracket.pdf", "application/pdf", SHEET, 200);
    const req = { doc: EMPTY, text: "", drawing, model: model(), kernel };
    const card = await runPartAsk(req);
    const review = card.review!;
    const value = (path: string) => review.rows.find((r) => r.path === path)?.value;
    expect(card.outcome, card.text).toBe("questions"); // the card is always shown first
    expect(review.blanks.map((b) => [b.path, b.note]), card.text).toEqual([]);
    expect(review.problems).toEqual([]);
    expect([value("width"), value("height"), value("thickness"), value("holes[0].diameter")]).toEqual([80, 40, 6, 6.6]);
    expect(value("drawing.units")).toBe("mm");
    expect(value("drawing.projection")).toBe("third-angle");

    const built = await continuePartAsk(req, card, {}); // "Confirm and build"
    expect(built.outcome, built.text).toBe("proposal");
    const accepted = applyProposal(EMPTY, built.proposal!);
    if (!accepted.ok) throw new Error(accepted.error);
    const r = rebuild(accepted.doc, getOC());
    expect(r.errors).toEqual([]);
    expect(r.measurements!.volume).toBeCloseTo(18994.728336, 3);
    expect(r.measurements!.holes.map((h) => h.axisPoint.slice(0, 2).map((v) => Math.round(v * 1e6) / 1e6))).toEqual([[30, 0]]);
    expect(accepted.doc.source).toMatchObject({ drawing: "bracket.pdf", projection: "third-angle", units: "mm" });
    r.dispose();
  }, 240_000);

  it("a blurry drawing leaves fields blank rather than inventing them", async () => {
    const drawing = await drawingOf("bracket-blurry.png", "image/png", "", null);
    const card = await runPartAsk({ doc: EMPTY, text: "", drawing, model: model(), kernel });
    expect(card.outcome, card.text).toBe("questions");
    expect(card.proposal).toBeNull();
    const numbers = card.review!.rows.filter((r) => r.kind === "number" || r.kind === "points" || r.path.startsWith("drawing."));
    expect(numbers.filter((r) => r.value !== null && r.source !== "placement").map((r) => r.path)).toEqual([]);
    expect(card.review!.blanks.map((b) => b.path)).toEqual(expect.arrayContaining(["width", "height", "thickness", "drawing.units", "drawing.projection"]));
  }, 240_000);
});
