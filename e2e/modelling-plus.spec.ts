// Phase P wave 3B in the browser: a fill pattern of a hole over a plate's
// face, a curve-driven pattern along an arc, a modelled M10 thread on a
// shaft and a cosmetic one shown in the view and called out on a drawing, a
// coordinate system used by a table pattern, text engraved into a plate, a
// dome, and intersection curves added to a sketch. Volumes in the comments.

import { expect, test, type Page } from "@playwright/test";
import { okFeature, savedDocument, viewportClick, waitForRebuild, openApp, commit } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;
const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const cyl = (d: number, h: number) => Math.PI * (d / 2) ** 2 * h;
const PLATE = 100 * 60 * 10;
const plate = [
  { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: 100, h: 60 }], constraints: [] },
  { id: "e1", op: "extrude", sketch: "s1", distance: 10 },
];
const hole = (id: string, center: [number, number], diameter = 6) => ({ id, op: "hole", face: TOP, center, diameter, depth: "through" });

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});
test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

async function openDocument(page: Page, features: unknown[]) {
  const text = JSON.stringify({ version: 1, units: "mm", name: "part", features }, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
}

/** The part's volume as the panel shows it, a number. */
async function volume(page: Page): Promise<number> {
  const t = (await page.getByTestId("volume").textContent()) ?? "";
  return Number(t.replace(/[^0-9.]/g, ""));
}
async function expectVolumeNear(page: Page, v: number, tol: number) {
  await expect.poll(async () => Math.abs((await volume(page)) - v), { timeout: 30_000 }).toBeLessThan(tol);
}

async function select(page: Page, id: string) {
  await page.getByTestId(`feature-${id}`).locator(".feature-row").click();
  await expect(page.getByTestId("prop-id")).toHaveValue(id);
}

test("fill pattern: a hole repeated over the plate's top, 5 mm in from the edges", async ({ page }) => {
  await openDocument(page, [...plate, hole("h1", [-40, -20])]);
  await select(page, "h1");
  await page.getByTestId("tool-pattern").click();
  await page.getByTestId("tool-fill-pattern").click();
  // The face to fill waits for a click.
  await viewportClick(page, [10, 5, 10]);
  await commit(page, "prop-spacing", "20");
  await commit(page, "prop-fill-margin", "5");
  // x -40 .. 40 by y -20 .. 20: 15 holes.
  await expect(page.getByTestId("prop-fill-count")).toContainText("15 instances");
  await okFeature(page);
  await expectVolumeNear(page, PLATE - 15 * cyl(6, 10), 0.01);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/fill-pattern.png` });
});

test("curve-driven pattern: holes along an arc", async ({ page }) => {
  await openDocument(page, [
    ...plate,
    { id: "arc", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] }, entities: [{ id: "a", type: "arc", center: [0, 0], start: [20, 0], end: [-20, 0] }], constraints: [] },
    hole("h1", [-20, 0]),
  ]);
  await select(page, "h1");
  await page.getByTestId("tool-pattern").click();
  await page.getByTestId("tool-curve-pattern").click();
  await commit(page, "prop-count", "5");
  await okFeature(page);
  await expectVolumeNear(page, PLATE - 5 * cyl(6, 10), 0.01);
  const f = ((await savedDocument(page)) as { features: Record<string, unknown>[] }).features.find((g) => g.op === "curvePattern");
  expect(f).toMatchObject({ feature: "h1", path: { sketch: "arc" }, count: 5 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/curve-pattern.png` });
});

const shaft = [
  { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 5 }], constraints: [] },
  { id: "e1", op: "extrude", sketch: "s1", distance: 30 },
];

