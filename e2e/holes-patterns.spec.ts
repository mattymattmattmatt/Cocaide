// Wave 5 in the browser: the Hole Wizard (an M6 counterbore at three sketch
// points, a tapped M8 called out on a drawing), a linear pattern of two
// features with one instance skipped and its direction from a picked edge, a
// circular pattern spanning 180°, a mirror about a face picked in the view,
// and a sketch-driven pattern. Volumes worked out in the comments.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, viewportClick, waitForRebuild } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;
/** A volume as the Measurements panel shows it: en-US, at most 3 decimals, with its unit. */
const shown = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 3 })} mm³`;
const feature = async (page: Page, id: string) => ((await savedDocument(page)) as { features: Record<string, unknown>[] }).features.find((f) => f.id === id);

const W = 100;
const D = 60;
const T = 10;
/** The plate: 100 x 60 x 10, x -50..50, y -30..30, z 0..10. */
const PLATE = W * D * T;
const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const cyl = (d: number, h: number) => Math.PI * (d / 2) ** 2 * h;

const plateFeatures = [
  { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: W, h: D }], constraints: [] },
  { id: "plate", op: "extrude", sketch: "s1", distance: T },
];
const points = (id: string, at: [number, number][]) => ({
  id,
  op: "sketch",
  plane: { type: "ref", ref: { face: TOP } },
  entities: at.map((p, i) => ({ id: `p${i + 1}`, type: "point", at: p })),
  constraints: [],
});
const hole = (id: string, center: [number, number], diameter = 6) => ({ id, op: "hole", face: TOP, center, diameter, depth: "through" });

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

/** Opens a document as if it had been worked on before (the app keeps it in local storage). */
async function openDocument(page: Page, features: unknown[]) {
  const text = JSON.stringify({ version: 1, units: "mm", name: "part", features }, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
}

/** Selects a feature in the tree. */
async function select(page: Page, id: string) {
  await page.getByTestId(`feature-${id}`).locator(".feature-row").click();
  await expect(page.getByTestId("prop-id")).toHaveValue(id);
}

async function patternTool(page: Page, which: "linear" | "circular" | "sketch") {
  await page.getByTestId("tool-pattern").click();
  await page.getByTestId(`tool-${which}-pattern`).click();
}

test("Hole Wizard: an M6 counterbore at three sketch points, numbers from the table", async ({ page }) => {
  await openDocument(page, [...plateFeatures, points("pts", [[-30, 0], [0, 0], [30, 0]])]);
  await expectVolume(page, shown(PLATE));

  // The sketch of points selected in the tree, then Hole: a hole at each point, on the face the sketch is on.
  await select(page, "pts");
  await page.getByTestId("tool-hole").click();
  await expect(page.getByTestId("prop-id")).toHaveValue("hole_1");
  await expect(page.getByTestId("prop-hole-position")).toHaveValue("points");
  await expect(page.getByTestId("prop-hole-points")).toHaveValue("pts");
  await expectVolume(page, shown(PLATE - 3 * cyl(5, T)));

  // Counterbore, then M6: the table's Ø6.6 clearance (normal fit) and Ø11 x 6.5 counterbore (ISO 4762 head).
  await page.getByTestId("prop-hole-kind-counterbore").click();
  await expect(page.getByTestId("prop-hole-kind-counterbore")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("prop-hole-size").selectOption("M6");
  await expect(page.getByTestId("prop-diameter")).toHaveValue("6.6");
  await expect(page.getByTestId("prop-counterbore-diameter")).toHaveValue("11");
  await expect(page.getByTestId("prop-counterbore-depth")).toHaveValue("6.5");
  // Each hole: the bore through, plus the counterbore's ring 6.5 deep.
  const one = cyl(6.6, T) + (cyl(11, 6.5) - cyl(6.6, 6.5));
  await expectVolume(page, shown(PLATE - 3 * one));
  await expect(page.getByTestId("prop-hole-callout")).toHaveText("3× Ø6.6 THRUCBORE Ø11 × 6.5 DEEP");
  expect(await feature(page, "hole_1")).toEqual({ id: "hole_1", op: "hole", face: TOP, points: "pts", depth: "through", kind: "counterbore", size: "M6" });

  // A close fit: Ø6.4.
  await page.getByTestId("prop-hole-fit").selectOption("close");
  await expect(page.getByTestId("prop-diameter")).toHaveValue("6.4");
  await expectVolume(page, shown(PLATE - 3 * (cyl(6.4, T) + cyl(11, 6.5) - cyl(6.4, 6.5))));

  // A number given wins over the table, and "Use the table" takes it back.
  await commit(page, "prop-counterbore-depth", "4");
  await expectVolume(page, shown(PLATE - 3 * (cyl(6.4, T) + cyl(11, 4) - cyl(6.4, 4))));
  await page.getByTestId("prop-counterbore-depth-table").click();
  await expect(page.getByTestId("prop-counterbore-depth")).toHaveValue("6.5");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/hole-wizard.png` });
  // The README picture of the Hole Wizard.
  await page.screenshot({ path: "docs/phase-o-hole-wizard.png" });
});

