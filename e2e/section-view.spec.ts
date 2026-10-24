// The section view (Phase P) in the browser, on the bracket (an 80 × 40 × 6
// plate on Z 0–6, centred on the origin, a Ø6.6 hole at X 30) and the stand
// (a base plate and an upright plate, two bodies): drag the plane's arrow
// (the offset follows, in whole millimetres); tilt it 30°; a second plane
// makes a corner cut, capped (pixels checked); the section stays on through
// a feature edit and a reload; Show plane; one body left whole; the view
// bar's toggle and the Section tag. Each state is screenshotted when
// SHOTS_DIR is set.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, waitForRebuild } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;
type Vec3 = [number, number, number];
type Plane = { normal: Vec3; constant: number };
type Hook = {
  project(p: number[]): [number, number];
  section(): (Plane & { capped: boolean }) | null;
  sections(): { planes: Plane[]; bodies: string[] | null; capped: boolean; planesDrawn: number };
  handlePoint(id: string): [number, number] | null;
  pick(x: number, y: number): { kind: string; index?: number } | null;
};
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/section-${name}.png` });
};
const sections = (page: Page) => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.sections());
const section = (page: Page) => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.section());
const project = (page: Page, p: Vec3) => page.evaluate((p) => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.project(p), p);
const handlePoint = (page: Page, id: string) => page.evaluate((id) => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.handlePoint(id), id);

/** The colour on the screen at client pixels (a 1 × 1 screenshot). */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x: Math.round(x) - 1, y: Math.round(y) - 1, width: 3, height: 3 } });
  // Decode the middle pixel with the browser (no image library needed here).
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(1, 1, 1, 1).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  }, png.toString("base64"));
}
/** The cap's orange (or its darker hatch): red well above blue. */
const isCap = ([r, , b]: [number, number, number]) => r - b > 60;

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

async function openSection(page: Page) {
  await page.getByTestId("tab-evaluate").click();
  await page.getByTestId("tool-section").click();
  await expect(page.getByTestId("section-panel")).toBeVisible();
  await expect.poll(() => section(page)).toEqual({ normal: [0, 1, 0], constant: 0, capped: true });
}

test("drag the plane's arrow: the plane moves along its normal and the offset follows, in whole millimetres", async ({ page }) => {
  await openSection(page);
  await expect(page.getByTestId("section-tag")).toHaveText("Section");
  await expect(page.getByTestId("view-section")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => sections(page).then((s) => s.planesDrawn)).toBe(1);
  await shot(page, "front");
  // The arrow on the Front plane points the way the offset grows (−Y, away from the viewer in the isometric view).
  const tip = (await handlePoint(page, "section:0"))!;
  expect(tip).not.toBeNull();
  await expect(page.getByTestId("handle-label-section:0")).toHaveText("Section: 0 mm");
  // How far one millimetre along −Y moves on the screen, at the arrow.
  const a = await project(page, [0, -24, 3]);
  const b = await project(page, [0, -34, 3]);
  const perMm: [number, number] = [(b[0] - a[0]) / 10, (b[1] - a[1]) / 10];
  await page.mouse.move(tip[0], tip[1]);
  await page.mouse.down();
  await page.mouse.move(tip[0] + perMm[0] * 3, tip[1] + perMm[1] * 3, { steps: 4 });
  await page.mouse.move(tip[0] + perMm[0] * 7.3, tip[1] + perMm[1] * 7.3, { steps: 4 });
  await expect(page.getByTestId("handle-label-section:0")).toHaveText("Section: 7 mm");
  await shot(page, "drag");
  await page.mouse.up();
  await expect(page.getByTestId("section-offset")).toHaveValue("7");
  // The plane is now at Y −7: three keeps where y + 7 ≥ 0 (normal +Y, constant 7).
  await expect.poll(() => section(page).then((s) => s?.constant)).toBe(7);
  // Typing still works.
  await commit(page, "section-offset", "-4");
  await expect.poll(() => section(page).then((s) => s?.constant)).toBe(-4);
  // With the panel folded out of the way, clicking the arrow's value opens it at the offset field.
  await page.getByTestId("section-collapse").click();
  await expect(page.getByTestId("section-offset")).toHaveCount(0);
  await page.getByTestId("handle-label-section:0").click();
  await expect(page.getByTestId("section-offset")).toBeFocused();
});

test("tilt a plane 30°: it turns about its own axis through the offset point", async ({ page }) => {
  await openSection(page);
  await commit(page, "section-tilt-a", "30");
  // Front (normal −Y) tilted 30° about X: n = (0, −cos 30°, −sin 30°)… three's plane normal is −n.
  await expect.poll(() => section(page).then((s) => s?.normal.map((x) => Math.round(x * 1000) / 1000))).toEqual([0, 0.866, 0.5]);
  expect((await section(page))!.constant).toBeCloseTo(0, 6);
  await expect(page.getByTestId("section-tilt-a")).toHaveValue("30");
  await shot(page, "tilt");
  // Back to square.
  await commit(page, "section-tilt-a", "0");
  await expect.poll(() => section(page).then((s) => s?.normal)).toEqual([0, 1, 0]);
});

test("a second plane makes a corner cut, capped on both cut faces; switched off, the first plane cuts alone", async ({ page }) => {
  await openSection(page);
  await page.getByTestId("section-add").click();
  await expect(page.getByTestId("section-tab-1")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("section-plane")).toHaveValue("Top");
  await expect.poll(() => sections(page)).toMatchObject({ planes: [{ normal: [0, 1, 0], constant: 0 }, { normal: [0, 0, -1], constant: 3 }], capped: true, planesDrawn: 2 });
  await expect(page.getByTestId("section-tag")).toHaveText("Section · 2 planes");
  // Planes off the screen for the pixel checks: they draw over the caps.
  await page.getByTestId("section-show-plane").uncheck();
  await expect.poll(() => sections(page).then((s) => s.planesDrawn)).toBe(0);
  await shot(page, "corner");
  // In the corner cut away (front, upper half) the cap of the Top plane shows at Z 3; behind the Front plane, the plate's top face.
  const capTop = await project(page, [-20, -10, 3]);
  const capFront = await project(page, [-20, 0, 4.5]);
  const kept = await project(page, [-20, 10, 6]);
  expect(isCap(await pixel(page, ...capTop))).toBe(true);
  expect(isCap(await pixel(page, ...capFront))).toBe(true);
  expect(isCap(await pixel(page, ...kept))).toBe(false);
  // Picking skips what is cut away: below the cap, the lower front half is still there to pick.
  const lower = await project(page, [-20, -19.5, 1.5]);
  expect(await page.evaluate(([x, y]) => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.pick(x, y)?.kind, lower)).toBe("face");
  // Section 2 off: the Front plane alone cuts the whole front half.
  await page.getByTestId("section-enabled").uncheck();
  await expect.poll(() => sections(page).then((s) => s.planes.length)).toBe(1);
  await expect(page.getByTestId("section-tab-1")).toHaveClass(/off/);
  await page.getByTestId("section-enabled").check();
  await page.getByTestId("section-remove").click();
  await expect(page.getByTestId("section-tab-1")).toHaveCount(0);
  await expect.poll(() => sections(page).then((s) => s.planes.length)).toBe(1);
});

test("the section stays on while you work: through a feature edit, folded, and after a reload; the view bar turns it off and on", async ({ page }) => {
  await openSection(page);
  await commit(page, "section-offset", "5");
  await expect.poll(() => section(page).then((s) => s?.constant)).toBe(5);
  // A feature edit (the plate's depth), rebuilt: the section is still on, where it was.
  await page.getByTestId("feature-ext_1").locator(".feature-row").click();
  await commit(page, "prop-distance", "10");
  await waitForRebuild(page);
  await expectVolume(page, "31,6");
  await expect(page.getByTestId("section-panel")).toBeVisible();
  expect(await section(page)).toEqual({ normal: [0, 1, 0], constant: 5, capped: true });
  // Folded to its title, still on.
  await page.getByTestId("section-collapse").click();
  await expect(page.getByTestId("section-summary")).toHaveText("Front plane");
  await expect(page.getByTestId("section-offset")).toHaveCount(0);
  expect(await section(page)).not.toBeNull();
  await shot(page, "folded");
  // Remembered for the part: back after a reload, as it was.
  await page.waitForTimeout(300);
  await page.reload();
  await waitForRebuild(page);
  await expect.poll(() => section(page)).toEqual({ normal: [0, 1, 0], constant: 5, capped: true });
  await expect(page.getByTestId("section-summary")).toBeVisible();
  // The view bar's toggle: off (the planes kept), on again.
  await page.getByTestId("view-section").click();
  await expect.poll(() => section(page)).toBeNull();
  await expect(page.getByTestId("section-tag")).toHaveCount(0);
  await expect(page.getByTestId("section-panel")).toHaveCount(0);
  await page.getByTestId("view-section").click();
  await expect.poll(() => section(page).then((s) => s?.constant)).toBe(5);
  // The tag opens the panel when it is closed: close (×) turns the section off; the toggle brings it back, the tag the panel.
  await page.getByTestId("section-panel-close").click();
  await expect.poll(() => section(page)).toBeNull();
  await page.getByTestId("view-section").click();
  await expect(page.getByTestId("section-panel")).toHaveCount(0);
  await page.getByTestId("section-tag").click();
  await expect(page.getByTestId("section-panel")).toBeVisible();
  await expect(page.getByTestId("section-offset")).toHaveValue("5");
});

test("section bodies: one body left whole, the other cut; each body's cap in its own colour", async ({ page }) => {
  await page.locator("select").first().selectOption("stand (two bodies)");
  await expectVolume(page, "133,143.363");
  await openSection(page);
  // The upright (Y −4 to 4, Z 8 to 68) is cut through its middle with the base: its front face is gone.
  const front = await project(page, [-30, -4, 40]);
  const pickAt = (p: [number, number]) => page.evaluate(([x, y]) => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.pick(x, y), p);
  await expect(page.getByTestId("section-bodies")).toBeVisible();
  await page.getByTestId("section-bodies").locator("summary").click();
  await page.getByTestId("section-body-upright").uncheck();
  await expect.poll(() => sections(page).then((s) => s.bodies)).toEqual(["base"]);
  await expect(page.getByTestId("section-bodies").locator("summary")).toHaveText("Section bodies: 1 of 2");
  // The upright is whole again: its front face is there to pick, at Y −4.
  const picked = await pickAt(front);
  expect(picked?.kind).toBe("face");
  const faceText = await page.evaluate(([x, y]) => {
    const v = (window as unknown as { __cocaideViewport: { pick(x: number, y: number): { point: number[] } | null } }).__cocaideViewport;
    return v.pick(x, y)?.point[1];
  }, front);
  expect(faceText).toBeCloseTo(-4, 3);
  await shot(page, "bodies");
  // Each body's colour on its cap.
  await page.getByTestId("section-body-upright").check();
  await expect.poll(() => sections(page).then((s) => s.bodies)).toBeNull();
  await page.getByTestId("section-cap-colour").selectOption("bodies");
  await expect.poll(() => sections(page).then((s) => s.capped)).toBe(true);
  await shot(page, "body-colours");
});
