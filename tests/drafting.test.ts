// Phase L: fabrication drawings. The drawing in the document (validation,
// commands, scope, renames that follow), the views projected from the
// rebuild, the sheet composed from them, the drawing checks, and the PDF and
// SVG exports. The browser half is e2e/drafting.spec.ts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { drawingChecks } from "../src/drafting/checks";
import { composeSheet, holeText, type ComposedSheet } from "../src/drafting/compose";
import { pdfString, sheetPDF } from "../src/drafting/pdf";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { sheetSVG } from "../src/drafting/svg";
import { textWidth } from "../src/drafting/text";
import { inView, viewFrame } from "../src/drafting/views";
import { getOC, loadOC } from "../src/kernel";

const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));
const table = example("table-frame");
const bracket = example("bracket");

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

/** The document with a new drawing, planned the way the app's New drawing does it. */
async function withDrawing(doc: RawDocument): Promise<RawDocument> {
  const c = await kernel.check(doc);
  const g = await kernel.project(doc, DEFAULT_VIEWS);
  const r = apply(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, g, { date: "2026-10-08" }) });
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

async function sheetOf(doc: RawDocument) {
  const c = await kernel.check(doc);
  const views = validateDocument(doc).drawing!.views.map((v) => ({ id: v.id, look: v.look }));
  const geometry = await kernel.project(doc, views);
  const sheet = composeSheet(doc, { measurements: c.measurements, geometry })!;
  return { sheet, checks: drawingChecks(sheet, doc, c.measurements, geometry), measurements: c.measurements };
}

function run(doc: RawDocument, ...cmds: Command[]): RawDocument {
  for (const cmd of cmds) {
    const r = apply(doc, cmd);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  }
  return doc;
}

