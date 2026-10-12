// Evaluate and view (Phase O wave 5) in the browser, on the bracket (an
// 80 × 40 × 6 plate centred on the origin with a Ø6.6 hole at X 30) and a
// 100 × 60 × 8 steel box: the rollback bar (roll above the hole, add a fillet
// there, roll to the end, undo); Measure (the plate's thickness between its top
// and bottom faces, exactly 6, and a long edge, exactly 80); Mass Properties
// against the box formulas; a section through the hole; the display styles and
// perspective, remembered per document; dragging the extrude's depth handle
// (one undo step) and typing a dimension shown on the model; the command
// palette running Fillet. Each state is screenshotted when SHOTS_DIR is set.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, viewportClick, waitForRebuild } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;
type Raw = Record<string, unknown>;
type Hook = {
  project(p: number[]): [number, number];
  display(): { style: string; perspective: boolean; edgesShown: boolean; surfacesShown: boolean };
  section(): { normal: number[]; constant: number; capped: boolean } | null;
  handlePoint(id: string): [number, number] | null;
};
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/evaluate-${name}.png` });
};
const ids = async (page: Page) => ((await savedDocument(page)).features as Raw[]).map((f) => f.id);
const feature = async (page: Page, id: string) => ((await savedDocument(page)).features as Raw[]).find((f) => f.id === id)!;
/** 80·40·6 − π·3.3²·6 */
const BRACKET = 80 * 40 * 6 - Math.PI * 3.3 * 3.3 * 6;

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

async function openDocument(page: Page, doc: Raw) {
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
}

const evaluateTab = (page: Page) => page.getByTestId("tab-evaluate").click();
const volumeOf = async (page: Page) => Number((await page.getByTestId("volume").textContent())!.replace(/[^\d.]/g, ""));

test("rollback: roll above the hole, add a fillet at the bar, roll to the end; undo puts the bar back", async ({ page }) => {
  await expect.poll(() => volumeOf(page)).toBeCloseTo(BRACKET, 2);
  // Right-click the hole in the tree: Roll back to here.
  await page.getByTestId("feature-hole_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-rollback-here").click();
  await expect(page.getByTestId("rollback-banner")).toContainText("Rolled back above hole_1: 1 feature is not built");
  await expect(page.getByTestId("feature-hole_1")).toHaveClass(/rolled-back/);
  await expect(page.getByTestId("feature-ext_1")).not.toHaveClass(/rolled-back/);
  await expectVolume(page, "19,200");
  expect((await savedDocument(page)).rollback).toBe("hole_1");
  await shot(page, "rollback");

  // A fillet on a short top edge (X = 40, at Z 6) goes in at the bar, above the hole.
  await viewportClick(page, [40, 0, 6]);
  await expect(page.getByTestId("selection")).toContainText("edge");
  await page.getByTestId("tool-fillet").click();
  await waitForRebuild(page);
  expect(await ids(page)).toEqual(["sketch_1", "ext_1", "fillet_1", "hole_1"]);
  expect((await savedDocument(page)).rollback).toBe("hole_1");
  await expect(page.getByTestId("feature-hole_1")).toHaveClass(/rolled-back/);
  await expect(page.getByTestId("feature-fillet_1")).not.toHaveClass(/rolled-back/);
  await shot(page, "rollback-added");

  // Right-click the bar: Roll to end. The hole is built again, after the fillet.
  await page.getByTestId("rollback-bar").click({ button: "right" });
  await page.getByTestId("ctx-rollback-end").click();
  await expect(page.getByTestId("rollback-banner")).toHaveCount(0);
  expect("rollback" in (await savedDocument(page))).toBe(false);
  await expect.poll(() => volumeOf(page)).toBeLessThan(BRACKET - 1);
  await shot(page, "rollback-end");

  // Undo puts the bar back above the hole.
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("rollback-banner")).toBeVisible();
  expect((await savedDocument(page)).rollback).toBe("hole_1");

  // Dragging the bar works too: above ext_1, then the arrow keys move it.
  await page.getByTestId("rollback-bar").dragTo(page.getByTestId("feature-ext_1"));
  await expect(page.getByTestId("rollback-banner")).toContainText("Rolled back above ext_1: 3 features are not built");
  await expect(page.getByTestId("status")).toHaveText(/No solid yet|Rebuilt/);
  await page.getByTestId("rollback-bar").press("ArrowDown");
  await expect(page.getByTestId("rollback-banner")).toContainText("Rolled back above fillet_1");
  await page.getByTestId("rollback-banner-end").click();
  await expect(page.getByTestId("rollback-banner")).toHaveCount(0);
});

test("measure: the plate's thickness between its top and bottom faces is exactly 6, a long edge exactly 80", async ({ page }) => {
  await evaluateTab(page);
  await page.getByTestId("tool-measure").click();
  await expect(page.getByTestId("measure-panel")).toBeVisible();
  // The top face, then (from below) the bottom face: no Ctrl needed while measuring.
  await viewportClick(page, [-20, -10, 6]);
  await expect(page.getByTestId("measure-title")).toHaveText("Flat face");
  await expect(page.getByTestId("measure-value-area")).toHaveText(`${(3200 - Math.PI * 3.3 * 3.3).toFixed(3).replace(/0+$/, "")} mm²`);
  await page.keyboard.press("Control+6");
  await viewportClick(page, [-20, -10, 0]);
  await expect(page.getByTestId("measure-title")).toHaveText("Flat face to flat face");
  await expect(page.getByTestId("measure-value-normal")).toHaveText("6 mm");
  await expect(page.getByTestId("measure-value-distance")).toHaveText("6 mm");
  await expect(page.getByTestId("measure-value-dz")).toHaveText("6 mm");
  await expect(page.getByTestId("measure-value-angle")).toHaveText("0°");
  await expect(page.getByTestId("measure-label")).toHaveText("6 mm");
  await shot(page, "measure-thickness");

  // A long edge on its own: 80. The panel stays open.
  await page.keyboard.press("Control+7");
  await page.getByTestId("measure-clear").click();
  await viewportClick(page, [0, -20, 6]);
  await expect(page.getByTestId("measure-title")).toHaveText("Straight edge");
  await expect(page.getByTestId("measure-value-length")).toHaveText("80 mm");
  // And the hole's top edge: Ø6.6, its centre 20 from the long edge.
  await viewportClick(page, [30, -3.3, 6]);
  await expect(page.getByTestId("measure-title")).toHaveText("Straight edge to circular edge");
  await expect(page.getByTestId("measure-value-centre")).toHaveText("20 mm");
  await expect(page.getByTestId("measure-value-diameter2")).toHaveText("6.6 mm");
  await shot(page, "measure-edge");
  await page.getByTestId("measure-panel-close").click();
  await expect(page.getByTestId("measure-panel")).toHaveCount(0);
});

test("mass properties of a 100 × 60 × 8 steel box match the formulas, the centre of mass is marked", async ({ page }) => {
  await openDocument(page, {
    version: 1,
    units: "mm",
    name: "box",
    material: { name: "Steel", densityKgPerM3: 7850 },
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 100, h: 60 }], constraints: [] },
      { id: "e1", op: "extrude", sketch: "s1", distance: 8 },
    ],
  });
  await evaluateTab(page);
  await page.getByTestId("tool-mass-properties").click();
  // m = 48 000 mm³ · 7.85e-6 kg/mm³ = 0.3768 kg; Ixx = m(60² + 8²)/12, Iyy = m(100² + 8²)/12, Izz = m(100² + 60²)/12.
  await expect(page.getByTestId("mass-volume")).toHaveText("48,000 mm³");
  await expect(page.getByTestId("mass-mass")).toHaveText("0.3768 kg");
  await expect(page.getByTestId("mass-area")).toHaveText(`${(2 * (6000 + 800 + 480)).toLocaleString("en-GB")} mm²`);
  await expect(page.getByTestId("mass-com")).toHaveText("X 0  Y 0  Z 4");
  await expect(page.getByTestId("mass-ixx")).toHaveText("115.05 kg·mm²");
  await expect(page.getByTestId("mass-iyy")).toHaveText("316.01 kg·mm²");
  await expect(page.getByTestId("mass-izz")).toHaveText("427.04 kg·mm²");
  await expect(page.getByTestId("mass-products")).toHaveText("0, 0, 0 kg·mm²");
  await expect(page.getByTestId("com-label")).toBeVisible();
  await shot(page, "mass");
  await page.getByTestId("mass-panel-close").click();
  await expect(page.getByTestId("com-label")).toHaveCount(0);
});

test("section view through the hole: capped, moved, flipped, off again", async ({ page }) => {
  await evaluateTab(page);
  await page.getByTestId("tool-section").click();
  await expect(page.getByTestId("section-panel")).toBeVisible();
  await expect(page.getByTestId("section-plane")).toHaveValue("Front");
  // Front through the middle: Y = 0, right through the hole's centre; the part's front half is cut away.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.section())).toEqual({ normal: [0, 1, 0], constant: 0, capped: true });
  await shot(page, "section-front");
  await commit(page, "section-offset", "5");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.section()?.constant)).toBe(5);
  await page.getByTestId("section-flip").check();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.section()?.normal)).toEqual([0, -1, 0]);
  await page.getByTestId("section-plane").selectOption("Right");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.section()?.normal)).toEqual([-1, 0, 0]);
  await shot(page, "section-right");
  // The tool again turns it off.
  await page.getByTestId("tool-section").click();
  await expect(page.getByTestId("section-panel")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.section())).toBeNull();
});

test("display styles and perspective switch, and are remembered for the document", async ({ page }) => {
  const display = () => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.display());
  expect(await display()).toEqual({ style: "shadedEdges", perspective: true, edgesShown: true, surfacesShown: true });
  const pick = async (style: string) => {
    await page.getByTestId("display-style").click();
    await page.getByTestId(`display-${style}`).click();
  };
  await pick("shaded");
  expect(await display()).toMatchObject({ style: "shaded", edgesShown: false, surfacesShown: true });
  await shot(page, "display-shaded");
  await pick("hiddenRemoved");
  expect(await display()).toMatchObject({ style: "hiddenRemoved", edgesShown: true, surfacesShown: false });
  await shot(page, "display-hidden-removed");
  await pick("hiddenVisible");
  expect(await display()).toMatchObject({ style: "hiddenVisible", edgesShown: true, surfacesShown: false });
  await shot(page, "display-hidden-visible");
  await pick("wireframe");
  expect(await display()).toMatchObject({ style: "wireframe", edgesShown: true, surfacesShown: false });
  await shot(page, "display-wireframe");
  await page.getByTestId("view-perspective").click();
  expect(await display()).toMatchObject({ perspective: false });
  await shot(page, "display-orthographic");

  // Reloaded, the bracket comes back as it was left.
  await page.reload();
  await waitForRebuild(page);
  expect(await display()).toMatchObject({ style: "wireframe", perspective: false });
  await pick("shadedEdges");
  expect(await display()).toMatchObject({ style: "shadedEdges", edgesShown: true, surfacesShown: true });

  // Zoom to selection and Previous view.
  await viewportClick(page, [30, -3.3, 6]);
  await page.getByTestId("view-zoom-selection").click();
  await page.waitForTimeout(600);
  await shot(page, "zoom-selection");
  await page.getByTestId("view-previous").click();
  await expect(page.getByTestId("notice")).toHaveCount(0);
});

test("drag the extrude's depth handle: the depth follows in whole millimetres, one undo step; type a dimension on the model", async ({ page }) => {
  // Pick the extrude in the tree: its depth arrow shows on the end face.
  await page.getByTestId("feature-ext_1").locator(".feature-row").click();
  const point = () => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.handlePoint("ext_1:distance"));
  await expect.poll(point).not.toBeNull();
  await expect(page.getByTestId("handle-label-ext_1:distance")).toHaveText("Depth 6 mm");
  const [x, y] = (await point())!;
  // Up the screen is up the part (+Z) in the isometric view.
  const [, y10] = await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.project([0, 0, 16]));
  const [, y6] = await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.project([0, 0, 6]));
  const perMm = (y6 - y10) / 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - perMm * 2, { steps: 4 });
  await page.mouse.move(x, y - perMm * 4.2, { steps: 4 });
  await expect(page.getByTestId("handle-label-ext_1:distance")).toHaveText("Depth 10 mm");
  await shot(page, "handle-drag");
  await page.mouse.up();
  await expect.poll(async () => (await feature(page, "ext_1")).distance).toBe(10);
  await expectVolume(page, (80 * 40 * 10 - Math.PI * 3.3 * 3.3 * 10).toLocaleString("en-US", { maximumFractionDigits: 0 }).slice(0, 5));
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await feature(page, "ext_1")).distance).toBe(6);

  // Double-click the extrude in the tree: its dimensions on the model (the sketch's width, the depth).
  await page.getByTestId("feature-ext_1").locator(".feature-row").dblclick();
  await expect(page.getByTestId("dims-chip")).toContainText("ext_1");
  await expect(page.getByTestId("dim3d-ext_1:distance")).toHaveText("6");
  await expect(page.getByTestId("dim3d-sketch_1:0")).toHaveText("80");
  await shot(page, "dimensions");
  await page.getByTestId("dim3d-sketch_1:0").dblclick();
  await commit(page, "dim-box-value", "90");
  await expect.poll(async () => ((await feature(page, "sketch_1")).constraints as Raw[])[0].value).toBe(90);
  await expect(page.getByTestId("dim3d-sketch_1:0")).toHaveText("90");
  await page.getByTestId("dim3d-ext_1:distance").dblclick();
  await commit(page, "dim-box-value", "8");
  await expect.poll(async () => (await feature(page, "ext_1")).distance).toBe(8);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("dims-chip")).toHaveCount(0);
});

test("selection filter, hover highlight in the tree, and the command palette runs Fillet", async ({ page }) => {
  // Edges only: a click on the top face picks nothing.
  await page.getByTestId("filter-edges").click();
  await viewportClick(page, [-20, -10, 6]);
  await expect(page.getByTestId("selection")).toHaveCount(0);
  await viewportClick(page, [40, 0, 6]);
  await expect(page.getByTestId("selection")).toContainText("edge");
  await page.getByTestId("filter-edges").click();

  // Hovering the extrude: its sketch is a parent; hovering the sketch, the extrude is its child.
  await page.getByTestId("feature-ext_1").hover();
  await expect(page.getByTestId("feature-sketch_1")).toHaveAttribute("data-relation", "parent");
  await expect(page.getByTestId("feature-hole_1")).not.toHaveAttribute("data-relation", /./);
  await page.getByTestId("feature-sketch_1").hover();
  await expect(page.getByTestId("feature-ext_1")).toHaveAttribute("data-relation", "child");
  await shot(page, "tree-relations");

  // Ctrl+K, "fil", Enter: Fillet on the selected edge.
  await page.getByTestId("viewport").hover();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("palette-input").fill("fil");
  await expect(page.getByTestId("palette-item-tool.fillet")).toBeVisible();
  await shot(page, "palette");
  await page.getByTestId("palette-input").press("Enter");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect.poll(() => ids(page)).toContain("fillet_1");
  await waitForRebuild(page);
});
