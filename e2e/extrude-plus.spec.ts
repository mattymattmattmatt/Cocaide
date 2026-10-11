// Extrude, cut, fillet and chamfer upgrades in the browser (Phase O wave 3B):
// an extrude taken up to a face picked in the view; a second direction and a
// drafted side; a thin wall from an open sketch line; a chamfer of two
// distances, then distance and angle. Volumes worked out in the comments.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, viewportClick, waitForRebuild } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;
/** A volume as the Measurements panel shows it: en-US, at most 3 decimals, with its unit. */
const shown = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 3 })} mm³`;
const volumeOf = async (page: Page) => Number((await page.getByTestId("volume").textContent())!.replace(/[^\d.]/g, ""));
const feature = async (page: Page, id: string) => ((await savedDocument(page)) as { features: Record<string, unknown>[] }).features.find((f) => f.id === id);

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const sketch = (id: string, entities: unknown[], plane: unknown = TOP) => ({ id, op: "sketch", plane, entities, constraints: [] });
const rect = (id: string, center: [number, number], w: number, h: number) => ({ id, type: "rect", center, w, h });

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

/** Opens a document as if it had been worked on before (the app keeps it in local storage). */
async function openDocument(page: Page, features: unknown[]) {
  const text = JSON.stringify({ version: 1, units: "mm", name: "part", features }, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
}

/** Opens a feature's properties from the tree. */
async function open(page: Page, id: string) {
  await page.getByTestId(`feature-${id}`).locator(".feature-row").click();
  await expect(page.getByTestId("prop-id")).toHaveValue(id);
}

test("an extrude goes up to a face picked in the view, and keeps to it", async ({ page }) => {
  // A 60 x 20 x 5 plate (x -30..30) with a 10 x 20 block on it at x 20..30 up to z = 15: 6000 + 10 x 20 x 10 = 8000.
  // A 10 x 20 boss sketched on Top at x -10..0, blind 8: 8000 + 10 x 20 x 3 = 8600.
  await openDocument(page, [
    sketch("sk_plate", [rect("r1", [0, 0], 60, 20)]),
    { id: "plate", op: "extrude", sketch: "sk_plate", distance: 5 },
    sketch("sk_block", [rect("r2", [25, 0], 10, 20)]),
    { id: "block", op: "extrude", sketch: "sk_block", distance: 15 },
    sketch("sk_boss", [rect("r3", [-5, 0], 10, 20)]),
    { id: "boss", op: "extrude", sketch: "sk_boss", distance: 8 },
  ]);
  await expectVolume(page, shown(8600));
  await open(page, "boss");
  await expect(page.getByTestId("prop-section-dir1")).toBeVisible();

  // Up to surface with nothing selected says what to click first, and changes nothing.
  await page.getByTestId("prop-extent").selectOption("upToFace");
  await expect(page.getByTestId("command-error")).toContainText("click it in the view first");
  expect((await feature(page, "boss"))!.extent).toBeUndefined();

  // The block's top face (z = 15), picked in the view, then Up to surface: the boss is 15 high, 8000 + 10 x 20 x 10.
  await viewportClick(page, [25, 0, 15]);
  await expect(page.getByTestId("selection")).toContainText("normal +Z");
  await page.getByTestId("prop-extent").selectOption("upToFace");
  await expectVolume(page, shown(10000));
  await expect(page.getByTestId("prop-up-to-ref")).toContainText("+Z");
  await expect(page.getByTestId("prop-distance")).toHaveCount(0);
  expect((await feature(page, "boss"))!.upTo).toMatchObject({ face: { type: "planar", normal: [0, 0, 1] } });

  // Offset from surface, 4 short of it: 11 high.
  await page.getByTestId("prop-extent").selectOption("offsetFromFace");
  await commit(page, "prop-offset", "4");
  await expectVolume(page, shown(8000 + 200 * 6));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/extrude-up-to-face.png` });

  // The plate made thinner (3): the face is found again (a query, not an index), the boss still ends 4 short of it.
  // 60 x 20 x 3 + the block above it, 10 x 20 x 12, + the boss above it, 10 x 20 x 8.
  await open(page, "plate");
  await commit(page, "prop-distance", "3");
  await expectVolume(page, shown(3600 + 2400 + 1600));
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});