test("a modelled M10 thread on a shaft: the groove's volume", async ({ page }) => {
  await openDocument(page, shaft);
  await viewportClick(page, [5, 0, 20]);
  await page.getByTestId("tool-thread").click();
  await expect(page.getByTestId("prop-thread-callout")).toContainText("M10×1.5 - 6g");
  await commit(page, "prop-thread-length", "20");
  await page.getByTestId("prop-thread-modelled").check();
  await okFeature(page);
  // The ISO groove over 20 mm: 20 / 1.5 turns × 2π ∫ρ w dρ = 267.97 mm³ (tests/threads.test.ts works it out).
  await expectVolumeNear(page, Math.PI * 25 * 30 - 267.966, 2);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/thread-modelled.png` });
});

test("a cosmetic thread: drawn on the shaft and called out on the drawing", async ({ page }) => {
  await openDocument(page, [...shaft, { id: "t1", op: "thread", face: { type: "cylindrical", radius: 5, pick: "largest" }, length: 20 }]);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cocaideViewport: { threads(): number } }).__cocaideViewport.threads())).toBe(1);
  // Nothing is cut.
  await expectVolumeNear(page, Math.PI * 25 * 30, 0.01);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/thread-cosmetic.png` });
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await expect(page.getByTestId("sheet")).toBeVisible();
  await expect.poll(async () => (await page.getByTestId("sheet").locator("text").allTextContents()).join("|")).toMatch(/M10×1\.5 - 6g/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/thread-callout.png` });
});

test("a coordinate system places a table pattern's holes; the table is pasted", async ({ page }) => {
  await openDocument(page, [...plate, hole("h1", [-40, -20]), { id: "cs1", op: "coordinateSystem", origin: { point: [-40, -20, 10] } }]);
  await select(page, "h1");
  await page.getByTestId("tool-pattern").click();
  await page.getByTestId("tool-table-pattern").click();
  // The newest coordinate system is taken; paste the table.
  await page.getByTestId("prop-table-paste-toggle").click();
  await page.getByTestId("prop-table-paste").fill("x, y\n0, 0\n20, 0\n0, 30\n70, 40");
  await page.getByTestId("prop-table-paste-use").click();
  await okFeature(page);
  await expectVolumeNear(page, PLATE - 4 * cyl(6, 10), 0.01);
  const f = ((await savedDocument(page)) as { features: Record<string, unknown>[] }).features.find((g) => g.op === "tablePattern");
  expect(f).toMatchObject({ system: { datum: "cs1" }, positions: [[0, 0], [20, 0], [0, 30], [70, 40]] });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/table-pattern.png` });
});

test("text engraved 1 mm into a plate: the volume less the letters' area", async ({ page }) => {
  await openDocument(page, [
    ...plate,
    { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] }, entities: [{ id: "t1", type: "text", at: [0, -5], text: "COCAIDE", height: 10, align: "center" }], constraints: [] },
    { id: "c1", op: "cut", sketch: "s2", distance: 1, direction: [0, 0, -1] },
  ]);
  const before = PLATE;
  const after = await volume(page);
  // The letters' area (about 230 mm² for 10 mm capitals) taken 1 mm deep.
  expect(before - after).toBeGreaterThan(150);
  expect(before - after).toBeLessThan(400);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/text-engraved.png` });
  // The sketch opens with the text in it; selecting it opens its box.
  await select(page, "s2");
  await page.getByTestId("edit-sketch").click();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
  await page.getByTestId("finish-sketch").click();
});

test("a dome on a round boss: the spherical cap's volume", async ({ page }) => {
  await openDocument(page, [
    { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 20 }], constraints: [] },
    { id: "e1", op: "extrude", sketch: "s1", distance: 20 },
  ]);
  await viewportClick(page, [5, 5, 20]);
  await page.getByTestId("tool-dome").click();
  await commit(page, "prop-dome-height", "6");
  await okFeature(page);
  // π·20²·20 + π·6·(3·20² + 6²)/6.
  await expectVolumeNear(page, Math.PI * 400 * 20 + (Math.PI * 6 * (1200 + 36)) / 6, 0.05);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dome.png` });
});

test("intersection curves: where the plate's faces cut a Front sketch", async ({ page }) => {
  await openDocument(page, [
    ...plate,
    { id: "s2", op: "sketch", plane: { type: "ref", ref: { datum: "Front" } }, entities: [{ id: "p1", type: "point", at: [0, 20] }], constraints: [] },
  ]);
  await select(page, "s2");
  await page.getByTestId("edit-sketch").click();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
  await page.keyboard.press("Escape");
  // Right-click empty sketch space: Intersection curve adds the top, bottom and end faces' cuts.
  await page.getByTestId("sketch-canvas").click({ button: "right", position: { x: 40, y: 40 } });
  await page.getByTestId("ctx-intersection-curve").click();
  await page.getByTestId("finish-sketch").click();
  await waitForRebuild(page);
  const s = ((await savedDocument(page)) as { features: Record<string, unknown>[] }).features.find((g) => g.id === "s2") as { entities: { type: string; ref?: { section?: unknown } }[] };
  const curves = s.entities.filter((e) => e.ref?.section);
  expect(curves.length).toBe(4);
  expect(curves.every((e) => e.type === "line")).toBe(true);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/intersection-curve.png` });
});
