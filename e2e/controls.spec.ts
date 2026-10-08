// The mouse and keyboard as SOLIDWORKS has them, and changed in Settings:
// middle-drag rotates, Ctrl+middle pans, the wheel zooms toward you, a middle
// double-click fits; Ctrl+1–8, F, Z, the arrows and Space for the view; S for
// the shortcut bar, Enter to repeat, Delete, F9; box selection in a sketch;
// the trackpad scheme; rebinding a key and resetting.

import { expect, test, type Page } from "@playwright/test";
import { openApp, sketchClick } from "./helpers";

type Cam = { position: number[]; target: number[]; up: number[] };

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

const cam = (page: Page) => page.evaluate(() => (window as unknown as { __cocaideViewport: { camera(): Cam } }).__cocaideViewport.camera());
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
const len = (a: number[]) => Math.hypot(...a);
const unit = (a: number[]) => a.map((x) => x / len(a));
/** Where the camera looks from, toward the camera, unit. */
const from = (c: Cam) => unit(sub(c.position, c.target)).map((x) => Math.round(x * 1000) / 1000 + 0);
const dist = (c: Cam) => len(sub(c.position, c.target));

async function centre(page: Page): Promise<[number, number]> {
  const box = (await page.getByTestId("viewport").boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2];
}

async function drag(page: Page, button: "left" | "middle" | "right", dx: number, dy: number, at?: [number, number]) {
  const [x, y] = at ?? (await centre(page));
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up({ button });
}

test("the SOLIDWORKS mouse: middle-drag rotates, Ctrl pans, Shift zooms; the wheel toward you zooms in; a middle double-click fits", async ({ page }) => {
  const start = await cam(page);
  // Middle-drag: the view turns about the part, at the same distance.
  await drag(page, "middle", 120, 0);
  const turned = await cam(page);
  expect(from(turned)).not.toEqual(from(start));
  expect(dist(turned)).toBeCloseTo(dist(start), 3);
  expect(turned.target).toEqual(start.target);
  // Left-drag does nothing to the view in this scheme.
  await drag(page, "left", 120, 0, [(await centre(page))[0] - 300, (await centre(page))[1] - 200]);
  expect(await cam(page)).toEqual(turned);
  // Ctrl + middle-drag: the view moves, still looking the same way.
  await page.keyboard.down("Control");
  await drag(page, "middle", 80, 40);
  await page.keyboard.up("Control");
  const panned = await cam(page);
  expect(panned.target).not.toEqual(turned.target);
  expect(from(panned)).toEqual(from(turned));
  // Shift + middle-drag up: closer.
  await page.keyboard.down("Shift");
  await drag(page, "middle", 0, -60);
  await page.keyboard.up("Shift");
  expect(dist(await cam(page))).toBeLessThan(dist(panned));
  // The wheel rolled toward you (down) zooms in; away zooms out.
  const before = dist(await cam(page));
  const [x, y] = await centre(page);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, 200);
  const zoomedIn = dist(await cam(page));
  expect(zoomedIn).toBeLessThan(before);
  await page.mouse.wheel(0, -200);
  expect(dist(await cam(page))).toBeGreaterThan(zoomedIn);
  // A middle double-click fits the part, from where you are looking.
  await page.mouse.click(x, y, { button: "middle", clickCount: 1 });
  await page.mouse.click(x, y, { button: "middle", clickCount: 2 });
  const fitted = await cam(page);
  expect(dist(fitted)).toBeCloseTo(dist(start), 1);
});

test("the view keys: Ctrl+1–7, F, Z and Shift+Z, the arrows, Space's menu, Ctrl+8 square to a face", async ({ page }) => {
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+1");
  expect(from(await cam(page))).toEqual([0, -1, 0]);
  await page.keyboard.press("Control+5");
  const top = await cam(page);
  expect(from(top)).toEqual([0, 0, 1]);
  expect(top.up).toEqual([0, 1, 0]);
  await page.keyboard.press("Control+4");
  expect(from(await cam(page))).toEqual([1, 0, 0]);
  await page.keyboard.press("Control+2");
  expect(from(await cam(page))).toEqual([0, 1, 0]);
  // The arrow turns the view 15°, Shift+arrow 90°.
  await page.keyboard.press("Control+1");
  await page.keyboard.press("ArrowLeft");
  const f = from(await cam(page));
  expect(Math.acos(-f[1]) * (180 / Math.PI)).toBeCloseTo(15, 1);
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Shift+ArrowRight");
  expect(from(await cam(page)).map(Math.abs)).toEqual([1, 0, 0]);
  // Z zooms out, Shift+Z in, F fits.
  await page.keyboard.press("Control+7");
  const iso = dist(await cam(page));
  await page.keyboard.press("z");
  expect(dist(await cam(page))).toBeGreaterThan(iso);
  await page.keyboard.press("Shift+Z");
  await page.keyboard.press("Shift+Z");
  expect(dist(await cam(page))).toBeLessThan(iso);
  await page.keyboard.press("f");
  expect(dist(await cam(page))).toBeCloseTo(iso, 1);
  // Space: the view orientation menu, at the pointer.
  await page.mouse.move(...(await centre(page)));
  await page.keyboard.press("Space");
  await expect(page.getByTestId("view-menu")).toBeVisible();
  await expect(page.getByTestId("view-bottom")).toContainText("Ctrl+6");
  await page.getByTestId("view-bottom").click();
  expect(from(await cam(page))).toEqual([0, 0, -1]);
  await expect(page.getByTestId("view-menu")).toHaveCount(0);
  // Ctrl+8: square to the selected face; again, from behind it.
  await page.keyboard.press("Control+8");
  await expect(page.getByTestId("notice")).toContainText("Normal to needs one flat face");
  await page.keyboard.press("Control+7");
  await page.evaluate(() => {
    const v = (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport;
    (window as unknown as { __top: [number, number] }).__top = v.project([-25, 5, 6]);
  });
  const [tx, ty] = await page.evaluate(() => (window as unknown as { __top: [number, number] }).__top);
  await page.mouse.click(tx, ty);
  await page.keyboard.press("Control+8");
  expect(from(await cam(page))).toEqual([0, 0, 1]);
  await page.keyboard.press("Control+8");
  expect(from(await cam(page))).toEqual([0, 0, -1]);
});

test("S brings the tools to the pointer, Enter repeats the last, Delete deletes the selected feature, F9 hides the left column", async ({ page }) => {
  await page.mouse.move(...(await centre(page)));
  await page.keyboard.press("s");
  await expect(page.getByTestId("shortcut-bar")).toBeVisible();
  await expect(page.getByTestId("bar-tool.combine")).toBeDisabled();
  await page.getByTestId("bar-tool.fillet").click();
  await expect(page.getByTestId("shortcut-bar")).toHaveCount(0);
  await expect(page.getByTestId("notice")).toContainText("edge");
  await page.getByTestId("notice").getByRole("button", { name: "Dismiss" }).click();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("notice")).toContainText("edge");
  // Delete: the selected feature goes; Ctrl+Z brings it back.
  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("feature-hole_1")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("feature-hole_1")).toHaveCount(1);
  await page.keyboard.press("F9");
  await expect(page.getByLabel("Feature tree")).toBeHidden();
  await page.keyboard.press("F9");
  await expect(page.getByLabel("Feature tree")).toBeVisible();
});

