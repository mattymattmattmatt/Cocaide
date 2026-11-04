// Phase Q wave Q2A: annotations and tolerancing. ISO 286 fits against the
// published tables, ISO 2768 / ISO 13920 / ASME general tolerances, how a
// tolerance is written, the validation of every annotation kind, their
// layout on real sheets (texts, values, collision-free auto layout on the
// example parts), the pick inference the sheet editor uses, the dangling
// warning, the auto-dimension engine v2 and the editAnnotation command.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeDrawing, type ComposedDrawing, type ComposedSheet } from "../src/drafting/compose";
import { classDeviations, fitOf, itTolerance, parseFit } from "../src/drafting/fits";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { viewSpecs } from "../src/drafting/specs";
import { sheetDXF } from "../src/drafting/dxf";
import { sheetSVG } from "../src/drafting/svg";
import { overlaps } from "../src/drafting/sheet";
import {
  angleTolText,
  generalLinear,
  iso13920Angle,
  iso13920Geometric,
  iso13920Linear,
  iso2768Angle,
  iso2768Edge,
  iso2768Geometric,
  iso2768Linear,
  parseGeneralTolerance,
  toleranceLine,
  toleranceOf,
  toleranceProblem,
} from "../src/drafting/tolerance";
import { parseRich, richWidth } from "../src/drafting/symbols/richtext";
import { dimensionFromPicks, dragGrip, gdtProblems, hitAnnotation, holeCallout, rememberPlaces, schemaFor } from "../src/drafting/annotate";
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

async function compose(doc: RawDocument): Promise<ComposedDrawing> {
  const v = validateDocument(doc);
  if (!v.drawing) throw new Error(v.drawingErrors.join("; "));
  const c = await kernel.check(doc);
  return composeDrawing(doc, { measurements: c.measurements, geometry: await kernel.project(doc, viewSpecs(v.drawing)) })!;
}

async function planned(name: string): Promise<RawDocument> {
  const doc = example(name);
  const c = await kernel.check(doc);
  return run(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS), { date: "2026-11-04" }) });
}

const said = (s: ComposedSheet, id: string) => s.annotations.find((a) => a.id === id)!;

describe("ISO 286 limits and fits", () => {
  it("has the standard tolerance grades: IT7 on Ø25 is 21 µm, IT6 13, IT11 on Ø100 220 µm, IT14 on 2000 mm 3.7 mm", () => {
    expect(itTolerance(25, 7)).toBe(0.021);
    expect(itTolerance(25, 6)).toBe(0.013);
    expect(itTolerance(100, 11)).toBe(0.22);
    expect(itTolerance(2000, 14)).toBe(3.7);
    // A size on a range's limit belongs to the range below: 30 is in 18–30.
    expect(itTolerance(30, 7)).toBe(0.021);
    expect(itTolerance(30.01, 7)).toBe(0.025);
    expect(itTolerance(600, "01")).toBeNull();
  });

  it("gives the published deviations: Ø25 H7 +0.021/0, g6 −0.007/−0.020, Ø40 m6 +0.025/+0.009", () => {
    expect(classDeviations(25, "H7")).toEqual({ upper: 0.021, lower: 0 });
    expect(classDeviations(25, "g6")).toEqual({ upper: -0.007, lower: -0.02 });
    expect(classDeviations(40, "m6")).toEqual({ upper: 0.025, lower: 0.009 });
    expect(classDeviations(25, "f7")).toEqual({ upper: -0.02, lower: -0.041 });
    expect(classDeviations(50, "F8")).toEqual({ upper: 0.064, lower: 0.025 });
    expect(classDeviations(10, "h9")).toEqual({ upper: 0, lower: -0.036 });
  });

  it("adds Δ = IT7 − IT6 to K, M, N and P–ZC holes: Ø25 K7 +0.006/−0.015, N7 −0.007/−0.028, P7 −0.014/−0.035, Ø100 S7 −0.058/−0.093", () => {
    expect(classDeviations(25, "K7")).toEqual({ upper: 0.006, lower: -0.015 });
    expect(classDeviations(25, "N7")).toEqual({ upper: -0.007, lower: -0.028 });
    expect(classDeviations(25, "P7")).toEqual({ upper: -0.014, lower: -0.035 });
    expect(classDeviations(100, "S7")).toEqual({ upper: -0.058, lower: -0.093 });
    expect(classDeviations(40, "M7")).toEqual({ upper: 0, lower: -0.025 });
  });

  it("rounds js down to an even µm and takes J and j from their own table", () => {
    // IT7 on 18–30 is 21 µm: ±10.
    expect(classDeviations(25, "js7")).toEqual({ upper: 0.01, lower: -0.01 });
    expect(classDeviations(25, "J7")).toEqual({ upper: 0.012, lower: -0.009 });
    expect(classDeviations(25, "j6")).toEqual({ upper: 0.009, lower: -0.004 });
  });

  it("pairs a hole and shaft: H7/g6 on Ø25 is a clearance fit of 0.007 to 0.041; H7/p6 interference; H7/k6 transition", () => {
    expect(fitOf(25, "H7/g6")).toEqual({ hole: { upper: 0.021, lower: 0 }, shaft: { upper: -0.007, lower: -0.02 }, maxClearance: 0.041, minClearance: 0.007, type: "clearance" });
    expect(fitOf(25, "H7/p6")!.type).toBe("interference");
    expect(fitOf(25, "H7/k6")!.type).toBe("transition");
    expect(parseFit("H7-g6")).toEqual(parseFit("H7/g6"));
    expect(parseFit("g6/H7")).toBeNull();
  });
});

