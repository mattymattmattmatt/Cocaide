// The view, the way desktop CAD moves it, on the bracket (an 80 × 40 × 6
// plate on Z 0–6, centred on the origin, a Ø6.6 hole at X 30): orthographic
// by default and a true isometric; panned, a middle-drag still spins the
// part about its own middle (it stays where it is on the screen); zoomed in
// at a corner, about the part under the middle of the view; a middle-click
// on a vertex pins the centre (a marker), Esc clears it; the triad and the
// view cube; a view change glides and ends at the exact camera; zoom to
// area; named views saved, renamed, applied, deleted and remembered; Select
// other and Alt+click pick the face hidden behind; the speed and Keep Z up in
// Settings. Each state is screenshotted when SHOTS_DIR is set.

import { expect, test, type Page } from "@playwright/test";
import { openApp, viewportClick } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;
type Vec3 = [number, number, number];
type Cam = { position: Vec3; target: Vec3; up: Vec3 };
type Hook = {
  project(p: number[]): [number, number];
  camera(): Cam;
  rotationCentre(): { point: Vec3; why: string };
  pinned(): Vec3 | null;
  pivotMarker(): boolean;
  glides(on: boolean, ms?: number): void;
  gliding(): boolean;
  finishGlide(): void;
  display(): { perspective: boolean };
};
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/view-${name}.png` });
};
const call = <K extends keyof Hook>(page: Page, fn: K, ...args: Parameters<Hook[K]>) =>
  page.evaluate(([fn, args]) => (window as unknown as { __cocaideViewport: Record<string, (...a: unknown[]) => unknown> }).__cocaideViewport[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<ReturnType<Hook[K]>>;
const cam = (page: Page) => call(page, "camera");
const project = (page: Page, p: Vec3) => call(page, "project", p);
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
const len = (a: number[]) => Math.hypot(...a);
const from = (c: Cam) => sub(c.position, c.target).map((x, _, all) => Math.round((x / len(all)) * 1000) / 1000 + 0);
const dist = (c: Cam) => len(sub(c.position, c.target));

async function centre(page: Page): Promise<[number, number]> {
  const box = (await page.getByTestId("viewport").boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/** A middle-drag (Ctrl: pan) from `at` by dx, dy. */
async function middleDrag(page: Page, dx: number, dy: number, at?: [number, number], ctrl = false) {
  const [x, y] = at ?? (await centre(page));
  await page.mouse.move(x, y);
  if (ctrl) await page.keyboard.down("Control");
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  if (ctrl) await page.keyboard.up("Control");
}

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("orthographic by default, and Isometric is the true one: equal angles from the front, right and above", async ({ page }) => {
  expect((await call(page, "display")).perspective).toBe(false);
  await expect(page.getByTestId("view-perspective")).toHaveAttribute("aria-label", "Orthographic");
  await page.keyboard.press("Control+7");
  const s = Math.round((1 / Math.sqrt(3)) * 1000) / 1000;
  expect(from(await cam(page))).toEqual([s, -s, s]);
  // Dimetric and Trimetric are in the Views menu.
  await page.getByTestId("view-menu-open").click();
  await page.getByTestId("view-dimetric").click();
  const d = from(await cam(page));
  expect(d[0]).toBeCloseTo(1 / 3, 2);
  expect(d[2]).toBeCloseTo(1 / 3, 2);
  await page.getByTestId("view-menu-open").click();
  await page.getByTestId("view-trimetric").click();
  expect(new Set(from(await cam(page)).map(Math.abs)).size).toBe(3);
  await shot(page, "trimetric");
});

test("panned off to one side, a middle-drag spins the part about its own middle: it stays where it is on the screen", async ({ page }) => {
  // Pan the part well off centre (Ctrl + middle-drag): the camera now looks at empty space.
  await middleDrag(page, 220, 90, undefined, true);
  const middle: Vec3 = [0, 0, 3];
  const before = await project(page, middle);
  const [cx, cy] = await centre(page);
  expect(Math.hypot(before[0] - cx, before[1] - cy)).toBeGreaterThan(150);
  expect(await call(page, "rotationCentre")).toEqual({ point: middle, why: "box" });
  const start = await cam(page);
  await middleDrag(page, 160, 70);
  const turned = await cam(page);
  expect(from(turned)).not.toEqual(from(start));
  const after = await project(page, middle);
  expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeLessThan(3);
  // And again: still about the part's middle, still in place.
  await middleDrag(page, -90, 120);
  const again = await project(page, middle);
  expect(Math.hypot(again[0] - before[0], again[1] - before[1])).toBeLessThan(3);
  await shot(page, "pan-rotate");
});

test("zoomed in at a corner so the part overflows: a middle-drag turns about the part under the middle of the view, which stays put", async ({ page }) => {
  // The wheel zooms in at the pointer: on the plate's top face near the front-right corner.
  const corner = await project(page, [34, -14, 6]);
  await page.mouse.move(...corner);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 200);
  const c = await call(page, "rotationCentre");
  expect(c.why).toBe("under");
  // The point under the middle of the view is on the top face, near where we zoomed.
  expect(c.point[2]).toBeCloseTo(6, 3);
  const [cx, cy] = await centre(page);
  const before = await project(page, c.point);
  expect(Math.hypot(before[0] - cx, before[1] - cy)).toBeLessThan(2);
  await middleDrag(page, 120, -60);
  const after = await project(page, c.point);
  expect(Math.hypot(after[0] - cx, after[1] - cy)).toBeLessThan(3);
  await shot(page, "zoomed-rotate");
});

test("zoomed in with the middle of the view just off a long edge: a middle-drag turns about the edge beside it, not a far corner", async ({ page }) => {
  await page.keyboard.press("Control+1");
  const [cx, cy] = await centre(page);
  // Pan the plate up until its long bottom edge is 10 px above the middle of the view, then zoom in there.
  const edge = await project(page, [0, -20, 0]);
  await middleDrag(page, 0, cy - 10 - edge[1], undefined, true);
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 200);
  // Nothing of the part is under the middle: the nearest point of it is on that edge, beside the middle
  // (its mesh has vertices only at the corners and round the hole, 26 mm and more away).
  const c = await call(page, "rotationCentre");
  expect(c.why).toBe("nearest");
  expect(Math.abs(c.point[0])).toBeLessThan(5);
  expect(c.point[2]).toBeCloseTo(0, 3);
  const before = await project(page, c.point);
  expect(Math.hypot(before[0] - cx, before[1] - cy)).toBeLessThan(120);
  await middleDrag(page, 90, 40);
  const after = await project(page, c.point);
  expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeLessThan(3);
  await shot(page, "nearest-edge");
});

test("a middle-click on a vertex pins the rotation centre there (a marker shows it); the part turns about it; Esc clears it", async ({ page }) => {
  const vertex: Vec3 = [40, -20, 6];
  const at = await project(page, vertex);
  await page.mouse.click(at[0], at[1], { button: "middle" });
  expect(await call(page, "pinned")).toEqual(vertex);
  expect(await call(page, "pivotMarker")).toBe(true);
  await expect(page.getByTestId("pinned-hint")).toContainText("Turning about the pinned point");
  // On one line, as wide as its words (it used to be squeezed into half the view and wrap).
  expect((await page.getByTestId("pinned-hint").boundingBox())!.height).toBeLessThan(34);
  expect((await call(page, "rotationCentre")).why).toBe("pinned");
  await shot(page, "pinned");
  // It stays pinned for more than one rotation, and the vertex keeps its place on the screen.
  await middleDrag(page, 140, 40);
  await middleDrag(page, -60, 80);
  const after = await project(page, vertex);
  expect(Math.hypot(after[0] - at[0], after[1] - at[1])).toBeLessThan(3);
  expect(await call(page, "pinned")).toEqual(vertex);
  await page.keyboard.press("Escape");
  expect(await call(page, "pinned")).toBeNull();
  expect(await call(page, "pivotMarker")).toBe(false);
  await expect(page.getByTestId("pinned-hint")).toHaveCount(0);
  // A middle-click on empty space clears it too, and a standard view.
  await page.mouse.click(at[0], at[1], { button: "middle" });
  const box = (await page.getByTestId("viewport").boundingBox())!;
  await page.waitForTimeout(400); // not a double-click
  await page.mouse.click(box.x + 200, box.y + box.height - 150, { button: "middle" });
  expect(await call(page, "pinned")).toBeNull();
  const again = await project(page, vertex);
  await page.waitForTimeout(400);
  await page.mouse.click(again[0], again[1], { button: "middle" });
  expect(await call(page, "pinned")).not.toBeNull();
  await page.keyboard.press("Control+7");
  expect(await call(page, "pinned")).toBeNull();
  // The hint's × clears it too.
  const last = await project(page, vertex);
  await page.waitForTimeout(400);
  await page.mouse.click(last[0], last[1], { button: "middle" });
  await expect(page.getByTestId("pinned-hint")).toBeVisible();
  await page.getByTestId("pinned-clear").click();
  expect(await call(page, "pinned")).toBeNull();
});

test("the triad looks along an axis (again: from the other side); the view cube's faces and corners turn the view", async ({ page }) => {
  await page.getByTestId("triad-x").click();
  expect(from(await cam(page))).toEqual([1, 0, 0]);
  await page.getByTestId("triad-x").click();
  expect(from(await cam(page))).toEqual([-1, 0, 0]);
  await page.getByTestId("triad-z").click();
  const top = await cam(page);
  expect(from(top)).toEqual([0, 0, 1]);
  expect(top.up).toEqual([0, 1, 0]);
  await shot(page, "triad-top");
  // The cube from the isometric view: its front, right and top faces show; the front face, then the corner.
  await page.keyboard.press("Control+7");
  await expect(page.getByTestId("view-cube")).toBeVisible();
  await page.getByTestId("cube-face-front").click();
  expect(from(await cam(page))).toEqual([0, -1, 0]);
  // Square to the front, the top is edge on (it takes no clicks); the front face's top edge is the front-top edge.
  await expect(page.getByTestId("cube-face-top")).toBeHidden();
  await page.getByTestId("cube-front-10").click();
  const h = Math.round(Math.SQRT1_2 * 1000) / 1000;
  expect(from(await cam(page))).toEqual([0, -h, h]);
  await page.getByTestId("cube-face-top").click();
  expect(from(await cam(page))).toEqual([0, 0, 1]);
  await page.keyboard.press("Control+7");
  // The front face's top-left cell is the front-left-top corner.
  await page.getByTestId("cube-front-00").click();
  const s = Math.round((1 / Math.sqrt(3)) * 1000) / 1000;
  expect(from(await cam(page))).toEqual([-s, -s, s]);
  // The arrows turn 90°; Home is the isometric.
  await page.getByTestId("cube-face-front").click();
  await page.getByTestId("cube-turn-left").click();
  expect(from(await cam(page))).toEqual([1, 0, 0]);
  await page.getByTestId("cube-turn-cw").click();
  expect((await cam(page)).up.map((x) => Math.round(x * 1000) / 1000 + 0)).toEqual([0, -1, 0]);
  await page.getByTestId("cube-home").click();
  expect(from(await cam(page))).toEqual([s, -s, s]);
  await shot(page, "cube");
  // Dragging the cube turns the view freely, about the part's middle (which stays put on the screen).
  const middle = await project(page, [0, 0, 3]);
  const cell = (await page.getByTestId("cube-face-front").boundingBox())!;
  const [fx, fy] = [cell.x + cell.width / 2, cell.y + cell.height / 2];
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 20, fy, { steps: 4 });
  await page.mouse.move(fx + 40, fy + 12, { steps: 4 });
  await page.mouse.up();
  const dragged = from(await cam(page));
  expect(dragged).not.toEqual([s, -s, s]);
  const still = await project(page, [0, 0, 3]);
  expect(Math.hypot(still[0] - middle[0], still[1] - middle[1])).toBeLessThan(3);
  // A drag that comes back to where it started and is released on the same cell is no click: no jump to Front.
  const cell2 = (await page.getByTestId("cube-face-front").boundingBox())!;
  const [gx, gy] = [cell2.x + cell2.width / 2, cell2.y + cell2.height / 2];
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 30, gy, { steps: 4 });
  await page.mouse.move(gx, gy, { steps: 4 });
  await page.mouse.up();
  expect(from(await cam(page))).not.toEqual([0, -1, 0]);
  await page.getByTestId("cube-home").click();
  // Hidden from the Views menu, shown again.
  await page.getByTestId("view-menu-open").click();
  await page.getByTestId("view-cube-toggle").click();
  await expect(page.getByTestId("view-cube")).toBeHidden();
  await page.getByTestId("view-menu-open").click();
  await page.getByTestId("view-cube-toggle").click();
  await expect(page.getByTestId("view-cube")).toBeVisible();
});

test("a view change glides, and ends at exactly the camera it jumps to", async ({ page }) => {
  // Where Front puts the camera (the tests jump by default).
  await page.keyboard.press("Control+1");
  const front = await cam(page);
  await page.keyboard.press("Control+7");
  const iso = await cam(page);
  // Slowed down (a second and a half) so it is seen partway even on a slow machine.
  await call(page, "glides", true, 1500);
  await page.keyboard.press("Control+1");
  expect(await call(page, "gliding")).toBe(true);
  // Partway it is between the two; it ends exactly at Front.
  const seen: string[] = [];
  const key = (c: Cam) => JSON.stringify(c);
  while (await call(page, "gliding")) seen.push(key(await cam(page)));
  expect(seen.some((c) => c !== key(iso) && c !== key(front))).toBe(true);
  expect(await cam(page)).toEqual(front);
  await shot(page, "glided-front");
  // A view rested on for a moment is one Previous view goes back to.
  await page.waitForTimeout(600);
  // An arrow key glides a 15° turn; finished at once, it is exactly there.
  await page.keyboard.press("ArrowLeft");
  await call(page, "finishGlide");
  const f = from(await cam(page));
  expect(Math.acos(-f[1]) * (180 / Math.PI)).toBeCloseTo(15, 1);
  // Previous view glides back.
  await page.waitForTimeout(600);
  await page.getByTestId("view-previous").click();
  await expect.poll(() => call(page, "gliding")).toBe(false);
  expect(from(await cam(page))).toEqual([0, -1, 0]);
});

test("zoom to area: drag a box round the hole and the view fills with it", async ({ page }) => {
  await page.getByTestId("view-zoom-area").click();
  await expect(page.getByTestId("view-zoom-area")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("zoom-area-hint")).toBeVisible();
  const before = dist(await cam(page));
  const hole = await project(page, [30, 0, 6]);
  await page.mouse.move(hole[0] - 30, hole[1] - 22);
  await page.mouse.down();
  await page.mouse.move(hole[0], hole[1], { steps: 4 });
  await page.mouse.move(hole[0] + 30, hole[1] + 22, { steps: 4 });
  await expect(page.getByTestId("zoom-area-box")).toBeVisible();
  await shot(page, "zoom-area-box");
  await page.mouse.up();
  await expect(page.getByTestId("view-zoom-area")).toHaveAttribute("aria-pressed", "false");
  expect(dist(await cam(page))).toBeLessThan(before / 5);
  // The hole is in the middle of the view now.
  const [cx, cy] = await centre(page);
  const now = await project(page, [30, 0, 6]);
  expect(Math.hypot(now[0] - cx, now[1] - cy)).toBeLessThan(25);
  await shot(page, "zoom-area");
  // Esc stops waiting for an area.
  await page.getByTestId("view-zoom-area").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-zoom-area")).toHaveAttribute("aria-pressed", "false");
});

test("named views: save one, apply it, rename it, delete it; kept for the part across a reload", async ({ page }) => {
  await page.keyboard.press("Control+4");
  await page.keyboard.press("ArrowUp");
  const saved = await cam(page);
  await page.getByTestId("view-menu-open").click();
  await page.getByTestId("view-save").click();
  await expect(page.getByTestId("view-save-name")).toHaveValue("View 1");
  await page.getByTestId("view-save-name").fill("Weld detail");
  await shot(page, "named-save");
  await page.getByTestId("view-save-ok").click();
  await expect(page.getByTestId("notice")).toContainText("View saved as Weld detail");
  await page.keyboard.press("Control+7");
  // Applied from the Space menu (the same menu, at the pointer).
  await page.mouse.move(...(await centre(page)));
  await page.keyboard.press("Space");
  await expect(page.getByTestId("named-view-Weld detail")).toBeVisible();
  await shot(page, "named-menu");
  await page.getByTestId("named-view-Weld detail").locator(".named-view-go").click();
  expect(await cam(page)).toEqual(saved);
  // Kept across a reload.
  await page.keyboard.press("Control+7");
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  await page.getByTestId("view-menu-open").click();
  await page.getByTestId("named-view-rename-Weld detail").click();
  await page.getByTestId("named-view-name-Weld detail").fill("End view");
  await page.getByTestId("named-view-rename-ok-Weld detail").click();
  await expect(page.getByTestId("named-view-End view")).toBeVisible();
  await page.getByTestId("named-view-End view").locator(".named-view-go").click();
  expect(await cam(page)).toEqual(saved);
  await page.getByTestId("view-menu-open").click();
  await page.getByTestId("named-view-delete-End view").click();
  await expect(page.getByTestId("named-view-End view")).toHaveCount(0);
  await expect(page.getByTestId("view-menu")).toContainText("None yet");
});

test("Select other lists every face under the pointer, nearest first, and picks the hidden one; Alt+click steps behind", async ({ page }) => {
  // Right-click the top face: the bottom face is right behind it.
  const p = await project(page, [-20, -10, 6]);
  await page.mouse.click(p[0], p[1], { button: "right" });
  await page.getByTestId("ctx-select-other").click();
  await expect(page.getByTestId("select-other")).toBeVisible();
  await expect(page.getByTestId("select-other-0")).toContainText("(flat, +Z)");
  await expect(page.getByTestId("select-other-1")).toContainText("(flat, -Z)");
  await page.getByTestId("select-other-1").hover();
  await shot(page, "select-other");
  await page.getByTestId("select-other-1").click();
  await expect(page.getByTestId("select-other")).toHaveCount(0);
  await expect(page.getByTestId("selection")).toContainText("normal -Z");
  // Alt+click on the top face: the face behind it (the bottom); again: round to the top.
  await page.keyboard.press("Escape");
  await page.mouse.move(p[0], p[1]);
  await page.keyboard.down("Alt");
  await page.mouse.click(p[0], p[1]);
  await page.keyboard.up("Alt");
  await expect(page.getByTestId("selection")).toContainText("normal -Z");
  await page.keyboard.down("Alt");
  await page.mouse.click(p[0], p[1]);
  await page.keyboard.up("Alt");
  await expect(page.getByTestId("selection")).toContainText("normal +Z");
  // A plain click is the nearest, as ever.
  await viewportClick(page, [-20, -10, 6]);
  await expect(page.getByTestId("selection")).toContainText("normal +Z");
  // With the filter on edges only, Alt+click picks no face behind either: in the middle of a face it picks nothing.
  await page.getByTestId("filter-edges").click();
  await page.keyboard.down("Alt");
  await page.mouse.click(p[0], p[1]);
  await page.keyboard.up("Alt");
  await expect(page.getByTestId("selection")).toHaveCount(0);
  await page.getByTestId("filter-edges").click();
});

test("Settings > Mouse: the rotation speed scales a drag's turn; Keep Z up keeps the view level", async ({ page }) => {
  const angle = (a: Cam, b: Cam) => {
    const u = from(a);
    const v = from(b);
    return (Math.acos(Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])) * 180) / Math.PI;
  };
  await page.keyboard.press("Control+1");
  const front = await cam(page);
  const box = (await page.getByTestId("viewport").boundingBox())!;
  // At 100 %, a drag of a quarter of the view's height turns 45°.
  await middleDrag(page, box.height / 4, 0);
  expect(angle(front, await cam(page))).toBeCloseTo(45, 0);
  await page.getByTestId("ask-settings-open").click();
  await page.getByTestId("settings-tab-mouse").click();
  // The slider in steps of 10 %: ten to the right is 200 %.
  await page.getByTestId("settings-rotate-speed").focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("settings-rotate-speed-value")).toHaveText("200 %");
  await page.getByTestId("settings-turntable").check();
  await expect(page.getByTestId("settings-animate")).toBeChecked();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Control+1");
  await middleDrag(page, box.height / 4, 0);
  expect(angle(front, await cam(page))).toBeCloseTo(90, 0);
  // Keep Z up: a diagonal drag leaves the screen's right level (no roll) and Z up the screen.
  await middleDrag(page, 70, 50);
  const c = await cam(page);
  const fwd = sub(c.target, c.position);
  const right = [fwd[1] * c.up[2] - fwd[2] * c.up[1], fwd[2] * c.up[0] - fwd[0] * c.up[2], fwd[0] * c.up[1] - fwd[1] * c.up[0]];
  expect(right[2] / len(right)).toBeCloseTo(0, 3);
  expect(c.up[2]).toBeGreaterThan(0);
  // Back to the defaults.
  await page.getByTestId("ask-settings-open").click();
  await page.getByTestId("settings-tab-mouse").click();
  await page.getByTestId("settings-reset-input").click();
  await expect(page.getByTestId("settings-rotate-speed-value")).toHaveText("100 %");
  await expect(page.getByTestId("settings-turntable")).not.toBeChecked();
});
