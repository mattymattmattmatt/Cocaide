// Phase Q wave Q1A: the drawing core. Drawings of sheets (a Phase L drawing
// read as one), the view kinds and their frames, edge keys that survive an
// unrelated rebuild and the GeoRefs that name them, sections and their
// hatching, details, breaks, the templates and their property links, the
// sheet tables wired in, and the exports (DXF layers, a multi-page PDF with
// its font embedded). The browser half is e2e/drawing-core.spec.ts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { migrateDrawing, nextViewLabel, parseGeoRef } from "../src/doc/drawing";
import { createHistory, record, undo } from "../src/doc/history";
import { allErrors, validateDocument } from "../src/doc/validate";
import { composeDrawing, type ComposedDrawing } from "../src/drafting/compose";
import { sheetDXF } from "../src/drafting/dxf";
import { listGeoRefs, resolveGeoRef } from "../src/drafting/georef";
import { hatchLines, materialPattern } from "../src/drafting/hatch";
import { drawingPDF, readTrueType } from "../src/drafting/pdf";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { resolveProps } from "../src/drafting/props";
import { viewSpecs } from "../src/drafting/specs";
import { sheetSVG } from "../src/drafting/svg";
import { auxiliaryFrame, projectedFrame, sectionFrame, viewFrame } from "../src/drafting/views";
import { clipOutside, clipToCircle, loopsArea } from "../src/drafting/clip";
import { readDxf } from "../src/io/dxf";
import { edgeKeys } from "../src/kernel/drawingViews";
import { getOC, loadOC } from "../src/kernel";

const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket");
const table = example("table-frame");

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

const sheet = (views: unknown[], annotations: unknown[] = [], extra: Record<string, unknown> = {}) => ({ sheets: [{ id: "s1", format: { size: "A3" }, projection: "third", views, annotations, ...extra }] });

async function compose(doc: RawDocument): Promise<ComposedDrawing> {
  const v = validateDocument(doc);
  if (!v.drawing) throw new Error(v.drawingErrors.join("; "));
  const c = await kernel.check(doc);
  const geometry = await kernel.project(doc, viewSpecs(v.drawing));
  return composeDrawing(doc, { measurements: c.measurements, geometry })!;
}

async function planned(doc: RawDocument): Promise<RawDocument> {
  const c = await kernel.check(doc);
  return run(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS), { date: "2026-11-04" }) });
}

