// Phase Q wave Q3A: the annotation tools' pure parts on real sheets (the
// kernel is real). Smart Dimension's inference from picks (Ø, R, lengths,
// parallel edges, a point and an edge, the angle of the quadrant the text is
// dragged into: 45° or 135° at the flange's chamfer), chain sets, linear ↔
// baseline, the fit editor's ISO 286 values, the format painter and
// favourites, Model Items (no duplicates), Auto Balloon layouts, remembered
// places, sheet sketches, the dimension's override and text below, hidden
// annotations.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import type { Annotation, DimensionAnnotation, Drawing } from "../src/doc/types";
import { validateDocument } from "../src/doc/validate";
import { composeDrawing, type ComposedSheet } from "../src/drafting/compose";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { viewSpecs } from "../src/drafting/specs";
import { getOC, loadOC } from "../src/kernel";
import type { Measurements } from "../src/kernel/measure";
import { snapIndex, type SnapTarget } from "../src/ui/drawing/snap";
import { autoBalloons } from "../src/ui/drawing/tools/balloons";
import { rememberCommands } from "../src/ui/drawing/tools/editing";
import { convertDimension, inferDimension, radialSwap, setFromPicks, type DimPick } from "../src/ui/drawing/tools/inference";
import { modelItems } from "../src/ui/drawing/tools/modelItems";
import { previewAnnotation } from "../src/ui/drawing/tools/preview";
import { sketchItems } from "../src/ui/drawing/tools/sketchTools";
import { applyFavourite, classChoices, favouriteFrom, fitSummary, paintPatch, styleOf } from "../src/ui/drawing/tools/styles";

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));

function run(doc: RawDocument, ...cmds: Command[]): RawDocument {
  for (const cmd of cmds) {
    const r = apply(doc, cmd);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  }
  return doc;
}

interface Drawn {
  doc: RawDocument;
  drawing: Drawing;
  sheet: ComposedSheet;
  m: Measurements | null;
  targets: SnapTarget[];
}

async function compose(doc: RawDocument): Promise<Drawn> {
  const v = validateDocument(doc);
  if (!v.drawing) throw new Error(v.drawingErrors.join("; "));
  const c = await kernel.check(doc);
  const sheet = composeDrawing(doc, { measurements: c.measurements, geometry: await kernel.project(doc, viewSpecs(v.drawing)) })!.sheets[0];
  return { doc, drawing: v.drawing, sheet, m: c.measurements, targets: snapIndex(sheet).targets };
}

/** The example with New drawing's sheet, its annotations kept or taken away. */
async function planned(name: string, keepAnnotations = true): Promise<Drawn> {
  const doc = example(name);
  const c = await kernel.check(doc);
  const d = planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS), { date: "2026-11-05" });
  if (!keepAnnotations) for (const s of d.sheets) s.annotations = [];
  return compose(run(doc, { type: "setDrawing", drawing: d } as Command));
}

const pick = (d: Drawn, ref: string): DimPick => {
  const t = d.targets.find((x) => x.ref === ref);
  if (!t) throw new Error(`no target ${ref}`);
  return { ref: t.ref, kind: t.kind, view: t.view, at: t.at };
};
const said = (s: ComposedSheet, id: string) => s.annotations.find((a) => a.id === id)!;

