// Sketch relations and dimensions as SOLIDWORKS has them: relations
// inferred while drawing, the Add Relations buttons for a selection, Smart
// Dimension with its Modify box, dimensions and relation glyphs drawn on the
// sketch, blue/black by how defined it is, and the right-click menus.

import { expect, test, type Page } from "@playwright/test";
import { commit, openApp, sketchClick } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  await commit(page, "doc-name", "relations");
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
});

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

async function ctrlClick(page: Page, x: number, y: number) {
  await page.keyboard.down("Control");
  await sketchClick(page, x, y);
  await page.keyboard.up("Control");
}

test("relations: inferred while drawing, added from a selection, shown as glyphs, and the sketch goes black when defined", async ({ page }) => {
  // A line drawn nearly level comes out level, with a Horizontal relation, as SOLIDWORKS infers it.
  await page.getByTestId("tool-line").click();
  await sketchClick(page, -30, 0);
  await sketchClick(page, 10, 0.4);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("constraint-list")).toContainText("l1 horizontal");
  await expect(page.getByTestId("glyph-0")).toHaveAttribute("data-relation", "horizontal");

  // A second line, then Ctrl-click both: the Add Relations buttons for two lines.
  await sketchClick(page, -30, 20);
  await sketchClick(page, 0, 35);
  await page.keyboard.press("Escape");
  await page.getByTestId("tool-select").click();
  await sketchClick(page, -10, 0);
  await ctrlClick(page, -15, 27.5);
  await expect(page.getByTestId("relation-buttons")).toBeVisible();
  for (const id of ["c-parallel", "c-perpendicular", "c-collinear", "c-equal"]) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("c-angle-value")).toHaveValue("26.565051");
  await page.getByTestId("c-parallel").click();
  await expect(page.getByTestId("constraint-list")).toContainText("l1 ∥ l2");
  // Parallel shows on both lines; the parallel lines can now be a distance apart.
  await expect(page.locator('[data-relation="parallel"]')).toHaveCount(2);

  // Pin l1 down and dimension it: l1 is fully defined (black), l2 still moves (blue).
  await sketchClick(page, -10, 0);
  await page.getByTestId("c-fix").click();
  await expect(page.locator('[data-entity="l1"]')).toHaveClass(/\bdefined\b/);
  await expect(page.locator('[data-entity="l2"]')).toHaveClass(/\bfree\b/);
  await expect(page.getByTestId("sketch-status")).toHaveText("Under defined");

  // Hide the glyphs, show them again.
  await page.getByTestId("tool-relations").click();
  await expect(page.locator(".glyph")).toHaveCount(0);
  await page.getByTestId("tool-relations").click();
  await expect(page.locator(".glyph")).not.toHaveCount(0);
});

test("Smart Dimension: a line's length, a circle's diameter, two lines' angle, in the Modify box; a double-click edits one", async ({ page }) => {
  await page.getByTestId("tool-line").click();
  await sketchClick(page, 0, 0);
  await sketchClick(page, 30, 0);
  await page.keyboard.press("Escape");
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, 60, 20);
  await sketchClick(page, 70, 20);

  // D, then the line, then a click in space: the Modify box, with what it measures now.
  await page.keyboard.press("d");
  await expect(page.getByTestId("tool-dimension")).toHaveAttribute("aria-pressed", "true");
  await sketchClick(page, 15, 0);
  await sketchClick(page, 15, -12);
  await expect(page.getByTestId("modify-box")).toBeVisible();
  await expect(page.getByTestId("modify-value")).toHaveValue("30");
  await page.getByTestId("modify-value").fill("45");
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("modify-box")).toHaveCount(0);
  // The line started on the origin and was drawn level: coincident and horizontal, then this length.
  await expect(page.getByTestId("constraint-list")).toContainText("l1 length");
  await expect(page.getByTestId("dim-2")).toContainText("45");

  // A circle is dimensioned by its diameter.
  await sketchClick(page, 70, 20);
  await sketchClick(page, 50, 40);
  await expect(page.getByTestId("modify-value")).toHaveValue("20");
  await page.getByTestId("modify-value").fill("16");
  await page.getByTestId("modify-ok").click();
  await expect(page.getByTestId("constraint-list")).toContainText("c1 diameter");
  await expect(page.getByTestId("dim-3")).toContainText("Ø16");

  // Double-click a dimension to change it.
  await page.getByTestId("tool-select").click();
  await page.getByTestId("dim-3").locator("text").dblclick();
  await expect(page.getByTestId("modify-value")).toHaveValue("16");
  await page.getByTestId("modify-value").fill("=10 * 2");
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("dim-3")).toContainText("Ø20");
  await expect(page.getByTestId("constraint-value-3")).toHaveValue("=10 * 2");

  // Two points: the box offers aligned, horizontal and vertical.
  await page.keyboard.press("d");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 60, 20);
  await expect(page.getByTestId("modify-c-distance-x")).toBeVisible();
  await page.getByTestId("modify-c-distance-y").click();
  await expect(page.getByTestId("modify-value")).toHaveValue("20");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("modify-box")).toHaveCount(0);
});

