// The right-click ask with a scripted model and the real kernel: the packet,
// the write scope, explain-only asks, rollback, the correction limit, the
// face rule, and accepting a proposal.

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal, conflictsWith, runAsk } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { ScriptedModel, say, use } from "../src/ask/model";
import { classify, isVisual } from "../src/ask/prompt";
import type { RawDocument } from "../src/doc/commands";
import { getOC, loadOC } from "../src/kernel";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
let kernel: LocalKernel;
let topFace: number;
let sideEdge: number;

beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
  const t = (await kernel.topology(bracket))!;
  topFace = t.faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99);
  sideEdge = t.edges.findIndex((e) => e.kind === "line" && Math.abs(e.end[2] - e.start[2]) > 5);
});

const firstUserText = (m: ScriptedModel) => {
  const content = m.requests[0].messages[0].content as Anthropic.ContentBlockParam[];
  return (content.find((b) => b.type === "text") as Anthropic.TextBlockParam).text;
};
const toolNames = (m: ScriptedModel) => m.requests[0].tools.map((t) => t.name);

describe("classifying a prompt", () => {
  it("questions are explain-only; requests and instructions may edit", () => {
    expect(classify("What is this face?")).toBe("explain");
    expect(classify("why did this fail")).toBe("explain");
    expect(classify("Can you make it 8 mm?")).toBe("edit");
    expect(classify("make it 8 mm")).toBe("edit");
    expect(classify("Fix this error. Do not touch anything else.")).toBe("edit");
  });

  it("asking what a face is wants a picture; a dimension change does not", () => {
    expect(isVisual("What is this face?", { kind: "face", index: 0 })).toBe(true);
    expect(isVisual("make it look like a bracket", { kind: "feature", id: "x" })).toBe(true);
    expect(isVisual("make it 8 mm", { kind: "feature", id: "hole_1" })).toBe(false);
  });
});