describe("Smart Dimension's inference from picks (the bracket)", () => {
  let d: Drawn;
  beforeAll(async () => {
    d = await planned("bracket", false);
  });

  it("a circle is its diameter, or its radius with the R toggle; an edge its length", () => {
    const hole = pick(d, "top:ehole_1/c1");
    expect(inferDimension(d.sheet, [hole], [250, 250])).toMatchObject({ type: "dimension", view: "top", kind: "diameter", refs: ["top:ehole_1/c1"] });
    expect(inferDimension(d.sheet, [hole], [250, 250], { radial: "radius" })).toMatchObject({ kind: "radius" });
    // The plate's bottom edge (41,179)–(201,179): its length, 80 at 1:2.
    expect(inferDimension(d.sheet, [pick(d, "top:eext_1/l5")], [120, 170])).toMatchObject({ refs: ["top:eext_1/l5"] });
  });

  it("two parallel edges are their distance; a circle and an edge, from its centre; a point alone asks for another", () => {
    const r = inferDimension(d.sheet, [pick(d, "top:eext_1/l5"), pick(d, "top:eext_1/l7")], [30, 220]) as DimensionAnnotation;
    expect(r.refs).toEqual(["top:eext_1/l5", "top:eext_1/l7"]);
    expect(r.kind).toBeUndefined();
    const c = inferDimension(d.sheet, [pick(d, "top:ehole_1/c1"), pick(d, "top:eext_1/l10")], [190, 270]) as DimensionAnnotation;
    expect(c.refs).toEqual(["top:chole_1/c1", "top:eext_1/l10"]);
    const corner = d.targets.find((t) => t.view === "top" && t.kind === "vertex")!;
    expect(inferDimension(d.sheet, [{ ref: corner.ref, kind: "vertex", view: "top", at: corner.at }], [0, 0])).toMatch(/second point/);
    expect(inferDimension(d.sheet, [pick(d, "top:eext_1/l5"), pick(d, "front:ecut/l1")], [0, 0])).toMatch(/one view/);
  });

  it("measures what it infers: the plate 40 between its long edges, the hole Ø6.6, drawn by the engine in the preview", () => {
    const r = inferDimension(d.sheet, [pick(d, "top:eext_1/l5"), pick(d, "top:eext_1/l7")], [30, 220]) as DimensionAnnotation;
    const l = previewAnnotation(d.sheet, { ...r, id: "p" } as Annotation)!;
    expect(l.value).toBeCloseTo(40, 6);
    expect(l.text).toBe("40");
    expect(l.prims.some((p) => p.k === "line" && p.fill)).toBe(true);
    const hole = inferDimension(d.sheet, [pick(d, "top:ehole_1/c1")], [230, 250]) as DimensionAnnotation;
    expect(previewAnnotation(d.sheet, { ...hole, id: "p", tolerance: { kind: "fitWithTol", fit: "H7" } } as Annotation)!.text).toBe("Ø6.6 H7 (+0.015/0)");
  });

  it("chain and baseline sets: across above the view when the pointer is above it, the side by its sign", () => {
    const top = d.sheet.views.find((v) => v.id === "top")!;
    const corners = d.targets.filter((t) => t.view === "top" && t.kind === "vertex").sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
    const r = setFromPicks(d.sheet, "chain", corners[0].ref, ["top:chole_1/c1", corners[corners.length - 1].ref], [120, top.box!.max[1] + 12]) as DimensionAnnotation;
    expect(r).toMatchObject({ kind: "chain", direction: "horizontal", origin: corners[0].ref });
    expect(r.offset).toBeCloseTo(12, 6);
    const below = setFromPicks(d.sheet, "baseline", corners[0].ref, ["top:chole_1/c1"], [120, top.box!.min[1] - 9]) as DimensionAnnotation;
    expect(below.offset).toBeCloseTo(-9, 6);
    const left = setFromPicks(d.sheet, "ordinate", corners[0].ref, ["top:chole_1/c1"], [top.box!.min[0] - 20, 200]) as DimensionAnnotation;
    expect(left).toMatchObject({ direction: "vertical", offset: -20 });
  });

  it("turns a dimension between two points into a baseline or ordinate set and back; Ø ↔ R", () => {
    const lin: DimensionAnnotation = { id: "d", type: "dimension", view: "top", from: "top:v1", to: "top:v2", direction: "horizontal", at: [1, 2], tolerance: { kind: "symmetric", plus: 0.1 } };
    const b = convertDimension(lin, "baseline") as DimensionAnnotation;
    expect(b).toEqual({ type: "dimension", view: "top", kind: "baseline", origin: "top:v1", points: ["top:v2"], direction: "horizontal", tolerance: { kind: "symmetric", plus: 0.1 } });
    expect(convertDimension({ ...b, id: "d" }, "linear")).toMatchObject({ kind: "linear", from: "top:v1", to: "top:v2" });
    expect(convertDimension({ id: "d", type: "dimension", view: "top", refs: ["top:e1"] }, "ordinate")).toMatch(/two points/);
    expect(radialSwap({ id: "d", type: "dimension", view: "top", kind: "diameter", refs: ["top:e1"] }, "radius")).toEqual({ kind: "radius" });
    expect(radialSwap(lin, "radius")).toBeNull();
  });
});

