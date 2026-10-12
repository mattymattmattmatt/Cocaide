// Sweep, loft and rib in the browser (Phase O wave 4): a spring made with the
// Helix tool (a round wire swept along an exact helix; volume within 1% of
// π/4·d²·turns·√((2πr)² + p²)), its turns changed in Properties; a circle
// profile swept up a path sketch, then a groove cut with Swept cut; a loft
// between squares on Top and on a plane feature 30 above it (ruled: the
// frustum formula), its sections reordered; a rib in an L-bracket's corner
// (triangle area x thickness), its thickness changed. Each result is looked
// at in a screenshot when SHOTS_DIR is set.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, waitForRebuild } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;
const PI = Math.PI;
/** A volume as the Measurements panel shows it: en-US, at most 3 decimals, with its unit (so the match is whole). */
const shown = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 3 })} mm³`;
const volumeOf = async (page: Page) => Number((await page.getByTestId("volume").textContent())!.replace(/[^\d.]/g, ""));
type Raw = Record<string, unknown>;

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

const sketch = (id: string, plane: unknown, entities: Raw[]): Raw => ({ id, op: "sketch", plane, entities, constraints: [] });
const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
/** Front: sketch x is the model's X, sketch y its Z. */
const FRONT = { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] };
const lastFeature = async (page: Page) => ((await savedDocument(page)) as { features: Raw[] }).features.at(-1)!;

/** Waits until the Measurements panel's volume is within `tol` (a fraction) of `want`. */
async function expectVolumeNear(page: Page, want: number, tol: number) {
  await expect.poll(async () => Math.abs((await volumeOf(page)) / want - 1), { timeout: 60_000 }).toBeLessThan(tol);
}

test("the Helix tool winds a spring (volume within 1%), and its turns change in Properties", async ({ page }) => {
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  await page.getByTestId("tool-sweep-menu").click();
  await expect(page.getByTestId("tool-sweep-cut")).toBeVisible();
  await page.getByTestId("tool-helix").click();
  // A 2 mm wire on a helix about Z: radius 10, pitch 5, 4 turns.
  expect(await lastFeature(page)).toMatchObject({ op: "sweep", circle: { diameter: 2 }, path: { helix: { axis: { datum: "Z" }, radius: 10, pitch: 5, turns: 4 } } });
  const spring = (turns: number) => PI * 1 * 1 * turns * Math.hypot(2 * PI * 10, 5);
  await expectVolumeNear(page, spring(4), 0.01);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  await expect(page.getByTestId("prop-helix-pitch")).toHaveValue("5");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sweep-spring.png` });

  // Six turns: half as much wire again.
  await commit(page, "prop-helix-turns", "6");
  await expectVolumeNear(page, spring(6), 0.01);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  expect(((await lastFeature(page)).path as { helix: Raw }).helix).toMatchObject({ pitch: 5, turns: 6 });
});

test("sweeps a circle profile up a path sketch, then cuts a groove with Swept cut", async ({ page }) => {
  // A 10 mm circle on Top at the origin, a 100 mm path up Z drawn on Front.
  await openDocument(page, [
    sketch("profile", TOP, [{ id: "c1", type: "circle", center: [0, 0], radius: 5 }]),
    sketch("path", FRONT, [{ id: "l1", type: "line", start: [0, 0], end: [0, 100] }]),
  ]);
  await page.getByTestId("tool-sweep-menu").click();
  await page.getByTestId("tool-sweep").click();
  expect(await lastFeature(page)).toMatchObject({ id: "sweep_1", op: "sweep", profile: "profile", path: { sketch: "path" } });
  // π·5²·100.
  await expectVolumeNear(page, PI * 25 * 100, 1e-4);
  await expect(page.getByTestId("prop-path-kind")).toHaveValue("sketch");
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sweep-rod.png` });

  // The path sketch selected in the tree, Swept cut runs a round section along it (both sketches are used, so no
  // profile sketch is offered); at 4 mm it bores the rod: π·(5² - 2²)·100.
  await page.getByTestId("feature-path").click();
  await page.getByTestId("tool-sweep-menu").click();
  await page.getByTestId("tool-sweep-cut").click();
  expect(await lastFeature(page)).toMatchObject({ op: "sweep", operation: "remove", circle: { diameter: 5 }, path: { sketch: "path" } });
  await expect(page.getByTestId("prop-sweep-profile-kind")).toHaveValue("circle");
  await commit(page, "prop-circle-diameter", "4");
  await expectVolumeNear(page, PI * (25 - 4) * 100, 1e-3);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sweep-bored.png` });
});

