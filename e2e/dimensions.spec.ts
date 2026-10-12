// Wave 4B: the details that make the sketcher feel like SOLIDWORKS. Driven
// dimensions offered when one would over-define, named dimensions read by
// expressions elsewhere, the Modify box's functions and units, min and max to
// a circle with Shift, Fully Define, typing a length while drawing, and the
// status line and Display/Delete Relations panel.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, sketchClick } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  await commit(page, "doc-name", "dimensions");
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
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

/** Smart Dimension on two picks (or one and a place), then a value typed into the Modify box. */
async function dimension(page: Page, a: [number, number], b: [number, number], value?: string) {
  await sketchClick(page, a[0], a[1]);
  await sketchClick(page, b[0], b[1]);
  if (value === undefined) return;
  await page.getByTestId("modify-value").fill(value);
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("modify-box")).toHaveCount(0);
}

test("an empty sketch says so; a dimension that over-defines is offered as driven, and follows the geometry", async ({ page }) => {
  await expect(page.getByTestId("sketch-status")).toHaveText("Empty sketch");
  // A level line from the origin: coincident and horizontal are inferred.
  await page.getByTestId("tool-line").click();
  await sketchClick(page, 0, 0);
  await sketchClick(page, 30, 0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sketch-status")).toHaveText("Under defined · 1 DOF");
  await page.keyboard.press("d");
  await dimension(page, [15, 0], [15, -10], "30");
  await expect(page.getByTestId("sketch-status")).toHaveText("Fully defined");

  // The distance between its ends would fix the length again: SOLIDWORKS asks.
  await sketchClick(page, 0, 0);
  await sketchClick(page, 30, 0);
  await expect(page.getByTestId("driven-prompt")).toBeVisible();
  await expect(page.getByTestId("driven-prompt")).toContainText("Make this dimension driven?");
  await page.getByTestId("driven-yes").click();
  await expect(page.getByTestId("constraint-row-3")).toHaveAttribute("data-state", "driven");
  await expect(page.getByTestId("dim-3")).toContainText("(30)");
  await expect(page.getByTestId("dim-3")).toHaveClass(/\bdriven\b/);
  await expect(page.getByTestId("sketch-status")).toHaveText("Fully defined");

  // Change the driving length: the driven one reads the new geometry.
  await page.getByTestId("tool-select").click();
  await page.getByTestId("dim-2").locator("text").dblclick();
  await page.getByTestId("modify-value").fill("42");
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("dim-3")).toContainText("(42)");

  // Right-click the driven one: make it driving would over-define, so it stays driven and says why.
  await page.getByTestId("dim-3").locator("text").click({ button: "right" });
  await page.getByTestId("ctx-toggle-driven").click();
  await expect(page.getByTestId("sketch-message")).toContainText("would over-define");
  await expect(page.getByTestId("constraint-row-3")).toHaveAttribute("data-state", "driven");

  // Make the length driven instead (its menu), then the other driving: the sketch stays fully defined.
  await page.getByTestId("dim-2").locator("text").click({ button: "right" });
  await page.getByTestId("ctx-toggle-driven").click();
  await expect(page.getByTestId("constraint-row-2")).toHaveAttribute("data-state", "driven");
  await expect(page.getByTestId("sketch-status")).toHaveText("Under defined · 1 DOF");
  await page.getByTestId("dim-3").locator("text").click({ button: "right" });
  await page.getByTestId("ctx-toggle-driven").click();
  await expect(page.getByTestId("sketch-status")).toHaveText("Fully defined");
  await page.getByTestId("finish-sketch").click();
  const sketch = ((await savedDocument(page)).features as { constraints: Record<string, unknown>[] }[])[0];
  expect(sketch.constraints[2]).toMatchObject({ type: "distance", entity: "l1", driven: true, value: 42 });
  expect(sketch.constraints[3]).toMatchObject({ type: "distance", value: 42 });
  expect(sketch.constraints[3].driven).toBeUndefined();
});