describe("the angle of the quadrant the text is in (the flange's 45° chamfer in its section)", () => {
  it("between the chamfer and the top face: 135° below the face, 45° in the narrow corner between them", async () => {
    const d = await planned("flange", false);
    const front = d.sheet.views.find((v) => v.id === "front")!;
    // Where they meet: the face's left end; the face runs right from it, the chamfer down and left.
    const face = d.targets.find((t) => t.ref === "front:ecut/l2")!.pts![0];
    const v = face[0][0] < face[face.length - 1][0] ? face[0] : face[face.length - 1];
    const at = (x: number, y: number) => [v[0] + x - front.centre[0], v[1] + y - front.centre[1]];
    const doc = run(
      d.doc,
      { type: "setAnnotation", id: "a1", annotation: { type: "dimension", view: "front", kind: "angular", refs: ["front:ecut/l1", "front:ecut/l2"], at: at(6, -3) } },
      { type: "setAnnotation", id: "a2", annotation: { type: "dimension", view: "front", kind: "angular", refs: ["front:ecut/l1", "front:ecut/l2"], at: at(8, 3) } },
    );
    const s = (await compose(doc)).sheet;
    expect(said(s, "a1").value).toBeCloseTo(135, 6);
    expect(said(s, "a1").text).toBe("135°");
    expect(said(s, "a2").value).toBeCloseTo(45, 6);
    expect(said(s, "a2").text).toBe("45°");
    const inferred = inferDimension(s, [pick({ ...d, sheet: s, targets: snapIndex(s).targets }, "front:ecut/l1"), pick({ ...d, sheet: s, targets: snapIndex(s).targets }, "front:ecut/l2")], [v[0] + 8, v[1] + 3]);
    expect(inferred).toMatchObject({ kind: "angular" });
  });
});

describe("the fit editor's ISO 286 values", () => {
  it("lists hole and shaft classes with their deviations at the size: Ø25 H7 +0.021/0, g6 −0.007/−0.020, p6 +0.035/+0.022", () => {
    const holes = classChoices(25, "hole");
    expect(holes.find((c) => c.value === "H7")).toMatchObject({ label: "H7  +0.021 / 0", upper: 0.021, lower: 0 });
    const shafts = classChoices(25, "shaft");
    expect(shafts.find((c) => c.value === "g6")!.label).toBe("g6  −0.007 / −0.020");
    expect(shafts.find((c) => c.value === "p6")!.label).toBe("p6  +0.035 / +0.022");
  });

  it("says what a fit means: H7/g6 on Ø25 is 25.000–25.021 over 24.980–24.993, clearance 0.007 to 0.041", () => {
    const s = fitSummary(25, "H7/g6", "Ø")!;
    expect(s.lines).toEqual(["Hole Ø25 H7: 25.000 – 25.021 (+0.021 / 0)", "Shaft Ø25 g6: 24.980 – 24.993 (−0.007 / −0.020)", "Clearance fit: clearance 0.007 to clearance 0.041"]);
    expect(fitSummary(25, "H7/p6")!.type).toBe("interference");
    expect(fitSummary(25, "H7/k6")!.lines[2]).toBe("Transition fit: interference 0.015 to clearance 0.019");
  });
});