describe("general tolerances", () => {
  it("ISO 2768-1: m on 50 mm is ±0.3, f on 4 mm ±0.05, c on 500 ±2, v under 3 mm none; broken edges; angles by the shorter side", () => {
    expect(iso2768Linear(50, "m")).toBe(0.3);
    expect(iso2768Linear(4, "f")).toBe(0.05);
    expect(iso2768Linear(500, "c")).toBe(2);
    expect(iso2768Linear(2, "v")).toBeNull();
    expect(iso2768Edge(2, "m")).toBe(0.2);
    expect(iso2768Edge(8, "c")).toBe(2);
    expect(iso2768Angle(30, "m")).toBe(0.5);
    expect(angleTolText(iso2768Angle(30, "m"))).toBe("±0°30'");
    expect(angleTolText(iso2768Angle(5, "v"))).toBe("±3°");
  });

  it("ISO 2768-2: K flatness of a 200 mm face 0.4, H perpendicularity on 150 mm 0.3, L run-out 0.5", () => {
    expect(iso2768Geometric("flatness", 200, "K")).toBe(0.4);
    expect(iso2768Geometric("perpendicularity", 150, "H")).toBe(0.3);
    expect(iso2768Geometric("circularRunout", 10, "L")).toBe(0.5);
  });

  it("ISO 13920: B on 1500 mm ±4, angle on a 600 mm leg ±30', F flatness over 2000 mm 6", () => {
    expect(iso13920Linear(1500, "B")).toBe(4);
    expect(iso13920Angle(600, "B")).toBe(0.5);
    expect(iso13920Geometric(3000, "F")).toBe(6);
  });

  it("reads the title block's general tolerance: ISO 2768-mK, ISO 13920-BF, an ASME block by decimals", () => {
    expect(parseGeneralTolerance("ISO 2768-mK")).toMatchObject({ standard: "ISO 2768", linear: "m", geometric: "K" });
    expect(parseGeneralTolerance("EN ISO 13920-BF")).toMatchObject({ standard: "ISO 13920", linear: "B", geometric: "F" });
    const asme = parseGeneralTolerance("X.X ±0.5, X.XX ±0.1, ANG ±0.5°");
    expect(asme).toMatchObject({ standard: "block", places: { 1: 0.5, 2: 0.1 }, angle: 0.5 });
    expect(generalLinear(asme, 25.4, 2)).toBe(0.1);
  });

  it("gives any dimension its effective tolerance: its own, a fit's, else the general one", () => {
    const d = { generalTolerance: "ISO 2768-mK" };
    expect(toleranceOf({ value: 50 }, d)).toMatchObject({ upper: 0.3, lower: -0.3, source: "general" });
    expect(toleranceOf({ value: 25, tolerance: { kind: "fit", fit: "H7" } }, d)).toMatchObject({ upper: 0.021, lower: 0, source: "fit" });
    expect(toleranceOf({ value: 25, tolerance: { kind: "bilateral", plus: 0.1, minus: 0.05 } }, d)).toMatchObject({ upper: 0.1, lower: -0.05, source: "dimension" });
    expect(toleranceOf({ value: 45, kind: "angular", side: 30 }, d)).toMatchObject({ upper: 0.5, source: "general" });
    expect(toleranceOf({ value: 25, tolerance: { kind: "basic" } }, d).source).toBe("basic");
    expect(toleranceOf({ value: 25 }, {}).source).toBe("none");
  });

  it("writes tolerances as the standards do", () => {
    expect(toleranceLine(25, "Ø25", { kind: "fitWithTol", fit: "H7" })).toBe("Ø25 H7 (+0.021/0)");
    expect(toleranceLine(25, "25", { kind: "symmetric", plus: 0.1 })).toBe("25 ±0.1");
    expect(toleranceLine(25, "25", { kind: "bilateral", plus: 0.1, minus: 0.05 })).toBe("25 +0.10/−0.05");
    expect(toleranceLine(25, "25", { kind: "limit", plus: 0.1, minus: 0.05 })).toBe("24.95–25.10");
    expect(toleranceLine(25, "25", { kind: "reference" })).toBe("(25)");
    expect(toleranceProblem({ kind: "bilateral", plus: 0.1, minus: -0.2 })).toContain("leave no room");
    expect(toleranceProblem({ kind: "fit", fit: "Q7" })).toContain("ISO 286");
  });
});

