// Phase Q wave Q4: a drawing's layout is stable. The sheet's scale is chosen
// once (New drawing, Fit views) and stored; moving a view moves only it (and
// the views lined up with it); a view off the sheet keeps its scale and the
// checks say so.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeDrawing, type ComposedDrawing } from "../src/drafting/compose";
import { layoutProblems } from "../src/drafting/checks";
import { fitViews, keepScale } from "../src/drafting/fit";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
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

type Sheet = { id: string; scale?: string; views: { id: string; scale?: string; at?: [number, number] }[] };
const sheetOf = (doc: RawDocument) => (doc.drawing as { sheets: Sheet[] }).sheets[0];
const r = (x: number) => Math.round(x * 1000) / 1000;
const size = (b: { min: number[]; max: number[] } | null) => (b ? [r(b.max[0] - b.min[0]), r(b.max[1] - b.min[1])] : null);
/** A sheet as it was stored before Q4: no scale, no view's scale chosen by the layout. */
function unscaled(doc: RawDocument): RawDocument {
  const out = structuredClone(doc);
  const s = sheetOf(out);
  delete s.scale;
  for (const v of s.views) if (v.id === "iso") delete v.scale;
  return out;
}

const EXAMPLES = ["bracket", "flange", "mounting-plate", "table-frame"];
const plans = new Map<string, RawDocument>();
async function plan(name: string): Promise<RawDocument> {
  if (!plans.has(name)) plans.set(name, await planned(example(name)));
  return plans.get(name)!;
}

describe("New drawing stores the scale it chose", () => {
  it("on the sheet, and an iso drawn smaller keeps its own", async () => {
    const want: Record<string, [string, string | undefined]> = { bracket: ["2:1", undefined], flange: ["1:1", undefined], "mounting-plate": ["1:1", undefined], "table-frame": ["1:10", "1:20"] };
    for (const name of EXAMPLES) {
      const s = sheetOf(await plan(name));
      expect([name, s.scale, s.views.find((v) => v.id === "iso")?.scale]).toEqual([name, ...want[name]]);
      const c = (await compose(await plan(name))).sheets[0];
      expect(c.scaleText).toBe(want[name][0]);
    }
  }, 120000);
});

describe("moving a view (the user's bug: views resized, a view half off the sheet made the scale huge)", () => {
  for (const stored of [true, false]) {
    it(`never changes a scale, another view's place or any view's size (${stored ? "scale stored" : "a sheet from before Q4, no scale stored"})`, async () => {
      for (const name of EXAMPLES) {
        const doc = stored ? await plan(name) : unscaled(await plan(name));
        const c0 = (await compose(doc)).sheets[0];
        for (const cv of c0.views) {
          // The views lined up with it go with it (and theirs).
          const follow = new Set<string>([cv.id]);
          for (let grew = true; grew; ) {
            grew = false;
            for (const x of c0.views) if (x.parent && follow.has(x.parent) && !follow.has(x.id) && (x.kind === "projected" || x.kind === "section")) (follow.add(x.id), (grew = true));
          }
          // Half off the sheet, past its right edge.
          const moved = run(doc, { type: "moveView", id: cv.id, at: [c0.frame.max[0], cv.centre[1] - 3] });
          const c1 = (await compose(moved)).sheets[0];
          expect([name, cv.id, c1.scaleText]).toEqual([name, cv.id, c0.scaleText]);
          for (const v of c1.views) {
            const was = c0.views.find((x) => x.id === v.id)!;
            expect([name, cv.id, v.id, v.scaleText, size(v.box)]).toEqual([name, cv.id, v.id, was.scaleText, size(was.box)]);
            if (!follow.has(v.id)) expect([name, cv.id, v.id, v.centre]).toEqual([name, cv.id, v.id, was.centre]);
          }
          // Where it was put (one lined up with its parent only along the parent's line).
          if (!cv.parent || cv.kind === "detail") expect(c1.views.find((v) => v.id === cv.id)!.centre).toEqual([c0.frame.max[0], cv.centre[1] - 3]);
        }
        // Every view moved a little: the scale stays (before Q4 it went to 10:1, there being nothing left to fit).
        let all = doc;
        for (const cv of c0.views) all = run(all, { type: "moveView", id: cv.id, at: [cv.centre[0] + 1, cv.centre[1]] });
        const c2 = (await compose(all)).sheets[0];
        expect([name, c2.scaleText, c2.views.map((v) => v.scaleText)]).toEqual([name, c0.scaleText, c0.views.map((v) => v.scaleText)]);
      }
    }, 240000);
  }

  it("takes the views lined up with it along, by as much as it moved", async () => {
    const doc = await plan("flange");
    const c0 = (await compose(doc)).sheets[0];
    // The flange's front is a section of its top view, the right view projected from the front.
    expect(sheetOf(doc).views.map((v) => [v.id, (v as { parent?: string }).parent])).toEqual([["top", undefined], ["front", "top"], ["right", "front"], ["iso", undefined]]);
    const top = c0.views.find((v) => v.id === "top")!;
    const c1 = (await compose(run(doc, { type: "moveView", id: "top", at: [top.centre[0] + 20, top.centre[1] - 10] }))).sheets[0];
    const d = (id: string) => {
      const a = c0.views.find((v) => v.id === id)!.centre;
      const b = c1.views.find((v) => v.id === id)!.centre;
      return [r(b[0] - a[0]), r(b[1] - a[1])];
    };
    expect(d("front")).toEqual([20, -10]);
    expect(d("top")).toEqual([20, -10]);
    expect(d("right")).toEqual([20, -10]);
    expect(d("iso")).toEqual([0, 0]);
    // Its dimensions and callouts go with it, the same size.
    const anns = (sheetOf(doc) as unknown as { annotations: { id: string; view?: string }[] }).annotations.filter((a) => a.view === "top" || a.view === "front");
    expect(anns.length).toBeGreaterThan(2);
    for (const a of anns) {
      const b0 = c0.annotations.find((x) => x.id === a.id)!.box!;
      const b1 = c1.annotations.find((x) => x.id === a.id)!.box!;
      expect([a.id, r(b1.min[0] - b0.min[0]), r(b1.min[1] - b0.min[1]), size(b1)]).toEqual([a.id, 20, -10, size(b0)]);
    }
  }, 60000);

  it("a view off the sheet keeps its scale, and the checks say it is off", async () => {
    const doc = await plan("table-frame");
    const c0 = (await compose(doc)).sheets[0];
    const iso = c0.views.find((v) => v.id === "iso")!;
    const c1 = (await compose(run(doc, { type: "moveView", id: "iso", at: [c0.frame.max[0], iso.centre[1]] }))).sheets[0];
    expect(c1.views.find((v) => v.id === "iso")!.scaleText).toBe("1:20");
    expect(layoutProblems(c1)).toContain("view iso is partly off the sheet");
    const c2 = (await compose(run(doc, { type: "moveView", id: "iso", at: [c0.width + 400, iso.centre[1]] }))).sheets[0];
    expect(c2.scaleText).toBe("1:10");
    expect(layoutProblems(c2)).toContain("view iso is off the sheet");
  }, 60000);

  it("a detail keeps its scale and place when its parent moves", async () => {
    const doc = run(await plan("mounting-plate"), { type: "setView", id: "det", view: { kind: "detail", parent: "top", circle: { at: [0, 0], r: 15 } } });
    const c0 = (await compose(doc)).sheets[0];
    const det = c0.views.find((v) => v.id === "det")!;
    const top = c0.views.find((v) => v.id === "top")!;
    const c1 = (await compose(run(doc, { type: "moveView", id: "top", at: [top.centre[0] + 200, top.centre[1] - 100] }))).sheets[0];
    const det1 = c1.views.find((v) => v.id === "det")!;
    expect([det1.scaleText, det1.centre, size(det1.box)]).toEqual([det.scaleText, det.centre, size(det.box)]);
  }, 60000);
});