const failed = (checks: { label: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.label);
const said = (sheet: ComposedSheet, id: string) => sheet.annotations.find((a) => a.id === id)!;
const texts = (sheet: ComposedSheet) => sheet.prims.flatMap((p) => (p.k === "text" ? [p.text] : []));

describe("the drawing in the document", () => {
  const drawing = {
    sheet: { size: "A3", projection: "third" },
    views: [
      { id: "front", look: "front" },
      { id: "iso", look: "iso" },
    ],
    annotations: [{ id: "d1", type: "dimension", view: "front", from: "@left", to: "@right" }],
  };

  it("validates the sheet, the views and the annotations, strictly", () => {
    expect(allErrors(validateDocument({ ...table, drawing }))).toEqual([]);
    const bad = {
      sheet: { size: "B5", projection: "second", scale: "ten" },
      views: [
        { id: "front", look: "side" },
        { id: "front", look: "top", hidden: "yes" },
      ],
      annotations: [
        { id: "d1", type: "dimension", view: "nowhere", from: "@middle", to: "A" },
        { id: "d2", type: "dimension", view: "front", member: "leg_a", from: "A" },
        { id: "b1", type: "balloon", view: "front", member: 3 },
        { id: "n1", type: "note", text: "", at: [10, 10] },
        { id: "t1", type: "table", table: "bom" },
        { id: "x1", type: "arrow" },
      ],
    };
    expect(validateDocument({ ...table, drawing: bad }).drawingErrors).toEqual([
      'document: drawing.sheet.size: must be "A4", "A3", "A2", "A1", "A0" (got "B5")',
      'document: drawing.sheet.scale: must be a scale like "1:10" (got "ten")',
      'document: drawing.sheet.projection: must be "third" or "first" (got "second")',
      'document: drawing.views[0].look: must be "front", "back", "top", "bottom", "left", "right", "iso" (got "side")',
      'document: drawing.views[1].id: duplicate id "front": views and annotations share their ids',
      "document: drawing.views[1].hidden: must be true or false (got \"yes\")",
      'document: drawing.annotations[0].view: no view "nowhere" (views: front)',
      'document: drawing.annotations[0].from: must be a node ("A"), a member end ("leg_a.start"), a hole ("hole_1") or a side of the view ("@left", "@right", "@top", "@bottom") (got "@middle")',
      "document: drawing.annotations[1]: a dimension is either between two points (from, to) or along a member, not both",
      "document: drawing.annotations[2].member: must name a member (got 3)",
      'document: drawing.annotations[3].text: must be the note\'s text (got "")',
      'document: drawing.annotations[4].table: must be "cutList" or "welds" (got "bom")',
      'document: drawing.annotations[5].type: must be "dimension", "hole", "balloon", "weld", "table", "note" (got "arrow")',
    ]);
  });

  it("refuses a dimension in an iso view: it shortens every length", () => {
    const iso = { ...drawing, annotations: [{ id: "d1", type: "dimension", view: "iso", from: "A", to: "B" }] };
    expect(validateDocument({ ...table, drawing: iso }).drawingErrors).toEqual([
      "document: drawing.annotations[0].view: iso is an iso view, which shortens every length: dimension in a view that looks square at the part",
    ]);
  });

  it("never stops the part rebuilding: a broken drawing is the drawing's problem", async () => {
    const broken = { ...table, drawing: { sheet: { size: "A3" }, views: "none", annotations: [] } };
    const c = await kernel.check(broken);
    expect(c.ok).toBe(true);
    expect(c.measurements!.volume).toBeCloseTo(3054720, 0);
  });

  it("sets the drawing, the sheet, a view and an annotation; a view takes its annotations with it", () => {
    let doc = run(table, { type: "setDrawing", drawing });
    doc = run(doc, { type: "setSheet", patch: { scale: "1:20", title: "Bench frame", number: null } });
    expect((doc.drawing as { sheet: unknown }).sheet).toEqual({ size: "A3", projection: "third", scale: "1:20", title: "Bench frame" });
    doc = run(doc, { type: "setView", id: "top", view: { look: "top", hidden: true } }, { type: "setAnnotation", id: "b1", annotation: { type: "balloon", view: "top", member: "rail_front" } });
    expect(validateDocument(doc).drawing!.views.map((v) => v.id)).toEqual(["front", "iso", "top"]);
    doc = run(doc, { type: "setView", id: "top", view: null });
    expect(validateDocument(doc).drawing!.annotations.map((a) => a.id)).toEqual(["d1"]);
    expect(apply(doc, { type: "setView", id: "d1", view: { look: "top" } })).toEqual({ ok: false, error: 'setView: "d1" is an annotation\'s id' });
    expect(apply(doc, { type: "setAnnotation", id: "front", annotation: { type: "note", text: "x", at: [0, 0] } })).toEqual({ ok: false, error: 'setAnnotation: "front" is a view\'s id' });
    expect(apply(table, { type: "setView", id: "top", view: { look: "top" } })).toEqual({ ok: false, error: "setView: the part has no drawing; make one first (setDrawing)" });
    doc = run(doc, { type: "setDrawing", drawing: null });
    expect(doc.drawing).toBeUndefined();
  });

  it("refuses an annotation that points at nothing, and a bad one through validation", () => {
    const doc = run(table, { type: "setDrawing", drawing });
    expect(apply(doc, { type: "setAnnotation", id: "b1", annotation: { type: "balloon", view: "front", member: "rail_middle" } })).toEqual({
      ok: false,
      error: 'setAnnotation: b1: no member "rail_middle" (there are rail_front, rail_right, rail_back, rail_left, leg_a, leg_b, leg_c, leg_d)',
    });
    expect(apply(doc, { type: "setAnnotation", id: "d2", annotation: { type: "dimension", view: "front", from: "A", to: "Q" } })).toMatchObject({
      ok: false,
      error: expect.stringContaining('setAnnotation: d2: no node or hole "Q"'),
    });
    expect(apply(doc, { type: "setAnnotation", id: "d2", annotation: { type: "dimension", view: "front", from: "A", to: "A" } })).toEqual({
      ok: false,
      error: "setAnnotation rejected: document: drawing.annotations[1]: runs from A to itself",
    });
  });

  it("follows the model: a renamed node or member is renamed on the sheet, a deleted member is not refused", () => {
    let doc = run(table, {
      type: "setDrawing",
      drawing: {
        ...drawing,
        annotations: [
          { id: "d1", type: "dimension", view: "front", from: "A", to: "E" },
          { id: "d2", type: "dimension", view: "front", member: "leg_a" },
          { id: "d3", type: "dimension", view: "front", from: "leg_a.start", to: "@right" },
          { id: "b1", type: "balloon", view: "iso", member: "leg_a" },
        ],
      },
    });
    doc = run(doc, { type: "renameNode", from: "A", to: "TOP_A" }, { type: "updateFeature", id: "leg_a", patch: { id: "post_a" } });
    expect(validateDocument(doc).drawing!.annotations).toEqual([
      { id: "d1", type: "dimension", view: "front", from: "TOP_A", to: "E" },
      { id: "d2", type: "dimension", view: "front", member: "post_a" },
      { id: "d3", type: "dimension", view: "front", from: "post_a.start", to: "@right" },
      { id: "b1", type: "balloon", view: "iso", member: "post_a" },
    ]);
  });

  it("scopes a drawing ask: a view and its annotations, one annotation, never the features", () => {
    const doc = run(table, { type: "setDrawing", drawing });
    const front = { writeScope: ["view:front"] };
    expect(apply(doc, { type: "setAnnotation", id: "d2", annotation: { type: "dimension", view: "front", member: "leg_a" } }, front).ok).toBe(true);
    expect(apply(doc, { type: "setAnnotation", id: "d1", annotation: { type: "dimension", view: "front", from: "@bottom", to: "@top" } }, front).ok).toBe(true);
    expect(apply(doc, { type: "setView", id: "front", view: { look: "front", hidden: true } }, front).ok).toBe(true);
    expect(apply(doc, { type: "setAnnotation", id: "b9", annotation: { type: "balloon", view: "iso", member: "leg_a" } }, front)).toEqual({
      ok: false,
      error: 'writeScope: setAnnotation "b9" is outside the scope [view:front]',
    });
    expect(apply(doc, { type: "updateFeature", id: "leg_a", patch: { size: "SHS 50x50x3" } }, front)).toEqual({
      ok: false,
      error: 'writeScope: updateFeature "leg_a" is outside the scope [view:front]',
    });
    expect(apply(doc, { type: "setSheet", patch: { scale: "1:5" } }, front).ok).toBe(false);
    const one = { writeScope: ["annotation:d1"] };
    expect(apply(doc, { type: "setAnnotation", id: "d1", annotation: { type: "dimension", view: "front", from: "@left", to: "A" } }, one).ok).toBe(true);
    expect(apply(doc, { type: "setAnnotation", id: "d1", annotation: { type: "dimension", view: "iso", from: "A", to: "B" } }, one).ok).toBe(false);
    expect(apply(doc, { type: "setSheet", patch: { scale: "1:5" } }, { writeScope: ["drawing"] }).ok).toBe(true);
  });
});

describe("views projected from the rebuild", () => {
  it("a node, a member end and the projected lines agree", async () => {
    const g = (await kernel.project(table, [{ id: "front", look: "front" }]))!;
    const front = g.views[0];
    const leg = front.bodies.find((b) => b.name === "leg_a")!;
    const xs = leg.visible.flat().map((p) => p[0]);
    // leg_a runs up the left outside corner: x 0 to 40 in the front view.
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 40]);
    expect(inView([1200, 0, 900], viewFrame("front"))).toEqual([1200, 900]);
    const c = await kernel.check(table);
    expect(c.measurements!.members.find((m) => m.id === "leg_a")!.ends).toEqual([
      [0, 0, 0],
      [0, 0, 860],
    ]);
  });

  it("knows where each hole was drilled, and how many its patterns made", async () => {
    const g = (await kernel.project(example("stand"), [{ id: "top", look: "top" }]))!;
    expect(g.holes).toEqual([{ feature: "hole_1", entry: [40, 25, 8], axis: [0, 0, -1], diameter: 10, depth: expect.any(Number), through: true, copies: 1 }]);
    expect(holeText(g.holes[0])).toEqual(["2× Ø10 THRU"]);
    expect(holeText({ ...g.holes[0], copies: 0, through: false, depth: 12, counterbore: { diameter: 11, depth: 4 } })).toEqual(["Ø10 × 12 DEEP", "CBORE Ø11 × 4 DEEP"]);
  });
});