test("right-click menus: an entity's relations and Ask AI…, a dimension's edit and delete, empty space's tools", async ({ page }) => {
  await page.getByTestId("tool-line").click();
  await sketchClick(page, 0, 0);
  await sketchClick(page, 20, 15);
  await page.keyboard.press("Escape");
  await page.getByTestId("tool-select").click();

  // On the line: relations it can take, construction, delete, and Ask AI.
  const [lx, ly] = await screenAt(page, 10, 7.5);
  await page.mouse.click(lx, ly, { button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Line l1");
  await expect(page.getByTestId("ctx-ask")).toBeVisible();
  await page.getByTestId("ctx-c-vertical").click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("constraint-list")).toContainText("l1 vertical");

  // Made vertical, the line now runs up from the origin. A dimension from its menu, then right-click that: edit or delete.
  const [x, y] = await screenAt(page, 0, 10);
  await page.mouse.click(x, y, { button: "right" });
  await page.getByTestId("ctx-dimension").click();
  await page.getByTestId("modify-value").fill("40");
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("dim-2")).toContainText("40");
  await page.getByTestId("dim-2").locator("text").click({ button: "right" });
  await expect(menu).toContainText("Distance 40");
  await page.getByTestId("ctx-delete-constraint").click();
  await expect(page.getByTestId("constraint-list").locator("li")).toHaveCount(2);

  // Empty space: the sketch tools and Exit sketch.
  const [ex, ey] = await screenAt(page, -40, -30);
  await page.mouse.click(ex, ey, { button: "right" });
  await expect(menu).toContainText("Sketch sketch_1");
  await page.getByTestId("ctx-tool-circle").click();
  await expect(page.getByTestId("tool-circle")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(ex, ey, { button: "right" });
  await page.getByTestId("ctx-finish").click();
  await expect(page.getByTestId("feature-sketch_1")).toBeVisible();
});

test("a plate sketched as in SOLIDWORKS: inferred relations, Smart Dimensions, equal holes, fully defined", async ({ page }) => {
  await page.getByTestId("tool-line").click();
  for (const [x, y] of [[-40, -20], [40, -20], [40, 20], [-40, 20], [-40, -20]]) await sketchClick(page, x, y);
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, -20, 0);
  await sketchClick(page, -14, 0);
  await sketchClick(page, 20, 0);
  await sketchClick(page, 26, 0);
  // Width, height, one hole's diameter and where it sits, the other hole the same and level with it.
  await page.keyboard.press("d");
  for (const [pick, place, value] of [
    [[0, -20], [0, -30], "80"],
    [[40, 0], [50, 0], "40"],
    [[-14, 0], [-8, 12], "12"],
  ] as const) {
    await sketchClick(page, pick[0], pick[1]);
    await sketchClick(page, place[0], place[1]);
    await page.getByTestId("modify-value").fill(value);
    await page.getByTestId("modify-value").press("Enter");
  }
  await sketchClick(page, -40, -20);
  await sketchClick(page, -20, 0);
  await page.getByTestId("modify-c-distance-x").click();
  await page.getByTestId("modify-value").press("Enter");
  await sketchClick(page, -40, -20);
  await sketchClick(page, -20, 0);
  await page.getByTestId("modify-c-distance-y").click();
  await page.getByTestId("modify-value").press("Enter");
  await page.getByTestId("tool-select").click();
  await sketchClick(page, -14, 0);
  await ctrlClick(page, 26, 0);
  await page.getByTestId("c-equal").click();
  // The two centres level, 40 apart: select both centres.
  await sketchClick(page, -20, 0);
  await ctrlClick(page, 20, 0);
  await page.getByTestId("c-horizontal-points").click();
  await sketchClick(page, -20, 0);
  await ctrlClick(page, 20, 0);
  await page.getByTestId("c-distance-x-value").fill("40");
  await page.getByTestId("c-distance-x").click();
  await sketchClick(page, -40, -20);
  await page.getByTestId("c-coincident").click();
  await expect(page.getByTestId("sketch-status")).toHaveText("Fully defined");
  await expect(page.locator(".entity.free")).toHaveCount(0);
  // Corner on the origin: the plate runs 0 to 80 by 0 to 40. Fit it, and right-click its top edge for its menu.
  await page.keyboard.press("f");
  const [x, y] = await screenAt(page, 25, 40);
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.getByTestId("context-menu")).toContainText("Line l3");
  await page.screenshot({ path: "docs/sketch-relations.png" });
});

test("right-click acts on what was right-clicked, not on the selection before it", async ({ page }) => {
  await page.getByTestId("tool-line").click();
  await sketchClick(page, -30, 10);
  await sketchClick(page, -10, 30);
  await page.keyboard.press("Escape");
  await sketchClick(page, 10, 10);
  await sketchClick(page, 30, 30);
  await page.keyboard.press("Escape");
  await page.getByTestId("tool-select").click();
  await sketchClick(page, -20, 20); // l1 selected
  const [x, y] = await screenAt(page, 20, 20);
  await page.mouse.click(x, y, { button: "right" }); // on l2
  await expect(page.getByTestId("context-menu")).toContainText("Line l2");
  await page.getByTestId("ctx-delete").click();
  await expect(page.locator('[data-entity="l2"]')).toHaveCount(0);
  await expect(page.locator('[data-entity="l1"]')).toHaveCount(1);
});