describe("a sheet from before Q4 keeps the scale it shows", () => {
  it("keepScale stores it (and an iso's own), and nothing moves", async () => {
    const doc = unscaled(await plan("table-frame"));
    const c0 = (await compose(doc)).sheets[0];
    const cmds = keepScale(sheetOf(doc) as never, c0);
    expect(cmds).toEqual([
      { type: "setSheet", sheet: "sheet1", patch: { scale: "1:10" } },
      expect.objectContaining({ type: "setView", id: "iso", sheet: "sheet1", view: expect.objectContaining({ scale: "1:20" }) }),
    ]);
    const kept = run(doc, ...cmds);
    const c1 = (await compose(kept)).sheets[0];
    expect(c1.views.map((v) => [v.id, v.scaleText, v.centre])).toEqual(c0.views.map((v) => [v.id, v.scaleText, v.centre]));
    expect(keepScale(sheetOf(kept) as never, c1)).toEqual([]);
  }, 60000);
});

describe("Fit views to sheet", () => {
  it("lays the views out afresh at the largest standard scale that fits, and stores it", async () => {
    const doc = await plan("table-frame");
    const c0 = (await compose(doc)).sheets[0];
    // The user set 1:5 (too big for A3) and dragged views about.
    let messy = run(doc, { type: "setSheet", patch: { scale: "1:5" } }, { type: "moveView", id: "front", at: [100, 100] }, { type: "moveView", id: "iso", at: [500, 20] });
    const v = validateDocument(messy);
    const ctx = { measurements: (await kernel.check(messy)).measurements, geometry: await kernel.project(messy, viewSpecs(v.drawing!)) };
    const fit = fitViews(messy, ctx, sheetOf(messy) as never);
    if ("error" in fit) throw new Error(fit.error);
    expect(fit.scale).toBe("1:10");
    messy = run(messy, ...fit.commands);
    const s = sheetOf(messy);
    expect(s.scale).toBe("1:10");
    expect(s.views.filter((x) => x.at)).toEqual([]);
    expect(s.views.find((x) => x.id === "iso")?.scale).toBe("1:20");
    const c1 = (await compose(messy)).sheets[0];
    expect(c1.views.map((x) => [x.id, x.scaleText, x.centre])).toEqual(c0.views.map((x) => [x.id, x.scaleText, x.centre]));
    expect(fitViews(messy, ctx, { ...(sheetOf(messy) as never as object), views: [] } as never)).toEqual({ error: "Fit views: the sheet has no views." });
  }, 60000);
});
