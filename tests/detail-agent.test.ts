// Phase Q wave Q3B: "Fully detail this drawing" through the agent loop, on the
// real kernel and composer, with a SCRIPTED model (it is not a model: it plays
// the turns a model would): the Claude path (ScriptedModel) and the Ollama
// path (the stand-in server of tests/ollama-standin.ts, with the compact
// prompt and lean tools a small local model gets). The bracket, the flange
// and the table frame are detailed end to end; every result is a proposal
// that, accepted, passes the critic.

import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal, runAsk } from "../src/ask/agent";
import { findingsOf, makePlan } from "../src/ask/detail/auto";
import { detailState } from "../src/ask/detail/execute";
import { planWith } from "../src/ask/detail/plan";
import { LocalKernel } from "../src/ask/kernel";
import { say, ScriptedModel, use } from "../src/ask/model";
import { OllamaClient } from "../src/ask/ollama/client";
import { OllamaModel } from "../src/ask/ollama/model";
import { DETAIL_PROMPT, isDetailRequest, leanTools, toolsFor } from "../src/ask/prompt";
import { apply, type RawDocument } from "../src/doc/commands";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { getOC, loadOC } from "../src/kernel";
import { example } from "./detail-fixtures";
import { OllamaStandIn, QWEN } from "./ollama-standin";

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

async function withDrawing(name: string): Promise<RawDocument> {
  const doc = example(name);
  const c = await kernel.check(doc);
  const r = apply(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS), { date: "2026-11-05" }) });
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

/** The proposal accepted on the document, and what the critic says of it. */
async function accepted(doc: RawDocument, result: Awaited<ReturnType<typeof runAsk>>) {
  expect(result.outcome, result.text).toBe("proposal");
  const r = applyProposal(doc, result.proposal!);
  if (!r.ok) throw new Error(r.error);
  const findings = findingsOf(await detailState(r.doc, kernel));
  return { doc: r.doc, errors: findings.filter((f) => f.severity === "error") };
}

describe("detailing requests and tools", () => {
  it("knows a detailing request from a single change", () => {
    expect(isDetailRequest(DETAIL_PROMPT)).toBe(true);
    expect(isDetailRequest("Fully detail this view: every feature it shows")).toBe(true);
    expect(isDetailRequest("please detail this drawing for manufacture")).toBe(true);
    expect(isDetailRequest("Dimension the overall size of the part in this view.")).toBe(false);
    expect(isDetailRequest("Give this hole or diameter the ISO 286 fit H7")).toBe(false);
  });

  it("offers the detail tools on the sheet; a small model's lean list keeps the plan and critic, not the picture", () => {
    const names = toolsFor("edit", "drawing").map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["detailPlan", "applyDetailPlan", "checkDrawing", "renderSheet", "deleteAnnotations", "setAnnotation", "editAnnotation"]));
    const lean = leanTools(toolsFor("edit", "drawing")).map((t) => t.name);
    expect(lean).toEqual(expect.arrayContaining(["detailPlan", "applyDetailPlan", "checkDrawing", "setAnnotation"]));
    expect(lean).not.toContain("renderSheet");
    // A question may look (the plan, the critic, the picture) but not change anything.
    expect(toolsFor("explain", "view").map((t) => t.name)).toEqual(["escalate", "detailPlan", "checkDrawing", "renderSheet"]);
  });
});