describe("the drawing as sheets", () => {
  const legacy = {
    sheet: { size: "A3", projection: "third", scale: "1:10", title: "Bench" },
    views: [
      { id: "front", look: "front", hidden: true },
      { id: "iso", look: "iso" },
    ],
    annotations: [{ id: "d1", type: "dimension", view: "front", from: "@left", to: "@right" }],
  };

  it("reads a Phase L drawing as one sheet in the classic template, hidden edges as display hidden", () => {
    expect(migrateDrawing(legacy)).toEqual({
      sheets: [
        {
          id: "sheet1",
          format: { template: "classic", size: "A3", title: "Bench" },
          scale: "1:10",
          projection: "third",
          views: [{ id: "front", look: "front", display: "hidden" }, { id: "iso", look: "iso" }],
          annotations: [{ id: "d1", type: "dimension", view: "front", from: "@left", to: "@right" }],
        },
      ],
    });
    expect(allErrors(validateDocument({ ...table, drawing: legacy }))).toEqual([]);
    // Untouched until the drawing is edited; then it is written as sheets.
    const doc = run({ ...table, drawing: legacy }, { type: "setSheet", patch: { title: "Bench frame" } });
    expect((doc.drawing as { sheets: { format: unknown }[] }).sheets[0].format).toEqual({ template: "classic", size: "A3", title: "Bench frame" });
  });

  it("checks each kind of view strictly, with messages that say what to do", () => {
    const bad = sheet([
      { id: "front", look: "front" },
      { id: "s", kind: "section", parent: "front" },
      { id: "o", kind: "section", parent: "front", line: [[0, 0], [10, 0], [20, 5]] },
      { id: "a", kind: "section", parent: "front", line: [[0, 0], [10, 0]], aligned: true },
      { id: "d", kind: "detail", parent: "front", circle: { at: [0, 0], r: 5 }, profile: [[0, 0], [1, 0], [1, 1]] },
      { id: "p", kind: "projected", parent: "q", direction: "up" },
      { id: "q", kind: "projected", parent: "p", direction: "up" },
      { id: "m", look: "front", line: [[0, 0], [1, 0]] },
      { id: "x", kind: "auxiliary", parent: "front", edge: "iso:eext_1/l0" },
      { id: "l1", kind: "detail", parent: "front", circle: { at: [0, 0], r: 5 }, label: "B" },
      { id: "l2", kind: "detail", parent: "front", circle: { at: [0, 0], r: 5 }, label: "B" },
    ]);
    expect(validateDocument({ ...bracket, drawing: bad }).drawingErrors).toEqual([
      "document: drawing.sheets[0].views[1].line: must be the cutting line on the parent: 2 or more [x, y] points, view mm (got nothing)",
      "document: drawing.sheets[0].views[2].line[2]: an offset section's line turns at right angles only; for a line through an angle, make it aligned (aligned: true, three points)",
      "document: drawing.sheets[0].views[3].line: an aligned section's line has three points: one end, the centre it turns about, the other end (got 2)",
      "document: drawing.sheets[0].views[4]: a detail view has a circle { at, r } or a closed profile on its parent, one of them",
      "document: drawing.sheets[0].views[5].parent: makes a loop of parents (p → q → p)",
      "document: drawing.sheets[0].views[6].parent: makes a loop of parents (q → p → q)",
      'document: drawing.sheets[0].views[7]: "line" is not for a model view: a model view looks at the part from a named orientation (look) or a custom one (orientation)',
      "document: drawing.sheets[0].views[8].edge: is in view iso; the edge must be one of the parent's (front)",
      'document: drawing.sheets[0].views[10].label: "B" is l1\'s label too: each section, detail and auxiliary view has its own',
    ]);
  });

  it("keeps an annotation on its view's sheet, and refuses a dimension in a view at an angle", () => {
    const two = {
      sheets: [
        { id: "s1", format: { size: "A3" }, projection: "third", views: [{ id: "front", look: "front" }], annotations: [] },
        { id: "s2", format: { size: "A4" }, projection: "third", views: [{ id: "tri", look: "trimetric" }], annotations: [{ id: "d1", type: "dimension", view: "front", from: "@left", to: "@right" }, { id: "d2", type: "dimension", view: "tri", from: "@left", to: "@right" }] },
      ],
    };
    expect(validateDocument({ ...bracket, drawing: two }).drawingErrors).toEqual([
      "document: drawing.sheets[1].annotations[0].view: front is on another sheet: an annotation goes on its view's sheet",
      "document: drawing.sheets[1].annotations[1].view: tri is a view at an angle to the part, which shortens every length: dimension in a view that looks square at the part",
    ]);
  });

  it("adds, renames, moves and deletes sheets and views, each one undo step, within the scope", () => {
    let doc = run(bracket, { type: "setDrawing", drawing: sheet([{ id: "front", look: "front" }]) });
    let h = createHistory(JSON.stringify(doc));
    doc = run(doc, { type: "addSheet", id: "s2" }, { type: "renameSheet", id: "s2", name: "Details" });
    h = record(h, JSON.stringify(doc));
    // A section gets the next free label (I, O and Q are skipped), and a new sheet the format of the one before it.
    doc = run(doc, { type: "setView", id: "a", view: { kind: "section", parent: "front", line: [[0, 10], [0, -4]] }, sheet: "s1" });
    const d = validateDocument(doc).drawing!;
    expect(d.sheets.map((s) => [s.id, s.name, s.format.size])).toEqual([
      ["s1", undefined, "A3"],
      ["s2", "Details", "A3"],
    ]);
    expect(d.sheets[0].views.find((v) => v.id === "a")!.label).toBe("A");
    expect(nextViewLabel({ sheets: [{ views: "ABCDEFGH".split("").map((label) => ({ label })) }] })).toBe("J");
    // A view moves to another sheet with its annotations.
    doc = run(doc, { type: "setAnnotation", id: "d1", annotation: { type: "dimension", view: "a", from: "@left", to: "@right" } }, { type: "moveView", id: "a", sheet: "s2" });
    const moved = validateDocument(doc).drawing!;
    expect(moved.sheets[1].views.map((v) => v.id)).toEqual(["a"]);
    expect(moved.sheets[1].annotations.map((a) => a.id)).toEqual(["d1"]);
    doc = run(doc, { type: "moveSheet", id: "s2", index: 0 });
    expect(validateDocument(doc).drawing!.sheets.map((s) => s.id)).toEqual(["s2", "s1"]);
    // Deleting a parent takes the views made from it, on any sheet.
    doc = run(doc, { type: "setView", id: "front", view: null });
    expect(validateDocument(doc).drawing!.sheets.map((s) => s.views.length)).toEqual([0, 0]);
    expect(apply(doc, { type: "deleteSheet", id: "s1" }).ok).toBe(true);
    expect(apply(run(doc, { type: "deleteSheet", id: "s1" }), { type: "deleteSheet", id: "s2" })).toEqual({ ok: false, error: "deleteSheet: a drawing has at least one sheet; delete the drawing instead (setDrawing null)" });
    // Scope: a view's ask can't add a sheet; the drawing's can.
    expect(apply(doc, { type: "addSheet" }, { writeScope: ["view:front"] }).ok).toBe(false);
    expect(apply(doc, { type: "setDrawingOptions", patch: { standard: "ASME" } }, { writeScope: ["drawing"] }).ok).toBe(true);
    // Undo puts the sheets back as they were.
    const back = JSON.parse(undo(h).present) as RawDocument;
    expect(validateDocument(back).drawing!.sheets.map((s) => s.id)).toEqual(["s1"]);
  });

  it("sets tables on a sheet through the table engine's checks", () => {
    const doc = run(bracket, { type: "setDrawing", drawing: sheet([{ id: "top", look: "top" }]) }, { type: "setTable", id: "t1", table: { kind: "holes", view: "top" } });
    expect(validateDocument(doc).drawing!.sheets[0].tables!.map((t) => [t.id, t.kind])).toEqual([["t1", "holes"]]);
    expect(apply(doc, { type: "setTable", id: "t2", table: { kind: "holes", view: "nowhere" } })).toMatchObject({ ok: false, error: expect.stringContaining("nowhere") });
    expect(apply(doc, { type: "setTable", id: "top", table: { kind: "bom" } })).toEqual({ ok: false, error: 'setTable: "top" is a view\'s or an annotation\'s id' });
    expect(validateDocument(run(doc, { type: "setTable", id: "t1", table: null })).drawing!.sheets[0].tables).toBeUndefined();
  });
});

