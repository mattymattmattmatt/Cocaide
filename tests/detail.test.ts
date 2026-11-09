// Phase Q wave Q3B: AI full drawing detailing, the parts that need no model.
// The design intent read from the model, the plan by rules (bearing seat
// H7, dowel H7/m6, a hole pattern's position Ø0.1 Ⓜ A|B|C, a weldment's
// ISO 13920 and weld symbols), the critic (a missing location, a size given
// twice, the tolerance stack with worked numbers), the packet v2 within its
// token budget, the sheet rendered to a picture, and Auto-detail on the
// bracket, flange and frame passing the critic.

import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { autoDetail, findingsOf, makePlan } from "../src/ask/detail/auto";
import { stackUp, stacks } from "../src/ask/detail/critic";
import { detailState } from "../src/ask/detail/execute";
import { clearanceFor, inferIntent } from "../src/ask/detail/intent";
import { drawingContext, PACKET_BUDGET, packetTokens } from "../src/ask/detail/packet";
import { activeItems, flatnessFor, planWith } from "../src/ask/detail/plan";
import { rasterizeSheet, sheetRaster } from "../src/ask/detail/raster";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { toleranceOf } from "../src/drafting/tolerance";
import { decodePNG } from "../src/render/pngDecode";
import { getOC, loadOC } from "../src/kernel";
import { bearingPlate, example } from "./detail-fixtures";

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

async function withDrawing(doc: RawDocument): Promise<RawDocument> {
  const c = await kernel.check(doc);
  return run(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS), { date: "2026-11-05" }) });
}

const errors = <T extends { severity: string }>(f: T[]) => f.filter((x) => x.severity === "error");

describe("design intent and the plan by rules", () => {
  it("reads ISO 273 clearance holes: Ø6.6 is M6 medium, Ø9 M8 medium, Ø6.4 M6 fine; Ø6 is none", () => {
    expect(clearanceFor(6.6)).toEqual({ size: "M6", fit: "normal" });
    expect(clearanceFor(9)).toEqual({ size: "M8", fit: "normal" });
    expect(clearanceFor(6.4)).toEqual({ size: "M6", fit: "close" });
    expect(clearanceFor(6)).toBeNull();
    expect([flatnessFor(80), flatnessFor(120), flatnessFor(400)]).toEqual([0.05, 0.1, 0.2]);
  });

  it("plans the bearing plate: bearing bore H7 (k6 shaft), dowels H7/m6, position Ø0.1 Ⓜ A|B|C on the M6 pattern, flatness 0.1 on A", async () => {
    const { plan } = await makePlan(bearingPlate(), kernel, { date: "2026-11-05" });
    const purposes = Object.fromEntries(plan.intent.holes.map((h) => [h.features[0], [h.purpose, h.fit ?? null, h.pair ?? null, h.count]]));
    expect(purposes).toEqual({ mount_1: ["clearance", null, null, 4], dowel_1: ["dowel", "H7", "H7/m6", 2], bearing_seat: ["bearing", "H7", "H7/k6", 1] });
    const fits = plan.items.filter((i) => i.action.do === "fit").map((i) => (i.action as { fit: string }).fit);
    expect(fits).toEqual(["H7", "H7"]);
    expect(plan.items.find((i) => i.label.startsWith("2× Ø6 dowel"))!.label).toContain("H7 (fit H7/m6)");
    const position = plan.items.find((i) => i.label.includes("4 Ø6.6 clearance"))!;
    expect(position.action).toMatchObject({ do: "gdt", rows: [{ characteristic: "position", diameter: true, tolerance: 0.1, material: "M", datums: [{ label: "A" }, { label: "B" }, { label: "C" }] }] });
    expect(position.needs).toEqual(["datum_A", "datum_B", "datum_C"]);
    // The bearing seat: position to A|B|C and square to A, no Ⓜ (a bearing must not float).
    const seat = plan.items.find((i) => i.label.includes("Ø35 bearing hole") && i.group === "gdt")!;
    expect((seat.action as { rows: unknown[] }).rows).toEqual([
      { characteristic: "position", diameter: true, tolerance: 0.05, datums: [{ label: "A" }, { label: "B" }, { label: "C" }] },
      { characteristic: "perpendicularity", diameter: true, tolerance: 0.02, datums: [{ label: "A" }] },
    ]);
    expect(plan.items.find((i) => i.id === "flatness_A")!.label).toBe("Flatness 0.1 on datum A");
    expect(plan.options).toEqual({ standard: "ISO", generalTolerance: "ISO 2768-mK", position: 0.1, roughness: "Ra 6.3" });
    // Unticking datum B leaves out every frame that needs it.
    const without = planWith(plan, { skip: ["datum_B"] });
    expect(activeItems(without).some((i) => i.group === "gdt" && i.id.startsWith("position"))).toBe(false);
    expect(activeItems(without).some((i) => i.id === "flatness_A")).toBe(true);
  });

  it("plans the flange: B is the bore Ø24 (a bearing's outside diameter), H7 dimensioned in the section, position Ø0.1 Ⓜ A|BⓂ on the bolt circle", async () => {
    const { plan } = await makePlan(example("flange"), kernel, { date: "2026-11-05" });
    expect(plan.intent.kind).toBe("round");
    expect(plan.intent.bores.map((b) => [b.diameter, b.purpose, b.fit])).toEqual([[24, "bearing", "H7"]]);
    const fit = plan.items.find((i) => i.group === "fits")!;
    expect(fit.action).toMatchObject({ do: "fit", fit: "H7", make: { type: "dimension", view: "front", kind: "diameter" } });
    expect(plan.items.find((i) => i.id === "datum_B")!.action).toMatchObject({ do: "datum", label: "B", dimension: (fit.action as { target: string }).target });
    const pos = plan.items.find((i) => i.id.startsWith("position"))!;
    expect((pos.action as { rows: unknown[] }).rows[0]).toEqual({ characteristic: "position", diameter: true, tolerance: 0.1, material: "M", datums: [{ label: "A" }, { label: "B", modifier: "M" }] });
  });

  it("plans a weldment: ISO 13920-BF, fillet a3 all round at its joints, no surface texture", async () => {
    const { plan } = await makePlan(example("table-frame"), kernel, { date: "2026-11-05" });
    expect(plan.intent.kind).toBe("weldment");
    expect(plan.options.generalTolerance).toBe("ISO 13920-BF");
    const welds = plan.items.filter((i) => i.group === "welds");
    expect(welds.length).toBeGreaterThanOrEqual(1);
    expect(welds[0].action).toMatchObject({ do: "weld", weld: { arrowSide: { symbol: "fillet", size: "a3" }, allAround: true } });
    expect(plan.items.some((i) => i.group === "surface")).toBe(false);
  });
});

