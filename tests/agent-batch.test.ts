// batch: several edits as one verified transaction (all or none, one undo
// step, a dry run that keeps nothing), in the MCP session and the right-click
// agent; and the build budget: a whole-part ask gets more room, a plan, and a
// self-check that sends failing checks back before it ends.

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { budgetFor, runAsk } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { atLeast, ScriptedModel, say, use } from "../src/ask/model";
import type { RawDocument } from "../src/doc/commands";
import { getOC, loadOC } from "../src/kernel";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
const BRACKET_VOLUME = 18994.728336;
const empty: RawDocument = { version: 1, units: "mm", name: "part", features: [] };
const top = { type: "planar", normal: [0, 0, 1], pick: "largest" };

/** A boss on the plate: a sketch on its top face, extruded, with a hole in it. */
const bossSteps = [
  { tool: "sketchProfile", sketch: "sk_boss", plane: { type: "ref", ref: { face: top } }, shapes: [{ circle: { center: [-20, 0], diameter: 16 } }] },
  { tool: "addFeature", feature: { id: "boss", op: "extrude", sketch: "sk_boss", distance: 10 } },
  { tool: "addFeature", feature: { id: "boss_hole", op: "hole", face: { type: "planar", normal: [0, 0, 1], rank: 1, pick: "largest" }, center: [-20, 0], diameter: 5, depth: "through" } },
];
const BOSS = Math.PI * 64 * 10 - Math.PI * 6.25 * 16;

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

describe("batch in the MCP session", () => {
  it("all steps kept as one revision and one undo step; each step says what it made", async () => {
    const s = await AgentSession.open({ doc: bracket });
    try {
      const r = (await s.call("batch", { commands: bossSteps })).result;
      expect(r).toMatchObject({ ok: true, changed: true, revision: 1 });
      expect(r.volume).toBeCloseTo(BRACKET_VOLUME + BOSS, 4);
      const results = r.results as Record<string, unknown>[];
      expect(results.map((x) => [x.step, x.tool, x.ok])).toEqual([
        [1, "sketchProfile", true],
        [2, "addFeature", true],
        [3, "addFeature", true],
      ]);
      expect(results[0]).toMatchObject({ sketch: "sk_boss", created: true, dof: 0, fullyDefined: true, id: "sk_boss" });
      expect(results[1]).toMatchObject({ id: "boss" });
      // One undo takes the whole batch back.
      expect((await s.call("undo")).result.volume).toBeCloseTo(BRACKET_VOLUME, 4);
      expect(s.doc.features.map((f) => f.id)).toEqual(["sketch_1", "ext_1", "hole_1"]);
    } finally {
      s.close();
    }
  });

  it("a step that fails keeps nothing: the error names the step", async () => {
    const s = await AgentSession.open({ doc: bracket });
    try {
      const before = s.text;
      const bad = [...bossSteps.slice(0, 2), { tool: "addFeature", feature: { id: "boss_hole", op: "hole", face: top, center: [300, 0], diameter: 5, depth: "through" } }];
      const r = (await s.call("batch", { commands: bad })).result;
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^batch rolled back: boss_hole: center \[300, 0\] is not on the selected face/);
      expect(s.text).toBe(before);
      expect(s.revision).toBe(0);
      // A step that does not even apply is named by number.
      const r2 = (await s.call("batch", { commands: [bossSteps[0], { tool: "updateFeature", id: "nope", patch: {} }] })).result;
      expect(r2.error).toMatch(/^batch step 2 \(updateFeature\): updateFeature: no feature "nope"\. Nothing in the batch was kept\./);
      expect((r2.results as unknown[]).length).toBe(2);
      expect((await s.call("batch", { commands: [{ tool: "exportSTEP" }] })).result.error).toMatch(/a batch step may be one of/);
    } finally {
      s.close();
    }
  });

  it("a dry run reports the rebuild and keeps nothing", async () => {
    const s = await AgentSession.open({ doc: bracket });
    try {
      const r = (await s.call("batch", { commands: bossSteps, dryRun: true })).result;
      expect(r).toMatchObject({ ok: true, dryRun: true, kept: false, revision: 0 });
      expect(r.volume).toBeCloseTo(BRACKET_VOLUME + BOSS, 4);
      expect(r.size).toEqual([80, 40, 16]);
      expect(s.doc.features).toHaveLength(3);
    } finally {
      s.close();
    }
  });

  it("the write scope holds inside a batch; what the batch adds is its to change", async () => {
    const s = await AgentSession.open({ doc: bracket, writeScope: ["+"] });
    try {
      const own = (await s.call("batch", { commands: [...bossSteps.slice(0, 2), { tool: "updateFeature", id: "boss", patch: { distance: 12 } }] })).result;
      expect(own.ok).toBe(true);
      const other = (await s.call("batch", { commands: [{ tool: "updateFeature", id: "ext_1", patch: { distance: 8 } }] })).result;
      expect(other.error).toMatch(/^batch step 1 \(updateFeature\): writeScope:/);
    } finally {
      s.close();
    }
  });

  it("a batch replays from the log", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { parseLog, replay } = await import("../src/agent/replay");
    const logPath = join(mkdtempSync(join(tmpdir(), "cocaide-batch-")), "log.jsonl");
    const s = await AgentSession.open({ doc: bracket, logPath });
    await s.call("batch", { commands: bossSteps });
    s.close();
    const run = parseLog(readFileSync(logPath, "utf8"))[0];
    const r = await replay(run);
    expect(r.steps.map((x) => [x.tool, x.ok, x.matches])).toEqual([["batch", true, true]]);
  });
});