describe("view frames", () => {
  const eq = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 12));
  it("projects from a parent a quarter turn: third angle looks from the side it is drawn on, first from the other", () => {
    const front = viewFrame("front");
    const top = projectedFrame(front, "up", "third");
    eq(top.eye, viewFrame("top").eye);
    eq(top.right, viewFrame("top").right);
    eq(top.up, viewFrame("top").up);
    eq(projectedFrame(front, "right", "third").eye, viewFrame("right").eye);
    // First angle: the view below the front looks from above.
    eq(projectedFrame(front, "down", "first").eye, viewFrame("top").eye);
    // A corner is the iso from that corner: (1, −1, 1)/√3.
    eq(projectedFrame(front, "upRight", "third").eye, viewFrame("iso").eye);
  });

  it("a section looks from the side cut away (left of its line), an auxiliary square to its edge", () => {
    // A line drawn right to left on the top view: the viewer at the front.
    eq(sectionFrame(viewFrame("top"), [[50, 0], [-50, 0]]).eye, [0, -1, 0]);
    eq(sectionFrame(viewFrame("top"), [[50, 0], [-50, 0]], true).eye, [0, 1, 0]);
    // An edge at 45° on the front view: the view looks along its normal, (−1, 0, 1)/√2.
    eq(auxiliaryFrame(viewFrame("front"), [0, 0], [10, 10]).eye, [-Math.SQRT1_2, 0, Math.SQRT1_2]);
  });
});

