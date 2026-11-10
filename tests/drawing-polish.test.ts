// Phase Q round 4, the polish pass: what a checker would mark on the example
// sheets. Fit views tries more arrangements before a smaller scale (the
// projection's group in other corners, packed closer, an iso in whatever room
// is left, a cut list moved to the top right) and the scales it picks; the
// cutting-plane letters keep off the dimension stacks; datums, frames and
// their hosts are placed clear of each other and of dimension lines; a cut
// that would take away what the front view shows is not made; and the AI's
// edits of a sheet stored before Q4 store its shown scale first, as the
// editor does.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal, runAsk } from "../src/ask/agent";
import { autoDetail } from "../src/ask/detail/auto";
import { LocalKernel } from "../src/ask/kernel";
import { ScriptedModel, say, use } from "../src/ask/model";
import { AgentSession } from "../src/agent/session";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { drawingChecks } from "../src/drafting/checks";
import { composeDrawing, type ComposedSheet } from "../src/drafting/compose";
import { fitViews, keepScale, keepScales, sheetsTouched } from "../src/drafting/fit";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { segmentHitsBox } from "../src/drafting/annotate/placement";
import { overlaps, type Box } from "../src/drafting/sheet";
import { textWidth } from "../src/drafting/text";
import { viewSpecs } from "../src/drafting/specs";
import { getOC, loadOC } from "../src/kernel";

const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

function run(doc: RawDocument, ...cmds: Command[]): RawDocument {
  for (const cmd of cmds) {
    const r = apply(doc, cmd);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  }
  return doc;
}

async function context(doc: RawDocument) {
  const v = validateDocument(doc);
  if (!v.drawing) throw new Error(v.drawingErrors.join("; "));
  const c = await kernel.check(doc);
  return { measurements: c.measurements, geometry: await kernel.project(doc, viewSpecs(v.drawing)) };
}

async function sheetOf(doc: RawDocument, i = 0): Promise<ComposedSheet> {
  return composeDrawing(doc, await context(doc))!.sheets[i];
}

const plans = new Map<string, RawDocument>();
async function planned(name: string): Promise<RawDocument> {
  if (!plans.has(name)) {
    const doc = example(name);
    const c = await kernel.check(doc);
    plans.set(name, run(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS), { date: "2026-11-05" }) } as Command));
  }
  return plans.get(name)!;
}

type Sheet = { id: string; scale?: string; views: { id: string; scale?: string; at?: number[] }[]; annotations: { id: string; type: string; at?: number[] }[] };
const stored = (doc: RawDocument) => (doc.drawing as { sheets: Sheet[] }).sheets[0];
/** As stored before Q4: no scale chosen and kept. */
function unscaled(doc: RawDocument): RawDocument {
  const out = structuredClone(doc);
  const s = stored(out);
  delete s.scale;
  for (const v of s.views) if (v.id === "iso") delete v.scale;
  return out;
}

/** A text prim's box on the sheet (unrotated). */
function textBox(p: { at: [number, number]; text: string; size: number; anchor?: string; bold?: boolean }): Box {
  const w = textWidth(p.text, p.size, p.bold);
  const x0 = p.anchor === "middle" ? p.at[0] - w / 2 : p.anchor === "end" ? p.at[0] - w : p.at[0];
  return { min: [x0, p.at[1] - 0.22 * p.size], max: [x0 + w, p.at[1] + 0.75 * p.size] };
}

describe("Fit views tries more arrangements and picks the largest standard scale that truly fits", () => {
  it("on the examples: the bracket 2:1, the flange 1:1, the mounting plate 2:1 (packed, its iso 1:1 beside), the frame 1:10 (iso 1:20)", async () => {
    const want: Record<string, [string, Record<string, string>]> = {
      bracket: ["2:1", {}],
      flange: ["1:1", {}],
      "mounting-plate": ["2:1", { iso: "1:1" }],
      "table-frame": ["1:10", { iso: "1:20" }],
    };
    for (const [name, [scale, views]] of Object.entries(want)) {
      const doc = await planned(name);
      // Let every place and the stored scale go, as Fit views does.
      const messy = run(doc, ...stored(doc).views.map((v): Command => ({ type: "moveView", id: v.id, at: [30, 30] })));
      const fit = fitViews(messy, await context(messy), stored(messy) as never);
      if ("error" in fit) throw new Error(fit.error);
      expect([name, fit.scale]).toEqual([name, scale]);
      const after = run(messy, ...fit.commands);
      const s = stored(after);
      expect([name, s.scale, Object.fromEntries(s.views.filter((v) => v.scale).map((v) => [v.id, v.scale]))]).toEqual([name, scale, views]);
      expect(s.views.every((v) => !v.at)).toBe(true);
      const sheet = await sheetOf(after);
      expect([name, sheet.scaleText, sheet.problems.filter((p) => /overlap|off the sheet/.test(p))]).toEqual([name, scale, []]);
    }
  }, 240000);

  it("the frame's New drawing with its cut list above the title block: 1:10, every view clear of the table", async () => {
    const doc = await planned("table-frame");
    const welded = doc;
    const sheet = await sheetOf(welded);
    expect(sheet.scaleText).toBe("1:10");
    // Every view clear of the cut list above the title block.
    const table = sheet.blocks.find((b) => b.id === "cut_list")!.box;
    for (const v of sheet.views) expect([v.id, overlaps(v.box!, table)]).toEqual([v.id, false]);
  }, 120000);

  it("Auto-detail's tables: the cut list goes to the top right where the views then fit at 1:10, and that place is stored", async () => {
    const r = await autoDetail(example("table-frame"), kernel, { date: "2026-11-05" });
    const s = stored(r.doc);
    expect(s.scale).toBe("1:10");
    const sheet = r.execution.state.sheet!;
    const table = sheet.blocks.find((b) => b.id === "cut_list")!.box;
    // At the frame's top right corner: its place stored on the table, so nothing moves it again.
    expect(table.max.map((x) => Math.round(x))).toEqual(sheet.frame.max.map((x) => Math.round(x)));
    expect(s.annotations.find((a) => a.id === "cut_list")!.at).toEqual([table.min[0], table.max[1]]);
  }, 120000);
});

