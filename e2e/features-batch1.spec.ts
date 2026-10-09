// Revolve, shell, draft and scale in the browser (Phase O wave 2): a profile
// sketched with a centreline and turned about it (volume by Pappus), its angle
// changed in Properties, a revolved cut; a box shelled from its top face
// through the right-click menu, then two of its sides drafted about the bottom
// face the tool picks for itself; a body scaled from the Bodies tab (volume x
// factor³). The Features tab with the new tools must stay tidy at 1500 x 900.

import { expect, test, type Page } from "@playwright/test";
import type { Vec3 } from "../src/doc/types";
import { commit, expectVolume, openApp, savedDocument, sketchClick, viewportClick } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;
const PI = Math.PI;
/** A volume as the Measurements panel shows it: en-US, at most 3 decimals, with its unit (so the match is whole). */
const shown = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 3 })} mm³`;
const volumeOf = async (page: Page) => Number((await page.getByTestId("volume").textContent())!.replace(/[^\d.]/g, ""));

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

/** A new part with a sketch open on Top. */
async function sketchOnTop(page: Page) {
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
}

/** A corner rectangle from one corner to the other, and a centreline, in the open sketch. */
async function rectAndCentreline(page: Page, a: [number, number], b: [number, number]) {
  // Keys go to the sketcher only when no field has the focus (the last property typed into may still have it).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("r");
  await expect(page.getByTestId("tool-rect")).toHaveAttribute("aria-pressed", "true");
  await sketchClick(page, ...a);
  await sketchClick(page, ...b);
  await page.keyboard.press("Shift+L");
  await expect(page.getByTestId("tool-centerline")).toHaveAttribute("aria-pressed", "true");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 0, 25);
  await page.keyboard.press("Escape"); // ends the line chain
}

/** Right-clicks the 3D view where a world point appears. */
async function viewportRightClick(page: Page, p: Vec3) {
  const [x, y] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), p);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y, { button: "right" });
}

test("sketches a profile with a centreline and revolves it (Pappus), changes its angle, then a revolved cut", async ({ page }) => {
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  await sketchOnTop(page);
  // A 10 x 20 rectangle at x = 10..20, y = 0..20, and a centreline up the sketch's Y axis.
  await rectAndCentreline(page, [10, 0], [20, 20]);
  await expect(page.getByTestId("profile-status")).toContainText("1 region, area 200");
  await page.getByTestId("finish-sketch").click();

  await page.getByTestId("tool-revolve-menu").click();
  await expect(page.getByTestId("tool-revolve-cut")).toBeVisible();
  await page.getByTestId("tool-revolve").click();
  // Pappus: 2π x 15 (the centroid's distance from the axis) x 200.
  await expectVolume(page, shown(2 * PI * 15 * 200));
  const doc = (await savedDocument(page)) as { features: { id: string; op: string; entities?: { id: string; construction?: boolean }[]; axis?: unknown }[] };
  const centreline = doc.features[0].entities!.find((e) => e.construction)!;
  expect(doc.features.at(-1)).toMatchObject({ id: "revolve_1", op: "revolve", sketch: doc.features[0].id, axis: { line: centreline.id } });
  await expect(page.getByTestId("prop-axis-line")).toHaveValue(centreline.id);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/revolve-properties.png` });

  // A quarter turn: π/2 x 15 x 200.
  await commit(page, "prop-angle", "90");
  await expectVolume(page, shown((PI / 2) * 15 * 200));
  await expect(page.getByTestId("feature-revolve_1")).toContainText("90°");

  // A revolved cut of y = 10..20 all the way round takes the upper half away (the sketcher now fits the part: stay in view).
  await sketchOnTop(page);
  await rectAndCentreline(page, [5, 10], [25, 20]);
  await expect(page.getByTestId("profile-status")).toContainText("1 region, area 200");
  await page.getByTestId("finish-sketch").click();
  await page.getByTestId("tool-revolve-menu").click();
  await page.getByTestId("tool-revolve-cut").click();
  await expectVolume(page, shown((PI / 2) * 15 * 100));
  await expect(page.getByTestId("prop-operation")).toHaveValue("remove");
  await expect(page.getByTestId("feature-revolve_cut_1")).toContainText("360° cut");
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});