describe("symbols and rich text", () => {
  it("draws drafting characters and palette tokens as glyphs among the letters", () => {
    const spans = parseRich("<MOD-DIAM>8 <HOLE-DEPTH>12 **bold** ⌖");
    expect(spans.map((s) => (s.kind === "glyph" ? `[${s.name}]` : s.text))).toEqual(["Ø8 ", "[depth]", "12 ", "bold", " ", "[position]"]);
    expect(spans.find((s) => s.kind === "text" && s.text === "bold")).toMatchObject({ bold: true });
    expect(richWidth(parseRich("↧"), 5)).toBeCloseTo(0.7 * 5 * 0.72, 6);
  });

  it("calls out holes in ISO 129 symbols", () => {
    const h = { feature: "h", entry: [0, 0, 0], axis: [0, 0, -1], diameter: 6.6, depth: 10, through: true, counterbore: { diameter: 11, depth: 4 }, copies: 3 } as never;
    expect(holeCallout(h, 4)).toEqual(["4× Ø6.6 THRU", "⌴ Ø11 ↧4"]);
    expect(holeCallout({ ...(h as object), counterbore: undefined, countersink: { diameter: 13, angle: 90 }, through: false } as never, 1, { pcd: 80 })).toEqual(["Ø6.6 ↧10 EQ SP", "⌵ Ø13 × 90°", "ON PCD Ø80"]);
  });
});