describe("the cutting-plane line's letters keep off the dimension stacks", () => {
  for (const name of ["bracket", "mounting-plate"]) {
    it(`${name}: no letter over a dimension's text or lines`, async () => {
      for (const doc of [await planned(name), (await autoDetail(example(name), kernel, { date: "2026-11-05" })).doc]) {
        const sheet = await sheetOf(doc);
        const section = sheet.views.find((v) => v.kind === "section")!;
        const letters = sheet.prims.filter((p): p is Extract<typeof p, { k: "text" }> => p.k === "text" && p.owner === section.id && p.text === section.label);
        expect(letters.length).toBe(2);
        const dims = new Set(sheet.annotations.filter((a) => a.type === "dimension").map((a) => a.id));
        for (const l of letters) {
          const box = textBox(l);
          for (const a of sheet.annotations) if (dims.has(a.id) && a.textBox) expect([name, a.id, overlaps(box, a.textBox, 0.2)]).toEqual([name, a.id, false]);
          for (const p of sheet.prims) {
            if (p.k !== "line" || !p.owner || !dims.has(p.owner)) continue;
            for (let i = 1; i < p.pts.length; i++) expect([name, p.owner, segmentHitsBox(p.pts[i - 1], p.pts[i], box)]).toEqual([name, p.owner, false]);
          }
        }
      }
    }, 120000);
  }
});

describe("Auto-detail's placement leaves the critic nothing to say about overlaps", () => {
  for (const name of ["bracket", "flange", "mounting-plate", "stand"]) {
    it(`${name}: no overlap findings, no datum's stem across a dimension line, the frames under their callouts clear`, async () => {
      const r = await autoDetail(example(name), kernel, { date: "2026-11-05" });
      expect(r.findings.filter((f) => f.rule === "overlap").map((f) => f.message)).toEqual([]);
      expect(r.findings.filter((f) => f.severity === "error").map((f) => f.message)).toEqual([]);
      const sheet = r.execution.state.sheet!;
      const dimLines = sheet.prims.filter((p) => p.k === "line" && !p.fill && sheet.annotations.some((a) => a.id === p.owner && a.type === "dimension"));
      for (const datum of sheet.annotations.filter((a) => a.type === "datum")) {
        // The stem: the datum's unfilled lines other than its frame (the box round its letter).
        const stems = sheet.prims.filter((p) => p.k === "line" && p.owner === datum.id && !p.fill && !p.closed);
        for (const s of stems) {
          if (s.k !== "line") continue;
          for (const d of dimLines) {
            if (d.k !== "line") continue;
            for (let i = 1; i < d.pts.length; i++) {
              const crossed = s.pts.slice(1).some((q, j) => segmentHitsBox(s.pts[j], q, { min: [Math.min(d.pts[i - 1][0], d.pts[i][0]) - 0.05, Math.min(d.pts[i - 1][1], d.pts[i][1]) - 0.05], max: [Math.max(d.pts[i - 1][0], d.pts[i][0]) + 0.05, Math.max(d.pts[i - 1][1], d.pts[i][1]) + 0.05] }));
              const along = Math.abs(d.pts[i][0] - d.pts[i - 1][0]) < 1e-6 || Math.abs(d.pts[i][1] - d.pts[i - 1][1]) < 1e-6;
              if (along && crossed) expect([name, datum.id, d.owner, "crosses"]).toEqual([name, datum.id, d.owner, "clear"]);
            }
          }
        }
      }
    }, 180000);
  }

  it("the flange's datums A and B stand apart (they were drawn over one another)", async () => {
    const r = await autoDetail(example("flange"), kernel, { date: "2026-11-05" });
    const sheet = r.execution.state.sheet!;
    const a = sheet.annotations.find((x) => x.id === "datum_A")!.textBox!;
    const b = sheet.annotations.find((x) => x.id === "datum_B")!.textBox!;
    expect(overlaps(a, b, -2)).toBe(false);
  }, 120000);
});