test("Hole Wizard: a tapped M8 blind hole, called out M8×1.25 - 6H ⌴11.25 on the drawing", async ({ page }) => {
  // A 30 thick block, so the 15 deep hole stops inside it.
  await openDocument(page, [plateFeatures[0], { ...plateFeatures[1], distance: 30 }]);
  // Click the top face, then Hole: one hole where it was clicked.
  await viewportClick(page, [0, 0, 30]);
  await expect(page.getByTestId("selection")).toContainText("normal +Z");
  await page.getByTestId("tool-hole").click();
  await commit(page, "prop-center-x", "0");
  await commit(page, "prop-center-y", "0");
  await page.getByTestId("prop-hole-kind-tapped").click();
  await page.getByTestId("prop-hole-size").selectOption("M8");
  await page.getByTestId("prop-hole-end").selectOption("blind");
  await commit(page, "prop-depth", "15");
  // The tap drill, Ø6.8, 15 deep; the thread is cosmetic (11.25 deep: the drill less three pitches).
  await expect(page.getByTestId("prop-diameter")).toHaveValue("6.8");
  await expect(page.getByTestId("prop-thread")).toContainText("M8×1.25 - 6H");
  await expect(page.getByTestId("prop-thread-depth")).toHaveValue("11.25");
  await expectVolume(page, shown(W * D * 30 - cyl(6.8, 15)));
  await expect(page.getByTestId("prop-hole-callout")).toHaveText("M8×1.25 - 6H ⌴11.25Ø6.8 ⌴15");

  // The drawing calls it out with its thread; the depth symbol is drawn, so the text comes in pieces around it.
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await expect(page.getByTestId("sheet")).toBeVisible();
  await expect.poll(async () => (await page.getByTestId("sheet").locator("text").allTextContents()).join("|")).toMatch(/M8×1\.25 - 6H \|11\.25\|Ø6\.8 \|15/);
  // The callout leaves the view through its nearer side: it stays on the sheet.
  await expect(page.getByTestId("drawing-checks")).toContainText("Every hole is called out");
  await expect(page.getByTestId("drawing-checks")).toContainText(/runs off the sheet\s*:\s*clear/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tapped-callout.png` });
});

test("linear pattern of two features, one instance skipped, along an edge picked in the view", async ({ page }) => {
  // Two Ø4 holes at x = -40, y = ±15.
  await openDocument(page, [...plateFeatures, hole("a", [-40, -15], 4), hole("b", [-40, 15], 4)]);
  await select(page, "a");
  await patternTool(page, "linear");
  await expect(page.getByTestId("prop-id")).toHaveValue("pattern_1");
  // Both features, 4 instances 20 apart: x = -40, -20, 0, 20.
  await page.getByTestId("prop-pattern-features-b").check();
  await commit(page, "prop-spacing", "20");
  await commit(page, "prop-count", "4");
  await expectVolume(page, shown(PLATE - 8 * cyl(4, T)));
  // Instance 3 (x = 0) left out, for both features.
  await page.getByTestId("prop-pattern-skip-3").uncheck();
  await expectVolume(page, shown(PLATE - 6 * cyl(4, T)));
  expect(await feature(page, "pattern_1")).toMatchObject({ features: ["a", "b"], skip: [3], count: 4, spacing: 20 });

  // The direction from the plate's front top edge (along +X), picked in the view: it follows the model.
  await viewportClick(page, [0, -D / 2, T]);
  await page.getByTestId("prop-pattern-along-use").click();
  await expect(page.getByTestId("prop-pattern-along-ref")).toBeVisible();
  await expect(page.getByTestId("prop-pattern-direction")).toHaveCount(0);
  expect((await feature(page, "pattern_1"))!.along).toHaveProperty("edge");
  await expectVolume(page, shown(PLATE - 6 * cyl(4, T)));
  // Reversed it runs off the plate: the error says which instance.
  await page.getByTestId("prop-pattern-reverse").check();
  await expect(page.getByTestId("prop-feature-error")).toContainText("instance 2");
  await page.getByTestId("prop-pattern-reverse").uncheck();
  await expectVolume(page, shown(PLATE - 6 * cyl(4, T)));
});

test("circular pattern spanning 180°: three instances 90° apart, the last on the end", async ({ page }) => {
  await openDocument(page, [...plateFeatures, hole("h", [20, 0])]);
  await select(page, "h");
  await patternTool(page, "circular");
  // About the Z axis, by reference.
  await page.getByTestId("prop-pattern-axis-mode").selectOption("ref");
  await expect(page.getByTestId("prop-pattern-axis")).toHaveValue("Z");
  await commit(page, "prop-count", "3");
  await commit(page, "prop-angle", "180");
  // At (20, 0), (0, 20) and (-20, 0).
  await expectVolume(page, shown(PLATE - 3 * cyl(6, T)));
  await expect(page.getByTestId("prop-pattern-skip")).toContainText("2 (90°)");
  await expect(page.getByTestId("prop-pattern-skip")).toContainText("3 (180°)");
  expect(await feature(page, "circular_1")).toMatchObject({ feature: "h", axis: { ref: { datum: "Z" } }, count: 3, angle: 180 });
});

test("mirror about a face picked in the view", async ({ page }) => {
  // A 10 x 60 x 20 block on the plate at x -10..0: its +X face is the plane x = 0. A Ø6 hole at x = -30 in the plate's
  // left top face (the innermost level facing +Z, the smaller of the two).
  await openDocument(page, [
    ...plateFeatures,
    { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, T] }, entities: [{ id: "r2", type: "rect", center: [-5, 0], w: 10, h: D }], constraints: [] },
    { id: "block", op: "extrude", sketch: "s2", distance: 20 },
    { id: "h", op: "hole", face: { type: "planar", normal: [0, 0, 1], rank: -1, pick: "smallest" }, center: [-30, 0], diameter: 6, depth: "through" },
  ]);
  const block = 10 * D * 20;
  await expectVolume(page, shown(PLATE + block - cyl(6, T)));
  await select(page, "h");
  await viewportClick(page, [0, 0, T + 10]);
  await expect(page.getByTestId("selection")).toContainText("normal +X");
  await page.getByTestId("tool-mirror").click();
  await expect(page.getByTestId("prop-id")).toHaveValue("mirror_1");
  // The copy at x = 30.
  await expectVolume(page, shown(PLATE + block - 2 * cyl(6, T)));
  await expect(page.getByTestId("prop-mirror-plane-ref")).toContainText("+X");
  expect((await feature(page, "mirror_1"))!.plane).toMatchObject({ type: "ref", ref: { face: { normal: [1, 0, 0] } } });
});

test("sketch-driven pattern: copies at a sketch's points, one left out", async ({ page }) => {
  await openDocument(page, [...plateFeatures, hole("h", [-30, 0]), points("pts", [[-30, 0], [0, 10], [25, -15], [40, 20]])]);
  await select(page, "h");
  await patternTool(page, "sketch");
  await expect(page.getByTestId("prop-id")).toHaveValue("sketchPattern_1");
  await expect(page.getByTestId("prop-sketch-pattern-sketch")).toHaveValue("pts");
  // The seed at the first point; a copy at each of the other three.
  await expectVolume(page, shown(PLATE - 4 * cyl(6, T)));
  await page.getByTestId("prop-pattern-skip-3").uncheck();
  await expectVolume(page, shown(PLATE - 3 * cyl(6, T)));
  // A table of positions instead: it starts from the points as they are; then one moved by typing.
  await page.getByTestId("prop-sketch-pattern-places").selectOption("table");
  await expectVolume(page, shown(PLATE - 3 * cyl(6, T)));
  await commit(page, "prop-position-y-1", "-10");
  await expectVolume(page, shown(PLATE - 3 * cyl(6, T)));
  expect(await feature(page, "sketchPattern_1")).toMatchObject({ positions: [[-30, 0], [0, -10], [25, -15], [40, 20]], skip: [3] });
});