describe("edge keys and GeoRefs", () => {
  it("numbers a feature's edges of a kind by radius then position", () => {
    const keys = edgeKeys([
      { kind: "line", createdBy: "ext", centroid: [5, 0, 0] },
      { kind: "circle", createdBy: "hole", radius: 3, centroid: [0, 0, 6] },
      { kind: "line", createdBy: "ext", centroid: [-5, 0, 0] },
      { kind: "circle", createdBy: "hole", radius: 3, centroid: [0, 0, 0] },
      { kind: "other", centroid: [0, 0, 0] },
    ]);
    expect(keys).toEqual(["ext/l1", "hole/c1", "ext/l0", "hole/c0", "?/o0"]);
    expect(parseGeoRef("top:ehole_1/c0")).toEqual({ view: "top", form: "e", key: "hole_1/c0" });
    expect(parseGeoRef("top:vext_1/l3.1")).toEqual({ view: "top", form: "v", key: "ext_1/l3", end: 1 });
    expect(parseGeoRef("top:qhole_1/c0.2")).toEqual({ view: "top", form: "q", key: "hole_1/c0", quadrant: 2 });
    expect(parseGeoRef("front:leg_a.start")).toEqual({ view: "front", form: "point", point: { kind: "end", member: "leg_a", end: "start" } });
    expect(parseGeoRef("front:")).toBeNull();
    expect(parseGeoRef("front:@middle")).toBeNull();
  });

  it("resolves the hole's circle, its centre and quadrant in the top view: Ø6.6 at (30, 0), 2:1", async () => {
    const doc = run(bracket, { type: "setDrawing", drawing: sheet([{ id: "top", look: "top" }], [], { scale: "2:1" }) });
    const d = await compose(doc);
    const refs = listGeoRefs(d, "top");
    // The hole's top edge (its bottom one, behind it, is hidden).
    const circle = refs.find((r) => r.what === "circle" && r.feature === "hole_1" && r.visible)!;
    expect(circle).toMatchObject({ kind: "circle", visible: true });
    expect(circle.radius).toBeCloseTo(3.3, 9);
    const r = resolveGeoRef(d, circle.ref)!;
    expect(r.kind).toBe("circle");
    if (r.kind !== "circle") return;
    expect(r.inView.c).toEqual([30, 0]);
    expect(r.r).toBeCloseTo(6.6, 9); // 3.3 at 2:1
    const c = resolveGeoRef(d, circle.ref.replace(":e", ":c"))!;
    expect(c.kind === "point" && c.model).toEqual([30, 0, 6]);
    const q = resolveGeoRef(d, circle.ref.replace(":e", ":q") + ".1")!;
    if (q.kind !== "point") throw new Error("not a point");
    expect(q.inView[0]).toBeCloseTo(30, 9);
    expect(q.inView[1]).toBeCloseTo(3.3, 9);
    // Every visible corner of the plate is an end of an edge: four in the top view.
    const ends = refs.filter((x) => x.what === "vertex" && x.feature === "ext_1" && x.visible);
    expect(ends.length).toBe(4);
    // A dimension may run between GeoRefs: the hole's centre from the plate's left edge reads 70.
    const dimmed = run(doc, { type: "setAnnotation", id: "d1", annotation: { type: "dimension", view: "top", from: "@left", to: circle.ref.replace(":e", ":c"), direction: "horizontal" } });
    const said = (await compose(dimmed)).sheets[0].annotations.find((a) => a.id === "d1")!;
    expect([said.problem, said.text]).toEqual([undefined, "70"]);
  });

  it("keeps the hole's keys after an unrelated edit upstream (a fillet on a far corner), and they resolve where the hole is", async () => {
    const doc = run(bracket, { type: "setDrawing", drawing: sheet([{ id: "top", look: "top" }]) });
    const before = listGeoRefs(await compose(doc), "top").filter((r) => r.feature === "hole_1");
    const fillet = { id: "round", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], near: [-40, -20, 3], pick: "all" }, radius: 5 };
    const edited = run(doc, { type: "addFeature", feature: fillet, index: 2 });
    expect((await kernel.check(edited)).ok).toBe(true);
    const after = listGeoRefs(await compose(edited), "top");
    expect(after.filter((r) => r.feature === "hole_1").map((r) => [r.ref, r.at])).toEqual(before.map((r) => [r.ref, r.at]));
    // The fillet's own edges are new keys of its own.
    expect(after.some((r) => r.feature === "round")).toBe(true);
  });
});