test("lofts between squares on Top and on an offset plane (ruled: a frustum), and reorders the sections", async ({ page }) => {
  await openDocument(page, [
    { id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 30 },
    sketch("big", TOP, [{ id: "r1", type: "rect", center: [0, 0], w: 20, h: 20 }]),
    sketch("small", { type: "ref", ref: { datum: "plane_1" } }, [{ id: "r2", type: "rect", center: [0, 0], w: 10, h: 10 }]),
  ]);
  await page.getByTestId("tool-loft-menu").click();
  await expect(page.getByTestId("tool-loft-cut")).toBeVisible();
  await page.getByTestId("tool-loft").click();
  expect(await lastFeature(page)).toMatchObject({ id: "loft_1", op: "loft", profiles: ["big", "small"] });
  await expect(page.getByTestId("prop-loft-profile-0")).toContainText("big");
  await expect(page.getByTestId("prop-loft-profile-1")).toContainText("small");
  // Ruled between similar squares: h/3·(A1 + A2 + √(A1·A2)) = 10·(400 + 100 + 200).
  await page.getByTestId("prop-ruled").check();
  await expectVolume(page, shown(7000));
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/loft-frustum.png` });

  // The other way round is the same solid.
  await page.getByTestId("prop-loft-down-0").click();
  await expect(page.getByTestId("prop-loft-profile-0")).toContainText("small");
  expect((await lastFeature(page)).profiles).toEqual(["small", "big"]);
  await expectVolume(page, shown(7000));
  await expect(page.getByTestId("feature-loft_1")).toContainText("2 sections ruled");
});

test("adds a rib in an L-bracket's corner (triangle area x thickness) and thickens it", async ({ page }) => {
  // An L-bracket on Front, 40 deep: legs 60 long and 10 thick meeting at [10, 10]; the rib's line on its middle plane.
  await openDocument(page, [
    sketch("l", FRONT, [
      { id: "a", type: "line", start: [0, 0], end: [60, 0] },
      { id: "b", type: "line", start: [60, 0], end: [60, 10] },
      { id: "c", type: "line", start: [60, 10], end: [10, 10] },
      { id: "d", type: "line", start: [10, 10], end: [10, 60] },
      { id: "e", type: "line", start: [10, 60], end: [0, 60] },
      { id: "f", type: "line", start: [0, 60], end: [0, 0] },
    ]),
    { id: "ext", op: "extrude", sketch: "l", distance: 40 },
    sketch("g", { type: "datum", normal: [0, -1, 0], origin: [0, -20, 0] }, [{ id: "g1", type: "line", start: [10, 50], end: [50, 10] }]),
  ]);
  const bracket = (60 * 10 + 10 * 50) * 40;
  await expectVolume(page, shown(bracket));
  await page.getByTestId("tool-rib").click();
  expect(await lastFeature(page)).toMatchObject({ id: "rib_1", op: "rib", sketch: "g", thickness: 3 });
  // The gusset fills the corner triangle (legs 40): 800 mm² x 3.
  await expectVolume(page, shown(bracket + 800 * 3));
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  await commit(page, "prop-thickness", "5");
  await expectVolume(page, shown(bracket + 800 * 5));
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/rib-gusset.png` });
});
