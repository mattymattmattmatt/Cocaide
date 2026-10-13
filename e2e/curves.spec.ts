// Ellipses and splines in the sketcher (Phase O wave 6): the Curve flyout,
// an ellipse drawn by centre, major end and a point it passes through, a
// closed spline clicked point by point and closed on its first point, an open
// one finished with Enter, dragging a spline's point, and each extruded to the
// volume its area gives (an ellipse's exactly π·a·b·h).

import { expect, test, type Page } from "@playwright/test";
import type { Constraint, SketchEntity, Vec2 } from "../src/doc/types";
import { interpolate, splineArea } from "../src/geom/spline";
import { commit, openApp, savedDocument, sketchClick } from "./helpers";

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

/** The finished sketch's entities and relations. */
async function finished(page: Page): Promise<{ entities: SketchEntity[]; constraints: Constraint[] }> {
  await page.getByTestId("finish-sketch").click();
  const doc = (await savedDocument(page)) as { features: { op: string; entities: SketchEntity[]; constraints?: Constraint[] }[] };
  const s = doc.features.find((f) => f.op === "sketch")!;
  return { entities: s.entities, constraints: s.constraints ?? [] };
}

/** The part's volume as the readout shows it (mm³). */
async function volume(page: Page): Promise<number> {
  await expect(page.getByTestId("volume")).toHaveText(/^[\d,]+(\.\d+)?/);
  const text = (await page.getByTestId("volume").textContent()) ?? "";
  return Number(text.replace(/,/g, "").match(/^[\d.]+/)![0]);
}

const toScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => {
    const m = (document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement).getScreenCTM()!;
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  }, [x, y]);

test("draws an ellipse with its axes from the Curve flyout and extrudes it to π·a·b·h", async ({ page }) => {
  // The Curve flyout: Spline first, then Ellipse and Partial ellipse.
  await page.getByTestId("tool-curve-flyout").click();
  for (const t of ["spline", "ellipse", "ellipse-arc"]) await expect(page.getByTestId(`flyout-${t}`)).toBeVisible();
  await page.getByTestId("flyout-ellipse").click();
  await expect(page.getByTestId("tool-ellipse")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tool-prompt")).toHaveText("Click the centre");

  // Centre on the origin, major end 30 along x, a point 15 above the centre: a = 30, b = 15.
  await sketchClick(page, 0, 0);
  await sketchClick(page, 30, 0);
  await expect(page.getByTestId("tool-prompt")).toHaveText("Click a point the ellipse passes through");
  await sketchClick(page, 0, 15);
  // π · 30 · 15 = 1413.717 mm².
  await expect(page.getByTestId("profile-status")).toContainText("area 1413.71");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-ellipse.png` });

  const { entities, constraints } = await finished(page);
  const el = entities.find((e) => e.type === "ellipse");
  expect(el).toMatchObject({ type: "ellipse", center: [0, 0], major: [30, 0], minor: 15 });
  // Its axes: two construction lines held to it.
  expect(entities.filter((e) => e.type === "line" && e.construction)).toHaveLength(2);
  expect(constraints).toContainEqual({ type: "coincident", points: [expect.stringMatching(/\.end$/), `${el!.id}.minorEnd`] });

  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "10");
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  const v = await volume(page);
  expect(Math.abs(v - Math.PI * 30 * 15 * 10)).toBeLessThan(0.01);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/extruded-ellipse.png` });
});

test("a spline closed on its first point extrudes to its area; an open one finishes with Enter and its points drag", async ({ page }) => {
  const pts: Vec2[] = [
    [0, 0],
    [30, -10],
    [50, 10],
    [30, 30],
    [5, 25],
  ];
  await page.keyboard.press("Shift+S");
  await expect(page.getByTestId("tool-spline")).toHaveAttribute("aria-pressed", "true");
  for (const [x, y] of pts) await sketchClick(page, x, y);
  // Back on the first point: closed into a smooth loop.
  await sketchClick(page, 0, 0);
  const area = Math.abs(splineArea(interpolate(pts, true)));
  await expect(page.getByTestId("profile-status")).toContainText(`area ${area.toFixed(3).slice(0, -1)}`);

  // An open spline off to the side, finished with Enter after three points.
  await sketchClick(page, -40, 40);
  await sketchClick(page, -30, 50);
  await sketchClick(page, -20, 40);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tool-prompt")).toHaveText("Click where the spline starts");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-splines.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Its middle point drags (the spline is not related to anything, so it follows the pointer).
  const [x0, y0] = await toScreen(page, -30, 50);
  const [x1, y1] = await toScreen(page, -30, 60);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 6 });
  await page.mouse.up();

  // Both splines are in the document: the closed one as clicked, the open one with its middle point moved.
  const { entities } = await finished(page);
  const splines = entities.filter((e): e is Extract<SketchEntity, { type: "spline" }> => e.type === "spline");
  expect(splines).toHaveLength(2);
  expect(splines[0]).toEqual({ id: "sp1", type: "spline", points: pts, closed: true });
  expect(splines[1].points).toHaveLength(3);
  expect(splines[1].points[1][0]).toBeCloseTo(-30, 0);
  expect(splines[1].points[1][1]).toBeCloseTo(60, 0);
  expect(splines[1].closed).toBeUndefined();
});

test("a closed spline extrudes to its area times the depth", async ({ page }) => {
  const pts: Vec2[] = [
    [0, 0],
    [30, -10],
    [50, 10],
    [30, 30],
    [5, 25],
  ];
  await page.keyboard.press("Shift+S");
  for (const [x, y] of pts) await sketchClick(page, x, y);
  await sketchClick(page, 0, 0);
  await finished(page);
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "8");
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  const expected = Math.abs(splineArea(interpolate(pts, true))) * 8;
  const v = await volume(page);
  expect(Math.abs(v - expected) / expected).toBeLessThan(1e-5);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/extruded-spline.png` });
});