test("in a sketch: L, R and C pick tools, a box left to right selects what's inside, right to left what it touches", async ({ page }) => {
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  await page.keyboard.press("r");
  await expect(page.getByTestId("tool-rect")).toHaveAttribute("aria-pressed", "true");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 20, 10);
  await page.keyboard.press("c");
  await sketchClick(page, 40, 5);
  await sketchClick(page, 44, 5);
  await page.keyboard.press("v");
  await expect(page.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");
  const toScreen = (x: number, y: number) =>
    page.evaluate(
      ([x, y]) => {
        const g = document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement;
        const m = g.getScreenCTM()!;
        return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as [number, number];
      },
      [x, y],
    );
  const boxDrag = async (a: [number, number], b: [number, number]) => {
    const [ax, ay] = await toScreen(...a);
    const [bx, by] = await toScreen(...b);
    await page.mouse.move(ax, ay);
    await page.mouse.down();
    await page.mouse.move((ax + bx) / 2, (ay + by) / 2, { steps: 4 });
    await page.mouse.move(bx, by, { steps: 4 });
    await page.mouse.up();
  };
  // Left to right round the rectangle only: just the rectangle.
  await boxDrag([-5, -5], [25, 15]);
  await expect(page.getByTestId("sketch-selection")).toContainText("1 selected");
  // Right to left across both: both.
  await boxDrag([42, 7], [10, 3]);
  await expect(page.getByTestId("sketch-selection")).toContainText("2 selected");
});

test("Settings: the trackpad scheme rotates on left-drag; a key rebound works and the old one doesn't; reset brings SOLIDWORKS's back", async ({ page }) => {
  await page.getByTestId("ask-settings-open").click();
  await page.getByTestId("settings-tab-mouse").click();
  await expect(page.getByTestId("mouse-table")).toContainText("Middle-drag");
  await page.getByTestId("settings-mouse").selectOption("trackpad");
  await page.getByTestId("settings-tab-keyboard").click();
  await expect(page.getByTestId("key-view.front")).toHaveText("Ctrl+1");
  await page.getByTestId("key-view.front").click();
  await expect(page.getByTestId("key-view.front")).toHaveText("Press a key…");
  await page.keyboard.press("Alt+1");
  await expect(page.getByTestId("key-view.front")).toHaveText("Alt+1");
  // Taking a key another command has: that one loses it.
  await page.getByTestId("key-tool.extrude").click();
  await page.keyboard.press("f");
  await expect(page.getByTestId("keys-note")).toContainText("taken from Zoom to fit");
  await expect(page.getByTestId("key-view.fit")).toContainText("add");
  await page.getByRole("button", { name: "Cancel" }).click();

  // Left-drag now rotates.
  const start = await cam(page);
  await drag(page, "left", 120, 0, [(await centre(page))[0] - 250, (await centre(page))[1] - 150]);
  expect(from(await cam(page))).not.toEqual(from(start));
  // Alt+1 is Front; Ctrl+1 is nothing now.
  await page.keyboard.press("Control+7");
  await page.keyboard.press("Control+1");
  expect(from(await cam(page))).not.toEqual([0, -1, 0]);
  await page.keyboard.press("Alt+1");
  expect(from(await cam(page))).toEqual([0, -1, 0]);
  // Kept across a reload.
  await page.reload();
  await page.getByTestId("ask-settings-open").click();
  await page.getByTestId("settings-tab-keyboard").click();
  await expect(page.getByTestId("key-view.front")).toHaveText("Alt+1");
  await page.getByTestId("settings-reset-input").click();
  await expect(page.getByTestId("key-view.front")).toHaveText("Ctrl+1");
  await expect(page.getByTestId("key-view.fit")).toHaveText("F");
  await page.getByTestId("settings-tab-mouse").click();
  await expect(page.getByTestId("settings-mouse")).toHaveValue("solidworks");
});