describe("Phase L acceptance: the table frame's drawing", () => {
  it("New drawing gives one A3 sheet, third-angle: front, top, right and an iso, dimensioned 1200, 600 and 900", async () => {
    const doc = await withDrawing(table);
    const { sheet, checks } = await sheetOf(doc);
    expect([sheet.size, sheet.projection, sheet.scaleText]).toEqual(["A3", "third", "1:10"]);
    expect(sheet.views.map((v) => [v.id, v.look])).toEqual([
      ["front", "front"],
      ["top", "top"],
      ["right", "right"],
      ["iso", "iso"],
    ]);
    // Third angle: the top view above the front, the right view to its right, lined up with it.
    const at = Object.fromEntries(sheet.views.map((v) => [v.id, v.centre]));
    expect(at.top[0]).toBeCloseTo(at.front[0], 9);
    expect(at.top[1]).toBeGreaterThan(at.front[1]);
    expect(at.right[1]).toBeCloseTo(at.front[1], 9);
    expect(at.right[0]).toBeGreaterThan(at.front[0]);
    const dims = sheet.annotations.filter((a) => a.type === "dimension").map((a) => [a.view, a.text]);
    expect(dims).toEqual([
      ["front", "1200"],
      ["front", "900"],
      ["right", "600"],
    ]);
    expect(sheet.problems).toEqual([]);
    expect(checks.map((c) => [c.label, c.ok, c.actual])).toEqual([
      ["Every view shows the part", true, "front, top, right, iso"],
      ["Every annotation is attached", true, "7 annotations"],
      ["Every cut list item has a balloon", true, "3 of 3"],
      ["The overall size is dimensioned", true, "length, width and height"],
      ["Nothing overlaps or runs off the sheet", true, "clear"],
    ]);
  });

  it("its balloons 1–3 sit on members of cut list items 1–3, and the cut list and title block are on it", async () => {
    const doc = await withDrawing(table);
    const { sheet } = await sheetOf(doc);
    const balloons = validateDocument(doc).drawing!.annotations.filter((a) => a.type === "balloon");
    const items = balloons.map((b) => said(sheet, b.id).item);
    expect(items).toEqual([1, 2, 3]);
    for (const b of balloons) {
      if (b.type !== "balloon") continue;
      const item = sheet.cutList.find((i) => i.item === said(sheet, b.id).item)!;
      expect(item.members).toContain(b.member);
    }
    const words = texts(sheet);
    // The cut list's rows.
    for (const row of [
      ["1", "SHS 40x40x3", "1200", "45° / 45°", "2", "8.09"],
      ["2", "SHS 40x40x3", "860", "square", "4", "11.99"],
      ["3", "SHS 40x40x3", "600", "45° / 45°", "2", "3.90"],
    ])
      for (const cell of row) expect(words).toContain(cell);
    // The title block: the name, the material, the mass and the scale.
    expect(words).toEqual(expect.arrayContaining(["table-frame", "steel (default)", "23.98 kg", "1:10", "A3", "2026-10-08", "THIRD ANGLE"]));
  });

  it("the checks fail when a balloon is deleted, and when a view is moved onto the title block", async () => {
    const doc = await withDrawing(table);
    const b2 = validateDocument(doc).drawing!.annotations.filter((a) => a.type === "balloon")[1];
    const { checks: noBalloon } = await sheetOf(run(doc, { type: "setAnnotation", id: b2.id, annotation: null }));
    expect(failed(noBalloon)).toEqual(["Every cut list item has a balloon"]);
    expect(noBalloon.find((c) => !c.ok)!.actual).toBe("no balloon for item 2 (leg_a, leg_b, leg_c, leg_d)");

    const { sheet, checks: moved } = await sheetOf(run(doc, { type: "setView", id: "top", view: { look: "top", at: [320, 30] } }));
    expect(failed(moved)).toEqual(["Nothing overlaps or runs off the sheet"]);
    expect(moved.find((c) => !c.ok)!.actual).toContain("view top overlaps the title block");
    expect(sheet.views.find((v) => v.id === "top")!.auto).toBe(false);
  });

  it("switching every member to SHS 50×50×3 updates the sheet: the leg reads 850, the balloons still match", async () => {
    let doc = await withDrawing(table);
    doc = run(doc, { type: "setAnnotation", id: "d9", annotation: { type: "dimension", view: "front", member: "leg_a" } });
    const before = await sheetOf(doc);
    expect(said(before.sheet, "d9").text).toBe("860");
    for (const f of doc.features) if (f.op === "member") doc = run(doc, { type: "updateFeature", id: String(f.id), patch: { size: "SHS 50x50x3" } });
    const after = await sheetOf(doc);
    expect(said(after.sheet, "d9").text).toBe("850");
    expect(after.sheet.annotations.filter((a) => a.type === "dimension").map((a) => a.text)).toEqual(["1200", "900", "600", "850"]);
    expect(after.sheet.cutList.map((i) => [i.item, i.designation, i.length])).toEqual([
      [1, "SHS 50x50x3", 1200],
      [2, "SHS 50x50x3", 850],
      [3, "SHS 50x50x3", 600],
    ]);
    const balloons = validateDocument(doc).drawing!.annotations.filter((a) => a.type === "balloon");
    for (const b of balloons) if (b.type === "balloon") expect(after.sheet.cutList.find((i) => i.item === said(after.sheet, b.id).item)!.members).toContain(b.member);
    expect(texts(after.sheet)).toContain("850");
    expect(failed(after.checks)).toEqual([]);
  });

  it("a deleted member's balloon is a problem on the sheet, not a refused edit", async () => {
    let doc = await withDrawing(table);
    doc = run(doc, { type: "setAnnotation", id: "b9", annotation: { type: "balloon", view: "front", member: "rail_back" } });
    const { sheet: s1 } = await sheetOf(doc);
    expect(said(s1, "b9").problem).toBe("rail_back can't be seen in front: balloon it in a view that shows it");
    doc = run(doc, { type: "setAnnotation", id: "b9", annotation: null }, { type: "setAnnotation", id: "d9", annotation: { type: "dimension", view: "top", member: "leg_a" } });
    const { sheet: s2, checks } = await sheetOf(doc);
    expect(said(s2, "d9").problem).toBe("leg_a doesn't lie flat in top (it runs straight at the viewer): dimension it in a view it lies flat in");
    expect(failed(checks)).toEqual(["Every annotation is attached"]);
  });

  it("the PDF opens in poppler, and its text has the title, the dimensions and the cut list", async () => {
    const doc = await withDrawing(table);
    const { sheet } = await sheetOf(doc);
    const dir = mkdtempSync(join(tmpdir(), "cocaide-pdf-"));
    const file = join(dir, "table-frame.pdf");
    writeFileSync(file, sheetPDF(sheet, { title: "table-frame" }));
    const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
    expect(info).toMatch(/Title:\s+table-frame/);
    expect(info).toMatch(/Page size:\s+1190\.55 x 841\.89 pts \(A3\)/);
    const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
    for (const word of ["table-frame", "1200", "900", "600", "CUT LIST", "23.98 kg", "1:10"]) expect(text).toContain(word);
    const rows = text.split("\n").map((l) => l.trim().split(/\s{2,}/));
    expect(rows).toEqual(
      expect.arrayContaining([
        ["1", "SHS 40x40x3", "1200", "45° / 45°", "2", "8.09"],
        ["2", "SHS 40x40x3", "860", "square", "4", "11.99"],
        ["3", "SHS 40x40x3", "600", "45° / 45°", "2", "3.90"],
      ]),
    );
  });

  it("the SVG is the sheet: every view and annotation a group with its id", async () => {
    const doc = await withDrawing(table);
    const { sheet } = await sheetOf(doc);
    const svg = sheetSVG(sheet);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="420mm" height="297mm" viewBox="0 0 420 297"/);
    for (const id of ["front", "top", "right", "iso", "d1", "d2", "d3", "cut_list", "titleBlock"]) expect(svg).toContain(`data-id="${id}"`);
    expect(svg).toContain(">1200</text>");
    expect(svg).toContain(">45° / 45°</text>");
  });
});

