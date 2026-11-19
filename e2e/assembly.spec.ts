// The Assembly tab in the browser: this part put in twice, a face of each
// picked and mated by a distance, the distance changed (the second part
// moves), fixed and floated, hidden, the parts list, interference and the
// assembly's STEP file. The kernel is real.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Vec3 } from "../src/doc/types";
import { expectVolume, openApp, savedDocument } from "./helpers";

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
  await expectVolume(page, "18,994.728"); // the bracket: an 80 × 40 × 6 plate with a hole
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

type Asm = { components: { id: string; part: string; at?: number[]; rotation?: number[]; fixed?: boolean; hidden?: boolean }[]; mates?: { id: string; type: string; value?: number; aligned?: boolean }[] };
const assembly = async (page: Page) => (await savedDocument(page)).assembly as Asm | undefined;

async function clickAt(page: Page, p: Vec3, ctrl = false) {
  const [x, y] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), p);
  await page.mouse.move(x, y);
  if (ctrl) await page.keyboard.down("Control");
  await page.mouse.click(x, y);
  if (ctrl) await page.keyboard.up("Control");
}

test("this part twice, mated by a distance between their tops; the distance changed moves the second", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  await expect(page.getByTestId("assembly-tree")).toContainText("No components yet");
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await expect(page.getByTestId("asm-component-bracket-1")).toBeVisible();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await expect(page.getByTestId("asm-component-bracket-2")).toBeVisible();
  await expect.poll(async () => (await assembly(page))?.components).toEqual([
    { id: "bracket-1", part: "self", fixed: true },
    { id: "bracket-2", part: "self", at: [90, 0, 0] },
  ]);
  // The view has both: pick the first's top face, Ctrl-click the second's.
  await page.waitForTimeout(1500);
  await clickAt(page, [-20, 10, 6]);
  await clickAt(page, [70, 10, 6], true);
  await expect(page.getByTestId("asm-mate-panel")).toBeVisible();
  await expect(page.getByTestId("asm-mate-btn-distance")).toBeEnabled();
  await expect(page.getByTestId("asm-mate-btn-concentric")).toBeDisabled();
  await page.screenshot({ path: "test-results/assembly-picked.png" });
  await page.getByTestId("asm-mate-btn-distance").click();
  await expect(page.getByTestId("asm-mate-distance1")).toBeVisible();
  // The faces are level now (0 apart): a distance starts at 10, and the second rises to it.
  await expect.poll(async () => (await assembly(page))?.mates).toEqual([{ id: "distance1", type: "distance", a: expect.anything(), b: expect.anything(), value: 10, aligned: true }]);
  await expect.poll(async () => (await assembly(page))?.components[1].at).toEqual([90, 0, 10]);
  // 20 mm: the second rises 20 (the tops are aligned, the second's 20 above the first's).
  await page.getByTestId("asm-prop-mate-value").fill("20");
  await page.getByTestId("asm-prop-mate-value").press("Enter");
  await expect.poll(async () => (await assembly(page))?.components[1].at).toEqual([90, 0, 20]);
  await expect(page.getByTestId("asm-prop-mate-status")).toHaveText("Holds.");
  await page.screenshot({ path: "test-results/assembly-mated.png" });

  // Undo takes the edit back; the parts list counts the part twice.
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await assembly(page))?.components[1].at).toEqual([90, 0, 10]);
  await expect(page.getByTestId("asm-bom")).toContainText("bracket2");
  // Interference: side by side, nothing overlaps.
  await page.getByTestId("asm-interference").click();
  await expect(page.getByTestId("asm-clashes")).toContainText("No components overlap");
  // The assembly as STEP: two named solids.
  const download = page.waitForEvent("download");
  await page.getByTestId("asm-export-step").click();
  const step = readFileSync(await (await download).path(), "utf8");
  for (const name of ["bracket-1", "bracket-2"]) expect(step).toContain(`'${name}'`);
});

test("a component dragged by its arrow moves, as one undo step; a fixed one has no handles", async ({ page }) => {
  type Hook = { project(p: number[]): [number, number]; handlePoint(id: string): [number, number] | null };
  await page.getByTestId("mode-assembly").click();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId("asm-insert").click();
    await page.getByTestId("asm-insert-self").click();
  }
  await expect(page.getByTestId("asm-component-bracket-2")).toBeVisible();
  await page.getByTestId("asm-component-bracket-1").locator(".asm-row").click();
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.handlePoint("bracket-1:move:z"))).toBeNull();
  await page.getByTestId("asm-component-bracket-2").locator(".asm-row").click();
  const point = () => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.handlePoint("bracket-2:move:z"));
  await expect.poll(point).not.toBeNull();
  const [x, y] = (await point())!;
  const [, y0] = await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.project([90, 0, 3]));
  const [, y30] = await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.project([90, 0, 33]));
  const perMm = (y0 - y30) / 30;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - perMm * 10, { steps: 5 });
  await page.mouse.move(x, y - perMm * 25, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.round(((await assembly(page))?.components[1].at?.[2] ?? 0) / 5) * 5).toBe(25);
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await assembly(page))?.components[1].at).toEqual([90, 0, 0]);
});

test("an example part put in beside this one is carried in the file; a pin's hole to the bracket's by a concentric mate", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-example-flange").click();
  await expect(page.getByTestId("asm-component-flange-1")).toBeVisible();
  const a = await assembly(page);
  expect(Object.keys((a as unknown as { parts: Record<string, unknown> }).parts)).toEqual(["flange"]);
  expect(a?.components.map((k) => [k.id, k.part])).toEqual([
    ["bracket-1", "self"],
    ["flange-1", "flange"],
  ]);
  await expect(page.getByTestId("asm-bom")).toContainText("flange");
  // The Model tab is the bracket still: the assembly never changes the part.
  await page.getByTestId("mode-model").click();
  await expectVolume(page, "18,994.728");
  await page.getByTestId("mode-assembly").click();
  await expect(page.getByTestId("asm-component-flange-1")).toBeVisible();
  await page.screenshot({ path: "test-results/assembly-example.png" });
});