describe("validation of every kind", () => {
  const sheet = (annotations: unknown[]) => ({ sheets: [{ id: "s1", format: { size: "A3" }, projection: "third", views: [{ id: "top", look: "top" }, { id: "iso", look: "iso" }], annotations }] });
  const errors = (annotations: unknown[]) => validateDocument({ ...example("bracket"), drawing: sheet(annotations) }).drawingErrors;

  it("accepts each kind written right", () => {
    expect(
      errors([
        { id: "d1", type: "dimension", view: "top", kind: "diameter", refs: ["top:ehole_1/c0"], tolerance: { kind: "fit", fit: "H7" } },
        { id: "d2", type: "dimension", view: "top", kind: "ordinate", origin: "@left", points: ["top:chole_1/c0"] },
        { id: "g1", type: "gdt", view: "top", dimension: "d1", rows: [{ characteristic: "position", diameter: true, tolerance: 0.1, material: "M", datums: [{ label: "A" }, { label: "B" }] }] },
        { id: "a1", type: "datum", view: "top", label: "A", on: "top:@bottom" },
        { id: "s1", type: "surface", view: "top", symbol: "removal", values: ["Ra 1.6"], on: "top:@top", lay: "=" },
        { id: "s2", type: "surface", general: true, symbol: "removal", values: ["Ra 3.2"] },
        { id: "w1", type: "weld", view: "top", on: "top:@left", arrowSide: { symbol: "fillet", size: "a5", length: 50, count: 3, pitch: 150 }, otherSide: { symbol: "fillet", size: "a5" }, field: true, process: "135" },
        { id: "n1", type: "note", text: "**NOTES**", at: [20, 40], numbered: true, leaders: [{ to: "top:@left", arrow: "dot" }] },
        { id: "r1", type: "revisionCloud", pts: [[10, 10], [40, 10], [40, 30]], rev: "B" },
        { id: "k1", type: "sketch", items: [{ kind: "line", a: [0, 0], b: [10, 0], line: "center" }, { kind: "text", at: [5, 5], text: "X" }] },
        { id: "t1", type: "datumTarget", view: "top", label: "A1", target: "area", size: 6, on: "top:mext_1/l0" },
      ]),
    ).toEqual([]);
  });

  it("says what is wrong, and how to say it right", () => {
    const e = errors([
      { id: "d1", type: "dimension", view: "top", kind: "angular", refs: ["top:ehole_1/c0"] },
      { id: "d2", type: "dimension", view: "iso", from: "@left", to: "@right" },
      { id: "g1", type: "gdt", view: "top", rows: [{ characteristic: "roundness", tolerance: 0.1 }], at: [0, 0] },
      { id: "a1", type: "datum", view: "top", label: "O", on: "top:@bottom" },
      { id: "w1", type: "weld", view: "top", on: "top:@left", arrowSide: { symbol: "zigzag" } },
      { id: "d3", type: "dimension", view: "top", from: "@left", to: "@right", tolerance: { kind: "symmetric" } },
    ]);
    expect(e.join("\n")).toContain("an angular dimension is on two edges or three points (got 1 GeoRef)");
    expect(e.join("\n")).toContain("which shortens every length");
    expect(e.join("\n")).toContain('characteristic: must be "straightness"');
    expect(e.join("\n")).toContain("I, O and Q are not used");
    expect(e.join("\n")).toContain('symbol: must be "fillet"');
    expect(e.join("\n")).toContain("±plus");
  });

  it("checks a frame against the rules: flatness takes no datum, perpendicularity needs one, Ⓜ on a surface is wrong, datums must exist", () => {
    const ctx = { datums: new Set(["A"]), standard: "ISO" as const, sizeFeature: false };
    expect(gdtProblems({ id: "g", type: "gdt", view: "v", rows: [{ characteristic: "flatness", tolerance: 0.05, datums: [{ label: "A" }] }] }, ctx)[0]).toContain("takes no datum");
    expect(gdtProblems({ id: "g", type: "gdt", view: "v", rows: [{ characteristic: "perpendicularity", tolerance: 0.05 }] }, ctx)[0]).toContain("needs a datum");
    expect(gdtProblems({ id: "g", type: "gdt", view: "v", rows: [{ characteristic: "position", tolerance: 0.1, material: "M", datums: [{ label: "B" }] }] }, ctx).join(" ")).toMatch(/feature of size[\s\S]*datum B is not on the drawing/);
    expect(gdtProblems({ id: "g", type: "gdt", view: "v", rows: [{ characteristic: "position", diameter: true, tolerance: 0.1, material: "M", datums: [{ label: "A" }] }] }, { ...ctx, sizeFeature: true })).toEqual([]);
  });
});

