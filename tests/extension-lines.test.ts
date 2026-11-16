// Every dimension's extension lines start on the part: each one's start is
// the drafting gap away from a drawn edge of its view (ISO: a small visible
// gap, then the line), never out in empty space. A plate with rounded
// corners was the case that broke it: an outline side's extension line
// started at the view's box corner, beside the rounded corner, short of the edge.

import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeDrawing } from "../src/drafting/compose";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { viewSpecs } from "../src/drafting/specs";
import { getOC, loadOC } from "../src/kernel";
import { readFileSync } from "node:fs";

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
}, 120_000);

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const plate: RawDocument = {
  version: 1,
  units: "mm",
  name: "rounded plate",
  features: [
    { id: "sk", op: "sketch", plane: TOP, entities: [{ id: "r", type: "rect", center: [0, 0], w: 120, h: 80 }] },
    { id: "ext", op: "extrude", sketch: "sk", distance: 8 },
    { id: "round", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" }, radius: 12 },
    { id: "hole", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [-35, -15], diameter: 25, depth: "through" },
  ],
} as unknown as RawDocument;

type Seg = [number[], number[]];
const distToSeg = (p: number[], [a, b]: Seg) => {
  const ab = [b[0] - a[0], b[1] - a[1]];
  const l2 = ab[0] ** 2 + ab[1] ** 2 || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
  return Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1]);
};

async function sheetOf(doc: RawDocument) {
  const c = await kernel.check(doc);
  const r = apply(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS), { date: "2026-11-16" }) });
  if (!r.ok) throw new Error(r.error);
  const v = validateDocument(r.doc);
  const geometry = await kernel.project(r.doc, viewSpecs(v.drawing!));
  return composeDrawing(r.doc, { measurements: c.measurements, geometry })!.sheets[0];
}

/** For each dimension, how far each extension line's start is from the nearest drawn view line (sheet mm). */
function gaps(sheet: Awaited<ReturnType<typeof sheetOf>>): { id: string; gap: number }[] {
  const views = new Set(sheet.views.map((v) => v.id));
  const viewLines: Seg[] = sheet.prims
    .filter((p): p is Extract<typeof p, { k: "line" }> => p.k === "line" && !!p.owner && views.has(p.owner) && !p.dash)
    .flatMap((p) => p.pts.slice(1).map((q, i): Seg => [p.pts[i], q]));
  // A circle's centre (seen end on) is where a hole's location is dimensioned from: its extension line starts there.
  const centres = sheet.views.flatMap((v) => v.edges.filter((e) => e.circle).map((e) => {
    const c = e.circle!.c;
    return [v.centre[0] + (c[0] - v.origin[0]) * v.scale, v.centre[1] + (c[1] - v.origin[1]) * v.scale];
  }));
  const out: { id: string; gap: number }[] = [];
  for (const a of sheet.annotations) {
    if (a.type !== "dimension" || a.problem) continue;
    const ext = a.extensions;
    for (const [from] of ext ?? []) out.push({ id: a.id, gap: Math.min(...viewLines.map((s) => distToSeg(from, s)), ...centres.map((c) => Math.hypot(from[0] - c[0], from[1] - c[1]))) });
  }
  return out;
}

describe("extension lines start on the part", () => {
  it("a plate with rounded corners: every extension line is the drafting gap from a drawn edge", async () => {
    const sheet = await sheetOf(plate);
    const g = gaps(sheet);
    expect(g.length).toBeGreaterThan(2);
    const far = g.filter((x) => x.gap > 1.8);
    expect(far, JSON.stringify(far)).toEqual([]);
  }, 120_000);

  it("the example parts too", async () => {
    for (const name of ["bracket", "flange", "mounting-plate"]) {
      const doc = JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8")) as RawDocument;
      const far = gaps(await sheetOf(doc)).filter((x) => x.gap > 1.8);
      expect([name, far]).toEqual([name, []]);
    }
  }, 240_000);
});