describe("the format painter and favourites", () => {
  const src: DimensionAnnotation = { id: "a", type: "dimension", view: "v", from: "p", to: "q", tolerance: { kind: "fitWithTol", fit: "H7" }, precision: 2, arrows: "outside" };
  it("copies a dimension's tolerance, decimals and arrows; what the source lacks is taken off the target", () => {
    const style = styleOf(src)!;
    expect(style.values).toEqual({ tolerance: { kind: "fitWithTol", fit: "H7" }, precision: 2, arrows: "outside", dual: null, inspection: null });
    expect(paintPatch({ id: "b", type: "dimension", view: "v", refs: ["v:e1"], inspection: true }, style)).toEqual(style.values);
    // A fit doesn't go on an angle; the rest does.
    expect(paintPatch({ id: "c", type: "dimension", view: "v", kind: "angular", refs: ["v:e1", "v:e2"] }, style)).toEqual({ precision: 2, arrows: "outside", dual: null, inspection: null });
    expect(paintPatch({ id: "n", type: "note", text: "x", at: [0, 0] }, style)).toMatch(/dimension's/);
    expect(paintPatch({ id: "h", type: "hole", view: "v", hole: "hole_1" }, style)).toEqual({ tolerance: { kind: "fitWithTol", fit: "H7" } });
    expect(styleOf({ id: "n", type: "note", text: "x", at: [0, 0], height: 5, bold: true })!.values).toEqual({ height: 5, bold: true, italic: null, underline: null, frame: null });
  });

  it("saves a dimension's style as a favourite and applies only its own fields", () => {
    const f = favouriteFrom(" Bore ", src);
    expect(f).toEqual({ name: "Bore", style: { tolerance: { kind: "fitWithTol", fit: "H7" }, precision: 2, arrows: "outside" } });
    expect(favouriteFrom("x", { id: "a", type: "dimension", view: "v" })).toMatch(/no tolerance/);
    expect(applyFavourite({ id: "a", type: "dimension", view: "v" }, { name: "±0.1", style: { tolerance: { kind: "symmetric", plus: 0.1 } } })).toEqual({ tolerance: { kind: "symmetric", plus: 0.1 } });
    expect(applyFavourite({ id: "a", type: "dimension", view: "v", kind: "angular" }, { name: "H7", style: { tolerance: { kind: "fit", fit: "H7" } } })).toMatch(/angle/);
  });
});

describe("Model Items", () => {
  it("brings the flange's own dimensions into its plan view once: the bolt holes' callout, the Ø80 rim and the hub, nothing twice", async () => {
    const d = await planned("flange", false);
    const r = modelItems(d.doc, d.sheet, [], { views: ["top"] });
    const holes = r.items.filter((a) => a.type === "hole");
    expect(holes).toEqual([{ type: "hole", view: "top", hole: "bolt_hole" }]);
    const dims = r.items.filter((a): a is Omit<DimensionAnnotation, "id"> => a.type === "dimension");
    expect(dims.every((a) => a.view === "top" && a.kind === "diameter")).toBe(true);
    const doc = run(d.doc, ...r.items.map((a, i): Command => ({ type: "setAnnotation", id: `m${i}`, annotation: a })));
    const after = await compose(doc);
    const values = after.sheet.annotations.filter((a) => a.type === "dimension").map((a) => Math.round(a.value! * 10) / 10);
    expect(values).toEqual(expect.arrayContaining([80, 40]));
    expect(new Set(values).size).toBe(values.length);
    // Again: everything is there.
    expect(modelItems(doc, after.sheet, after.drawing.sheets[0].annotations, { views: ["top"] }).items).toEqual([]);
  });

  it("a weldment's member lengths, in a view each lies flat in", async () => {
    const d = await planned("table-frame", false);
    const r = modelItems(d.doc, d.sheet, [], { views: ["front", "top", "right"], sketch: false, holes: false });
    const members = r.items.flatMap((a) => (a.type === "dimension" && a.member ? [a.member] : []));
    // Alike members (the same length along the same direction) once each: a front rail, a leg, a side rail.
    expect(members).toHaveLength(3);
  });
});

describe("Auto Balloon", () => {
  it("balloons each cut list item once, in a row above the front view, in the order their parts are", async () => {
    const d = await planned("table-frame", false);
    const r = autoBalloons(d.sheet, [], { views: ["front"], layout: "top" });
    const front = d.sheet.views.find((v) => v.id === "front")!;
    // The front view shows a rail, a leg and the end of a side rail: items 1, 2 and 3.
    expect(r.balloons.map((b) => b.member).sort()).toEqual(["leg_a", "rail_front", "rail_right"]);
    for (const b of r.balloons) expect(b.at![1] + front.centre[1]).toBeCloseTo(front.box!.max[1] + 14, 6);
    // In a row, at least a balloon apart.
    const xs = r.balloons.map((b) => b.at![0]).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(12);
    const all = autoBalloons(d.sheet, [], { layout: "square" });
    expect(all.balloons).toHaveLength(3);
    expect(all.unseen).toEqual([]);
    // Ballooned already: nothing more.
    const doc = run(d.doc, ...all.balloons.map((b, i): Command => ({ type: "setAnnotation", id: `b${i}`, annotation: b })));
    const after = await compose(doc);
    expect(autoBalloons(after.sheet, after.drawing.sheets[0].annotations).balloons).toEqual([]);
    expect(after.sheet.annotations.filter((a) => a.type === "balloon").map((a) => a.item).sort()).toEqual([1, 2, 3]);
  });
});

describe("editing", () => {
  it("remembers where each dimension is drawn with the next edit, leaving out what the edit touches", async () => {
    const d = await planned("bracket");
    const cmds = rememberCommands(d.drawing, d.sheet, [{ type: "setAnnotation", id: "d1", annotation: null }]);
    const ids = cmds.map((c) => (c as { id: string }).id);
    expect(ids).toContain("d2");
    expect(ids).not.toContain("d1");
    expect((cmds[0] as unknown as { patch: { last: { pts: number[][]; text: string } } }).patch.last.pts.length).toBeGreaterThan(1);
    const doc = run(d.doc, ...cmds);
    const again = await compose(doc);
    // Only the one the first edit left out is still to remember.
    expect(rememberCommands(again.drawing, again.sheet, []).map((c) => (c as { id: string }).id)).toEqual(["d1"]);
  });

  it("sketches on the sheet: a line, a rectangle, a circle by a point on it, an arc counter-clockwise", () => {
    expect(sketchItems("line", [[0, 0], [10, 0]], "center")).toEqual([{ kind: "line", a: [0, 0], b: [10, 0], line: "center" }]);
    expect(sketchItems("rectangle", [[0, 0], [10, 0]])).toBeNull();
    expect(sketchItems("circle", [[5, 5], [8, 9]])).toEqual([{ kind: "circle", c: [5, 5], r: 5 }]);
    expect(sketchItems("arc", [[0, 0], [10, 0], [0, 10]])).toEqual([{ kind: "arc", c: [0, 0], r: 10, start: 0, end: 90 }]);
  });

  it("writes an overridden value as typed, text under the line, and leaves a hidden annotation off the sheet", async () => {
    const d = await planned("bracket");
    const doc = run(d.doc, { type: "editAnnotation", id: "d1", patch: { override: "80 REF", below: "2 PLACES" } }, { type: "editAnnotation", id: "d2", patch: { hidden: true } });
    const s = (await compose(doc)).sheet;
    expect(said(s, "d1").text).toBe("80 REF / 2 PLACES");
    const texts = s.prims.filter((p) => p.k === "text" && p.owner === "d1").map((p) => (p.k === "text" ? p.text : ""));
    expect(texts.join(" ")).toContain("2 PLACES");
    expect(said(s, "d2").hidden).toBe(true);
    expect(s.prims.some((p) => p.owner === "d2")).toBe(false);
    expect(apply(d.doc, { type: "editAnnotation", id: "d2", patch: { hidden: "yes" } })).toMatchObject({ ok: false });
  });
});
