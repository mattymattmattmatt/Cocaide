// Phase L: the agent on drawings. A right-click on the sheet (a view, an
// annotation, the drawing) builds its packet and scope; the ask edits the
// drawing alone, each edit checked on the composed sheet; the proposal is
// judged by the drawing checks, with one correction pass. Scripted model,
// real kernel.

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal, runAsk } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { ScriptedModel, say, use } from "../src/ask/model";
import { buildPacket, describeScope, scopeFor, targetLabel } from "../src/ask/packet";
import { scopedActions, toolsFor } from "../src/ask/prompt";
import { apply, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeSheet } from "../src/drafting/compose";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { getOC, loadOC } from "../src/kernel";

const table: RawDocument = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));

let kernel: LocalKernel;
let drawn: RawDocument;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
  const c = await kernel.check(table);
  const g = await kernel.project(table, DEFAULT_VIEWS);
  const r = apply(table, { type: "setDrawing", drawing: planDrawing(table, c.measurements, g, { date: "2026-10-08" }) });
  if (!r.ok) throw new Error(r.error);
  drawn = r.doc;
});

const firstText = (m: ScriptedModel) => (m.requests[0].messages[0].content as Anthropic.TextBlockParam[]).find((b) => b.type === "text")!.text;
const packetOf = (m: ScriptedModel) => JSON.parse(firstText(m).split("Context packet:\n")[1].split("\n\n")[0]);

async function reads(doc: RawDocument, id: string) {
  const c = await kernel.check(doc);
  const views = validateDocument(doc).drawing!.views.map((v) => ({ id: v.id, look: v.look }));
  const sheet = composeSheet(doc, { measurements: c.measurements, geometry: await kernel.project(doc, views) })!;
  return sheet.annotations.find((a) => a.id === id);
}