describe("sections, details and breaks", () => {
  it("cuts the bracket through its hole: the cut face is (80 − 6.6) × 6 = 440.4 mm², hatched as steel", async () => {
    const doc = await planned(bracket);
    const d = await compose(doc);
    const front = d.sheets[0].views.find((v) => v.id === "front")!;
    expect([front.kind, front.label, front.look]).toEqual(["section", "A", "front"]);
    const g = await kernel.project(doc, viewSpecs(validateDocument(doc).drawing!));
    const pv = g!.views.find((v) => v.id === "front")!;
    const area = pv.sections!.reduce((t, r) => t + r.area, 0);
    expect(area).toBeCloseTo(440.4, 6);
    // The loops say the same (even-odd: two pieces either side of the hole).
    expect(pv.sections!.reduce((t, r) => t + loopsArea(r.loops), 0)).toBeCloseTo(440.4, 3);
    expect(materialPattern(undefined)).toBe("steel");
    expect(d.sheets[0].prims.filter((p) => p.owner === "front" && p.layer === "HATCH").length).toBeGreaterThan(10);
    // The cutting line on the top view, with its letter at both ends.
    const marks = d.sheets[0].prims.filter((p) => p.layer === "SECTION" && p.k === "text").map((p) => (p.k === "text" ? p.text : ""));
    expect(marks).toEqual(["A", "A"]);
    expect(d.sheets[0].prims.some((p) => p.k === "text" && p.text === "A–A")).toBe(true);
  });

  it("cuts a tube across: SHS 40×40×3 is 40² − 34² = 444 mm² of steel", async () => {
    const members = example("frame-members");
    const doc = run(members, { type: "setDrawing", drawing: sheet([{ id: "front", look: "front" }]) });
    const first = await compose(doc);
    const o = first.sheets[0].views[0].outline!;
    const leg = run(doc, { type: "setView", id: "cut", view: { kind: "section", parent: "front", line: [[o.min[0] - 10, o.min[1] + 100], [o.max[0] + 10, o.min[1] + 100]] } });
    const g = await kernel.project(leg, viewSpecs(validateDocument(leg).drawing!));
    const regions = g!.views.find((v) => v.id === "cut")!.sections!;
    expect(regions.map((r) => r.body)).toEqual(["leg"]);
    expect(regions[0].area).toBeCloseTo(444, 6);
  });

  it("hatches each member of a weldment its own way, and a thin wall solid", () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const lines = hatchLines([square], "general", 45, 1);
    // Lines 1 apart across a 45° diamond of half-diagonal 7.07: 15 of them, 2(15 × 7.071 − 2(1 + … + 7)) = 100.13 long in all.
    expect(lines.length).toBe(15);
    expect(lines.reduce((t, l) => t + Math.hypot(l.pts[1][0] - l.pts[0][0], l.pts[1][1] - l.pts[0][1]), 0)).toBeCloseTo(100.13, 1);
    // A hole in the face is left clear: a 4 × 4 square inside takes 16 of the 100.
    const hole: [number, number][] = [[3, 3], [7, 3], [7, 7], [3, 7]];
    const total = hatchLines([square, hole], "general", 0, 0.5).reduce((t, l) => t + Math.abs(l.pts[1][0] - l.pts[0][0]), 0);
    expect(total).toBeCloseTo(0.5 * 0 + (100 - 16) / 0.5, 0);
    expect(materialPattern({ name: "6082-T6 aluminium", densityKgPerM3: 2700 })).toBe("aluminium");
    expect(materialPattern({ densityKgPerM3: 8500 })).toBe("copper");
  });

  it("draws a detail at the next standard scale up from twice its parent's: 2:1 → 5:1, labelled B (5 : 1)", async () => {
    const doc = run(bracket, { type: "setDrawing", drawing: sheet([{ id: "front", look: "front" }, { id: "det", kind: "detail", parent: "front", circle: { at: [30, 3], r: 6 }, label: "B" }], [], { scale: "2:1" }) });
    const d = await compose(doc);
    const det = d.sheets[0].views.find((v) => v.id === "det")!;
    expect(det.scaleText).toBe("5:1");
    expect(det.box!.max[0] - det.box!.min[0]).toBeCloseTo(60, 9); // its circle, Ø12 at 5:1
    const texts = d.sheets[0].prims.flatMap((p) => (p.k === "text" ? [p.text] : []));
    expect(texts).toEqual(expect.arrayContaining(["B (5 : 1)", "B"]));
    expect(clipToCircle([[0, 0], [10, 0]], [5, 0], 2)).toEqual([[[3, 0], [7, 0]]]);
  });

  it("shortens a broken view by what it leaves out, and its dimension still reads true: 1200 drawn 46 mm long at 1:10", async () => {
    const doc = run(
      table,
      { type: "setDrawing", drawing: sheet([{ id: "front", look: "front", breaks: [{ axis: "x", from: 200, to: 1000 }] }], [{ id: "d1", type: "dimension", view: "front", from: "@left", to: "@right" }], { scale: "1:10" }) },
    );
    const d = await compose(doc);
    const front = d.sheets[0].views[0];
    // (1200 − 800 + 6 mm of paper at 1:10, 60) × 0.1 = 46.
    expect(front.box!.max[0] - front.box!.min[0]).toBeCloseTo(46, 9);
    expect(d.sheets[0].annotations[0].text).toBe("1200");
    expect(d.sheets[0].prims.filter((p) => p.layer === "BREAK").length).toBe(2);
    expect(clipOutside([[0, 0], [10, 0]], 0, [[2, 5]])).toEqual([[[0, 0], [2, 0]], [[5, 0], [10, 0]]]);
  });
});

