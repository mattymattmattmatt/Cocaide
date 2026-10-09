// The sketch tool registry in the browser (Phase O wave 1): SOLIDWORKS-style
// flyouts that show and run the variant used last, keys, the shortcut bar and
// the right-click menu listing the drawing tools, the options strip, Esc that
// first drops the shape and then the tool, every new shape drawn as plain
// lines, arcs, circles and points with their relations, and a centre
// rectangle and a hexagon extruded to the volume their formulas give.

import { expect, test, type Page } from "@playwright/test";
import type { Constraint, SketchEntity } from "../src/doc/types";
import { commit, expectVolume, openApp, savedDocument, sketchClick } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

const pressed = (page: Page, testId: string) => expect(page.getByTestId(testId)).toHaveAttribute("aria-pressed", "true");

/** The finished sketch's entities and relations. */
async function finished(page: Page): Promise<{ entities: SketchEntity[]; constraints: Constraint[] }> {
  await page.getByTestId("finish-sketch").click();
  const doc = (await savedDocument(page)) as { features: { op: string; entities: SketchEntity[]; constraints?: Constraint[] }[] };
  const s = doc.features.find((f) => f.op === "sketch")!;
  return { entities: s.entities, constraints: s.constraints ?? [] };
}

test("flyouts show and run the tool used last; keys, the shortcut bar and the menu pick tools; Esc drops the shape, then the tool", async ({ page }) => {
  // The Rectangle flyout lists its four, and its button becomes the one picked.
  await page.getByTestId("tool-rect-flyout").click();
  for (const t of ["rect", "rect-center", "rect3", "parallelogram"]) await expect(page.getByTestId(`flyout-${t}`)).toBeVisible();
  await page.getByTestId("flyout-rect3").click();
  await pressed(page, "tool-rect3");
  await expect(page.getByTestId("tool-rect")).toHaveCount(0);
  await expect(page.getByTestId("tool-prompt")).toHaveText("Click a corner");

  // Keys: R is the corner rectangle, Shift+R the centre one; the button follows.
  await page.keyboard.press("r");
  await pressed(page, "tool-rect");
  await page.keyboard.press("Shift+R");
  await pressed(page, "tool-rect-center");
  await page.keyboard.press("Shift+L");
  await pressed(page, "tool-centerline");
  await page.keyboard.press("p");
  await pressed(page, "tool-point");

  // The polygon's options: sides and inscribed or circumscribed, while it is the tool.
  await page.keyboard.press("g");
  await pressed(page, "tool-polygon");
  await expect(page.getByTestId("tool-option-sides")).toHaveValue("6");
  await page.getByTestId("tool-option-sides-up").click();
  await expect(page.getByTestId("tool-option-sides")).toHaveValue("7");
  await commit(page, "tool-option-sides", "99");
  await expect(page.getByTestId("tool-option-sides")).toHaveValue("40");
  await commit(page, "tool-option-sides", "6");
  await page.getByTestId("tool-option-mode-circumscribed").click();
  await expect(page.getByTestId("tool-option-mode-circumscribed")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("tool-option-mode-inscribed").click();

  // Esc: first the shape being drawn, then the tool.
  await sketchClick(page, 0, 0);
  await expect(page.getByTestId("tool-prompt")).toContainText("Click a corner (inscribed)");
  if (SHOTS) {
    await page.mouse.move(800, 400, { steps: 4 });
    await page.screenshot({ path: `${SHOTS}/sketch-polygon-strip.png` });
  }
  await page.keyboard.press("Escape");
  await pressed(page, "tool-polygon");
  await expect(page.getByTestId("tool-prompt")).toHaveText("Click the centre");
  await page.keyboard.press("Escape");
  await pressed(page, "tool-select");
  await expect(page.getByTestId("tool-strip")).toHaveCount(0);

  // The shortcut bar lists every drawing tool.
  await sketchClick(page, 30, 30);
  await page.keyboard.press("s");
  await expect(page.getByTestId("shortcut-bar")).toBeVisible();
  for (const t of ["line", "centerline", "midpoint-line", "rect-center", "rect3", "parallelogram", "circle3", "arc3", "tangent-arc", "slot-center", "polygon", "point"]) {
    await expect(page.getByTestId(`bar-${t}`)).toBeVisible();
  }
  await page.getByTestId("bar-arc3").click();
  await pressed(page, "tool-arc3");

  // The right-click menu has each toolbar button's tool: a flyout's, the one it shows.
  const [x, y] = await page.evaluate(() => {
    const m = (document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement).getScreenCTM()!;
    return [m.a * 30 + m.e, m.d * 30 + m.f];
  });
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.getByTestId("ctx-tool-rect-center")).toBeVisible();
  await expect(page.getByTestId("ctx-tool-arc3")).toBeVisible();
  await page.getByTestId("ctx-tool-polygon").click();
  await pressed(page, "tool-polygon");
  await page.getByTestId("cancel-sketch").click();
});

