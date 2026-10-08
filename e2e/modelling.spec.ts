// The rest of the Phase B modeller: sketch tools and editing, tree operations,
// edge picks, patterns, and the JSON tab, all in the browser.

import { expect, test } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, sketchClick, viewportClick } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  test.info().annotations.push({ type: "problems", description: "" });
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("edits a sketch dimension and the part follows", async ({ page }) => {
  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  await commit(page, "constraint-value-0", "100");
  await page.getByTestId("finish-sketch").click();
  await expectVolume(page, "23,794.728");
  await expect(page.getByTestId("holes")).toHaveText("1 × Ø6.6"); // the hole followed the top face
});

test("cancelling a sketch leaves the document alone", async ({ page }) => {
  const before = await savedDocument(page);
  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  await commit(page, "constraint-value-0", "120");
  await page.getByTestId("cancel-sketch").click();
  expect(await savedDocument(page)).toEqual(before);
});

test("draws a closed line profile, constrains it, cuts it", async ({ page }) => {
  await viewportClick(page, [-10, 5, 6]);
  await page.getByTestId("tool-sketch").click();
  await page.getByRole("menuitem", { name: "On selected face" }).click();
  await page.getByTestId("tool-line").click();
  for (const [x, y] of [[-30, -10], [-10, -10], [-10, 10], [-30, 10], [-30, -10]]) await sketchClick(page, x, y);
  await expect(page.getByTestId("profile-status")).toContainText("1 region, area 400");
  // The chain closed itself: four coincidences, no gaps.
  await expect(page.getByTestId("constraint-list").locator("li")).toHaveCount(4);
  await page.getByTestId("finish-sketch").click();
  await page.getByTestId("tool-cut").click();
  // On a top-face sketch the cut defaults into the part.
  await expectVolume(page, "16,994.728"); // 400 mm² x 5 mm removed
});

test("draws circles, arcs and slots", async ({ page }) => {
  // Points on multiples of 10 mm sit on the grid at any zoom, so grid snap keeps them exact.
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, -20, 0);
  await sketchClick(page, -10, 0);
  await page.getByTestId("tool-slot").click();
  await sketchClick(page, 10, 0);
  await sketchClick(page, 30, 0);
  await sketchClick(page, 20, 10);
  await page.getByTestId("tool-arc").click();
  await sketchClick(page, 0, 30);
  await sketchClick(page, 10, 30);
  await sketchClick(page, 0, 40);
  await expect(page.getByTestId("profile-status")).toContainText("open at"); // a lone arc is not a closed profile
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("profile-status")).toContainText("2 regions");
  await page.getByTestId("tool-select").click();
  await sketchClick(page, -10, 0);
  await commit(page, "c-radius-value", "4");
  await expect(page.getByTestId("constraint-list")).toContainText("c1 radius");
  await expect(page.getByTestId("profile-status")).toContainText(`area ${Math.round((Math.PI * 16 + 20 * 20 + Math.PI * 100) * 1000) / 1000}`);
  await page.getByTestId("finish-sketch").click();
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});

test("suppresses, reorders by drag, and refuses impossible moves", async ({ page }) => {
  await page.getByTestId("feature-hole_1").hover();
  await page.getByRole("button", { name: "Suppress hole_1" }).click();
  await expectVolume(page, "19,200");
  await page.getByRole("button", { name: "Unsuppress hole_1" }).click();
  await expectVolume(page, "18,994.728");

  await page.getByTestId("feature-ext_1").hover();
  await page.getByRole("button", { name: "Move ext_1 up" }).click();
  await expect(page.getByTestId("notice")).toContainText("ext_1 uses sketch_1, which would come after it");

  await page.getByTestId("feature-sketch_1").hover();
  await page.getByRole("button", { name: "Delete sketch_1" }).click();
  await expect(page.getByTestId("notice")).toContainText("sketch_1 is used by ext_1");

  // Drag the hole above the extrude: allowed, and it then has no solid to drill.
  await page.getByTestId("feature-hole_1").dragTo(page.getByTestId("feature-ext_1"));
  await expect(page.getByTestId("feature-hole_1")).toContainText("nothing to drill");
  await page.locator("body").press("Control+z");
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});

test("fillets picked corners: shift-click adds an edge, again removes it", async ({ page }) => {
  await page.getByRole("button", { name: "Iso" }).click();
  await viewportClick(page, [40, -20, 3]);
  await viewportClick(page, [40, 20, 3], { shift: true });
  await viewportClick(page, [-40, -20, 3], { shift: true });
  await page.getByRole("button", { name: "Front" }).click();
  await viewportClick(page, [-40, -20, 3], { shift: true });
  await viewportClick(page, [-40, -20, 3], { shift: true }); // toggles off again
  await expect(page.getByTestId("selection")).toContainText("3 edges");
  await page.getByRole("button", { name: "Iso" }).click();
  await page.getByTestId("tool-fillet").click();
  await commit(page, "prop-radius", "5");
  await expectVolume(page, "18,898.158"); // 3 x (1 - pi/4) x 25 x 6
});

test("chamfers a picked edge and patterns the hole", async ({ page }) => {
  await viewportClick(page, [0, -20, 6]);
  await page.getByTestId("tool-chamfer").click();
  await commit(page, "prop-chamfer-distance", "1");
  await expectVolume(page, "18,954.728"); // 0.5 x 1 x 1 x 80

  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await page.getByTestId("tool-pattern").click();
  await page.getByTestId("tool-linear-pattern").click();
  await page.getByTestId("prop-pattern-direction").selectOption("−X");
  await commit(page, "prop-spacing", "20");
  await commit(page, "prop-count", "4");
  await expect(page.getByTestId("holes")).toHaveText(/^4 /);

  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await page.getByTestId("tool-pattern").click();
  await page.getByTestId("tool-circular-pattern").click();
  await commit(page, "prop-count", "2");
  await expect(page.getByTestId("holes")).toHaveText(/^4 /); // the 180° copy lands on an existing pattern hole
});

test("the JSON tab edits the same document", async ({ page }) => {
  await page.getByTestId("tab-document").click();
  const editor = page.getByTestId("doc-editor");
  await editor.fill((await editor.inputValue()).replace('"distance": 6', '"distance": 10'));
  await expectVolume(page, "31,657.881");
  await page.locator("body").press("Control+z");
  await expectVolume(page, "18,994.728");
});