describe("templates, properties and tables on the sheet", () => {
  it("links title-block fields to the drawing's and the part's properties", async () => {
    expect(resolveProps('$PRP:"company" / $PRP:"partNumber" / $PRPMODEL:"mass" / $PRP:"none"', { drawing: { company: "Acme Works" }, part: { partNumber: "BR-1" }, model: { mass: "0.15 kg" }, sheet: {} })).toBe("Acme Works / BR-1 / 0.15 kg / ");
    const doc = run(
      { ...bracket, properties: { partNumber: "BR-1001", description: "Mounting bracket" } },
      { type: "setDrawing", drawing: { ...sheet([{ id: "front", look: "front" }]), properties: { company: "Acme Works" }, generalTolerance: "ISO 2768-mK" } },
      { type: "setSheet", patch: { subtitle: 'for $PRP:"company"', checkedBy: "QA" } },
    );
    const texts = (await compose(doc)).sheets[0].prims.flatMap((p) => (p.k === "text" && p.owner === "titleBlock" ? [p.text] : []));
    expect(texts).toEqual(expect.arrayContaining(["Mounting bracket", "for Acme Works", "BR-1001", "Acme Works", "ISO 2768-mK", "QA", "0.15 kg", "1 / 1"]));
  });

  it("draws the ANSI border lettered from the bottom and numbered from the right, the revision block in the top right", async () => {
    const doc = run(bracket, { type: "setDrawing", drawing: { ...sheet([{ id: "front", look: "front" }]), standard: "ASME", revisions: [{ rev: "A", description: "First issue" }] } }, { type: "setSheet", patch: { size: "ANSI B" } });
    const s = (await compose(doc)).sheets[0];
    expect([s.template, s.width, s.height]).toEqual(["ansi", 431.8, 279.4]);
    const zone = (t: string) => s.prims.filter((p) => p.k === "text" && p.owner === "sheet" && p.text === t).map((p) => (p.k === "text" ? p.at : [0, 0]));
    // Column 1 is at the right, row A at the bottom.
    expect(zone("1")[0][0]).toBeGreaterThan(zone("4")[0][0]);
    expect(zone("A")[0][1]).toBeLessThan(zone("B")[0][1]);
    expect(s.revisionBlock!.max).toEqual(s.frame.max);
    expect(s.prims.some((p) => p.k === "text" && p.text === "First issue")).toBe(true);
  });

  it("keeps the views clear of a sheet's tables, and draws a hole table with its tags", async () => {
    const plate = example("mounting-plate");
    const doc = run(plate, { type: "setDrawing", drawing: sheet([{ id: "top", look: "top" }], [], { tables: [{ id: "holes", kind: "holes", view: "top" }] }) });
    const s = (await compose(doc)).sheets[0];
    const t = s.blocks.find((b) => b.id === "holes")!;
    const top = s.views[0];
    expect(t.box.max[1] - t.box.min[1]).toBeGreaterThan(20);
    expect(top.box!.max[0] < t.box.min[0] || top.box!.min[0] > t.box.max[0] || top.box!.max[1] < t.box.min[1] || top.box!.min[1] > t.box.max[1]).toBe(true);
    const tags = s.prims.flatMap((p) => (p.k === "text" && p.owner === "holes" ? [p.text] : []));
    expect(tags).toEqual(expect.arrayContaining(["HOLE TABLE", "A1", "A2", "B1", "B2", "C1"]));
    expect(s.problems).toEqual([]);
  });
});

