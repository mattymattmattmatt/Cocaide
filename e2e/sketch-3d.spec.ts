// Sketching in the 3D view (Phase P wave 2A), as a user meets it: a sketch
// opens in the 3D view, turned to face its plane, the part still there; the
// middle button turns the view and the sketch stays editable on its plane;
// model edges off the plane are hovered and dimensioned where the 3D view
// shows them; another sketch's line is a reference the sketch follows; an
// edge-on plane pauses drawing until Ctrl+8 faces it again; Finish glides
// back to the view before; an empty sketch adds nothing.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, sketchClick, viewportClick, waitForRebuild } from "./helpers";

type Cam = { position: number[]; target: number[]; up: number[] };
type Hook = { __cocaideViewport: { project(p: number[]): [number, number]; camera(): Cam; display(): { perspective: boolean; surfacesShown: boolean } } };

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = await openApp(page);
});

test.afterEach(() => expect(problems).toEqual([]));

const cam = (page: Page) => page.evaluate(() => (window as unknown as Hook).__cocaideViewport.camera());
const project = (page: Page, p: number[]) => page.evaluate((p) => (window as unknown as Hook).__cocaideViewport.project(p), p);
/** Where the camera looks from, toward the camera, unit (3 decimals). */
const from = (c: Cam) => {
  const d = c.position.map((x, i) => x - c.target[i]);
  const n = Math.hypot(...d);
  return d.map((x) => Math.round((x / n) * 1000) / 1000 + 0);
};

async function bracket(page: Page) {
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
}

/** A new sketch on the bracket's front side face (y = -20): its x is the world's x, its y the world's z. */
async function sketchOnSide(page: Page) {
  await viewportClick(page, [0, -20, 3]);
  await expect(page.getByTestId("selection")).toContainText(/face/i);
  await page.getByTestId("tool-sketch").click();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
  await expect(page.getByTestId("sketch-canvas")).toHaveAttribute("data-facing", "true");
}

/** Turns the view with the middle button (the sketch's left button stays its tools'). */
async function turn(page: Page, dx = 120, dy = 80) {
  const box = (await page.getByTestId("sketch-canvas").boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 6 });
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  await expect(page.getByTestId("sketch-canvas")).toHaveAttribute("data-facing", "false");
}

/** The last feature of the working document. */
async function lastFeature(page: Page): Promise<{ id: string; op: string; entities: Record<string, unknown>[]; constraints: Record<string, unknown>[] }> {
  const doc = (await savedDocument(page)) as { features: { id: string; op: string; entities: Record<string, unknown>[]; constraints: Record<string, unknown>[] }[] };
  return doc.features[doc.features.length - 1];
}

/** The first point of an entity's outline in the sketcher, sketch mm (a circle's is its rim at angle 0). */
async function firstPoint(page: Page, id: string): Promise<[number, number]> {
  const d = await page.locator(`[data-testid=sketch-canvas] path[data-entity="${id}"]`).getAttribute("d");
  const m = /^M(-?[\d.e-]+) (-?[\d.e-]+)/.exec(d ?? "");
  return [Number(m![1]), Number(m![2])];
}

