// Showing and hiding sketches, on the bracket (sketch_1, extruded by ext_1,
// and a hole): a sketch a feature uses is hidden once used; the tree's eye,
// its right-click and the view's right-click show or hide one, kept in the
// document; the view's Sketches toggle hides them all; a circle drawn and
// cut is hidden once cut.

import { expect, test, type Page } from "@playwright/test";
import { okFeature, openApp, savedDocument, sketchClick } from "./helpers";

type Hook = { sketches(): string[]; sketchPoint(id: string): [number, number] | null };
const drawn = (page: Page) => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.sketches());
const pointOn = (page: Page, id: string) => page.evaluate((id) => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.sketchPoint(id), id);
const sketchField = async (page: Page, id: string) => ((await savedDocument(page)).features as Record<string, unknown>[]).find((f) => f.id === id)?.shown;

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("a used sketch is hidden; the eye, the tree's and the view's right-click show and hide it, kept in the document", async ({ page }) => {
  // sketch_1 is extruded: hidden, its eye closed, its row faded.
  await expect.poll(() => drawn(page)).toEqual([]);
  const row = page.getByTestId("feature-sketch_1");
  await expect(row).toHaveClass(/hidden-sketch/);
  const eye = page.getByTestId("sketch-eye-sketch_1");
  await expect(eye).toHaveAttribute("aria-pressed", "false");

  // The eye shows it: drawn, and saved as shown.
  await eye.click();
  await expect.poll(() => drawn(page)).toEqual(["sketch_1"]);
  await expect(row).not.toHaveClass(/hidden-sketch/);
  expect(await sketchField(page, "sketch_1")).toBe(true);

  // Right-click it in the view: its menu, with Hide.
  const [x, y] = (await pointOn(page, "sketch_1"))!;
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.getByTestId("context-menu")).toContainText("sketch_1");
  await page.getByTestId("ctx-hide-sketch").click();
  await expect.poll(() => drawn(page)).toEqual([]);
  // Back to the default: the field is gone, not false.
  expect(await sketchField(page, "sketch_1")).toBeUndefined();

  // The tree's right-click shows it; on the extrude, it names the sketch.
  await row.locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-show-sketch").click();
  await expect.poll(() => drawn(page)).toEqual(["sketch_1"]);
  await page.getByTestId("feature-ext_1").locator(".feature-row").click({ button: "right" });
  await expect(page.getByTestId("ctx-hide-sketch")).toHaveText(/Hide sketch_1/);
  await page.keyboard.press("Escape");

  // The view's Sketches toggle hides them all, and brings them back.
  await page.getByTestId("view-sketches").click();
  await expect.poll(() => drawn(page)).toEqual([]);
  await page.getByTestId("view-sketches").click();
  await expect.poll(() => drawn(page)).toEqual(["sketch_1"]);

  // Undo: hidden again.
  await page.keyboard.press("Control+z");
  await expect.poll(() => drawn(page)).toEqual([]);
});

test("a circle sketched and cut through is hidden once cut; selected in the tree, it is drawn while selected", async ({ page }) => {
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, -20, 0);
  await sketchClick(page, -10, 0);
  await page.getByTestId("finish-sketch").click();
  // Not used yet: shown.
  await expect.poll(() => drawn(page)).toEqual(["sketch_2"]);
  await page.getByTestId("tool-cut").click();
  if (await page.getByTestId("session-bar").isVisible()) await okFeature(page);
  await expect.poll(async () => ((await savedDocument(page)).features as { op: string }[]).some((f) => f.op === "cut")).toBe(true);
  await expect.poll(() => drawn(page)).toEqual([]);
  await expect(page.getByTestId("feature-sketch_2")).toHaveClass(/hidden-sketch/);
  // Selected in the tree it is drawn (to see it, or pick it); the selection gone, hidden again.
  await page.getByTestId("feature-sketch_2").locator(".feature-row").click();
  await expect.poll(() => drawn(page)).toEqual(["sketch_2"]);
  await page.keyboard.press("Escape");
  await page.getByTestId("feature-ext_1").locator(".feature-row").click();
  await expect.poll(() => drawn(page)).toEqual([]);
});
