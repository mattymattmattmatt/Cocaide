// The VR walkthrough in a browser with an emulated Quest 3 (Meta's WebXR emulator, iwer): Settings > VR, the start
// point placed in the view (a floor, then a heading), the VR button, then in VR: standing at the start facing its way,
// teleporting along the floor with the trigger's arc, a snap turn, roof off, back to the start, and out again.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { openApp, savedDocument, waitForRebuild } from "./helpers";

type Hook = {
  project(p: number[]): [number, number];
  vr(): { active: boolean; standing?: { at: number[]; heading: number }; roofOff?: boolean; drawn?: { calls: number; triangles: number }; marker: { at: number[]; heading: number } | null };
};
const hook = <T,>(page: Page, f: (h: Hook) => T) => page.evaluate(`(${f.toString()})(window.__cocaideViewport)`) as Promise<T>;
const vr = (page: Page) => hook(page, (h) => h.vr());
const device = (page: Page, js: string) => page.evaluate(`(() => { const d = window.__xrDevice; ${js} })()`);

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: readFileSync("node_modules/iwer/build/iwer.min.js", "utf8") });
  await page.addInitScript({ content: "window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });" });
  await openApp(page);
  // A 10 × 10 m slab, a 600 high platform on it (another level), a wall.
  const doc = {
    version: 1, units: "mm", name: "site",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [5000, 5000], w: 10000, h: 10000 }] },
      { id: "slab", op: "extrude", sketch: "s1", distance: 100, newBody: "slab" },
      { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, entities: [{ id: "r", type: "rect", center: [7500, 8000], w: 3000, h: 3000 }] },
      { id: "deck", op: "extrude", sketch: "s2", distance: 500, newBody: "deck" },
      { id: "s3", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, entities: [{ id: "r", type: "rect", center: [2000, 3000], w: 3000, h: 200 }] },
      { id: "wall", op: "extrude", sketch: "s3", distance: 2600, newBody: "wall" },
    ],
  };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await waitForRebuild(page);
});

test("the start point placed in the view, then in VR: standing there, teleport, snap turn, roof off, back to the start, out", async ({ page }) => {
  // Settings > VR: this (emulated) headset can do VR; no start yet.
  await page.getByTestId("ask-settings-open").click();
  await page.getByTestId("settings-tab-vr").click();
  await expect(page.getByTestId("vr-support")).toContainText("This browser can do VR");
  await expect(page.getByTestId("vr-start-readout")).toContainText("Not set");
  await page.getByTestId("vr-start-place").click();
  await expect(page.getByTestId("vr-hint")).toContainText("Click the floor");
  // The floor at (3000, 6000) on the slab's top, then a point north of it: facing north (90°).
  const [x, y] = await hook(page, (h) => h.project([3000, 6000, 100]));
  await page.mouse.move(x, y);
  await expect.poll(async () => (await vr(page)).marker?.at.map((v) => Math.round(v / 50) * 50)).toEqual([3000, 6000, 100]);
  await page.mouse.click(x, y);
  await expect(page.getByTestId("vr-hint")).toContainText("the way you want to face");
  const [nx, ny] = await hook(page, (h) => h.project([3000, 9000, 100]));
  await page.mouse.move(nx, ny, { steps: 4 });
  await page.mouse.click(nx, ny);
  await expect(page.getByTestId("vr-hint")).toHaveCount(0);
  await expect.poll(async () => ((await savedDocument(page)) as { vr?: { start: { at: number[]; heading: number } } }).vr?.start.heading).toBe(90);
  const start = ((await savedDocument(page)) as { vr: { start: { at: number[]; heading: number } } }).vr.start;
  expect(start.at.map((v) => Math.round(v / 50) * 50)).toEqual([3000, 6000, 100]);
  // The marker stays, and nothing was selected by those clicks.
  await expect.poll(async () => (await vr(page)).marker?.heading).toBe(90);

  // The VR button (the emulator says this browser can do it): in VR, standing at the start, facing north.
  await page.getByTestId("view-vr").click();
  await expect.poll(async () => (await vr(page)).active).toBe(true);
  await page.waitForTimeout(500);
  let s = (await vr(page)).standing!;
  expect(Math.abs(s.at[0] - start.at[0])).toBeLessThan(60);
  expect(Math.abs(s.at[1] - start.at[1])).toBeLessThan(60);
  expect(Math.abs(s.heading - 90)).toBeLessThanOrEqual(2);
  // Looking up from where you stand still draws (nothing in the model is culled while you are in it).
  await device(page, "d.quaternion.set(0.3827, 0, 0, 0.9239);");
  await page.waitForTimeout(300);
  expect((await vr(page)).drawn!.calls).toBeGreaterThan(3);
  await device(page, "d.quaternion.set(0, 0, 0, 1);");

  // Teleport: the right controller pointed ahead and down, the trigger held then let go: about 1.5–2 m north.
  await device(page, "const c = d.controllers.right; c.position.set(0.2, 1.2, -0.3); c.quaternion.set(-0.2588, 0, 0, 0.9659); c.updateButtonValue('trigger', 1);");
  await page.waitForTimeout(400);
  await device(page, "d.controllers.right.updateButtonValue('trigger', 0);");
  await expect.poll(async () => (await vr(page)).standing!.at[1]).toBeGreaterThan(start.at[1] + 1000);
  s = (await vr(page)).standing!;
  expect(Math.abs(s.at[0] - start.at[0])).toBeLessThan(400);
  expect(Math.abs(s.at[2] - 100)).toBeLessThan(60); // still on the slab's level

  // A flick of the right stick: a 30° snap turn (to the right: facing 60°).
  await device(page, "d.controllers.right.updateAxes('thumbstick', 1, 0);");
  await page.waitForTimeout(250);
  await device(page, "d.controllers.right.updateAxes('thumbstick', 0, 0);");
  await expect.poll(async () => (await vr(page)).standing!.heading).toBe(60);

  // B: roof off; A: back to the start, facing its way.
  await device(page, "d.controllers.right.updateButtonValue('b-button', 1);");
  await expect.poll(async () => (await vr(page)).roofOff).toBe(true);
  await device(page, "d.controllers.right.updateButtonValue('b-button', 0);");
  await device(page, "d.controllers.right.updateButtonValue('a-button', 1);");
  await expect.poll(async () => Math.abs((await vr(page)).standing!.at[1] - start.at[1])).toBeLessThan(60);
  await device(page, "d.controllers.right.updateButtonValue('a-button', 0);");
  expect(Math.abs((await vr(page)).standing!.heading - 90)).toBeLessThanOrEqual(2);
  // The headset's frames draw the model (the desktop view stays out of the way meanwhile).
  await page.waitForTimeout(300);
  expect((await vr(page)).drawn!.calls).toBeGreaterThan(3);

  // Out again: the desktop view as it was.
  await hook(page, (h) => (h as unknown as { exitVr(): void }).exitVr());
  await expect.poll(async () => (await vr(page)).active).toBe(false);
  await expect(page.getByTestId("status")).toContainText("Rebuilt");
});

test("no VR button where the browser can't do VR", async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __xrDevice: { uninstallRuntime(): void } }).__xrDevice.uninstallRuntime());
  await expect(page.getByTestId("view-fit")).toBeVisible();
  // (The check ran with the emulator in place; a page without it shows none.)
  const page2 = await page.context().newPage();
  await openApp(page2);
  await expect(page2.getByTestId("view-fit")).toBeVisible();
  await expect(page2.getByTestId("view-vr")).toHaveCount(0);
  await page2.close();
});
