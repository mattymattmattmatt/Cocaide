// Appearances in the browser: the part coloured from the Appearance section
// (a swatch, a finish, a typed colour, undo and back to the default), a body
// from its swatch in Bodies, a feature's faces from its right-click menu, and
// an assembly component from its properties. The kernel is real.

import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument, viewportClick } from "./helpers";

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
  await expect(page.getByTestId("asm-component-bracket-2").locator(".look-chip")).toHaveAttribute("data-look", "#f2c230");
  if (SHOTS) {
    const box = (await page.locator("canvas").first().boundingBox())!;
    await page.mouse.click(box.x + 40, box.y + box.height - 40);
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/look-assembly.png` });
  }
});

/** The colour drawn at a model point (the part's face there), as [r, g, b]. */
async function pixelAt(page: Page, p: [number, number, number]): Promise<[number, number, number]> {
  const [x, y] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), p);
  const png = await page.screenshot({ clip: { x: Math.round(x) - 1, y: Math.round(y) - 1, width: 3, height: 3 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(1, 1, 1, 1).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  }, png.toString("base64"));
}

test("a swatch under the pointer shows on the part before it is kept; leaving puts it back", async ({ page }) => {
  const top: [number, number, number] = [-22, 9, 6]; // the bracket's top face, clear of its hole and the axes drawn at the origin
  const before = await pixelAt(page, top);
  await page.getByTestId("appearance-panel").getByTestId("look-open-part").click();
  const picker = page.getByTestId("appearance-picker");
  await picker.getByTestId("look-swatch-green").hover();
  // Tried, not kept: the part is green in the view, the document unchanged.
  await expect.poll(async () => { const [r, g, b] = await pixelAt(page, top); return g > r + 25 && g > b + 10; }).toBe(true);
  expect((await saved(page)).appearance).toBeUndefined();
  // Off the swatches: the view goes back.
  await picker.getByTestId("look-status").hover();
  await expect.poll(async () => { const [r, g, b] = await pixelAt(page, top); return Math.abs(r - before[0]) + Math.abs(g - before[1]) + Math.abs(b - before[2]) < 12; }).toBe(true);
  // Escape closes it, keeping nothing.
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  expect((await saved(page)).appearance).toBeUndefined();
});

test("copy and paste a look, colour two bodies at once, and Clear all in one step", async ({ page }) => {
  await page.locator("select").first().selectOption("table frame (weldment)");
  await expectVolume(page, "3,054,720");
  const picker = page.getByTestId("appearance-picker");
  // leg_a: copper, copied.
  await page.getByTestId("body-look-leg_a").click();
  await picker.getByTestId("look-swatch-copper").click();
  await picker.getByTestId("look-copy").click();
  await picker.getByTestId("look-done").click();
  // leg_b: pasted.
  await page.getByTestId("body-look-leg_b").click();
  await picker.getByTestId("look-paste").click();
  await expect.poll(async () => (await saved(page)).bodyAppearances?.leg_b).toEqual({ color: "#b8734a", finish: "metallic" });
  await picker.getByTestId("look-done").click();
  // Two legs picked in the view: one colour for both, one undo step.
  await viewportClick(page, [1180, 0, 450]);
  await viewportClick(page, [20, 0, 450], { shift: true });
  const panel = page.getByTestId("appearance-panel");
  await expect(panel.getByTestId("look-line-all")).toContainText("All 2 bodies");
  await panel.getByTestId("look-open-all").click();
  await expect(picker).toContainText("2 bodies");
  await picker.getByTestId("look-swatch-navy").click();
  await expect.poll(async () => (await saved(page)).bodyAppearances).toEqual({ leg_a: { color: "#26375e" }, leg_b: { color: "#26375e" } });
  await picker.getByTestId("look-done").click();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await saved(page)).bodyAppearances).toEqual({ leg_a: { color: "#b8734a", finish: "metallic" }, leg_b: { color: "#b8734a", finish: "metallic" } });
  // Clear all: every colour off in one step, and back with one undo.
  await panel.getByTestId("look-clear-all").click();
  await expect.poll(async () => (await saved(page)).bodyAppearances).toBeUndefined();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => Object.keys((await saved(page)).bodyAppearances ?? {}).sort()).toEqual(["leg_a", "leg_b"]);
});

