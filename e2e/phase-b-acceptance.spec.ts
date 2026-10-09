// Phase B acceptance (spec section 7):
//   a human makes the bracket with no JSON editing; undo returns the
//   previous solid; a bad selector shows the error, not a crash.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { importSTEP, loadOC, scoped, volumeOf } from "../src/kernel";
import { isValidShape } from "../src/kernel/measure";
import { commit, expectVolume, openApp, savedDocument, sketchClick, viewportClick } from "./helpers";

const BRACKET = "18,994.728";

/** The whole bracket, by hand: sketch, dimensions, extrude, hole. */
async function buildBracket(page: Page) {
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  await commit(page, "doc-name", "bracket");

  // Sketch a rectangle on the top plane and dimension it.
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  // A centre rectangle from the origin: four lines, their centre point on the origin.
  await page.getByTestId("tool-rect-flyout").click();
  await page.getByTestId("flyout-rect-center").click();
  await sketchClick(page, 0, 0);
  await sketchClick(page, 30, 15);
  await expect(page.getByTestId("profile-status")).toContainText("1 region");
  await page.getByTestId("tool-select").click();
  await sketchClick(page, 10, 15); // the top side
  await page.getByTestId("c-length-value").fill("80");
  await page.getByTestId("c-length").click();
  await sketchClick(page, 40, 5); // the right side, now at x = 40
  await page.getByTestId("c-length-value").fill("40");
  await page.getByTestId("c-length").click();
  await expect(page.getByTestId("sketch-dof")).toHaveText("Fully defined");
  await page.getByTestId("finish-sketch").click();

  // Extrude it 6 mm.
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "6");
  await expectVolume(page, "19,200");

  // Click the top face and drill the hole.
  await viewportClick(page, [-10, 5, 6]);
  await expect(page.getByTestId("selection")).toContainText("normal +Z");
  await page.getByTestId("tool-hole").click();
  await commit(page, "prop-center-x", "30");
  await commit(page, "prop-center-y", "0");
  await commit(page, "prop-diameter", "6.6");
  await expectVolume(page, BRACKET);
}

test("a human makes the bracket with no JSON editing", async ({ page }) => {
  const problems = await openApp(page);
  await buildBracket(page);
  await expect(page.getByTestId("holes")).toHaveText("1 × Ø6.6");

  // The document the clicks produced is the spec's bracket, its rectangle four lines round a centre point on the origin.
  const doc = (await savedDocument(page)) as { features: Record<string, unknown>[] };
  const r6 = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 + 0 : v)));
  const [a, b, c, d]: [number, number][] = [[-40, -20], [40, -20], [40, 20], [-40, 20]];
  expect(r6(doc.features[0])).toEqual({
    id: "sketch_1",
    op: "sketch",
    plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
    entities: [
      { id: "l1", type: "line", start: a, end: b },
      { id: "l2", type: "line", start: b, end: c },
      { id: "l3", type: "line", start: c, end: d },
      { id: "l4", type: "line", start: d, end: a },
      { id: "l5", type: "line", start: a, end: c, construction: true },
      { id: "l6", type: "line", start: b, end: d, construction: true },
      { id: "p1", type: "point", at: [0, 0] },
    ],
    constraints: [
      { type: "coincident", points: ["l1.end", "l2.start"] },
      { type: "coincident", points: ["l2.end", "l3.start"] },
      { type: "coincident", points: ["l3.end", "l4.start"] },
      { type: "coincident", points: ["l4.end", "l1.start"] },
      { type: "horizontal", entity: "l1" },
      { type: "vertical", entity: "l2" },
      { type: "horizontal", entity: "l3" },
      { type: "vertical", entity: "l4" },
      { type: "coincident", points: ["l5.start", "l1.start"] },
      { type: "coincident", points: ["l5.end", "l3.start"] },
      { type: "coincident", points: ["l6.start", "l2.start"] },
      { type: "coincident", points: ["l6.end", "l4.start"] },
      { type: "midpoint", point: "p1.at", entity: "l5" },
      { type: "coincident", points: ["p1.at", "origin"] },
      { type: "distance", entity: "l3", value: 80 },
      { type: "distance", entity: "l2", value: 40 },
    ],
  });
  expect(doc.features.slice(1)).toEqual([
    { id: "extrude_1", op: "extrude", sketch: "sketch_1", distance: 6 },
    {
      id: "hole_1",
      op: "hole",
      face: { type: "planar", normal: [0, 0, 1], pick: "largest" },
      center: [30, 0],
      diameter: 6.6,
      depth: "through",
    },
  ]);

  // And it exports a STEP that reads back as the same solid.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export STEP" }).click();
  const file = "out/e2e/ui-bracket.step";
  await (await download).saveAs(file); // kept for the FreeCAD check: npm run verify:freecad -- out/e2e/ui-bracket.step
  const oc = await loadOC();
  const shape = importSTEP(oc, readFileSync(file));
  scoped((s) => {
    expect(isValidShape(oc, s, shape)).toBe(true);
    expect(volumeOf(oc, s, shape)).toBeCloseTo(80 * 40 * 6 - Math.PI * 3.3 ** 2 * 6, 6);
  });
  shape.delete();
  expect(problems).toEqual([]);
});

test("undo returns the previous solid, redo brings it back", async ({ page }) => {
  const problems = await openApp(page);
  await buildBracket(page);

  await page.getByTestId("undo").click(); // diameter 6.6 -> 5
  await expect(page.getByTestId("holes")).toHaveText("1 × Ø5");
  await page.getByTestId("undo").click(); // centre y
  await page.getByTestId("undo").click(); // centre x
  await page.getByTestId("undo").click(); // the hole itself
  await expectVolume(page, "19,200");
  await expect(page.getByTestId("holes")).toHaveText("none");

  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("Control+Shift+z");
  await expectVolume(page, BRACKET);
  expect(problems).toEqual([]);
});

test("a bad selector shows the error, not a crash", async ({ page }) => {
  const problems = await openApp(page);
  await buildBracket(page);

  // Round the hole rim by clicking it, then make the hole smaller so the
  // fillet's selector (a circle of radius 3.3 on the top face) finds nothing.
  await viewportClick(page, [30, 3.3, 6]);
  await expect(page.getByTestId("selection")).toContainText("circular edge · Ø6.6");
  await page.getByTestId("tool-fillet").click();
  await commit(page, "prop-radius", "0.5");
  await expectVolume(page, "18,993.578");

  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await commit(page, "prop-diameter", "5");
  await expect(page.getByTestId("status")).toHaveText(/^1 error/);
  await expect(page.getByTestId("feature-fillet_1")).toContainText(
    "edges: selector matched 0 edges (wanted circle edges radius 3.3 on the planar face normal +Z)",
  );
  // The rest of the part still rebuilds and shows.
  await expect(page.getByTestId("holes")).toHaveText("1 × Ø5");
  await expect(page.getByRole("button", { name: "Export STEP" })).toBeEnabled();

  // Export is refused while the rebuild has errors.
  await page.getByRole("button", { name: "Export STEP" }).click();
  await expect(page.getByTestId("notice")).toContainText("STEP not exported: 1 rebuild error");

  // Undo puts the selector's target back.
  await page.locator("body").press("Control+z");
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  expect(problems).toEqual([]);
});
