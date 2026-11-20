// Lettering and labels on a drawing: the font changed for the whole drawing
// (every letter on the sheet set in it, its widths measured in it), slanted
// lettering, a view's own label, and the PDF carrying the font.

import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument } from "./helpers";

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
  await expectVolume(page, "18,994.728");
});
test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

const sheetText = (page: Page) => page.getByTestId("sheet").locator("text");

test("a serif, slanted drawing with a labelled view, exported as PDF with the font in it", async ({ page }) => {
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await expect(sheetText(page).first()).toBeAttached();
  // The sheet's panel (nothing selected): Lettering.
  await page.getByTestId("drawing-font").selectOption("serif");
  await page.getByTestId("drawing-lettering").selectOption("slanted");
  await expect.poll(async () => {
    const d = (await savedDocument(page)).drawing as { font?: string; lettering?: string };
    return [d.font, d.lettering];
  }).toEqual(["serif", "slanted"]);
  // Every letter on the sheet in the serif, leaning.
  const families = await sheetText(page).evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("font-family") ?? ""))]);
  expect(families.every((f) => /Times/.test(f))).toBe(true);
  const styles = await sheetText(page).evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("font-style") ?? ""))]);
  expect(styles).toEqual(["italic"]);
  // A view's own label.
  await page.getByTestId("drawing-item-iso").click();
  await page.getByTestId("prop-view-caption").fill("Isometric view");
  await page.getByTestId("prop-view-caption").press("Enter");
  await expect(sheetText(page).filter({ hasText: "ISOMETRIC VIEW" })).toHaveCount(1);
  await page.screenshot({ path: "test-results/lettering.png" });
  // The PDF carries the serif (Liberation Serif, Times' metric twin).
  const wait = page.waitForEvent("download");
  await page.getByTestId("drawing-export-pdf").click();
  const { readFileSync } = await import("node:fs");
  const pdf = readFileSync((await (await wait).path())!, "latin1");
  expect(pdf).toContain("/BaseFont /LiberationSerif");
});