test("a sketch on a side face opens in the 3D view facing it; turned with the middle button it stays editable; Finish glides back", async ({ page }) => {
  await bracket(page);
  const before = await cam(page);
  await sketchOnSide(page);
  // The 3D view is still there, the part drawn, square onto the face from the front (-Y), orthographic.
  await expect(page.getByTestId("sketch-stage")).toBeVisible();
  await expect.poll(async () => from(await cam(page))).toEqual([0, -1, 0]);
  const display = await page.evaluate(() => (window as unknown as Hook).__cocaideViewport.display());
  expect(display.surfacesShown).toBe(true);
  expect(display.perspective).toBe(false);
  // See-through and Section at sketch plane are toggles in the view's bar.
  await page.getByTestId("sketch-see-through").click();
  await expect(page.getByTestId("sketch-see-through")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("sketch-see-through").click();
  await expect(page.getByTestId("sketch-see-through")).toHaveAttribute("aria-pressed", "false");

  // Middle-drag turns the view: no longer facing the plane, and the sketch is still drawn on it.
  await turn(page);
  expect(from(await cam(page))).not.toEqual([0, -1, 0]);
  await expect(page.getByTestId("sketch-edge-on")).toHaveCount(0);

  // A line drawn in the turned view lands on the plane where it was clicked: 40 mm long, 20 above the plate's foot.
  await page.getByTestId("tool-line").click();
  await sketchClick(page, -20, 20);
  await sketchClick(page, 20, 20);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid=sketch-canvas] path[data-entity]")).toHaveCount(1);
  await page.getByTestId("tool-select").click();
  await page.mouse.move(5, 5);
  await page.screenshot({ path: "out/e2e/sketch-3d-turned.png" });

  // Finish: back to the view the sketch was opened from.
  await page.getByTestId("finish-sketch").click();
  await waitForRebuild(page);
  await expect(page.getByTestId("sketch-canvas")).toHaveCount(0);
  await expect.poll(async () => from(await cam(page))).toEqual(from(before));
  const f = await lastFeature(page);
  expect(f.op).toBe("sketch");
  const line = f.entities.find((e) => e.type === "line") as { start: number[]; end: number[] };
  line.start.forEach((x, i) => expect(x).toBeCloseTo([-20, 20][i], 6));
  line.end.forEach((x, i) => expect(x).toBeCloseTo([20, 20][i], 6));
});

test("in a turned view a model edge off the plane is hovered where the view shows it, and Smart Dimension takes it", async ({ page }) => {
  await bracket(page);
  await sketchOnSide(page);
  // A circle on the face, then turn the view.
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, 10, 3);
  await sketchClick(page, 12, 3);
  await turn(page);
  // The plate's back top edge (y = 20, z = 6) is not in the sketch plane: hovering it in 3D lights it up.
  const [ex, ey] = await project(page, [10, 20, 6]);
  await page.getByTestId("tool-select").click();
  await page.mouse.move(ex, ey);
  await expect(page.getByTestId("scene-hover")).toHaveCount(1);
  // Smart Dimension: the circle's centre, then that edge.
  await page.getByTestId("tool-dimension").click();
  await sketchClick(page, 10, 3);
  await page.mouse.move(ex, ey);
  await page.mouse.click(ex, ey);
  await expect(page.getByTestId("modify-box")).toBeVisible();
  // Its projection is the line z = 6 on the face: the distance down to the centre (on the grid near z = 3).
  await expect(page.getByTestId("modify-value")).toHaveValue(/^[2-4](\.0+)?$/);
  await page.getByTestId("modify-value").fill("2");
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("constraint-list")).toContainText("c1 centre ↔ model edge (straight, 80 mm, +X)");
  await page.getByTestId("finish-sketch").click();
  await waitForRebuild(page);
  const f = await lastFeature(page);
  const ref = f.entities.find((e) => e.ref) as { type: string; ref: { edge: unknown } };
  expect(ref.type).toBe("line");
  expect(ref.ref.edge).toBeTruthy();
  const circle = f.entities.find((e) => e.type === "circle") as { center: number[] };
  expect(circle.center[1]).toBeCloseTo(4, 6);
});

