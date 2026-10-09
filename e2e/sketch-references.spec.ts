// Sketch references to the model (DESIGN §2.4), as a user meets them: the
// model's edges in the sketcher are real things to hover, snap to, dimension
// and relate to; dimensioning to one adds a reference that follows the model;
// Convert Entities copies a face's outline in; and editing an earlier sketch
// shows the part as it stood before it.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, sketchClick, viewportClick, waitForRebuild } from "./helpers";

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = await openApp(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
});

test.afterEach(() => expect(problems).toEqual([]));

/** A new sketch on the bracket's top face (z = 6): its x and y are the world's. */
async function sketchOnTop(page: Page) {
  await viewportClick(page, [0, 12, 6]);
  await expect(page.getByTestId("selection")).toContainText(/face/i);
  await page.getByTestId("tool-sketch").click();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
}

/** Where a sketch point is on the screen. */
async function screenAt(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(
    ([x, y]) => {
      const m = (document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement).getScreenCTM()!;
      return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as [number, number];
    },
    [x, y],
  );
}

/** The first point of an entity's outline in the sketcher (a circle's is its rim at angle 0). */
async function firstPoint(page: Page, id: string): Promise<[number, number]> {
  const d = await page.locator(`[data-testid=sketch-canvas] path[data-entity="${id}"]`).getAttribute("d");
  const m = /^M(-?[\d.e-]+) (-?[\d.e-]+)/.exec(d ?? "");
  return [Number(m![1]), Number(m![2])];
}

test("dimension a circle to a model edge: the hole follows the edge when the plate changes", async ({ page }) => {
  await sketchOnTop(page);
  // The plate's edges are drawn as model edges: hovering the right-hand one highlights it, purple.
  const [ex, ey] = await screenAt(page, 40, 5);
  await page.mouse.move(ex, ey);
  await expect(page.locator('[data-testid=model-edges] path.hover')).toHaveCount(1);

  // A circle (radius 4), then Smart Dimension from its centre to that edge: 12 mm.
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, 20, 10);
  await sketchClick(page, 24, 10);
  await page.getByTestId("tool-dimension").click();
  await sketchClick(page, 20, 10);
  await sketchClick(page, 40, 5);
  await expect(page.getByTestId("modify-box")).toBeVisible();
  await page.getByTestId("modify-value").fill("12");
  await page.getByTestId("modify-value").press("Enter");
  // The edge became a reference entity of the sketch, named by what it is; the circle moved to 12 from it.
  const list = page.getByTestId("constraint-list");
  await expect(list).toContainText("c1 centre ↔ model edge (straight, 40 mm, +Y)");
  await expect(page.locator("[data-testid=sketch-canvas] path.entity.reference")).toHaveCount(1);
  expect((await firstPoint(page, "c1"))[0]).toBeCloseTo(28 + 4, 6);

  // Then from the sketch's X axis (a line every sketch has): 10, clear of the plate's own hole; and the diameter.
  await sketchClick(page, 28, 10);
  const [ax, ay] = await screenAt(page, -20, 0);
  await page.mouse.click(ax, ay);
  await page.getByTestId("modify-value").fill("10");
  await page.getByTestId("modify-value").press("Enter");
  await expect(list).toContainText("c1 centre ↔ X axis");
  await sketchClick(page, 32, 10);
  await sketchClick(page, 45, 25);
  await page.getByTestId("modify-value").fill("6");
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("sketch-dof")).toHaveText("Fully defined");
  // The reference shows as one in the selection: what it follows.
  await page.getByTestId("tool-select").click();
  await sketchClick(page, 40, -15);
  await expect(page.getByTestId("sketch-selection-detail")).toContainText("Reference: model edge (straight, 40 mm, +Y)");
  await page.keyboard.press("Escape");
  await page.mouse.move(10, 10);
  await page.screenshot({ path: "out/e2e/sketch-references.png" });

  // Finish, and cut it through the plate.
  await page.getByTestId("finish-sketch").click();
  await waitForRebuild(page);
  await page.getByTestId("tool-cut").click();
  await page.getByTestId("prop-extent").selectOption("throughAll");
  await waitForRebuild(page);
  await expectVolume(page, "18,825.082");

  // Make the plate 100 wide in its own sketch: the right edge moves 10 mm, and the hole goes with it.
  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
  // The first sketch has no part before it: no model edges to show.
  await expect(page.locator("[data-testid=model-edges] path")).toHaveCount(0);
  await commit(page, "constraint-value-0", "100");
  await page.getByTestId("finish-sketch").click();
  await waitForRebuild(page);
  await expectVolume(page, "23,625.082");
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);

  // Open the hole's sketch again: it opens as the rebuild solved it, the circle 12 from the edge at x = 50.
  // It sees the part as it stood before it: the plate and its first hole (14 edges), not the hole cut from it.
  await page.getByTestId("feature-sketch_2").locator(".feature-row").dblclick();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
  await expect(page.locator("[data-testid=model-edges] path")).toHaveCount(14);
  expect((await firstPoint(page, "c1"))[0]).toBeCloseTo(38 + 3, 6);
  await expect(page.getByTestId("sketch-dof")).toHaveText("Fully defined");
  await page.getByTestId("cancel-sketch").click();
});