describe("batch in the right-click agent", () => {
  it("one batch is one edit turn: a surgical ask can still make its correction after it", async () => {
    const model = new ScriptedModel([
      () => [use("batch", { commands: bossSteps })],
      () => [use("updateFeature", { id: "boss", patch: { distance: 12 } })],
      () => [say("Added a Ø16 boss, 12 tall, with a Ø5 hole.")],
    ]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "ext_1" }, text: "add a boss", model, kernel, reach: "part" });
    expect(r.calls.map((c) => [c.tool, c.ok, c.revision])).toEqual([
      ["batch", true, 1],
      ["updateFeature", true, 2],
    ]);
    expect(r.proposal!.changes.map((c) => [c.id, c.kind])).toEqual([
      ["sk_boss", "added"],
      ["boss", "added"],
      ["boss_hole", "added"],
    ]);
    // Accepting replays every command the batch stood for.
    expect(r.proposal!.commands.map((c) => c.type)).toEqual(["addFeature", "addFeature", "addFeature", "updateFeature"]);
    const result = JSON.parse((model.requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0].content as string);
    expect(result.results.map((x: { tool: string }) => x.tool)).toEqual(["sketchProfile", "addFeature", "addFeature"]);
  });

  it("from a face, the one-feature rule applies to each feature a batch adds", async () => {
    const t = (await kernel.topology(bracket))!;
    const face = t.faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99);
    const model = new ScriptedModel([() => [use("batch", { commands: bossSteps })], () => [say("Only one feature from a face.")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "face", index: face }, text: "add a boss with a hole", model, kernel });
    expect(r.calls[0].ok).toBe(false);
    expect(r.calls[0].error).toMatch(/^batch step 3 \(addFeature\): from a face, the ask adds one feature; boss is it/);
    expect(r.proposal).toBeNull();
  });

  it("a dry run in the agent keeps nothing", async () => {
    const model = new ScriptedModel([() => [use("batch", { commands: bossSteps, dryRun: true })], () => [say("It would work.")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "ext_1" }, text: "would a boss fit?", mode: "edit", model, kernel, reach: "part" });
    expect(r.outcome).toBe("answer");
    expect(r.calls[0]).toMatchObject({ ok: true, revision: 0 });
  });
});