test("another sketch's line, hovered in 3D and dimensioned to, is a reference the sketch follows when that sketch changes", async ({ page }) => {
  // The bracket and a guide sketch on a plane 30 behind the side face: a line 20 above the foot, its height dimensioned.
  const doc = {
    version: 1,
    units: "mm",
    name: "guide",
    features: [
      { id: "sketch_1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 80, h: 40 }], constraints: [] },
      { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: 6, direction: [0, 0, 1] },
      {
        id: "guide",
        op: "sketch",
        plane: { type: "datum", normal: [0, -1, 0], origin: [0, 10, 0] },
        entities: [{ id: "l1", type: "line", start: [-15, 20], end: [15, 20] }],
        constraints: [
          { type: "horizontal", entity: "l1" },
          { type: "distance", point: "l1.start", line: "X", value: 20 },
        ],
      },
    ],
  };
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
  await sketchOnSide(page);
  await page.getByTestId("tool-circle").click();
  await sketchClick(page, 0, 12);
  await sketchClick(page, 2, 12);
  await turn(page);
  // The guide's line, 30 behind the plane: hovered where the view draws it.
  const [gx, gy] = await project(page, [5, 10, 20]);
  await page.getByTestId("tool-select").click();
  await page.mouse.move(gx, gy);
  await expect(page.getByTestId("scene-hover")).toHaveCount(1);
  await page.getByTestId("tool-dimension").click();
  await sketchClick(page, 0, 12);
  await page.mouse.move(gx, gy);
  await page.mouse.click(gx, gy);
  await expect(page.getByTestId("modify-box")).toBeVisible();
  await page.getByTestId("modify-value").fill("5");
  await page.getByTestId("modify-value").press("Enter");
  await expect(page.getByTestId("constraint-list")).toContainText("c1 centre ↔ guide l1 (straight, 30 mm, +X)");
  await page.getByTestId("finish-sketch").click();
  await waitForRebuild(page);
  const f = await lastFeature(page);
  const ref = f.entities.find((e) => e.ref) as { ref: { sketch: string; entity: string } };
  expect(ref.ref).toEqual({ sketch: "guide", entity: "l1" });
  expect((f.entities.find((e) => e.type === "circle") as { center: number[] }).center[1]).toBeCloseTo(15, 6);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);

  // Raise the guide's line 4 mm: the circle, 5 below it, follows.
  await page.getByTestId("feature-guide").locator(".feature-row").dblclick();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
  await commit(page, "constraint-value-1", "24");
  await page.getByTestId("finish-sketch").click();
  await waitForRebuild(page);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  await page.getByTestId(`feature-${f.id}`).locator(".feature-row").dblclick();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
  expect((await firstPoint(page, "c1"))[1]).toBeCloseTo(19, 6);
  await page.getByTestId("cancel-sketch").click();
});

test("turned edge-on, drawing pauses with a hint; Ctrl+8 faces the plane again", async ({ page }) => {
  await bracket(page);
  await sketchOnSide(page);
  // Looking straight down (Top) sees the side face's plane edge-on.
  await page.keyboard.press("Control+5");
  await expect(page.getByTestId("sketch-edge-on")).toBeVisible();
  await expect(page.getByTestId("sketch-edge-on")).toContainText("The sketch plane is edge-on — turn the view or press Ctrl+8");
  await page.keyboard.press("Control+8");
  await expect(page.getByTestId("sketch-edge-on")).toHaveCount(0);
  await expect(page.getByTestId("sketch-canvas")).toHaveAttribute("data-facing", "true");
  await expect.poll(async () => from(await cam(page))).toEqual([0, -1, 0]);
  await page.getByTestId("cancel-sketch").click();
});

test("an empty sketch finished adds nothing, and says so; one in the document reads 'Empty sketch'", async ({ page }) => {
  await bracket(page);
  const count = ((await savedDocument(page)) as { features: unknown[] }).features.length;
  await sketchOnSide(page);
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("sketch-canvas")).toHaveCount(0);
  await expect(page.getByTestId("notice")).toContainText("The sketch was empty, so nothing was added");
  expect(((await savedDocument(page)) as { features: unknown[] }).features.length).toBe(count);

  // A document with an empty sketch (written by hand, or by the assistant): its properties say so.
  const text = JSON.stringify({ version: 1, units: "mm", name: "empty", features: [{ id: "sketch_1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [], constraints: [] }] });
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
  await page.getByTestId("feature-sketch_1").locator(".feature-row").click();
  await expect(page.getByText("Empty sketch")).toBeVisible();
});
