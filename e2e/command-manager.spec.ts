// Phase O's UI foundations in the browser: the model toolbar as SOLIDWORKS's
// CommandManager (Sketch always at hand, tools on tabs, the tab remembered,
// every tool still on the shortcut bar and Enter), Ctrl/Shift-click to select
// several faces and edges, and property editors declared as fields, which
// turn a pick into selectors and send nested values whole.

import { expect, test, type Page } from "@playwright/test";
import type { Vec3 } from "../src/doc/types";
import { commit, expectVolume, openApp, savedDocument, viewportClick, waitForRebuild } from "./helpers";

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
  await expectVolume(page, "18,994.728"); // the bracket, a fresh profile's part
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

type Feature = Record<string, unknown>;
const feature = async (page: Page, id: string) => ((await savedDocument(page)).features as Feature[]).find((f) => f.id === id);

/** Clicks a world point in the view with Ctrl held: it goes in or out of the selection. */
async function ctrlClick(page: Page, p: Vec3) {
  const [x, y] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), p);
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  await page.mouse.click(x, y);
  await page.keyboard.up("Control");
}

test("the toolbar is a CommandManager: Sketch always there, the tools on tabs, the tab remembered", async ({ page }) => {
  const bar = page.getByRole("toolbar", { name: "Modelling" });
  // Evaluate has no tools yet, so it doesn't show.
  await expect(bar.getByRole("tab")).toHaveText(["Features", "Reference", "Bodies", "Weldments"]);
  await expect(page.getByTestId("tab-features")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tool-extrude")).toBeVisible();
  await expect(page.getByTestId("tool-combine")).toHaveCount(0);

  await page.getByTestId("tab-bodies").click();
  await expect(page.getByTestId("tab-bodies")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tool-combine")).toBeDisabled(); // one body
  await expect(page.getByTestId("tool-extrude")).toHaveCount(0);
  for (const id of ["undo", "redo", "tool-sketch"]) await expect(page.getByTestId(id)).toBeVisible();

  await page.reload();
  await waitForRebuild(page);
  await expect(page.getByTestId("tab-bodies")).toHaveAttribute("aria-selected", "true");

  // A tool on another tab is still on the shortcut bar, and Enter repeats it.
  const box = (await page.getByTestId("viewport").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("s");
  await page.getByTestId("bar-tool.extrude").click();
  await expect(page.getByTestId("feature-extrude_1")).toBeVisible();
  await expectVolume(page, "32,000"); // 80 x 40 x 10 from the sketch on Top: the plate and its hole filled
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("feature-extrude_2")).toBeVisible();
});

test("Ctrl- and Shift-click select several faces and edges; a plain click starts again", async ({ page }) => {
  const chip = page.getByTestId("selection");
  await viewportClick(page, [-10, 5, 6]); // the top face
  await expect(chip).toContainText("planar face · normal +Z");
  await ctrlClick(page, [0, -20, 3]); // and the front face
  await expect(chip).toHaveText("Selected: 2 faces");
  await viewportClick(page, [0, -20, 6], { shift: true }); // and the edge between them
  await expect(chip).toHaveText("Selected: 2 faces + 1 edge");
  await ctrlClick(page, [-10, 5, 6]); // the top face out again
  await expect(chip).toHaveText("Selected: 1 face + 1 edge");
  await viewportClick(page, [-10, 5, 6]);
  await expect(chip).toContainText("planar face · normal +Z");
  await page.keyboard.press("Escape");
  await expect(chip).toHaveCount(0);
});

test("a fillet's edges: Use selected edges moves it to the edge picked now", async ({ page }) => {
  await viewportClick(page, [0, -20, 6]); // the top front edge
  await page.getByTestId("tool-fillet").click();
  await commit(page, "prop-radius", "2");
  await expectVolume(page, "18,926.05"); // 18,994.728 - (1 - pi/4) x 2² x 80
  const front = JSON.stringify((await feature(page, "fillet_1"))!.edges);
  await expect(page.getByTestId("prop-edges")).toContainText("-Y");

  await viewportClick(page, [0, 20, 6]); // the top back edge
  await page.getByTestId("prop-edges-use").click();
  await expect(page.getByTestId("prop-edges")).toContainText("+Y");
  await expect.poll(async () => JSON.stringify((await feature(page, "fillet_1"))!.edges)).not.toBe(front);
  await expect.poll(async () => (await feature(page, "fillet_1"))!.radius).toBe(2);
  await expectVolume(page, "18,926.05"); // the same edge length, so the same volume
});

test("a second pattern direction makes a grid, and goes again with its spacing and count", async ({ page }) => {
  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await page.getByTestId("tool-pattern").click();
  await page.getByTestId("tool-linear-pattern").click();
  await page.getByTestId("prop-pattern-direction").selectOption("−X");
  await commit(page, "prop-spacing", "20");
  await expect(page.getByTestId("holes")).toHaveText(/^3 /); // x = 30, 10, -10
  await page.getByTestId("prop-pattern-second").check();
  await commit(page, "prop-spacing2", "10");
  await expect(page.getByTestId("holes")).toHaveText(/^6 /); // and each again at y = 10
  expect(await feature(page, "pattern_1")).toMatchObject({ direction2: [0, 1, 0], spacing2: 10, count2: 2 });
  await page.getByTestId("prop-pattern-second").uncheck();
  await expect(page.getByTestId("holes")).toHaveText(/^3 /);
  const p = (await feature(page, "pattern_1"))!;
  expect(["direction2", "spacing2", "count2"].filter((k) => k in p)).toEqual([]);
});

test("a circular pattern's axis point is one field of the axis: the whole axis is sent", async ({ page }) => {
  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await page.getByTestId("tool-pattern").click();
  await page.getByTestId("tool-circular-pattern").click();
  await commit(page, "prop-axis-origin-x", "20");
  await commit(page, "prop-count", "2");
  // The hole at x = 30 turned 180° about x = 20 lands at x = 10.
  await expect(page.getByTestId("holes")).toHaveText(/^2 /);
  expect((await feature(page, "circular_1"))!.axis).toEqual({ origin: [20, 0, 0], direction: [0, 0, 1] });
  expect((await feature(page, "circular_1"))!.angle).toBeUndefined();
});