describe("right-click ask", () => {
  it('hole_1, "make it 8 mm": a proposal that changes that diameter only', async () => {
    const model = new ScriptedModel([() => [use("updateFeature", { id: "hole_1", patch: { diameter: 8 } })], () => [say("hole_1 is now Ø8, through.")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(r.text).toBe("hole_1 is now Ø8, through.");
    expect(r.proposal!.changes).toEqual([{ id: "hole_1", kind: "changed", fields: [{ path: "diameter", before: 6.6, after: 8 }] }]);
    expect(r.proposal!.touched).toEqual(["hole_1"]);
    expect(r.proposal!.volumeAfter).toBeCloseTo(80 * 40 * 6 - Math.PI * 16 * 6, 6);

    // The packet is the prompt: target, parent, children. Not the whole tree; the user's words last.
    const text = firstUserText(model);
    const packet = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    expect(packet.target).toMatchObject({ kind: "feature", id: "hole_1" });
    expect(packet.writeScope).toEqual(["hole_1"]);
    expect(packet.parent.id).toBe("ext_1");
    expect(packet.children).toEqual([]);
    expect(packet.measurements).toMatchObject({ diameter: 6.6, measuredDepth: 6 });
    expect(text).not.toContain("sketch_1\",\n  \"op\": \"sketch\"");
    expect(text).not.toContain('"entities"');
    expect(text.endsWith("The user's request:\nmake it 8 mm")).toBe(true);
    expect(toolNames(model)).toContain("updateFeature");

    // The tool result showed the agent the new measured diameter.
    const second = model.requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(JSON.parse(second[0].content as string)).toMatchObject({ ok: true, features: [{ id: "hole_1", diameter: 8, measuredDiameters: [8] }] });

    // Accepting replays the commands: only hole_1.diameter differs.
    const accepted = applyProposal(bracket, r.proposal!);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.doc.features[2].diameter).toBe(8);
      expect({ ...accepted.doc.features[2], diameter: 6.6 }).toEqual(bracket.features[2]);
      expect(accepted.doc.features.slice(0, 2)).toEqual(bracket.features.slice(0, 2));
    }
  });

  it('a sketch entity, "pattern the part": refused as out of scope, nothing proposed', async () => {
    const pattern = { op: "linearPattern", feature: "ext_1", direction: [1, 0, 0], spacing: 100, count: 2 };
    const model = new ScriptedModel([() => [use("addFeature", { feature: pattern })], () => [say("Patterning the part is outside what this entity's scope allows.")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "entity", sketch: "sketch_1", entity: "r1" }, text: "pattern the part", model, kernel });
    expect(r.outcome).toBe("refused");
    expect(r.proposal).toBeNull();
    expect(r.calls[0].error).toMatch(/^writeScope: addFeature "linearPattern_1" is outside the scope \[sketch_1\/r1\]/);
    expect(r.text).toBe("Patterning the part is outside what this entity's scope allows.");
  });

  it("escalate ends the ask with nothing changed", async () => {
    const model = new ScriptedModel([() => [use("escalate", { reason: "Patterning the whole part is not something one rectangle can do." })], () => [say("unused")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "entity", sketch: "sketch_1", entity: "r1" }, text: "pattern the part", model, kernel });
    expect(r).toMatchObject({ outcome: "refused", proposal: null, text: "Patterning the whole part is not something one rectangle can do." });
    expect(model.requests).toHaveLength(1);
  });

  it('"what is this face" returns text, gets one framed picture and no write tools', async () => {
    const model = new ScriptedModel([() => [say("The top face of the plate, 80 × 40 mm, with hole_1 through it.")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "face", index: topFace }, text: "What is this face?", model, kernel });
    expect(r).toMatchObject({ outcome: "answer", mode: "explain", visual: true, proposal: null, calls: [] });
    expect(r.text).toContain("top face");
    const tools = toolNames(model);
    expect(tools).toEqual(["measure", "getFeature", "escalate"]);
    const content = model.requests[0].messages[0].content as Anthropic.ContentBlockParam[];
    expect(content.filter((b) => b.type === "image")).toHaveLength(1);
    const text = firstUserText(model);
    expect(text).toContain('"selection": {');
  });

  it("an explain-only ask cannot write even if the model tries", async () => {
    const model = new ScriptedModel([() => [use("updateFeature", { id: "hole_1", patch: { diameter: 8 } })], () => [say("It is a 6.6 mm through hole.")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "What is this?", model, kernel });
    expect(r.outcome).toBe("answer");
    expect(r.proposal).toBeNull();
    expect(r.calls[0]).toMatchObject({ ok: false, error: "this ask is a question; it cannot change the part" });
  });

  it("an edit that breaks the part is rolled back inside the ask; the correction is proposed", async () => {
    const model = new ScriptedModel([
      () => [use("updateFeature", { id: "hole_1", patch: { diameter: 500 } })],
      () => [use("updateFeature", { id: "hole_1", patch: { diameter: 8 } })],
      () => [say("Ø500 would remove the whole plate, so I set Ø8.")],
    ]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it bigger", model, kernel });
    expect(r.calls.map((c) => [c.ok, c.revision])).toEqual([
      [false, 0],
      [true, 1],
    ]);
    expect(r.calls[0].error).toMatch(/^updateFeature rolled back: hole_1: removes all the material/);
    expect(r.proposal!.changes[0].fields).toEqual([{ path: "diameter", before: 6.6, after: 8 }]);
  });

  it("one correction pass, then no more edits", async () => {
    const step = (d: number) => () => [use("updateFeature", { id: "hole_1", patch: { diameter: d } })];
    const model = new ScriptedModel([step(7), step(7.5), step(9), () => [say("Stopped at Ø7.5.")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8", model, kernel });
    expect(r.calls.map((c) => c.ok)).toEqual([true, true, false]);
    expect(r.calls[2].error).toMatch(/^no more edits in this ask/);
    expect(r.proposal!.changes[0].fields).toEqual([{ path: "diameter", before: 6.6, after: 7.5 }]);
  });

  it("from a face, one feature that uses that face", async () => {
    const packetSelection = { type: "planar", normal: [0, 0, 1], pick: "largest" };
    const hole = (center: number[], face: unknown = packetSelection) => ({ op: "hole", face, center, diameter: 5, depth: "through" });
    const model = new ScriptedModel([
      () => [use("addFeature", { feature: hole([-30, 0], { type: "planar", normal: [0, 0, -1], pick: "largest" }) })],
      () => [use("addFeature", { feature: hole([-30, 0]) })],
      () => [use("addFeature", { feature: hole([-20, 0]) })],
      () => [say("Added hole_2 at [-30, 0].")],
    ]);
    const r = await runAsk({ doc: bracket, target: { kind: "face", index: topFace }, text: "put a 5 mm hole at -30, 0", model, kernel });
    expect(r.calls.map((c) => c.ok)).toEqual([false, true, false]);
    expect(r.calls[0].error).toBe("the hole's face selector must pick the face you right-clicked; use the packet's selection");
    expect(r.calls[2].error).toBe("from a face, the ask adds one feature; hole_2 is it");
    expect(r.proposal!.changes).toEqual([{ id: "hole_2", kind: "added" }]);
  });

  it("from an edge, a fillet that includes that edge", async () => {
    const t = (await kernel.topology(bracket))!;
    const e = t.edges[sideEdge];
    const model = new ScriptedModel([
      () => [use("addFeature", { feature: { op: "fillet", edges: { type: "edge", kind: "circle", radius: 3.3, pick: "all" }, radius: 1 } })],
      () => [use("addFeature", { feature: { op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], near: e.mid, pick: "all" }, radius: 2 } })],
      () => [say("Filleted the corner, R2.")],
    ]);
    const r = await runAsk({ doc: bracket, target: { kind: "edge", index: sideEdge }, text: "fillet this edge, radius 2", model, kernel });
    expect(r.calls.map((c) => c.ok)).toEqual([false, true]);
    expect(r.calls[0].error).toMatch(/^the fillet's edges must be the edge you right-clicked/);
    expect(r.outcome).toBe("proposal");
  });

  it("reads only what the packet names", async () => {
    const model = new ScriptedModel([() => [use("getFeature", { id: "sketch_1" }), use("getFeature", { id: "ext_1" })], () => [say("ok")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "explain the parent", model, kernel });
    expect(r.calls.map((c) => c.ok)).toEqual([false, true]);
    expect(r.calls[0].error).toBe("sketch_1 is outside this ask's context (the packet's target, parent and children)");
  });

  it("a sketch ask edits that sketch's contents only", async () => {
    const model = new ScriptedModel([
      () => [use("addConstraint", { sketch: "sketch_1", constraint: { type: "distanceY", entity: "r1", value: 40 } })],
      () => [use("addFeature", { feature: { op: "extrude", sketch: "sketch_1", distance: 3 } })],
      () => [say("Added the height; the extrude is outside this sketch.")],
    ]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "sketch_1" }, text: "add the missing height and extrude it again", model, kernel });
    expect(r.packet!.writeScope).toEqual(["sketch_1/*"]);
    expect(r.calls.map((c) => c.ok)).toEqual([true, false]);
    expect(r.calls[1].error).toMatch(/^writeScope: addFeature/);
    expect(r.proposal!.changes[0]).toMatchObject({ id: "sketch_1", kind: "changed" });
  });

  it("a user edit to a feature the proposal touches drops it; other edits do not", async () => {
    const model = new ScriptedModel([() => [use("updateFeature", { id: "hole_1", patch: { diameter: 8 } })], () => [say("done")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model, kernel });
    const userChangedHole = structuredClone(bracket);
    userChangedHole.features[2].center = [20, 0];
    expect(conflictsWith(r.proposal!, userChangedHole)).toEqual(["hole_1"]);
    const userChangedPlate = structuredClone(bracket);
    userChangedPlate.features[1].distance = 10;
    expect(conflictsWith(r.proposal!, userChangedPlate)).toEqual([]);
    const accepted = applyProposal(userChangedPlate, r.proposal!);
    expect(accepted.ok && accepted.doc.features[1].distance).toBe(10);
    expect(accepted.ok && accepted.doc.features[2].diameter).toBe(8);
  });

  it("a failed feature: the packet carries the error and the scope is that feature", async () => {
    const broken = structuredClone(bracket);
    broken.features[2].center = [300, 0];
    const model = new ScriptedModel([() => [use("updateFeature", { id: "hole_1", patch: { center: [30, 0] } })], () => [say("Moved the hole back onto the plate.")]]);
    const r = await runAsk({ doc: broken, target: { kind: "failed", id: "hole_1" }, text: "Fix this error. Do not touch anything else.", model, kernel });
    expect(r.packet!.error).toMatch(/^hole_1: center \[300, 0\] is not on the selected face/);
    expect(r.packet!.writeScope).toEqual(["hole_1"]);
    expect(r.outcome).toBe("proposal");
  });
});