test("draws every new shape as lines, arcs, circles and points held by relations", async ({ page }) => {
  // Points on multiples of 5 mm: the grid snaps every click to them at this zoom.
  // Centreline (Shift+L): a construction line; Esc ends its chain.
  await page.keyboard.press("Shift+L");
  await sketchClick(page, -40, 40);
  await sketchClick(page, -40, 20);
  await page.keyboard.press("Escape");
  // Midpoint line: the middle, then one end.
  await page.getByTestId("tool-line-flyout").click();
  await page.getByTestId("flyout-midpoint-line").click();
  await sketchClick(page, -20, 30);
  await sketchClick(page, -10, 30);
  // 3-point rectangle and parallelogram.
  await page.getByTestId("tool-rect-flyout").click();
  await page.getByTestId("flyout-rect3").click();
  await sketchClick(page, 0, 20);
  await sketchClick(page, 20, 20);
  await sketchClick(page, 20, 30);
  await page.getByTestId("tool-rect-flyout").click();
  await page.getByTestId("flyout-parallelogram").click();
  await sketchClick(page, 30, 20);
  await sketchClick(page, 45, 20);
  await sketchClick(page, 50, 30);
  // Perimeter circle (Shift+C) and 3-point arc (Shift+A).
  await page.keyboard.press("Shift+C");
  await sketchClick(page, -50, 0);
  await sketchClick(page, -40, 10);
  await sketchClick(page, -30, 0);
  await page.keyboard.press("Shift+A");
  await sketchClick(page, -10, 0);
  await sketchClick(page, 10, 0);
  await sketchClick(page, 0, 6);
  // A line, then a tangent arc carrying on from its end.
  await page.keyboard.press("l");
  await sketchClick(page, 25, 0);
  await sketchClick(page, 35, 0);
  await page.keyboard.press("Escape");
  await page.getByTestId("tool-arc-flyout").click();
  await page.getByTestId("flyout-tangent-arc").click();
  await sketchClick(page, 35, 0);
  await sketchClick(page, 45, 10);
  await page.keyboard.press("Escape");
  // Centrepoint slot (Shift+O), a point (P), a hexagon (G).
  await page.keyboard.press("Shift+O");
  await sketchClick(page, -30, -30);
  await sketchClick(page, -15, -30);
  await sketchClick(page, -20, -25);
  await page.keyboard.press("p");
  await sketchClick(page, 40, -30);
  await page.keyboard.press("g");
  await sketchClick(page, 10, -30);
  await sketchClick(page, 20, -30);
  await expect(page.getByTestId("sketch-message")).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-shapes.png` });

  const { entities, constraints } = await finished(page);
  const count = (type: string, construction = false) => entities.filter((e) => e.type === type && !!e.construction === construction).length;
  // Lines: midpoint line 1, rectangle 4, parallelogram 4, line 1, slot 2, hexagon 6; construction: centreline and the slot's centreline.
  expect([count("line"), count("line", true), count("circle"), count("circle", true), count("arc"), count("point")]).toEqual([18, 2, 1, 1, 4, 2]);
  const has = (k: Partial<Constraint>) => expect(constraints).toContainEqual(expect.objectContaining(k));
  // The midpoint line runs from [-30, 30] to [-10, 30], level.
  const mid = entities.find((e) => e.type === "line" && !e.construction) as Extract<SketchEntity, { type: "line" }>;
  expect(mid.start.map(Math.round)).toEqual([-30, 30]);
  has({ type: "horizontal", entity: mid.id });
  has({ type: "perpendicular" });
  has({ type: "parallel" });
  // The tangent arc is tangent to the line and starts at its end.
  const arcs = entities.filter((e) => e.type === "arc");
  const line = entities.find((e) => e.type === "line" && e.start[0] === 25)!;
  has({ type: "tangent", entities: [arcs[1].id, line.id] });
  has({ type: "coincident", points: [`${arcs[1].id}.start`, `${line.id}.end`] });
  // The slot's centre point is the middle of its centreline; the hexagon's sides are equal and one is level.
  has({ type: "midpoint", point: "p1.at" });
  expect(constraints.filter((k) => k.type === "equal")).toHaveLength(5 + 1);
  expect(constraints.filter((k) => k.type === "pointOn")).toHaveLength(6);
});

test("a line chain carries on from each end; double-click ends it, clicking its start closes it", async ({ page }) => {
  await page.keyboard.press("l");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 20, 0);
  await sketchClick(page, 20, 20);
  await expect(page.locator("[data-entity]")).toHaveCount(2);
  // A tangent arc on from the end (A), then lines again.
  await page.keyboard.press("a");
  await expect(page.getByTestId("tool-prompt")).toContainText("Tangent arc");
  await sketchClick(page, 0, 20);
  await sketchClick(page, 0, 0);
  await expect(page.getByTestId("profile-status")).toContainText("1 region");
  // The chain closed at its start: the tool is ready for a new one.
  await expect(page.getByTestId("tool-prompt")).toHaveText("Click where the line starts");
  await sketchClick(page, 30, 0);
  const [x, y] = await page.evaluate(() => {
    const m = (document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement).getScreenCTM()!;
    return [m.a * 40 + m.e, m.d * 10 + m.f];
  });
  await page.mouse.dblclick(x, y);
  await expect(page.getByTestId("tool-prompt")).toHaveText("Click where the line starts");
  const { entities, constraints } = await finished(page);
  expect(entities.map((e) => e.type)).toEqual(["line", "line", "arc", "line", "line"]);
  expect(constraints).toContainEqual({ type: "tangent", entities: ["a1", "l2"] });
  // Closed where it started: on the origin, as the first click was.
  expect(constraints).toContainEqual({ type: "coincident", points: ["l1.start", "origin"] });
  expect(constraints).toContainEqual({ type: "coincident", points: ["l3.end", "origin"] });
});

test("extrudes a centre rectangle and a hexagon to the volumes their formulas give", async ({ page }) => {
  // A centre rectangle on the origin, 40 x 20.
  await page.keyboard.press("Shift+R");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 20, 10);
  await expect(page.getByTestId("sketch-dof")).toHaveText("Under defined: 2 degrees of freedom");
  // A hexagon round [-40, 0], corners 10 from it, a side level.
  await page.getByTestId("tool-polygon").click();
  await sketchClick(page, -40, 0);
  await sketchClick(page, -30, 0);
  await expect(page.getByTestId("profile-status")).toContainText("2 regions");
  await page.getByTestId("finish-sketch").click();
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "10");
  // (40 x 20 + 3√3/2 x 10²) x 10.
  const volume = (800 + ((3 * Math.sqrt(3)) / 2) * 100) * 10;
  await expectVolume(page, volume.toLocaleString("en-US", { maximumFractionDigits: 3 }));
});

test("the toolbar stays on one row with a flyout open", async ({ page }) => {
  const rows = await page.evaluate(() => {
    const bar = document.querySelector(".sketch-toolbar") as HTMLElement;
    // One row: every button and separator centred on the same line, nothing scrolled out of sight.
    const middles = new Set([...bar.children].map((c) => c.getBoundingClientRect()).map((r) => Math.round(r.top + r.height / 2)));
    return { rows: middles.size, overflow: bar.scrollWidth - bar.clientWidth };
  });
  expect(rows).toEqual({ rows: 1, overflow: 0 });
  await page.getByTestId("tool-rect-flyout").click();
  await expect(page.getByTestId("flyout-parallelogram")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-flyout-rect.png` });
  await page.getByTestId("tool-arc-flyout").click();
  await expect(page.getByTestId("flyout-tangent-arc")).toBeVisible();
  await expect(page.getByTestId("flyout-parallelogram")).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-flyout-arc.png` });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("flyout-tangent-arc")).toHaveCount(0);
});