describe("exports", () => {
  it("writes DXF with a layer per kind of line, R2000 and R12", async () => {
    const d = await compose(await planned(bracket));
    const dxf = sheetDXF(d.sheets[0]);
    const read = readDxf(dxf);
    const layers = new Set(read.entities.map((e) => e.layer));
    for (const l of ["VISIBLE", "HIDDEN", "CENTER", "HATCH", "SECTION", "DIMENSION", "BORDER", "TITLE"]) expect(layers.has(l)).toBe(true);
    // Text (which the reader skips) on its own layer too.
    expect(dxf).toMatch(/\r?\nTEXT\r?\n[\s\S]*\r?\n  8\r?\nTEXT\r?\n/);
    expect(dxf).toContain("AC1015");
    expect(dxf).toMatch(/LTYPE[\s\S]*CENTER/);
    expect(sheetDXF(d.sheets[0], { version: "R12" })).toContain("AC1009");
  });

  it("writes every sheet a page, the font embedded, in a PDF poppler reads", async () => {
    const doc = run(await planned(bracket), { type: "addSheet", id: "s2", sheet: { format: { size: "A4", template: "minimal" } } }, { type: "setView", id: "iso2", view: { look: "iso", display: "shadedEdges" }, sheet: "s2" });
    const d = await compose(doc);
    const font = (f: string) => {
      const data = new Uint8Array(readFileSync(new URL(`../public/fonts/${f}`, import.meta.url)));
      return { data, deflated: new Uint8Array(deflateSync(data)) };
    };
    const regular = font("LiberationSans-Regular.ttf");
    // Its widths are Helvetica's, as the sheet measures text: "0" is 556/1000 of the size.
    const tt = readTrueType(regular.data);
    expect(Math.round((tt.advance(tt.glyph(48)!) * 1000) / tt.unitsPerEm)).toBe(556);
    const pdf = drawingPDF(d.sheets, { title: "bracket", fonts: { regular, bold: font("LiberationSans-Bold.ttf") } });
    const dir = mkdtempSync(join(tmpdir(), "cocaide-q1a-"));
    const file = join(dir, "bracket.pdf");
    writeFileSync(file, pdf);
    const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
    expect(info).toMatch(/Pages:\s+2/);
    expect(info).toMatch(/Page size:\s+1190\.55 x 841\.89 pts \(A3\)/);
    const fonts = execFileSync("pdffonts", [file], { encoding: "utf8" });
    expect(fonts).toMatch(/LiberationSans\s+TrueType\s+WinAnsi\s+yes/);
    const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
    for (const w of ["A–A", "80", "Ø6.6 THRU", "bracket"]) expect(text).toContain(w);
    expect(text).toMatch(/1\s*\/\s*2/);
    // The SVG of the shaded sheet fills its faces.
    expect(sheetSVG(d.sheets[1])).toContain('fill-rule="evenodd"');
  });

  it("keeps a view's projection for the next ask: the same spec of the same rebuild is not projected again", async () => {
    const doc = await planned(bracket);
    const specs = viewSpecs(validateDocument(doc).drawing!);
    const a = await kernel.project(doc, specs);
    const b = await kernel.project(run(doc, { type: "setSheet", patch: { title: "renamed" } }), specs);
    expect(b!.views[0].edges).toBe(a!.views[0].edges);
  });
});