test("Convert Entities: a face's outline into the sketch, linked; it extrudes", async ({ page }) => {
  await sketchOnTop(page);
  await page.getByTestId("tool-convert").click();
  await expect(page.getByTestId("convert-strip")).toBeVisible();
  // Click inside the top face (not on an edge): the face is picked, its outline is what converts.
  await sketchClick(page, -20, 10);
  await expect(page.getByTestId("tool-prompt")).toContainText("1 picked");
  await page.getByTestId("convert-ok").click();
  // Four straight edges and the hole's rim, joined at the corners, and a profile with a hole.
  await expect(page.locator("[data-testid=sketch-canvas] path.entity.reference")).toHaveCount(5);
  await expect(page.getByTestId("constraint-list").locator("li")).toHaveCount(4);
  await expect(page.getByTestId("profile-status")).toHaveText("Profile: 1 region, area 3165.788 mm²");
  await expect(page.getByTestId("sketch-dof")).toHaveText("Fully defined");
  await page.screenshot({ path: "out/e2e/sketch-convert.png" });
  await page.getByTestId("finish-sketch").click();
  await waitForRebuild(page);
  await page.getByTestId("tool-extrude").click();
  await waitForRebuild(page);
  await expectVolume(page, "50,652.609");
});

test("a line drawn from a model corner is tied to it; the right-click menu converts a model edge as construction", async ({ page }) => {
  await sketchOnTop(page);
  await page.getByTestId("tool-line").click();
  // The corner of the top face snaps (a coincident glyph at the cursor), and the line starts there, tied to it.
  const [cx, cy] = await screenAt(page, 40.4, 20.3);
  await page.mouse.move(cx, cy);
  await expect(page.getByTestId("infer-coincident")).toBeVisible();
  await page.mouse.click(cx, cy);
  await sketchClick(page, 10, 30);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("constraint-list")).toContainText(/l1 start ≡ model edge \(straight, \d+ mm, \+[XY]\) (start|end)/);
  await expect(page.locator("[data-testid=sketch-canvas] path.entity.reference")).toHaveCount(1);
  // Right-click the left edge: convert it as construction (purple and dashed).
  await page.getByTestId("tool-select").click();
  const [lx, ly] = await screenAt(page, -40, -5);
  await page.mouse.click(lx, ly, { button: "right" });
  await page.getByTestId("ctx-convert-construction").click();
  await expect(page.locator("[data-testid=sketch-canvas] path.entity.reference.construction")).toHaveCount(2);
  await page.getByTestId("finish-sketch").click();
  await waitForRebuild(page);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});