describe("a weldment's welds on the sheet", () => {
  const welded: RawDocument = {
    ...table,
    welds: [
      { id: "w1", between: ["leg_a", "rail_front"], type: "fillet", size: 3, length: 160, allRound: true },
      { id: "w2", between: ["leg_b", "rail_front"], type: "butt", size: 3, length: 40 },
    ],
  };

  it("draws a symbol per weld and the weld table, beside the title block, and checks every weld has one", async () => {
    const doc = await withDrawing(welded);
    const { sheet, checks } = await sheetOf(doc);
    expect(sheet.annotations.filter((a) => a.type === "weld").map((a) => [a.view, a.text])).toEqual([
      ["front", "w1: fillet 3, 160 long, all round"],
      ["front", "w2: butt 3, 40 long"],
    ]);
    expect(sheet.scaleText).toBe("1:10");
    const weldTable = sheet.blocks.find((b) => b.id === "weld_table")!.box;
    // Along the bottom border, left of the title block; the cut list stays above it.
    expect(weldTable.max[0]).toBeCloseTo(sheet.titleBlock.min[0], 9);
    expect(weldTable.min[1]).toBeCloseTo(sheet.frame.min[1], 9);
    expect(texts(sheet)).toEqual(expect.arrayContaining(["WELDS", "w1", "leg_a + rail_front", "fillet", "all round", "w2", "butt"]));
    expect(failed(checks)).toEqual([]);
    expect(checks.find((c) => c.label === "Every weld has a symbol")!.actual).toBe("2 of 2");
    const w2 = validateDocument(doc).drawing!.annotations.find((a) => a.type === "weld" && a.weld === "w2")!;
    const { checks: without } = await sheetOf(run(doc, { type: "setAnnotation", id: w2.id, annotation: null }));
    expect(without.filter((c) => !c.ok).map((c) => [c.label, c.actual])).toEqual([["Every weld has a symbol", "no symbol for w2"]]);
  });
});