test("shells a box from its top face (right-click), then drafts two sides about the bottom", async ({ page }) => {
  await page.getByTestId("new-part").click();
  await sketchOnTop(page);
  await page.keyboard.press("r");
  await sketchClick(page, -10, -10);
  await sketchClick(page, 10, 10);
  await page.getByTestId("finish-sketch").click();
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "20");
  await expectVolume(page, shown(8000));

  // Right-click the top face: Shell (remove this face), 2 mm walls: 20³ - 16 x 16 x 18.
  await viewportRightClick(page, [0, 0, 20]);
  await page.getByTestId("ctx-shell").click();
  await expectVolume(page, shown(8000 - 16 * 16 * 18));
  await expect(page.getByTestId("prop-faces")).toContainText("+Z");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/shell-properties.png` });
  await commit(page, "prop-thickness", "1");
  await expectVolume(page, shown(8000 - 18 * 18 * 19));
  await commit(page, "prop-thickness", "2");
  await expectVolume(page, shown(8000 - 16 * 16 * 18));

  // Two outer sides, +X and -Y, picked; Draft finds the bottom face for the neutral plane, 3°.
  await viewportClick(page, [10, 0, 10]);
  await viewportClick(page, [0, -10, 10], { shift: true });
  await page.getByTestId("tool-draft").click();
  const draft = ((await savedDocument(page)) as { features: Record<string, unknown>[] }).features.at(-1)!;
  expect(draft).toMatchObject({ op: "draft", angle: 3, neutral: { face: { type: "planar", normal: [0, 0, -1] } } });
  expect(draft.faces).toHaveLength(2);
  // The cross-section at height z is (20 - z tan 3°)², less the cavity.
  const t = Math.tan((3 * PI) / 180);
  const expected = 8000 - 8000 * t + (8000 * t * t) / 3 - 16 * 16 * 18;
  await expect.poll(() => volumeOf(page)).toBeLessThan(8000 - 16 * 16 * 18);
  expect(Math.abs((await volumeOf(page)) - expected)).toBeLessThan(0.01);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/draft-properties.png` });
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});

test("scales the bracket from the Bodies tab: the volume goes as the factor cubed", async ({ page }) => {
  const plate = 80 * 40 * 6 - PI * 3.3 ** 2 * 6;
  await expectVolume(page, "18,994.728");
  await page.getByTestId("tab-bodies").click();
  await page.getByTestId("tool-scale").click();
  await expectVolume(page, shown(plate * 8));
  await commit(page, "prop-factor", "0.5");
  await expectVolume(page, shown(plate / 8));
  await expect(page.getByTestId("prop-about")).toHaveValue("centroid");
  await expect(page.getByTestId("feature-scale_1")).toContainText("×0.5");
});

test("the Features tab holds the new tools tidily at 1500 x 900", async ({ page }) => {
  await page.getByTestId("tab-features").click();
  for (const id of ["tool-extrude", "tool-cut", "tool-revolve-menu", "tool-hole", "tool-fillet", "tool-chamfer", "tool-shell", "tool-draft", "tool-pattern", "tool-mirror"]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  // Nothing spills out of the toolbar, and every button sits on one row.
  const fit = await page.locator(".command-manager .cm-tools").evaluate((el) => {
    const boxes = [...el.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
    return { overflow: el.scrollWidth - el.clientWidth, rows: new Set(boxes.map((b) => Math.round(b.top))).size, right: Math.max(...boxes.map((b) => b.right)) };
  });
  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.rows).toBe(1);
  expect(fit.right).toBeLessThanOrEqual(1500);
  await page.getByTestId("tool-revolve-menu").click();
  await expect(page.getByTestId("tool-revolve")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/features-tab.png` });
  await page.keyboard.press("Escape");
  if (SHOTS) {
    await page.getByTestId("tab-bodies").click();
    await page.screenshot({ path: `${SHOTS}/bodies-tab.png` });
  }
});