test("the Modify box takes functions and units, spins, and a renamed dimension drives another feature's depth", async ({ page }) => {
  // A rectangle from the origin.
  await page.getByTestId("tool-rect").click();
  await sketchClick(page, 0, 0);
  await sketchClick(page, 40, 20);
  await page.keyboard.press("d");
  // Its bottom side: sqrt(2)*10, worked out once; what it comes to shows as it is typed.
  await sketchClick(page, 20, 0);
  await sketchClick(page, 20, -10);
  await page.getByTestId("modify-value").fill("sqrt(2)*10");
  await expect(page.getByTestId("modify-evaluated")).toHaveText("= 14.142136 mm");
  await page.getByTestId("modify-value").press("Enter");
  const width = page.getByTestId("constraint-list").locator("li", { hasText: "l1 length" });
  await expect(width.locator("input")).toHaveValue(/^14\.142135/);
  // Its right side: 1in is 25.4 mm. A typing slip says what is wrong, in the box.
  await sketchClick(page, 14.142136, 10);
  await sketchClick(page, 30, 10);
  await page.getByTestId("modify-value").fill("1in +");
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("modify-error")).toBeVisible();
  await page.getByTestId("modify-value").fill("1in");
  await expect(page.getByTestId("modify-evaluated")).toHaveText("= 25.4 mm");
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("constraint-list").locator("li", { hasText: "l2 length" }).locator("input")).toHaveValue("25.4");

  // Double-click the width: spin it up a step (1 mm), rename it, apply.
  await page.getByTestId("tool-select").click();
  const widthDim = page.locator('.dim:has-text("14.142")');
  await widthDim.locator("text").dblclick();
  await page.getByTestId("modify-value").fill("40");
  await page.getByTestId("modify-spin-up").click();
  await expect(page.getByTestId("modify-value")).toHaveValue("41");
  await page.getByTestId("modify-value").press("ArrowDown");
  await expect(page.getByTestId("modify-value")).toHaveValue("40");
  await page.getByTestId("modify-name").fill("width");
  await page.getByTestId("modify-ok").click();
  await expect(page.getByTestId("constraint-list")).toContainText("width");
  await page.getByTestId("finish-sketch").click();

  // Extrude it, its depth half the sketch's width by name.
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "=sketch_1.width / 2");
  await expect(page.getByTestId("properties").locator(".expr-value")).toHaveText("= 20");
  await expectVolume(page, "20,320"); // 40 × 25.4 × 20

  // Change the width in the sketch: the depth follows.
  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  await page.locator('.dim:has-text("40")').first().locator("text").dblclick();
  await page.getByTestId("modify-value").fill("50");
  await page.getByTestId("modify-value").press("Enter");
  await page.getByTestId("finish-sketch").click();
  await expectVolume(page, "31,750"); // 50 × 25.4 × 25

  // Rename it again in the sketcher: the extrude's expression follows the new name.
  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  await page.locator('.dim:has-text("50")').first().locator("text").dblclick();
  await page.getByTestId("modify-name").fill("plate_w");
  await page.getByTestId("modify-value").press("Enter");
  await page.getByTestId("finish-sketch").click();
  const doc = await savedDocument(page);
  const ext = (doc.features as Record<string, unknown>[])[1];
  expect(ext.distance).toBe("=sketch_1.plate_w / 2");
  await expectVolume(page, "31,750");
});

test("Smart Dimension: Shift-click a circle for its near or far side; two points by where the dimension is dropped", async ({ page }) => {
  await page.getByTestId("tool-line").click();
  await sketchClick(page, 0, -10);
  await sketchClick(page, 0, 10);
  await page.keyboard.press("Escape");
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, 40, 10);
  await sketchClick(page, 50, 10);
  await page.keyboard.press("d");

  // The line's top end, then Shift-click the circle on its near side: to the circle's edge (min).
  await sketchClick(page, 0, 10);
  await page.keyboard.down("Shift");
  await sketchClick(page, 30, 10);
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("modify-box")).toContainText("(min)");
  await expect(page.getByTestId("modify-value")).toHaveValue("30");
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("constraint-list")).toContainText("(min)");

  // The far side: to beyond the circle (max).
  await sketchClick(page, 0, 10);
  await page.keyboard.down("Shift");
  await sketchClick(page, 50, 10);
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("modify-box")).toContainText("(max)");
  await expect(page.getByTestId("modify-value")).toHaveValue("50");
  await page.keyboard.press("Escape");

  // Two points dropped above them: the horizontal distance comes first; beside them, the vertical.
  await sketchClick(page, 0, -10);
  await sketchClick(page, 40, 10);
  await expect(page.getByTestId("modify-value")).toHaveValue(/.+/);
  await page.keyboard.press("Escape");
  await sketchClick(page, 0, -10);
  await sketchClick(page, 40, 10);
  await expect(page.getByTestId("modify-box")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Fully Define previews what it adds, then the sketch is fully defined and nothing moved", async ({ page }) => {
  await page.getByTestId("tool-rect").click();
  await sketchClick(page, 10, 10);
  await sketchClick(page, 50, 30);
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, -20, -20);
  await sketchClick(page, -10, -20);
  await expect(page.getByTestId("sketch-status")).toHaveText(/^Under defined · \d+ DOF$/);
  await page.getByTestId("tool-fully-define").click();
  await expect(page.getByTestId("fully-define")).toBeVisible();
  await expect(page.getByTestId("fully-define-list").locator("li")).not.toHaveCount(0);
  await expect(page.locator('[data-testid^="dim-proposed-"]').first()).toBeVisible();
  await page.getByTestId("fully-define-apply").click();
  await expect(page.getByTestId("fully-define")).toHaveCount(0);
  await expect(page.getByTestId("sketch-status")).toHaveText("Fully defined");
  await expect(page.locator(".entity.free")).toHaveCount(0);
  await page.getByTestId("finish-sketch").click();
  const sketch = ((await savedDocument(page)).features as { entities: { id: string; center?: number[]; radius?: number; start?: number[] }[] }[])[0];
  const c = sketch.entities.find((e) => e.radius !== undefined)!;
  expect(c.center).toEqual([-20, -20]);
  expect(c.radius).toBe(10);
  expect(sketch.entities.find((e) => e.id === "l1")!.start).toEqual([10, 10]);
});