describe("the critic", () => {
  it("finds a hole that is not located, and a size given twice", async () => {
    const doc = await withDrawing(example("bracket"));
    // New drawing locates the hole 70 from the left (d5); without it the hole floats.
    const lost = run(doc, { type: "setAnnotation", id: "d5", annotation: null });
    const f1 = findingsOf(await detailState(lost, kernel));
    expect(f1.some((f) => f.rule === "located" && f.ids?.includes("hole_1"))).toBe(true);
    // The overall length again, in the section: twice.
    const twice = run(doc, { type: "setAnnotation", id: "d_again", annotation: { type: "dimension", view: "front", from: "@left", to: "@right" } });
    const f2 = findingsOf(await detailState(twice, kernel));
    expect(f2.find((f) => f.rule === "twice")?.ids).toEqual(["d1", "d_again"]);
    expect(errors(findingsOf(await detailState(doc, kernel))).filter((f) => f.rule === "located" || f.rule === "twice")).toEqual([]);
  });

  it("stacks tolerances worst case and RSS: ISO 2768-m, 20 + 30 + 30 is ±0.6 / ±0.35 within ±0.6; four links of 20 is ±0.8, over", () => {
    const d = { generalTolerance: "ISO 2768-mK" };
    const link = (v: number) => ({ value: v, tol: toleranceOf({ value: v }, d) });
    expect(toleranceOf({ value: 20 }, d)).toMatchObject({ upper: 0.2, lower: -0.2 });
    const s = stackUp([link(20), link(30), link(30)], d);
    expect(s.span).toBe(80);
    expect(s.worst).toBeCloseTo(0.6, 9);
    expect(s.rss).toBeCloseTo(Math.sqrt(3 * 0.04), 9);
    expect(s.limit).toBeCloseTo(0.6, 9);
    expect(s.ok).toBe(true);
    const four = stackUp([link(20), link(20), link(20), link(20)], d);
    expect(four.worst).toBeCloseTo(0.8, 9);
    expect(four.ok).toBe(false);
    // A fit in the chain counts its own band: Ø25 H7 is +0.021/0, half 0.0105.
    const fit = stackUp([{ value: 25, tol: toleranceOf({ value: 25, tolerance: { kind: "fit", fit: "H7" } }, d) }, link(30)], d, 0.25);
    expect(fit.worst).toBeCloseTo(0.0105 + 0.2, 9);
    expect(fit.ok).toBe(true);
  });

  it("follows a chain of dimensions on the sheet and flags it over its limit", async () => {
    const doc = await withDrawing(example("bracket"));
    const g = (await detailState(doc, kernel)).sheet!;
    const plan = g.views.find((v) => v.id === "top")!;
    const circle = plan.edges.find((e) => e.look === "circle")!;
    const c = `top:c${circle.key}`;
    // @left → the hole (70) → @right (10): one chain of two links across the 80.
    const chained = run(doc, { type: "setAnnotation", id: "d5", annotation: null }, { type: "setAnnotation", id: "k1", annotation: { type: "dimension", view: "top", from: "@left", to: c, direction: "horizontal" } }, { type: "setAnnotation", id: "k2", annotation: { type: "dimension", view: "top", from: c, to: "@right", direction: "horizontal" } });
    const st = await detailState(chained, kernel);
    const list = stacks({ doc: chained, drawing: st.drawing!, sheets: st.composed!.sheets, measurements: st.check.measurements, geometry: st.geometry, stackLimit: 0.3 });
    const k = list.find((s) => s.ids.includes("k1"))!;
    // 70 is ±0.3 and 10 is ±0.2 in ISO 2768-m: ±0.5 worst case, over the 0.3 asked.
    expect(k.ids).toEqual(["k1", "k2"]);
    expect(k.worst).toBeCloseTo(0.5, 9);
    expect(k.ok).toBe(false);
    // And the overall 80 over that chain gives the same size twice (a closed loop): it is reported, not stacked.
    expect(findingsOf(st).find((f) => f.rule === "twice")?.ids).toEqual(["d1", "k1", "k2"]);
  });
});