test("a second direction, then a draft on the first", async ({ page }) => {
  await openDocument(page, [sketch("sk", [rect("r1", [0, 0], 10, 10)]), { id: "ext", op: "extrude", sketch: "sk", distance: 5 }]);
  await expectVolume(page, shown(500));
  await open(page, "ext");

  // Direction 2, blind 3: z = -3..5.
  await page.getByTestId("prop-direction2").check();
  await expect(page.getByTestId("prop-direction2-extent")).toHaveValue("blind");
  await commit(page, "prop-direction2-distance", "3");
  await expectVolume(page, shown(800));

  // Draft on direction 1, 5° inward: a frustum h/3 (A1 + A2 + sqrt(A1 A2)) with sides 10 and 10 - 2 x 5 tan 5°.
  await page.getByTestId("prop-draft").check();
  await expect(page.getByTestId("prop-draft-angle")).toHaveValue("5");
  const top = 10 - 2 * 5 * Math.tan((5 * Math.PI) / 180);
  const frustum = (5 / 3) * (100 + top * top + 10 * top);
  await expect.poll(() => volumeOf(page)).toBeCloseTo(300 + frustum, 2);
  // Outward: the top grows instead.
  await page.getByTestId("prop-draft-outward").check();
  const wide = 10 + 2 * 5 * Math.tan((5 * Math.PI) / 180);
  await expect.poll(() => volumeOf(page)).toBeCloseTo(300 + (5 / 3) * (100 + wide * wide + 10 * wide), 2);
  expect((await feature(page, "ext"))!.draft).toEqual({ angle: 5, outward: true });
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});

test("a thin wall from an open sketch: an L of two lines", async ({ page }) => {
  // Lines (0,0)-(20,0)-(20,10) on Top: no closed profile.
  await openDocument(page, [
    sketch("sk", [
      { id: "l1", type: "line", start: [0, 0], end: [20, 0] },
      { id: "l2", type: "line", start: [20, 0], end: [20, 10] },
    ]),
  ]);
  await page.getByTestId("feature-sk").locator(".feature-row").click();
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "10");
  await expect(page.getByTestId("prop-feature-error")).toContainText("make it a thin feature");

  // Thin feature, 1 mm: the wall on the L's outside (its convex side), [0,21] x [-1,0] + [20,21] x [0,10] = 31, 10 high.
  await page.getByTestId("prop-thin").check();
  await expectVolume(page, shown(310));
  await expect(page.getByTestId("prop-feature-error")).toHaveCount(0);
  await commit(page, "prop-thin-thickness", "2");
  await expectVolume(page, shown(640)); // [0,22] x [-2,0] + [20,22] x [0,10] = 64
  // Both sides of the lines, mitred at the corner: trapezoids (21 + 19) / 2 x 2 + (11 + 9) / 2 x 2 = 40 + 20.
  await page.getByTestId("prop-thin-side").selectOption("mid");
  await expectVolume(page, shown(600));
  expect((await feature(page, "extrude_1"))!.thin).toEqual({ thickness: 2, side: "mid" });
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});

test("a chamfer of two distances, flipped, then a distance and an angle", async ({ page }) => {
  // A 20 x 20 x 20 cube (x, y -10..10, z 0..20).
  await openDocument(page, [sketch("sk", [rect("r1", [0, 0], 20, 20)]), { id: "cube", op: "extrude", sketch: "sk", distance: 20 }]);
  await expectVolume(page, shown(8000));
  await viewportClick(page, [0, -10, 20]); // the top front edge
  await expect(page.getByTestId("selection")).toContainText(/edge/i);
  await page.getByTestId("tool-chamfer").click();
  await expectVolume(page, shown(8000 - 0.5 * 20));

  // Distance – distance: 2 on the top face, 1 on the front: a triangle 2 x 1 / 2 along 20 mm.
  await page.getByTestId("prop-chamfer-type").selectOption("distances");
  await commit(page, "prop-chamfer-distance", "2");
  await commit(page, "prop-chamfer-distance2", "1");
  await expectVolume(page, shown(8000 - 1 * 20));
  // Flip swaps the faces: the same volume, the 2 now down the front face.
  await page.getByTestId("prop-chamfer-flip").check();
  await expectVolume(page, shown(8000 - 1 * 20));
  expect(await feature(page, "chamfer_1")).toMatchObject({ distance: 2, distance2: 1, flip: true });
  await expect(page.getByTestId("feature-summary-chamfer_1")).toHaveText("2 × 1");

  // Angle – distance: 2 at 30°, the other leg 2 tan 30°.
  await page.getByTestId("prop-chamfer-type").selectOption("angle");
  await commit(page, "prop-chamfer-angle", "30");
  await expect.poll(() => volumeOf(page)).toBeCloseTo(8000 - 0.5 * 2 * 2 * Math.tan(Math.PI / 6) * 20, 2);
  expect(await feature(page, "chamfer_1")).toMatchObject({ distance: 2, angle: 30 });
  expect((await feature(page, "chamfer_1"))!.distance2).toBeUndefined();
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});