test("typing a length while drawing a line opens a box at the pointer; the value becomes the line's dimension", async ({ page }) => {
  await page.getByTestId("tool-line").click();
  await sketchClick(page, 0, 0);
  const [x, y] = await screenAt(page, 20, 0);
  await page.mouse.move(x, y);
  await page.keyboard.type("25");
  await expect(page.getByTestId("typed-box")).toBeVisible();
  await expect(page.getByTestId("typed-length")).toHaveValue("25");
  await page.keyboard.press("Tab");
  await page.keyboard.type("0");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("typed-box")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("constraint-list")).toContainText("l1 length");
  await expect(page.getByTestId("constraint-list")).toContainText("l1 horizontal");
  await expect(page.getByTestId("sketch-status")).toHaveText("Fully defined");
  const row = page.getByTestId("constraint-list").locator("li", { hasText: "l1 length" });
  await expect(row.locator("input")).toHaveValue("25");
});

test("the relations panel lists, filters and highlights; an over-defined sketch names the conflict and offers fixes", async ({ page }) => {
  // A sketch that arrives over defined (as an agent or an import may write it): its length and its width.
  await page.getByTestId("cancel-sketch").click();
  await page.getByTestId("tab-document").click();
  const editor = page.getByTestId("doc-editor");
  const doc = JSON.parse(await editor.inputValue());
  doc.features = [
    {
      id: "sketch_1",
      op: "sketch",
      plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
      entities: [
        { id: "l1", type: "line", start: [0, 0], end: [30, 0] },
        { id: "c1", type: "circle", center: [15, 20], radius: 5 },
      ],
      constraints: [
        { type: "coincident", points: ["l1.start", "origin"] },
        { type: "horizontal", entity: "l1" },
        { type: "distance", entity: "l1", value: 30 },
        { type: "distanceX", entity: "l1", value: 30 },
        { type: "diameter", entity: "c1", value: 10 },
      ],
    },
  ];
  await editor.fill(JSON.stringify(doc, null, 2));
  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  await expect(page.getByTestId("sketch-status")).toHaveText("Over defined: d2 conflicts with d1");
  await expect(page.getByTestId("sketch-status")).toHaveClass(/\bover\b/);
  await expect(page.getByTestId("constraint-row-3")).toHaveAttribute("data-state", "conflict");
  await expect(page.getByTestId("dim-3")).toHaveClass(/\bconflict\b/);

  // Filter: over defining only; on the selected circle only.
  await page.getByTestId("relations-filter").selectOption("over");
  await expect(page.getByTestId("constraint-list").locator("li")).toHaveCount(2);
  await page.getByTestId("relations-filter").selectOption("selected");
  await expect(page.getByTestId("relations-none")).toBeVisible();
  await sketchClick(page, 20, 20);
  await expect(page.getByTestId("constraint-list").locator("li")).toHaveCount(1);
  await page.getByTestId("relations-filter").selectOption("all");
  // A row clicked highlights what it holds.
  await page.getByTestId("constraint-row-1").locator(".constraint-label").click();
  await expect(page.locator('[data-entity="l1"]')).toHaveClass(/\brelated\b/);

  await page.screenshot({ path: "out/shots/dimensions-over-defined.png" });
  // One click: make d2 driven.
  await page.getByTestId("fix-driven-3").click();
  // The line can still grow (its width now only measures), and the circle can move: 2 degrees of freedom.
  await expect(page.getByTestId("sketch-status")).toHaveText("Under defined · 2 DOF");
  await expect(page.getByTestId("dim-3")).toContainText("(30)");
  await page.screenshot({ path: "out/shots/dimensions-relations-panel.png" });
});