describe("New drawing does not cut away what the front view shows", () => {
  it("the stand: its holes are behind the upright, so the front stays a view (not a section) and the 68 height is dimensioned", async () => {
    const doc = await planned("stand");
    const views = stored(doc).views as { id: string; kind?: string }[];
    expect(views.some((v) => v.kind === "section")).toBe(false);
    const c = await context(doc);
    const sheet = composeDrawing(doc, c)!.sheets[0];
    const checks = drawingChecks([sheet], doc, c.measurements, c.geometry);
    expect(checks.find((x) => x.label.startsWith("The overall size"))!.ok).toBe(true);
  }, 120000);

  it("the mounting plate and the flange keep their sections (nothing in front of their cuts)", async () => {
    for (const name of ["mounting-plate", "flange", "bracket"]) expect([name, (stored(await planned(name)).views as { kind?: string }[]).some((v) => v.kind === "section")]).toEqual([name, true]);
  }, 120000);
});

describe("the AI's first edit of a sheet stored before Q4 stores the scale it shows, as the editor does", () => {
  it("sheetsTouched: a command's sheet, the sheet holding what it names, else the first", async () => {
    const doc = run(await planned("bracket"), { type: "addSheet", id: "s2" } as Command);
    expect(sheetsTouched(doc, [{ type: "moveView", id: "front", at: [1, 2] } as Command])).toEqual(["sheet1"]);
    expect(sheetsTouched(doc, [{ type: "setAnnotation", id: "n9", sheet: "s2", annotation: { type: "text", text: "x", at: [1, 1] } } as Command])).toEqual(["s2"]);
    expect(sheetsTouched(doc, [{ type: "setDrawingOptions", patch: { standard: "ISO" } } as Command])).toEqual([]);
  }, 120000);

  it("keepScales gives the editor's keepScale for the sheet edited, and nothing once a scale is stored", async () => {
    const doc = unscaled(await planned("table-frame"));
    const sheet = await sheetOf(doc);
    const cmd: Command = { type: "moveView", id: "iso", at: [300, 200] };
    const keep = keepScales(doc, [cmd], () => sheet);
    expect(keep).toEqual(keepScale(stored(doc) as never, sheet));
    expect(keep[0]).toEqual({ type: "setSheet", sheet: "sheet1", patch: { scale: sheet.scaleText } });
    expect(keepScales(await planned("table-frame"), [cmd], () => sheet)).toEqual([]);
    // A command that sets the scale itself, or replaces the drawing, needs none.
    expect(keepScales(doc, [{ type: "setSheet", patch: { scale: "1:5" } } as Command], () => sheet)).toEqual([]);
  }, 120000);

  it("the agent session (MCP, the bridge): a moveView stores the sheet's scale first, so nothing else moves", async () => {
    const doc = unscaled(await planned("table-frame"));
    const before = await sheetOf(doc);
    const s = await AgentSession.open({ doc });
    const r = (await s.call("moveView", { id: "iso", at: [330, 210] })).result as { ok: boolean };
    expect(r.ok).toBe(true);
    const after = JSON.parse(s.text) as RawDocument;
    s.close();
    expect(stored(after).scale).toBe(before.scaleText);
    expect(stored(after).views.find((v) => v.id === "iso")!.scale).toBe(before.views.find((v) => v.id === "iso")!.scaleText);
    const sheet = await sheetOf(after);
    for (const v of sheet.views) if (v.id !== "iso") expect([v.id, v.centre]).toEqual([v.id, before.views.find((x) => x.id === v.id)!.centre]);
  }, 120000);

  it("the in-app ask: the proposal stores it (outside the ask's scope) and accepting replays it", async () => {
    const doc = unscaled(await planned("table-frame"));
    const before = await sheetOf(doc);
    const model = new ScriptedModel([() => [use("moveView", { id: "iso", at: [330, 210] })], () => [say("Moved the iso view.")]]);
    const r = await runAsk({ doc, target: { kind: "view", id: "iso" }, text: "move the iso up", model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(r.proposal!.keepScale?.[0]).toEqual({ type: "setSheet", sheet: "sheet1", patch: { scale: before.scaleText } });
    expect(r.proposal!.commands.map((c) => c.type)).toEqual(["moveView"]);
    const accepted = applyProposal(doc, r.proposal!);
    if (!accepted.ok) throw new Error(accepted.error);
    expect(stored(accepted.doc).scale).toBe(before.scaleText);
  }, 120000);
});
