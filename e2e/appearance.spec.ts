// Appearances in the browser: the part coloured from the Appearance section
// (a swatch, a finish, a typed colour, undo and back to the default), a body
// from its swatch in Bodies, a feature's faces from its right-click menu, and
// an assembly component from its properties. The kernel is real.

import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument } from "./helpers";

const SHOTS = process.env.LOOK_SHOTS;

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
  await expectVolume(page, "18,994.728"); // the bracket
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

const saved = async (page: Page) => (await savedDocument(page)) as Record<string, any>;

test("the part: a swatch, a finish, a typed colour, undo, and back to the default", async ({ page }) => {
  const panel = page.getByTestId("appearance-panel");
  await expect(panel.getByTestId("look-line-part")).toContainText("From the default colour");
  await panel.getByTestId("look-open-part").click();
  const picker = page.getByTestId("appearance-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId("look-reset")).toBeDisabled();
  await picker.getByTestId("look-swatch-blue").click();
  await expect.poll(async () => (await saved(page)).appearance).toEqual({ color: "#2f6fd6" });
  await expect(picker.getByTestId("look-status")).toHaveText("Blue");
  await expect(picker.getByTestId("look-swatch-blue")).toHaveAttribute("aria-checked", "true");
  await picker.getByTestId("look-finish-gloss").click();
  await expect.poll(async () => (await saved(page)).appearance).toEqual({ color: "#2f6fd6", finish: "gloss" });
  await picker.getByTestId("look-hex").fill("#C04");
  await picker.getByTestId("look-hex").press("Enter");
  await expect.poll(async () => (await saved(page)).appearance).toEqual({ color: "#cc0044", finish: "gloss" });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/look-part.png` });
  // Each choice was one undo step.
  await picker.getByTestId("look-done").click();
  await expect(picker).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await saved(page)).appearance).toEqual({ color: "#2f6fd6", finish: "gloss" });
  // The section lists it; its × goes back to the default.
  await expect(panel.getByTestId("look-line-part")).toContainText("#2f6fd6, gloss");
  await panel.getByTestId("look-clear-part").click();
  await expect.poll(async () => (await saved(page)).appearance).toBeUndefined();
});

test("a body from its swatch, a feature's faces from its menu, and the list of what is coloured", async ({ page }) => {
  await page.locator("select").first().selectOption("table frame (weldment)");
  await expectVolume(page, "3,054,720");
  await page.getByTestId("body-look-leg_a").click();
  const picker = page.getByTestId("appearance-picker");
  await expect(picker).toContainText("Body leg_a");
  await picker.getByTestId("look-swatch-red").click();
  await expect.poll(async () => (await saved(page)).bodyAppearances).toEqual({ leg_a: { color: "#d64545" } });
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  // A feature: right-click it in the tree.
  await page.getByTestId("feature-rail_front").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-appearance").click();
  await expect(picker).toContainText("Feature rail_front");
  await picker.getByTestId("look-swatch-brass").click();
  await expect.poll(async () => (await saved(page)).features.find((f: any) => f.id === "rail_front").appearance).toEqual({ color: "#c9a44c", finish: "metallic" });
  await picker.getByTestId("look-done").click();
  const panel = page.getByTestId("appearance-panel");
  await expect(panel.getByTestId("look-line-body:leg_a")).toContainText("Red");
  await expect(panel.getByTestId("look-line-feature:rail_front")).toContainText("Brass");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/look-frame.png` });
});

test("an assembly component's own colour, over its part's", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await page.getByTestId("asm-component-bracket-2").click();
  await page.getByTestId("asm-prop-look").click();
  const picker = page.getByTestId("asm-look-picker");
  await picker.getByTestId("look-swatch-safety-yellow").click();
  await expect.poll(async () => (await saved(page)).assembly.components.find((k: any) => k.id === "bracket-2").appearance).toEqual({ color: "#f2c230" });
  await picker.getByTestId("look-done").click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/look-assembly.png` });
});
