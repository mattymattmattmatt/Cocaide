// A view turned on the sheet (DrawingView.rotation): its lines turn about
// its centre, its horizontal and vertical dimensions turn with it (along the
// part's edges, their values unchanged, extension lines still on the part),
// their text reads from the bottom or the right whatever the turn, and notes
// and callouts stay upright.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeDrawing, viewToSheet, type ComposedSheet } from "../src/drafting/compose";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { viewSpecs } from "../src/drafting/specs";
import { getOC, loadOC } from "../src/kernel";

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
}, 120_000);

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
type Raw = { drawing: { sheets: { views: { id: string; rotation?: number }[] }[] } };

async function sheetWith(turn: number | undefined): Promise<{ sheet: ComposedSheet; doc: RawDocument }> {
  const c = await kernel.check(bracket);
  const r = apply(bracket, { type: "setDrawing", drawing: planDrawing(bracket, c.measurements, await kernel.project(bracket, DEFAULT_VIEWS), { date: "2026-11-17" }) });
  if (!r.ok) throw new Error(r.error);
  const raw = JSON.parse(JSON.stringify(r.doc)) as Raw;
  const top = raw.drawing.sheets[0].views.find((v) => v.id === "top")!;
  if (turn !== undefined) top.rotation = turn;
  const doc = raw as unknown as RawDocument;
  const v = validateDocument(doc);
  const geometry = await kernel.project(doc, viewSpecs(v.drawing!));
  return { sheet: composeDrawing(doc, { measurements: c.measurements, geometry })!.sheets[0], doc };
}

const angleOf = (a: number[], b: number[]) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
/** The same direction as `want`, either way along (degrees). */
const parallel = (deg: number, want: number) => {
  const d = (((deg - want) % 180) + 180) % 180;
  return Math.min(d, 180 - d) < 0.01;
};
type Seg = [number[], number[]];
const distToSeg = (p: number[], [a, b]: Seg) => {
  const ab = [b[0] - a[0], b[1] - a[1]];
  const l2 = ab[0] ** 2 + ab[1] ** 2 || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
  return Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1]);
};

describe("a turned view", () => {
  it("is stored and checked: degrees, -360 to 360", () => {
    const bad = (rotation: unknown) => {
      const raw = JSON.parse(JSON.stringify({ ...bracket, drawing: { sheets: [{ id: "s", views: [{ id: "v", look: "top", rotation }], annotations: [] }] } }));
      return (validateDocument(raw) as unknown as { drawingErrors: string[] }).drawingErrors.filter((e) => e.includes("rotation"));
    };
    expect(bad(30)).toEqual([]);
    expect(bad(-90)).toEqual([]);
    expect(bad(400).join(" ")).toMatch(/rotation/);
    expect(bad("30").join(" ")).toMatch(/rotation/);
  });

  for (const turn of [30, 150, -90]) {
    it(`turned ${turn}°: its lines and its dimensions turn, the values stay, the text reads, the extension lines start on the part`, async () => {
      const plain = (await sheetWith(undefined)).sheet;
      const { sheet } = await sheetWith(turn);
      const cv = sheet.views.find((v) => v.id === "top")!;
      expect(cv.rotation).toBe(turn);
      // The plate's long edge (80 along the view's x) now runs at the turn.
      const edges = cv.edges.filter((e) => e.visible && e.look === "line" && e.pts.length === 2);
      const long = edges.find((e) => Math.abs(Math.abs(e.pts[1][0] - e.pts[0][0]) - 80) < 1e-6 && Math.abs(e.pts[1][1] - e.pts[0][1]) < 1e-6)!;
      const [a, b] = long.pts.map((p) => viewToSheet(cv, p));
      expect(parallel(angleOf(a, b), turn)).toBe(true);
      // A drawn line of the view lies there.
      const drawn = sheet.prims.filter((p) => p.k === "line" && p.owner === "top" && !p.fill) as { pts: number[][] }[];
      expect(drawn.some((p) => p.pts.some((q) => Math.hypot(q[0] - a[0], q[1] - a[1]) < 0.05))).toBe(true);

      const dims = sheet.annotations.filter((x) => x.type === "dimension" && x.view === "top" && !x.problem);
      expect(dims.length).toBeGreaterThan(1);
      for (const d of dims) {
        const was = plain.annotations.find((x) => x.id === d.id)!;
        expect([d.id, d.value]).toEqual([d.id, was.value]);
        expect(d.text).toBe(was.text);
      }
      // The 80: its line along the plate's long edge.
      const eighty = dims.find((d) => d.value !== undefined && Math.abs(d.value - 80) < 1e-6)!;
      const line = sheet.prims.filter((p) => p.k === "line" && p.owner === eighty.id && !p.fill) as { pts: number[][] }[];
      expect(line.some((p) => p.pts.length === 2 && Math.hypot(p.pts[1][0] - p.pts[0][0], p.pts[1][1] - p.pts[0][1]) > 20 && parallel(angleOf(p.pts[0], p.pts[1]), turn))).toBe(true);
      // Every dimension's text reads from the bottom or the right.
      const texts = sheet.prims.filter((p) => p.k === "text" && dims.some((d) => d.id === p.owner)) as { angle?: number; text: string }[];
      expect(texts.length).toBeGreaterThan(1);
      for (const t of texts) {
        const ang = t.angle ?? 0;
        expect([t.text, ang > -90 - 1e-6 && ang <= 90 + 1e-6]).toEqual([t.text, true]);
      }
      // Each extension line starts the drafting gap from a drawn line of the view, or at a hole's centre.
      const segs: Seg[] = drawn.flatMap((p) => p.pts.slice(1).map((q, i): Seg => [p.pts[i], q]));
      const centres = cv.edges.filter((e) => e.circle).map((e) => viewToSheet(cv, e.circle!.c));
      for (const d of dims)
        for (const [from] of d.extensions ?? []) {
          const gap = Math.min(...segs.map((s) => distToSeg(from, s)), ...centres.map((c) => Math.hypot(from[0] - c[0], from[1] - c[1])));
          expect([d.id, gap <= 1.8]).toEqual([d.id, true]);
        }
      // Callouts and notes stay upright.
      const callouts = sheet.prims.filter((p) => p.k === "text" && sheet.annotations.some((x) => x.id === p.owner && (x.type === "hole" || x.type === "note"))) as { angle?: number }[];
      for (const t of callouts) expect(t.angle ?? 0).toBe(0);
    }, 120_000);
  }

  it("not turned: the sheet is as it was", async () => {
    const a = (await sheetWith(undefined)).sheet;
    const b = (await sheetWith(0)).sheet;
    expect(JSON.stringify(b.prims)).toBe(JSON.stringify(a.prims));
  }, 120_000);
});