describe("laying annotations out on a sheet", () => {
  it("draws every kind on the bracket: an H7 fit, a GD&T frame under it, datums, a surface symbol, a weld, notes", async () => {
    let doc = await planned("bracket");
    const drawn = await compose(doc);
    const view = drawn.sheets[0].views.find((v) => v.id === "top")!;
    const hole = view.edges.find((e) => e.look === "circle")!;
    doc = run(
      doc,
      { type: "setAnnotation", id: "fit", annotation: { type: "dimension", view: "top", kind: "diameter", refs: [`top:e${hole.key}`], tolerance: { kind: "fitWithTol", fit: "H7" } } },
      { type: "setAnnotation", id: "pos", annotation: { type: "gdt", view: "top", dimension: "fit", rows: [{ characteristic: "position", diameter: true, tolerance: 0.1, material: "M", datums: [{ label: "A" }, { label: "B" }, { label: "C" }] }] } },
      { type: "setAnnotation", id: "flat", annotation: { type: "gdt", view: "front", on: "front:@bottom", rows: [{ characteristic: "flatness", tolerance: 0.05 }] } },
      { type: "setAnnotation", id: "ra", annotation: { type: "surface", view: "top", on: "top:@top", symbol: "removal", values: ["Ra 1.6"] } },
      { type: "setAnnotation", id: "wl", annotation: { type: "weld", view: "top", on: "top:@right", arrowSide: { symbol: "fillet", size: "a4" }, allAround: true, process: "135" } },
      { type: "setAnnotation", id: "rev", annotation: { type: "revisionCloud", pts: [[60, 60], [90, 60], [90, 80], [60, 80]], rev: "B" } },
    );
    const s = (await compose(doc)).sheets[0];
    expect(said(s, "fit").text).toBe("Ø6.6 H7 (+0.015/0)");
    expect(said(s, "fit").value).toBeCloseTo(6.6, 6);
    expect(said(s, "pos").text).toBe("position | Ø0.1Ⓜ | A | B | C");
    expect(said(s, "flat").problem).toBeUndefined();
    expect(said(s, "ra").text).toBe("surface removal Ra 1.6");
    expect(said(s, "wl").text).toContain("arrow side fillet a4");
    expect(s.problems).toEqual([]);
    // The frame hangs under the fit's text.
    const fit = said(s, "fit").textBox!;
    const pos = said(s, "pos").textBox!;
    expect(pos.max[1]).toBeLessThanOrEqual(fit.min[1]);
    // Drawn as lines on their layers: the frame's symbol is no character the PDF's font lacks.
    const dxf = sheetDXF(s);
    expect(dxf).toContain("DIMENSION");
    expect(dxf).toContain("ANNOTATION");
    expect(sheetSVG(s)).not.toContain("⌖");
  });

  it("keeps a dimension whose edge is gone at its last place, in the warning colour, and lists it", async () => {
    let doc = await planned("bracket");
    const s0 = (await compose(doc)).sheets[0];
    const hole = s0.views.find((v) => v.id === "top")!.edges.find((e) => e.look === "circle")!;
    doc = run(doc, { type: "setAnnotation", id: "dia", annotation: { type: "dimension", view: "top", kind: "diameter", refs: [`top:e${hole.key}`] } });
    const d = await compose(doc);
    const remembered = rememberPlaces(validateDocument(doc).drawing!, d)!;
    doc = run(doc, { type: "setDrawing", drawing: remembered });
    // The hole goes: its callout and diameter dangle.
    doc = { ...doc, features: doc.features.filter((f) => (f as { id: string }).id !== "hole_1") } as RawDocument;
    const s = (await compose(doc)).sheets[0];
    const dia = said(s, "dia");
    expect(dia.problem).toBeDefined();
    expect(dia.dangling).toBe(true);
    expect(s.prims.filter((p) => p.owner === "dia").every((p) => p.k === "area" || p.color === "#c0392b")).toBe(true);
    expect(dia.text).toBe("Ø6.6");
  });

  it("infers dimensions from picks as the smart dimension tool does", async () => {
    const doc = await planned("mounting-plate");
    const s = (await compose(doc)).sheets[0];
    const top = s.views.find((v) => v.id === "top")!;
    const circle = top.edges.find((e) => e.look === "circle")!;
    const lines = top.edges.filter((e) => e.look === "line" && e.visible);
    const horizontal = lines.filter((e) => Math.abs(e.pts[0][1] - e.pts[e.pts.length - 1][1]) < 1e-6);
    expect(dimensionFromPicks(s, [`top:e${circle.key}`], [300, 200])).toMatchObject({ kind: "diameter" });
    expect(dimensionFromPicks(s, [`top:e${horizontal[0].key}`, `top:e${horizontal[1].key}`], [300, 200])).toMatchObject({ refs: [`top:e${horizontal[0].key}`, `top:e${horizontal[1].key}`] });
    const vertical = lines.find((e) => Math.abs(e.pts[0][0] - e.pts[e.pts.length - 1][0]) < 1e-6)!;
    expect(dimensionFromPicks(s, [`top:e${horizontal[0].key}`, `top:e${vertical.key}`], [300, 200])).toMatchObject({ kind: "angular" });
    expect(dimensionFromPicks(s, ["top:@left", "front:@left"], [0, 0])).toContain("different views");
    // Every kind's properties for the panel.
    expect(schemaFor({ id: "x", type: "dimension", view: "top", kind: "angular", refs: [] }).some((f) => f.key === "major")).toBe(true);
  });

  it("drags a dimension's text and finds what is under a point", async () => {
    const doc = await planned("bracket");
    const s = (await compose(doc)).sheets[0];
    const d = s.annotations.find((a) => a.type === "dimension" && a.grips?.length)!;
    const a = validateDocument(doc).drawing!.sheets[0].annotations.find((x) => x.id === d.id)!;
    const moved = dragGrip(a, d.grips![0], [100, 100], s);
    expect((moved as { at: number[] }).at).toBeDefined();
    const c = d.textBox!;
    expect(hitAnnotation(s, [(c.min[0] + c.max[0]) / 2, (c.min[1] + c.max[1]) / 2])).toBe(d.id);
  });

  it("edits an annotation's fields through the command layer (editAnnotation): a fit tolerance reads H7", async () => {
    let doc = await planned("bracket");
    const d = validateDocument(doc).drawing!.sheets[0].annotations.find((a) => a.type === "dimension")!;
    doc = run(doc, { type: "editAnnotation", id: d.id, patch: { tolerance: { kind: "fit", fit: "H7" }, precision: 1 } });
    const s = (await compose(doc)).sheets[0];
    expect(said(s, d.id).text).toMatch(/^\d+\.0 H7$/);
    expect(apply(doc, { type: "editAnnotation", id: d.id, patch: { tolerance: { kind: "fit", fit: "Z99" } } })).toMatchObject({ ok: false });
    expect(apply(doc, { type: "editAnnotation", id: "nope", patch: {} })).toEqual({ ok: false, error: 'editAnnotation: no annotation "nope"' });
  });
});