describe("a right-click on the sheet", () => {
  it("scopes a view to itself and its annotations, an annotation to itself, empty paper to the drawing", () => {
    expect(scopeFor(drawn, { kind: "view", id: "front" })).toEqual(["view:front"]);
    expect(scopeFor(drawn, { kind: "annotation", id: "d1" })).toEqual(["annotation:d1"]);
    expect(scopeFor(drawn, { kind: "drawing" })).toEqual(["drawing"]);
    expect(describeScope(["view:front"])).toBe("view front and its annotations");
    expect(targetLabel(drawn, { kind: "annotation", id: "b4" })).toBe("balloon b4");
    expect(scopedActions("view").map((a) => a.label)).toEqual(["Dimension the overall size", "Dimension a member's length", "Balloon what it shows", "Show hidden edges"]);
  });

  it("gets the drawing's tools and nothing that edits the part", () => {
    expect(toolsFor("edit", "view").map((t) => t.name)).toEqual(["escalate", "setAnnotation", "setView", "setSheet"]);
    expect(toolsFor("explain", "view").map((t) => t.name)).toEqual(["escalate"]);
    expect(toolsFor("edit", "feature").map((t) => t.name)).not.toContain("setAnnotation");
  });

  it("the view's packet: its direction and scale, where its nodes, members and holes are on the sheet, its annotations and the checks", async () => {
    const p = await buildPacket(drawn, { kind: "view", id: "front" }, kernel);
    expect(p.target).toEqual({ kind: "view", id: "front", label: "view front" });
    expect(p.writeScope).toEqual(["view:front"]);
    const view = p.view as { look: string; scale: string; orthographic: boolean; shows: { nodes: Record<string, number[]>; members: { id: string; liesFlat: boolean; seen: boolean; cutListItem: number; length: number }[] } };
    expect([view.look, view.scale, view.orthographic]).toEqual(["front", "1:10", true]);
    expect(Object.keys(view.shows.nodes)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    const leg = view.shows.members.find((m) => m.id === "leg_a")!;
    expect(leg).toMatchObject({ length: 860, cutListItem: 2, liesFlat: true, seen: true });
    // rail_left runs straight at the viewer in the front view: it can't be dimensioned there.
    expect(view.shows.members.find((m) => m.id === "rail_left")).toMatchObject({ liesFlat: false });
    expect(p.children).toEqual([
      { id: "d1", type: "dimension", view: "front", from: "@left", to: "@right", reads: "1200" },
      { id: "d2", type: "dimension", view: "front", from: "@bottom", to: "@top", reads: "900" },
    ]);
    expect((p.checks as { ok: boolean }[]).every((c) => c.ok)).toBe(true);
    expect(p.measurements).toMatchObject({ overallSize: [1200, 600, 900] });
  });
});

describe("Phase L acceptance: the leg height from a right-click on the front view", () => {
  it("proposes a dimension that, accepted, reads 860; the proposal shows the drawing checks", async () => {
    const model = new ScriptedModel([
      () => [use("setAnnotation", { id: "d10", annotation: { type: "dimension", view: "front", member: "leg_a" } })],
      () => [say("Added d10, leg_a's cut length: 860, on the left of the front view.")],
    ]);
    const r = await runAsk({ doc: drawn, target: { kind: "view", id: "front" }, text: "Dimension the leg height", model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(r.calls.map((c) => [c.tool, c.ok, c.error])).toEqual([["setAnnotation", true, undefined]]);
    expect(r.proposal!.changes).toEqual([{ id: "d10", what: "dimension", kind: "added" }]);
    expect(r.proposal!.checks!.every((c) => c.ok)).toBe(true);
    expect(r.proposal!.touched).toEqual(["drawing:d10"]);
    expect(r.proposal!.volumeBefore).toBe(r.proposal!.volumeAfter);
    // The tool told the model what the new dimension reads.
    const result = (model.requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0].content as string;
    expect(JSON.parse(result)).toMatchObject({ ok: true, annotation: { id: "d10", type: "dimension", reads: "860" } });
    const accepted = applyProposal(drawn, r.proposal!);
    expect(accepted.ok).toBe(true);
    expect((await reads((accepted as { doc: RawDocument }).doc, "d10"))!.text).toBe("860");
  });

  it("rejects an edit to the part's features from a drawing ask", async () => {
    const model = new ScriptedModel([
      () => [use("updateFeature", { id: "leg_a", patch: { size: "SHS 50x50x3" } })],
      () => [say("That needs the model, not the drawing.")],
    ]);
    const r = await runAsk({ doc: drawn, target: { kind: "view", id: "front" }, text: "Make the legs heavier", model, kernel });
    expect(r.outcome).toBe("refused");
    expect(r.calls[0].error).toBe('writeScope: updateFeature "leg_a" is outside the scope [view:front]');
    expect(r.proposal).toBeNull();
  });

  it("rolls back a dimension the view can't show, with the reason, and keeps the fixed one", async () => {
    const model = new ScriptedModel([
      () => [use("setAnnotation", { id: "d10", annotation: { type: "dimension", view: "front", member: "rail_left" } })],
      () => [use("setAnnotation", { id: "d10", annotation: { type: "dimension", view: "front", member: "leg_a" } })],
      () => [say("rail_left runs at the viewer in the front view; dimensioned leg_a instead.")],
    ]);
    const r = await runAsk({ doc: drawn, target: { kind: "view", id: "front" }, text: "Dimension the length of rail_left", model, kernel });
    expect(r.calls.map((c) => [c.ok, c.error])).toEqual([
      [false, "setAnnotation rolled back: d10: rail_left doesn't lie flat in front (it runs straight at the viewer): dimension it in a view it lies flat in"],
      [true, undefined],
    ]);
    expect(r.outcome).toBe("proposal");
  });

  it("judges the proposal by the drawing checks: a check it breaks gets the one correction pass", async () => {
    const model = new ScriptedModel([
      () => [use("setAnnotation", { id: "b5", annotation: null })],
      () => [say("Removed b5.")],
      (req) => {
        const last = req.messages.at(-1)!.content as Anthropic.TextBlockParam[];
        expect(last[0].text).toContain("- Every cut list item has a balloon: no balloon for item 2 (leg_a, leg_b, leg_c, leg_d)");
        return [use("setAnnotation", { id: "b5", annotation: { type: "balloon", view: "iso", member: "leg_b" } })];
      },
      () => [say("Kept item 2's balloon, on leg_b.")],
    ]);
    const r = await runAsk({ doc: drawn, target: { kind: "drawing" }, text: "Tidy the balloons", model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(r.proposal!.checks!.filter((c) => !c.ok)).toEqual([]);
    expect(model.requests).toHaveLength(4);
    expect(r.proposal!.changes).toEqual([]);
  });

  it("answers a question about an annotation without tools that write", async () => {
    const model = new ScriptedModel([() => [say("d2 is the frame's overall height, 900, from the floor to the top of the rails.")]]);
    const r = await runAsk({ doc: drawn, target: { kind: "annotation", id: "d2" }, text: "What does this dimension show?", model, kernel });
    expect(r.outcome).toBe("answer");
    expect(model.requests[0].tools.map((t) => t.name)).toEqual(["escalate"]);
    expect(packetOf(model).annotation).toEqual({ id: "d2", type: "dimension", view: "front", from: "@bottom", to: "@top", reads: "900" });
    expect(packetOf(model).parent.view.id).toBe("front");
  });
});

describe("drawings over the agent session (MCP)", () => {
  it("makes the drawing, edits it without rebuilding the part, reads it back, and exports it", async () => {
    const { AgentSession } = await import("../src/agent/session");
    const { parseLog, replay } = await import("../src/agent/replay");
    const { mkdtempSync, readFileSync: read, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cocaide-drawing-"));
    const log = join(dir, "log.jsonl");
    const s = await AgentSession.open({ doc: table, outDir: dir, logPath: log });
    const made = await s.call("newDrawing", { date: "2026-10-08" });
    expect(made.result).toMatchObject({ ok: true, changed: true, revision: 1 });
    const added = await s.call("setAnnotation", { id: "d10", annotation: { type: "dimension", view: "front", member: "leg_a" } });
    expect(added.result).toMatchObject({ ok: true, revision: 2, annotation: { id: "d10", type: "dimension", reads: "860" } });
    const gone = await s.call("setAnnotation", { id: "b5", annotation: null });
    expect(gone.result).toMatchObject({ ok: true, failingChecks: ["Every cut list item has a balloon: no balloon for item 2 (leg_a, leg_b, leg_c, leg_d)"] });
    await s.call("undo");
    const d = await s.call("drawing");
    expect(d.result).toMatchObject({ ok: true, sheet: { size: "A3", scale: "1:10", projection: "third" } });
    expect((d.result.annotations as { id: string; reads?: string }[]).map((a) => [a.id, a.reads])).toEqual([
      ["d1", "1200"],
      ["d2", "900"],
      ["d3", "600"],
      ["b4", "1"],
      ["b5", "2"],
      ["b6", "3"],
      ["cut_list", "cut list, 3 items"],
      ["d10", "860"],
    ]);
    expect((d.result.checks as { ok: boolean }[]).every((c) => c.ok)).toBe(true);
    const pdf = await s.call("exportDrawing", { format: "pdf" });
    expect(pdf.result).toMatchObject({ ok: true, file: join(dir, "table-frame-drawing.pdf") });
    expect(existsSync(pdf.result.file as string)).toBe(true);
    const svg = await s.call("exportDrawing", { format: "svg", file: "frame" });
    expect(read(svg.result.file as string, "utf8")).toContain(">860</text>");
    expect((await s.call("exportDrawing", { format: "dxf" })).result).toMatchObject({ ok: false, error: 'exportDrawing: format must be "pdf" or "svg"' });
    const final = s.text;
    s.close();
    // The log replays to the same document, the drawing included.
    const r = await replay(parseLog(read(log, "utf8"))[0]);
    expect(r.divergedAt).toBeUndefined();
    expect(r.document).toBe(final);
  }, 60_000);
});
