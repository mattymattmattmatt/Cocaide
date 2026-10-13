// Wave 7 review fixes in the browser, each from a reproduced finding:
// - a locked drag-handle label (its value set by an expression) says why and
//   opens no value box, so the expression is never replaced by a number;
// - a section on a plane feature follows the plane when it moves, and closes
//   when the plane is deleted;
// - a sketch-driven pattern's skipped copy follows its place when a position
//   is removed from the table;
// - Mass Properties of the stand (two bodies) shows no "-0".

import { expect, test, type Page } from "@playwright/test";
import { commit, openApp, savedDocument, waitForRebuild } from "./helpers";

type Raw = Record<string, unknown>;
type Hook = { section(): { normal: number[]; constant: number; capped: boolean } | null };
const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const feature = async (page: Page, id: string) => ((await savedDocument(page)).features as Raw[]).find((f) => f.id === id);
const section = (page: Page) => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.section());

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

async function openDocument(page: Page, doc: Raw) {
  const text = JSON.stringify({ version: 1, units: "mm", name: "review", ...doc }, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
}

test("a locked depth handle's label says why and keeps the expression", async ({ page }) => {
  await openDocument(page, {
    parameters: { t: 6 },
    features: [
      { id: "s1", op: "sketch", plane: TOP, entities: [{ id: "r", type: "rect", center: [0, 0], w: 80, h: 40 }], constraints: [] },
      { id: "e1", op: "extrude", sketch: "s1", distance: "=t*2" },
    ],
  });
  await page.getByTestId("feature-e1").locator(".feature-row").click();
  const label = page.getByTestId("handle-label-e1:distance");
  await expect(label).toHaveText("Depth 12 mm");
  await expect(label).toHaveClass(/locked/);
  await label.click();
  await expect(page.getByTestId("handle-box")).toHaveCount(0);
  await expect(page.getByTestId("notice")).toContainText("=t*2");
  expect((await feature(page, "e1"))!.distance).toBe("=t*2");
});

test("a section on a plane feature follows the plane, and closes when it is deleted", async ({ page }) => {
  await openDocument(page, {
    features: [
      { id: "s1", op: "sketch", plane: TOP, entities: [{ id: "r", type: "rect", center: [0, 0], w: 80, h: 40 }], constraints: [] },
      { id: "e1", op: "extrude", sketch: "s1", distance: 20 },
      { id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 5 },
    ],
  });
  await page.getByTestId("tab-evaluate").click();
  await page.getByTestId("tool-section").click();
  await page.getByTestId("section-plane").selectOption("plane_1");
  await expect.poll(async () => (await section(page))?.constant).toBe(5);

  // Moved to 15: the cut moves with it.
  await page.getByTestId("feature-plane_1").locator(".feature-row").click();
  await commit(page, "prop-distance", "15");
  await expect.poll(async () => (await feature(page, "plane_1"))!.distance).toBe(15);
  await expect.poll(async () => (await section(page))?.constant).toBe(15);
  await expect(page.getByTestId("section-plane")).toHaveValue("plane_1");

  // Deleted: the section closes and says so, never cutting at a plane the panel does not show.
  await page.getByTestId("feature-plane_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-delete").click();
  await expect.poll(async () => ((await savedDocument(page)).features as Raw[]).map((f) => f.id)).toEqual(["s1", "e1"]);
  await expect.poll(() => section(page)).toBeNull();
  await expect(page.getByTestId("section-panel")).toHaveCount(0);
  await expect(page.getByTestId("notice")).toContainText("plane_1 is no longer in the part");
});

test("sketch-driven pattern: removing a position keeps the skipped copy where it was", async ({ page }) => {
  const T = 10;
  await openDocument(page, {
    features: [
      { id: "s1", op: "sketch", plane: TOP, entities: [{ id: "r", type: "rect", center: [0, 0], w: 100, h: 60 }], constraints: [] },
      { id: "e1", op: "extrude", sketch: "s1", distance: T },
      { id: "h", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [-30, 0], diameter: 6, depth: "through" },
      { id: "p", op: "sketchPattern", feature: "h", positions: [[30, 0], [-30, 0], [0, 10], [30, 20]], from: [-30, 0], skip: [3] },
    ],
  });
  await page.getByTestId("feature-p").locator(".feature-row").click();
  const checks = () =>
    page.getByTestId("prop-pattern-skip").locator("label").evaluateAll((ls) => ls.map((l) => `${l.textContent?.trim()}=${(l.querySelector("input") as HTMLInputElement).checked}`));
  await expect.poll(checks).toEqual(["1 (the seed)=true", "2 at [30, 0]=true", "3 at [0, 10]=false", "4 at [30, 20]=true"]);
  await page.getByTestId("prop-position-remove-0").click();
  await expect.poll(async () => (await feature(page, "p"))!.positions).toEqual([[-30, 0], [0, 10], [30, 20]]);
  expect((await feature(page, "p"))!.skip).toEqual([2]);
  await expect.poll(checks).toEqual(["1 (the seed)=true", "2 at [0, 10]=false", "3 at [30, 20]=true"]);
});

test("Mass Properties of the stand shows no -0", async ({ page }) => {
  await page.getByLabel("Open an example").selectOption("stand (two bodies)");
  await waitForRebuild(page);
  await page.getByTestId("tab-evaluate").click();
  await page.getByTestId("tool-mass-properties").click();
  await expect(page.getByTestId("mass-panel")).toContainText("Pxy, Pxz, Pyz");
  const text = await page.getByTestId("mass-panel").innerText();
  expect(text).not.toMatch(/(^|[^\d.])-0(?![.\d])/);
});
