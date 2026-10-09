// Reference geometry in the browser (Wave 1A): planes, axes and points from
// the Reference tab, picked from the selection; sketches placed on a plane or
// a face by reference, following it; the default planes in the tree and the
// view, shown SOLIDWORKS-style.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, sketchClick, viewportClick } from "./helpers";

type Hook = { __cocaideViewport: { datums(): string[]; datumPoint(id: string): [number, number] | null } };
const drawn = (page: Page) => page.evaluate(() => (window as unknown as Hook).__cocaideViewport.datums());
const boundingBox = (page: Page) => page.getByTestId("measurements").locator("dd").first();
type Doc = { features: Record<string, unknown>[] };

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("an offset plane from Top, a sketch on it, extruded: the body sits at the offset", async ({ page }) => {
  await page.getByTestId("tab-reference").click();
  // Nothing selected: a plane 10 mm above Top, and a notice saying what to select next time.
  await page.getByTestId("tool-plane").click();
  await expect(page.getByTestId("notice")).toContainText("Made a plane 10 mm above Top");
  await expect(page.getByTestId("feature-plane_1")).toBeVisible();
  await commit(page, "prop-distance", "20");
  await expect(page.getByTestId("prop-datum-where")).toHaveText("through 0, 0, 20 · normal +Z");
  expect(await drawn(page)).toContain("plane_1");
  // The plane feature is selected in the tree: Sketch sketches on it straight away.
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, 0, 0);
  await sketchClick(page, 10, 0);
  await page.getByTestId("finish-sketch").click();
  const doc = (await savedDocument(page)) as Doc;
  expect(doc.features.find((f) => f.id === "sketch_2")?.plane).toEqual({ type: "ref", ref: { datum: "plane_1" } });
  await page.getByTestId("tab-features").click();
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "10");
  // The plate is 0..6; the cylinder 20..30 above it.
  await expect(boundingBox(page)).toHaveText("80 × 40 × 30 mm");
  // Move the plane and the cylinder goes with it.
  await page.getByTestId("feature-plane_1").locator(".feature-row").click();
  await commit(page, "prop-distance", "40");
  await expect(boundingBox(page)).toHaveText("80 × 40 × 50 mm");
});

test("the default planes: listed first in the tree, shown while selected or by their eye, remembered", async ({ page }) => {
  await expect(page.getByTestId("datum-Front")).toBeVisible();
  // Hidden until selected (SOLIDWORKS); the origin's triad is shown.
  expect(await drawn(page)).toEqual(["Origin"]);
  await page.getByTestId("datum-Top").locator(".feature-row").click();
  await expect(page.getByTestId("selection")).toHaveText("Selected: Top plane");
  expect(await drawn(page)).toContain("Top");
  await page.screenshot({ path: "out/e2e/datums-top-selected.png" });
  // Its menu: sketch on it.
  await page.getByTestId("datum-Top").locator(".feature-row").click({ button: "right" });
  await expect(page.getByTestId("ctx-sketch-plane")).toBeVisible();
  await page.keyboard.press("Escape");
  // Click off it: hidden again. The eye shows it for good, and the choice is kept across a reload.
  await page.getByTestId("datum-Top").locator(".feature-row").click(); // still selected: stays
  await viewportClick(page, [-10, 5, 6]);
  expect(await drawn(page)).not.toContain("Top");
  await page.getByTestId("datum-Front").hover();
  await page.getByTestId("datum-eye-Front").click();
  await page.getByTestId("datum-Right").hover();
  await page.getByTestId("datum-eye-Right").click();
  await page.getByTestId("datum-Top").hover();
  await page.getByTestId("datum-eye-Top").click();
  expect(await drawn(page)).toEqual(expect.arrayContaining(["Front", "Top", "Right", "Origin"]));
  await page.getByRole("button", { name: "Iso" }).click();
  await page.mouse.move(5, 5);
  await page.getByTestId("viewport").screenshot({ path: "out/e2e/datums-planes-shown.png" });
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/, { timeout: 60_000 });
  expect(await drawn(page)).toEqual(expect.arrayContaining(["Front", "Top", "Right"]));
  // The Planes toggle hides them all (the origin keeps its own eye).
  await page.getByTestId("view-planes").click();
  expect(await drawn(page)).toEqual(["Origin"]);
  // A plane in the view is picked on its border, never in front of the part.
  await page.getByTestId("view-planes").click();
  const at = await page.evaluate(() => (window as unknown as Hook).__cocaideViewport.datumPoint("Right"));
  await page.mouse.click(at![0], at![1]);
  await expect(page.getByTestId("selection")).toHaveText("Selected: Right plane");
  await viewportClick(page, [-10, 5, 6]);
  await expect(page.getByTestId("selection")).toContainText("planar face");
});

test("a sketch on a face of the bracket follows the face when the extrude gets deeper", async ({ page }) => {
  await viewportClick(page, [-10, 5, 6]);
  // A face selected: Sketch sketches on it straight away.
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, -20, 0);
  await sketchClick(page, -10, 0);
  await page.getByTestId("finish-sketch").click();
  const doc = (await savedDocument(page)) as Doc;
  expect(doc.features.find((f) => f.id === "sketch_2")?.plane).toEqual({ type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } });
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "10");
  await expect(boundingBox(page)).toHaveText("80 × 40 × 16 mm");
  // Deeper plate: the boss stands on its new top face.
  await page.getByTestId("feature-ext_1").locator(".feature-row").click();
  await commit(page, "prop-distance", "10");
  await expect(boundingBox(page)).toHaveText("80 × 40 × 20 mm");
  // The sketch opens where it is now, and finishing keeps its plane a reference.
  await page.getByTestId("feature-sketch_2").locator(".feature-row").dblclick();
  await page.getByTestId("finish-sketch").click();
  const after = (await savedDocument(page)) as Doc;
  expect(after.features.find((f) => f.id === "sketch_2")?.plane).toEqual({ type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } });
});

test("an axis from the hole's wall; a point at its rim's centre", async ({ page }) => {
  await page.getByRole("button", { name: "Iso" }).click();
  // The far side of the hole's wall, half way down.
  await viewportClick(page, [30 - 2.33, 2.33, 3]);
  await expect(page.getByTestId("selection")).toContainText("cylindrical face");
  await page.getByTestId("tab-reference").click();
  await page.getByTestId("tool-axis").click();
  await expect(page.getByTestId("feature-axis_1")).toBeVisible();
  await expect(page.getByTestId("prop-datum-where")).toHaveText(/^through 30, 0, -?[\d.]+ · along [+-]Z$/);
  expect(await drawn(page)).toContain("axis_1");
  // The rim's near side.
  await viewportClick(page, [30 + 2.33, -2.33, 6]);
  await expect(page.getByTestId("selection")).toContainText("circular edge");
  await page.getByTestId("tool-point").click();
  await expect(page.getByTestId("feature-point_1")).toBeVisible();
  await expect(page.getByTestId("prop-datum-where")).toHaveText("at 30, 0, 6");
  const doc = (await savedDocument(page)) as Doc;
  expect(doc.features.find((f) => f.id === "point_1")).toMatchObject({ op: "point", mode: "center" });
});