describe("Claude path (scripted model): the bracket, the flange, the frame", () => {
  it("bracket: the model reads the plan, applies it, checks the drawing and stops; accepted, it passes the critic", async () => {
    const doc = await withDrawing("bracket");
    const model = new ScriptedModel([
      () => [use("detailPlan", {})],
      () => [use("applyDetailPlan", {})],
      () => [use("checkDrawing", {})],
      () => [use("renderSheet", {})],
      () => [say("Datum A is the mounting face, B and C the left and bottom edges; the M6 clearance hole is positioned Ø0.1 Ⓜ to A|B|C with its 70 basic.")],
      () => [say("Done.")],
      () => [say("Done.")],
    ]);
    const r = await runAsk({ doc, target: { kind: "drawing" }, text: DETAIL_PROMPT, model, kernel });
    // A detailing ask: the plan in the packet, the guide in the turn, the detail budget.
    const first = JSON.stringify(model.requests[0].messages[0].content);
    expect(first).toContain("detailing");
    expect(first).toContain("This is a detailing ask");
    expect(model.requests[0].maxTokens).toBe(12000);
    expect(r.calls.map((c) => [c.tool, c.ok])).toEqual([["detailPlan", true], ["applyDetailPlan", true], ["checkDrawing", true], ["renderSheet", true]]);
    // The picture went back as an image beside its result.
    expect(JSON.stringify(model.requests[4].messages.at(-1)!.content)).toContain('"type":"image"');
    const { doc: after, errors } = await accepted(doc, r);
    expect(errors).toEqual([]);
    const d = (after.drawing as { sheets: { annotations: { type: string }[] }[] }).sheets[0].annotations.map((a) => a.type);
    expect(d).toEqual(expect.arrayContaining(["gdt", "surface"]));
  });

  it("flange: the plan from the card (tolerance level changed, the spigot left out) is applied first; the model then refines one frame", async () => {
    const doc = await withDrawing("flange");
    const { plan } = await makePlan(doc, kernel, { date: "2026-11-05" });
    const card = planWith(plan, { skip: ["revision"], options: { generalTolerance: "ISO 2768-fH" } });
    const model = new ScriptedModel([
      (req) => {
        // The plan was applied before the first turn: the packet says what it made.
        const text = JSON.stringify(req.messages[0].content);
        expect(text).toContain("applied");
        const frame = /gdt_position\w*/.exec(text)?.[0] ?? "gdt_position";
        return [use("editAnnotation", { id: frame, patch: { rows: [{ characteristic: "position", diameter: true, tolerance: 0.15, material: "M", datums: [{ label: "A" }, { label: "B", modifier: "M" }] }] } })];
      },
      () => [use("checkDrawing", {})],
      () => [say("Bore Ø24 H7 is datum B; the bolt circle is positioned Ø0.15 Ⓜ to A|BⓂ (the M6 counterbores float).")],
      () => [say("Done.")],
      () => [say("Done.")],
    ]);
    const r = await runAsk({ doc, target: { kind: "drawing" }, text: DETAIL_PROMPT, model, kernel, detail: { plan: card } });
    expect(r.calls[0], JSON.stringify(r.calls[0])).toMatchObject({ tool: "editAnnotation", ok: true });
    const { doc: after, errors } = await accepted(doc, r);
    expect(errors).toEqual([]);
    const d = after.drawing as { generalTolerance: string; revisions?: unknown[]; sheets: { annotations: Record<string, unknown>[] }[] };
    expect(d.generalTolerance).toBe("ISO 2768-fH");
    expect(d.revisions).toBeUndefined();
    const pos = d.sheets[0].annotations.find((a) => a.type === "gdt" && JSON.stringify(a.rows).includes("position")) as { rows: { tolerance: number }[] };
    expect(pos.rows[0].tolerance).toBe(0.15);
  });

  it("frame: weld symbols, ISO 13920-BF and the notes; the critic's round shows what is left, and the model fixes nothing it need not", async () => {
    const doc = await withDrawing("table-frame");
    const model = new ScriptedModel([() => [use("applyDetailPlan", {})], () => [say("Welds a3 all round at every joint, ISO 13920-BF, the cut list and balloons.")], () => [say("Done.")], () => [say("Done.")]]);
    const r = await runAsk({ doc, target: { kind: "drawing" }, text: "Fully detail this drawing", model, kernel });
    const { doc: after, errors } = await accepted(doc, r);
    expect(errors).toEqual([]);
    const d = after.drawing as { generalTolerance: string; sheets: { annotations: { type: string; arrowSide?: { symbol: string } }[] }[] };
    expect(d.generalTolerance).toBe("ISO 13920-BF");
    expect(d.sheets[0].annotations.filter((a) => a.type === "weld").every((a) => a.arrowSide?.symbol === "fillet")).toBe(true);
  });

  it("an error the critic finds goes back to the model for a correction round", async () => {
    const doc = await withDrawing("bracket");
    const model = new ScriptedModel([
      () => [use("applyDetailPlan", {})],
      // A duplicate of the overall length: the critic will say so.
      () => [use("setAnnotation", { id: "dup", annotation: { type: "dimension", view: "front", from: "@left", to: "@right" } })],
      () => [say("Done.")],
      (req) => {
        expect(JSON.stringify(req.messages.at(-1)!.content)).toContain("The detailing critic, round 1 of 3");
        return [use("deleteAnnotations", { ids: ["dup"] })];
      },
      () => [say("Removed the duplicate length.")],
      () => [say("Done.")],
    ]);
    const r = await runAsk({ doc, target: { kind: "drawing" }, text: DETAIL_PROMPT, model, kernel });
    expect(r.calls.map((c) => c.tool)).toEqual(["applyDetailPlan", "setAnnotation", "deleteAnnotations"]);
    const { errors } = await accepted(doc, r);
    expect(errors).toEqual([]);
  });
});

describe("Ollama path (scripted stand-in, compact prompt and lean tools)", () => {
  for (const name of ["bracket", "flange", "table-frame"]) {
    it(`${name}: applyDetailPlan, checkDrawing, a short answer; accepted, it passes the critic`, async () => {
      const server = new OllamaStandIn();
      const model = new OllamaModel(new OllamaClient("http://localhost:11434", { fetch: server.fetch }), { model: QWEN.name, numCtx: 16384 });
      server.script(
        { tool_calls: [{ name: "applyDetailPlan", arguments: {} }] },
        // A small model often sends its arguments as a string.
        { tool_calls: [{ name: "checkDrawing", arguments: "{}" }] },
        { content: "The drawing is detailed: datums, fits, tolerances and notes." },
        { content: "Done." },
        { content: "Done." },
      );
      const doc = await withDrawing(name);
      const r = await runAsk({ doc, target: { kind: "drawing" }, text: DETAIL_PROMPT, model, kernel });
      const chat = server.chats[0];
      // The compact prompt, the lean tools (no picture), the compact packet and guide.
      expect(chat.tools!.map((t) => t.function.name)).not.toContain("renderSheet");
      expect(chat.tools!.map((t) => t.function.name)).toEqual(expect.arrayContaining(["applyDetailPlan", "checkDrawing"]));
      const user = chat.messages.find((m) => m.role === "user")!.content;
      expect(user).toContain("Detailing: call applyDetailPlan first");
      expect(user.length).toBeLessThan(40000);
      const { errors } = await accepted(doc, r);
      expect(errors).toEqual([]);
    });
  }
});