describe("a plate's drawing", () => {
  it("calls out the hole where it shows as a circle, places it, and shows it hidden in the front", async () => {
    const doc = await withDrawing(bracket);
    const { sheet, checks } = await sheetOf(doc);
    expect(sheet.annotations.map((a) => [a.id, a.view, a.text])).toEqual([
      ["d1", "front", "80"],
      ["d2", "front", "6"],
      ["d3", "right", "40"],
      ["h4", "top", "Ø6.6 THRU"],
      ["d5", "top", "70"],
      ["d6", "top", "20"],
    ]);
    expect(sheet.scaleText).toBe("2:1");
    expect(failed(checks)).toEqual([]);
    expect(sheet.prims.some((p) => p.owner === "front" && p.k === "line" && p.dash)).toBe(true);
  });

  it("fails the hole check when the callout goes, and the size check when a dimension does", async () => {
    let doc = await withDrawing(bracket);
    doc = run(doc, { type: "setAnnotation", id: "h4", annotation: null }, { type: "setAnnotation", id: "d3", annotation: null });
    const { checks } = await sheetOf(doc);
    expect(checks.filter((c) => !c.ok).map((c) => [c.label, c.actual])).toEqual([
      ["The overall size is dimensioned", "no dimension of 40 (y)"],
      ["Every hole is called out", "no callout for hole_1"],
    ]);
  });
});

describe("the sheet's text and the PDF's strings", () => {
  it("measures Helvetica, and writes WinAnsi", () => {
    expect(textWidth("1200", 10)).toBeCloseTo(22.24, 6);
    expect(textWidth("Ø6.6", 10)).toBeCloseTo(7.78 + 5.56 + 2.78 + 5.56, 6);
    expect(pdfString("Ø6.6 (THRU) 45° × 2 – a\\b")).toBe("\\3306.6 \\(THRU\\) 45\\260 \\327 2 \\226 a\\\\b");
  });
});
