// The part-level prompt with a scripted model and the real kernel.

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal, conflictsWith } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { ScriptedModel, say, use } from "../src/ask/model";
import { continuePartAsk, runPartAsk } from "../src/ask/part";
import type { RawDocument } from "../src/doc/commands";
import { blank, emptyHoleGroup, emptyIntent, stated, type Intent } from "../src/intent/schema";
import { getOC, loadOC, rebuild } from "../src/kernel";

const EMPTY: RawDocument = { version: 1, units: "mm", name: "part", features: [] };
const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
const BRACKET_TEXT = "80 x 40 x 6 plate, four 6.6 holes 8 mm from corners";

const bracketIntent = (): Intent => ({
  ...emptyIntent(),
  name: "bracket",
  width: stated(80, "80 x 40 x 6"),
  height: stated(40, "80 x 40 x 6"),
  thickness: stated(6, "80 x 40 x 6"),
  holes: [{ ...emptyHoleGroup(), diameter: stated(6.6, "6.6 holes"), count: stated(4, "four"), placement: "corners", inset: stated(8, "8 mm from corners") }],
});

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

describe("part-level prompt", () => {
  it('"80 x 40 x 6 plate, four 6.6 holes 8 mm from corners" produces the plate without a human fix', async () => {
    const model = new ScriptedModel([], [bracketIntent()]);
    const r = await runPartAsk({ doc: EMPTY, text: BRACKET_TEXT, model, kernel });
    expect(r.outcome, r.text).toBe("proposal");
    expect(r.review!.blanks).toEqual([]);
    expect(r.proposal!.replace).toBe(true);
    expect(r.proposal!.checks!.every((c) => c.ok)).toBe(true);
    expect(r.text).toBe('A 80 × 40 × 6 mm plate with 4 holes ("bracket"). Checked against the request: 6 of 6 checks pass.');
    expect(r.calls).toEqual([]); // no correction was needed
    expect(model.requests).toEqual([]); // and no agent turns: the planner built it

    // The request went to the model with the user's words, the text last.
    const content = model.intentRequests[0].content as Anthropic.TextBlockParam[];
    expect(content.at(-1)!.text.endsWith(`The request:\n${BRACKET_TEXT}`)).toBe(true);

    const accepted = applyProposal(EMPTY, r.proposal!);
    if (!accepted.ok) throw new Error(accepted.error);
    const built = rebuild(accepted.doc, getOC());
    expect(built.errors).toEqual([]);
    expect(built.measurements!.boundingBox!.size).toEqual([80, 40, 6]);
    expect(built.measurements!.holeDiameters).toEqual([6.6, 6.6, 6.6, 6.6]);
    built.dispose();
  });

  it('"a plate with some holes" asks instead of guessing', async () => {
    const vague: Intent = {
      ...emptyIntent(),
      holes: [{ ...emptyHoleGroup(), count: { value: null, evidence: "some holes", source: "missing", confidence: 0 } }],
      questions: ["How big is the plate?", "How thick?", "What hole diameter, how many, and where?"],
    };
    const model = new ScriptedModel([], [vague]);
    const r = await runPartAsk({ doc: EMPTY, text: "a plate with some holes", model, kernel });
    expect(r.outcome).toBe("questions");
    expect(r.proposal).toBeNull();
    expect(r.review!.blanks.map((b) => b.label)).toEqual(["Width (X)", "Height (Y)", "Thickness", "Holes: diameter", "Holes: where", "Holes: count"]);
    expect(r.text).toBe("I need 6 things before I build this: width (x), height (y), thickness, holes: diameter, holes: where, holes: count.");

    // The answers come back through the card, and then it builds.
    const second = await continuePartAsk({ doc: EMPTY, text: "a plate with some holes", model, kernel }, r, {
      width: 80,
      height: 40,
      thickness: 6,
      "holes[0].diameter": 6.6,
      "holes[0].placement": "corners",
    });
    expect(second.outcome).toBe("questions");
    expect(second.review!.blanks.map((b) => b.path)).toEqual(["holes[0].inset"]);
    const third = await continuePartAsk({ doc: EMPTY, text: "a plate with some holes", model, kernel }, second, { "holes[0].inset": 8 });
    expect(third.outcome).toBe("proposal");
    expect(third.proposal!.checks!.every((c) => c.ok)).toBe(true);
  });

  it("asks even when the model invents the numbers", async () => {
    const invented: Intent = { ...bracketIntent() };
    const model = new ScriptedModel([], [invented]);
    const r = await runPartAsk({ doc: EMPTY, text: "a plate with some holes", model, kernel });
    expect(r.outcome).toBe("questions");
    expect(r.review!.blanks.map((b) => b.note)).toEqual([
      "80 is not in the request",
      "40 is not in the request",
      "6 is not in the request",
      "6.6 is not in the request",
      "8 is not in the request",
    ]);
  });

  it("a question about the part is answered from the part packet, with no write tools", async () => {
    const model = new ScriptedModel([() => [say("An 80 × 40 × 6 plate with one Ø6.6 through hole.")]]);
    const r = await runPartAsk({ doc: bracket, text: "What is this part?", model, kernel });
    expect(r).toMatchObject({ outcome: "answer", mode: "explain", proposal: null });
    expect(model.intentRequests).toHaveLength(0);
    expect(model.requests[0].tools.map((t) => t.name)).toEqual(["measure", "getFeature", "escalate"]);
    expect(r.packet!.target).toMatchObject({ kind: "part", label: "the whole part" });
    expect(r.packet!.writeScope).toEqual(["*"]);
    expect((r.packet!.part as { features: unknown[] }).features).toHaveLength(3);
  });

  it("an edit to the whole part is a proposal of commands", async () => {
    const intent = { ...emptyIntent("edit"), thickness: stated(10, "10") };
    const model = new ScriptedModel([() => [use("updateFeature", { id: "ext_1", patch: { distance: 10 } })], () => [say("The plate is now 10 thick.")]], [intent]);
    const r = await runPartAsk({ doc: bracket, text: "make the plate 10 thick", model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(r.proposal!.replace).toBeUndefined();
    expect(r.proposal!.changes).toEqual([{ id: "ext_1", kind: "changed", fields: [{ path: "distance", before: 6, after: 10 }] }]);
  });

  it("a new part over an existing one replaces it, and any user edit since drops the proposal", async () => {
    const model = new ScriptedModel([], [bracketIntent()]);
    const r = await runPartAsk({ doc: bracket, text: BRACKET_TEXT, model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(r.proposal!.changes.map((c) => `${c.kind} ${c.id}`)).toEqual(["changed sketch_1", "changed ext_1", "changed hole_1", "added pattern_1", "changed parameters"]);
    const edited = structuredClone(bracket);
    edited.name = "renamed";
    expect(conflictsWith(r.proposal!, edited)).toEqual(["the part"]);
    expect(conflictsWith(r.proposal!, bracket)).toEqual([]);
  });

  it("when the plan does not match the request, one correction pass, then over to the human", async () => {
    // Holes 2 mm from the edges with a 3 mm radius break out of the plate: they are not whole holes.
    const text = "20 x 20 x 5 plate, four 6 holes 2 mm from corners";
    const intent: Intent = {
      ...emptyIntent(),
      width: stated(20, "20"),
      height: stated(20, "20"),
      thickness: stated(5, "5"),
      holes: [{ ...emptyHoleGroup(), diameter: stated(6, "6 holes"), count: stated(4, "four"), placement: "corners", inset: stated(2, "2 mm") }],
    };
    const model = new ScriptedModel([() => [say("The request puts the holes past the plate's edges; I cannot match it without changing the request.")]], [intent]);
    const r = await runPartAsk({ doc: EMPTY, text, model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(r.critique!.ok).toBe(false);
    expect(model.requests).toHaveLength(1); // exactly one correction turn
    expect(r.proposal!.notes).toContain("The holes are 2 mm from the edges but 3 mm in radius, so they break out of the edges.");
    expect(r.text).toMatch(/still does not match the request after one correction: Hole count: expected 4, measured 0/);
    expect(r.text.endsWith("Over to you.")).toBe(true);
  });

  it("a dropped drawing goes to the model as a document; unclear numbers are blanks", async () => {
    const intent: Intent = {
      ...bracketIntent(),
      thickness: { value: 6, evidence: "t=6?", source: "stated", confidence: 0.5 },
    };
    const model = new ScriptedModel([], [intent]);
    const drawing = { name: "bracket.pdf", mediaType: "application/pdf", data: "JVBERi0xLjQK" };
    const r = await runPartAsk({ doc: EMPTY, text: "", drawing, model, kernel });
    expect(r.outcome).toBe("questions");
    expect(r.review!.blanks.map((b) => [b.path, b.note])).toEqual([["thickness", "read with low confidence (50%)"]]);
    const content = model.intentRequests[0].content;
    expect(content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
    // Printed numbers read clearly are trusted without a text to match them against.
    expect(r.review!.rows.find((x) => x.path === "width")!.blank).toBe(false);
  });

  it("a malformed reading fails cleanly", async () => {
    const model = new ScriptedModel([], [{ action: "create", kind: "plate" }]);
    const r = await runPartAsk({ doc: EMPTY, text: "a plate 10 x 10 x 1", model, kernel });
    expect(r.outcome).toBe("failed");
    expect(r.text).toMatch(/^The model's reading did not fit the intent schema/);
    expect(blank().value).toBeNull();
  });
});