test("up to a curved face by Use selected", async ({ page }) => {
  // A radius 10 cylinder along X (x -20..20) at z = 30, and a 10 x 4 boss on Top up to its underside:
  // under the cylinder the boss reaches z = 30 - sqrt(100 - y²), so it is 10 · (30·4 - (2·sqrt(96) + 100·asin(0.2))).
  const RIGHT = { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] };
  const cylinder = Math.PI * 100 * 40;
  const boss = 10 * (120 - (2 * Math.sqrt(96) + 100 * Math.asin(0.2)));
  await openDocument(page, [
    sketch("s_cyl", [{ id: "c", type: "circle", center: [0, 30], radius: 10 }], RIGHT),
    { id: "cyl", op: "extrude", sketch: "s_cyl", extent: "midplane", distance: 40 },
    sketch("s1", [rect("r1", [0, 0], 10, 4)]),
    { id: "boss", op: "extrude", sketch: "s1", extent: "upToFace", upTo: { datum: "Top" } },
  ]);
  await open(page, "boss");
  // The round face (not its axis: a curved face is a surface to go up to).
  await viewportClick(page, [0, -7.07, 37.07]);
  await expect(page.getByTestId("selection")).toContainText("cylindrical face");
  await page.getByTestId("prop-up-to-use").click();
  await expect.poll(() => volumeOf(page)).toBeCloseTo(cylinder + boss, 2);
  expect((await feature(page, "boss"))!.upTo).toMatchObject({ face: { type: "cylindrical", radius: 10 } });
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});

test("fillet: the edges of a picked face, and a radius set whose radius is edited in place", async ({ page }) => {
  // A 20 mm cube. Its top face picked, then Fillet: R1 on the four top edges, (1 - π/4)·1²·20 each, less a little
  // where they meet at the corners (each corner's blend overlaps the two edges' runs).
  await openDocument(page, [sketch("sk", [rect("r1", [0, 0], 20, 20)]), { id: "cube", op: "extrude", sketch: "sk", distance: 20 }]);
  const corner = 1 - Math.PI / 4;
  await viewportClick(page, [3, 2, 20]);
  await expect(page.getByTestId("selection")).toContainText("normal +Z");
  await page.getByTestId("tool-fillet").click();
  await expect.poll(async () => 8000 - (await volumeOf(page))).toBeGreaterThan(4 * corner * 20 - 1);
  expect(8000 - (await volumeOf(page))).toBeLessThan(4 * corner * 20);
  expect(await feature(page, "fillet_1")).toMatchObject({ faces: [{ type: "planar", normal: [0, 0, 1] }], radius: 1 });

  // An edge picked and used as well, then left out again (×): back to the face's edges alone.
  const faceOnly = await volumeOf(page);
  await viewportClick(page, [10, -10, 10]);
  await page.getByTestId("prop-edges-use").click();
  await expect.poll(() => volumeOf(page)).toBeLessThan(faceOnly - 0.1);
  expect(await feature(page, "fillet_1")).toMatchObject({ edges: { type: "edge" }, faces: [{ type: "planar" }] });
  await page.getByTestId("prop-edges-remove-0").click();
  await expect.poll(() => volumeOf(page)).toBeCloseTo(faceOnly, 2);
  expect((await feature(page, "fillet_1"))!.edges).toBeUndefined();

  // A vertical edge as a radius set of its own (it starts at R1), then R3. The set's fillet meets the top's at a corner,
  // so the volume is only bounded: more removed than with the set at R1.
  await page.getByTestId("prop-fillet-sets-add").click();
  await expect(page.getByTestId("command-error")).toContainText("Click the edges for the new radius");
  await viewportClick(page, [10, -10, 10]);
  await expect(page.getByTestId("selection")).toContainText("edge");
  await page.getByTestId("prop-fillet-sets-add").click();
  await expect(page.getByTestId("prop-fillet-sets-radius-0")).toHaveValue("1");
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  const atOne = await volumeOf(page);
  await commit(page, "prop-fillet-sets-radius-0", "3");
  await expect.poll(async () => ((await feature(page, "fillet_1"))!.sets as { radius: number }[])[0].radius).toBe(3);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  await expect.poll(() => volumeOf(page)).toBeLessThan(atOne - 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/fillet-radius-sets.png` });
});