describe("the build budget, the plan and the self-check", () => {
  it("budgets by kind of ask", () => {
    expect(budgetFor({ target: { kind: "feature", id: "x" }, mode: "edit" })).toMatchObject({ kind: "surgical", maxTurns: 8, corrections: 1, maxTokens: 8000 });
    expect(budgetFor({ target: { kind: "feature", id: "x" }, reach: "part", mode: "edit" }).kind).toBe("wide");
    expect(budgetFor({ target: { kind: "part" }, mode: "edit" })).toMatchObject({ kind: "build", minEffort: "medium", maxTokens: 16000 });
    expect(budgetFor({ target: { kind: "part" }, mode: "edit", build: false }).kind).toBe("surgical");
    expect(budgetFor({ target: { kind: "part" }, mode: "explain" }).kind).toBe("surgical");
    expect(atLeast("low", "medium")).toBe("medium");
    expect(atLeast("high", "medium")).toBe("high");
  });

  it("a whole-part build: plan, batch, a failing check is sent back, fixed, then it looks and ends", async () => {
    const plate = (h: number) => [
      { tool: "sketchProfile", sketch: "sk", shapes: [{ rect: { center: [0, 0], width: 60, height: 40 } }] },
      { tool: "addFeature", feature: { id: "plate", op: "extrude", sketch: "sk", distance: h } },
    ];
    const model = new ScriptedModel([
      () => [use("plan", { features: ["sk: 60 x 40 rectangle on Top", "plate: extrude it 10"], checks: [{ label: "volume", measure: "volume", expected: 24000 }, { label: "height", measure: "sizeZ", expected: 10 }] })],
      () => [use("batch", { commands: plate(8) })],
      () => [say("Built the plate.")],
      // The self-check: the volume and height are off; fix and look.
      () => [use("updateFeature", { id: "plate", patch: { distance: 10 } }), use("partSummary", {})],
      () => [say("A 60 × 40 × 10 plate.")],
    ]);
    const r = await runAsk({ doc: empty, target: { kind: "part" }, text: "a 60 x 40 x 10 plate", mode: "edit", build: true, model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(r.proposal!.volumeAfter).toBeCloseTo(24000, 6);
    expect(r.text).toBe("A 60 × 40 × 10 plate.");
    // More room per turn, at least medium effort, and plan offered.
    expect(model.requests[0]).toMatchObject({ maxTokens: 16000, minEffort: "medium" });
    expect(model.requests[0].tools.map((t) => t.name)).toEqual(expect.arrayContaining(["plan", "batch", "sketchProfile", "holes", "listFaces"]));
    const review = model.requests[3].messages.at(-1)!.content as Anthropic.TextBlockParam[];
    expect(review[0].text).toMatch(/^Before you finish, a self-check of the build:/);
    expect(review[0].text).toContain("- volume: expected 24000, measured 19200");
    expect(review[0].text).toContain("- height: expected 10, measured 8");
    expect(review[0].text).toContain("You have not looked at the result");
    // The plan's checks show in partSummary once it passes.
    const summary = JSON.parse((model.requests[4].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[1].content as string);
    expect(summary.planChecks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it("a build that checks out ends without a self-check turn", async () => {
    const model = new ScriptedModel([
      () => [use("plan", { features: ["the plate"], checks: [{ label: "volume", measure: "volume", expected: 24000 }] })],
      () => [use("batch", { commands: [{ tool: "sketchProfile", sketch: "sk", shapes: [{ rect: { center: [0, 0], width: 60, height: 40 } }] }, { tool: "addFeature", feature: { id: "plate", op: "extrude", sketch: "sk", distance: 10 } }] }), use("screenshot", {})],
      () => [say("Done.")],
    ]);
    const r = await runAsk({ doc: empty, target: { kind: "part" }, text: "plate", mode: "edit", build: true, model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(model.requests).toHaveLength(3);
  });

  it("a surgical ask keeps its one correction pass", async () => {
    const step = (d: number) => () => [use("updateFeature", { id: "hole_1", patch: { diameter: d } })];
    const model = new ScriptedModel([step(7), step(7.5), step(9), () => [say("Stopped.")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8", model, kernel });
    expect(r.calls.map((c) => c.ok)).toEqual([true, true, false]);
    expect(model.requests[0]).toMatchObject({ maxTokens: 8000 });
    expect(model.requests[0].minEffort).toBeUndefined();
  });
});