describe("packet v2", () => {
  it("keeps a whole sheet within its token budget, the compact one too, and says what it cut", async () => {
    const { state, plan } = await makePlan(bearingPlate(), kernel);
    const full = drawingContext(state, plan.intent, {})!;
    const compact = drawingContext(state, plan.intent, { compact: true })!;
    expect(Math.abs(full.tokens - packetTokens(full))).toBeLessThanOrEqual(2);
    expect(full.tokens).toBeLessThanOrEqual(PACKET_BUDGET.full);
    expect(compact.tokens).toBeLessThanOrEqual(PACKET_BUDGET.compact);
    expect(compact.tokens).toBeLessThan(full.tokens);
    expect(full.design.holes).toEqual(expect.arrayContaining([expect.stringContaining("dowel, group pattern, H7 (fit H7/m6)")]));
    // A GeoRef in a line: what it is, its size, its feature and that feature's purpose.
    expect(full.views.find((v) => v.id === "top")!.geoRefs).toEqual(expect.arrayContaining([expect.stringMatching(/^top:e\S+ circle Ø6\.6 \S+ \(clearance M6\)$/)]));
    expect(full.annotations.some((a) => /\[general: ±0\.3 \(ISO 2768-mK\)\]/.test(a))).toBe(true);
    expect(packetTokens({ a: "x".repeat(400) })).toBe(Math.ceil(JSON.stringify({ a: "x".repeat(400) }).length / 4));
  });
});

describe("Auto-detail (no model) on the bracket, flange and frame", () => {
  for (const name of ["bracket", "flange", "table-frame"]) {
    it(`${name}: carried out item by item, the result passes the critic`, async () => {
      const r = await autoDetail(example(name), kernel, { date: "2026-11-05" });
      expect(r.execution.results.filter((x) => !x.ok)).toEqual([]);
      expect(errors(r.findings)).toEqual([]);
      const st = r.execution.state;
      expect(st.drawing!.generalTolerance).toBe(name === "table-frame" ? "ISO 13920-BF" : "ISO 2768-mK");
      expect(st.drawing!.revisions).toEqual([{ rev: "A", description: "FIRST ISSUE", date: "2026-11-05" }]);
      const types = new Set(st.sheet!.annotations.filter((a) => !a.problem).map((a) => a.type));
      if (name === "table-frame") expect([...types]).toEqual(expect.arrayContaining(["weld", "balloon", "table", "note"]));
      else expect([...types]).toEqual(expect.arrayContaining(["gdt", "datum", "surface", "hole", "note"]));
      if (name === "flange") {
        const said = st.sheet!.annotations.map((a) => a.text);
        expect(said).toEqual(expect.arrayContaining(["Ø24 H7", "position | Ø0.1Ⓜ | A | B(M)", "perpendicularity | Ø0.02 | A", "flatness | 0.05"]));
      }
    });
  }

  it("the bearing plate's sheet passes the critic too, and its intent reads from the rebuild", async () => {
    const doc = bearingPlate();
    const r = await autoDetail(doc, kernel, { date: "2026-11-05" });
    expect(errors(r.findings)).toEqual([]);
    const st = r.execution.state;
    expect(inferIntent(doc, st.check.measurements, st.geometry!.holes, st.topology).holes.length).toBe(3);
    const texts = st.sheet!.annotations.map((a) => a.text);
    expect(texts).toEqual(expect.arrayContaining(["Ø35 H7 THRU", "2× Ø6 H7 ↧10"]));
  });
});

describe("renderSheet", () => {
  it("draws the sheet: white paper, black lines and text, at the size asked", async () => {
    const st = await detailState(await withDrawing(example("bracket")), kernel);
    const img = rasterizeSheet(st.sheet!, { side: 840 });
    expect([img.width, img.height]).toEqual([840, 594]);
    let dark = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 100) dark++;
    // Lines, text and the title block: a few per cent of the paper.
    expect(dark / (img.width * img.height)).toBeGreaterThan(0.005);
    expect(dark / (img.width * img.height)).toBeLessThan(0.2);
    const png = await sheetRaster(st.sheet!, { side: 600 });
    const back = await decodePNG(png.png);
    expect([back.width, back.height]).toEqual([600, 424]);
    expect(Array.from(back.data.slice(0, 3))).toEqual([255, 255, 255]);
  });
});