describe("the auto-dimension engine v2", () => {
  for (const name of ["bracket", "flange", "mounting-plate", "table-frame"]) {
    it(`lays ${name} out with nothing over anything: no text on text, every annotation drawn, no size twice`, async () => {
      const doc = await planned(name);
      const s = (await compose(doc)).sheets[0];
      expect(s.problems).toEqual([]);
      const boxes = s.annotations.filter((a) => a.textBox && a.type !== "centerMark" && a.type !== "centerline").map((a) => ({ id: a.id, b: a.textBox! }));
      const clashes: string[] = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i].b, boxes[j].b, 0.3)) clashes.push(`${boxes[i].id} × ${boxes[j].id}`);
      expect(clashes).toEqual([]);
      const dims = s.annotations.filter((a) => a.type === "dimension" && a.along);
      // The same size along the same direction between the same two places is a duplicate (two features of one size are not).
      const keys = dims.map((d) => `${d.text}@${d.along!.map((x) => Math.round(Math.abs(x))).join("")}@${JSON.stringify(d.place?.pts.slice(0, 2).map((p) => p[d.along![0] ? 0 : 1]).sort())}`);
      expect(new Set(keys).size, keys.join(", ")).toBe(keys.length);
    });
  }

  it("calls out alike holes once: the mounting plate's two counterbored holes are 2×, its pattern of holes centre to centre", async () => {
    const doc = await planned("mounting-plate");
    const s = (await compose(doc)).sheets[0];
    const callouts = s.annotations.filter((a) => a.type === "hole").map((a) => a.text);
    expect(callouts).toEqual(expect.arrayContaining(["2× Ø6.6 THRU ⌴ Ø11 ↧4", "2× Ø6.6 THRU ⌵ Ø13 × 90°"]));
    const texts = s.annotations.filter((a) => a.type === "dimension").map((a) => a.text);
    expect(texts).toEqual(expect.arrayContaining(["100", "60", "80", "40", "R6 TYP", "Ø20"]));
    expect(s.annotations.filter((a) => a.type === "datum").map((a) => a.text).sort()).toEqual(["datum A", "datum B", "datum C"]);
    expect(s.annotations.find((a) => a.id === "general_notes")!.text).toContain("GENERAL TOLERANCES ISO 2768-mK.");
  });

  it("dimensions a turned part's diameters from the side and its bolt circle by its pitch circle", async () => {
    const doc = await planned("flange");
    const s = (await compose(doc)).sheets[0];
    const texts = s.annotations.filter((a) => a.type === "dimension" || a.type === "hole").map((a) => a.text);
    expect(texts).toEqual(expect.arrayContaining(["Ø80", "Ø40", "18", "10", "Ø24", "6× Ø6.6 THRU EQ SP ⌴ Ø11 ↧4 ON PCD Ø60"]));
  });
});
