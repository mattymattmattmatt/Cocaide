// Phase Q wave Q4 in the browser: the layout is stable. The user's bug was
// "the auto views resized weirdly when moved, and one half off the sheet
// changed the scale to something huge". New drawing stores the sheet's
// scale; dragging a view (even half off the sheet) changes no scale and no
// view's size, only that view's place (the views lined up with it go too);
// the checks say a view is off the sheet; Fit views lays them out afresh.
// The kernel is real.

import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

type Box = { min: [number, number]; max: [number, number] };
type ViewInfo = { centre: [number, number]; box: Box; scale: number; origin: [number, number] };
interface SheetHook {
  toScreen(x: number, y: number): [number, number];
  view(id: string): ViewInfo | null;
  titleBlock(): Box;
}

async function at(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(([x, y]) => (window as unknown as Record<string, SheetHook>).__cocaideSheet.toScreen(x, y), [x, y]);
}
async function viewOf(page: Page, id: string): Promise<ViewInfo> {
  await expect.poll(() => page.evaluate((id) => !!(window as unknown as Record<string, SheetHook>).__cocaideSheet.view(id)?.box, id)).toBe(true);
  return page.evaluate((id) => (window as unknown as Record<string, SheetHook>).__cocaideSheet.view(id)!, id);
}
const size = (v: ViewInfo) => [Math.round((v.box.max[0] - v.box.min[0]) * 100) / 100, Math.round((v.box.max[1] - v.box.min[1]) * 100) / 100];

/** The scale the title block says ("2:1"): the text in its box that is a scale. */
async function titleScale(page: Page): Promise<string> {
  const tb = await page.evaluate(() => (window as unknown as Record<string, SheetHook>).__cocaideSheet.titleBlock());
  const [x0, y0] = await at(page, tb.min[0], tb.max[1]);
  const [x1, y1] = await at(page, tb.max[0], tb.min[1]);
  const texts = page.getByTestId("sheet").locator(".sheet-paper text");
  const out: string[] = [];
  for (let i = 0; i < (await texts.count()); i++) {
    const t = texts.nth(i);
    const s = (await t.textContent())?.trim() ?? "";
    if (!/^\d+(\.\d+)?\s*:\s*\d+(\.\d+)?$/.test(s)) continue;
    const b = await t.boundingBox();
    if (b && b.x >= x0 - 1 && b.x + b.width <= x1 + 1 && b.y >= y0 - 1 && b.y + b.height <= y1 + 1) out.push(s);
  }
  expect(out).toHaveLength(1);
  return out[0];
}

/** Drags a view by its middle by (dx, dy) screen pixels; with Alt it goes exactly there (no snapping, not kept on the sheet). */
async function drag(page: Page, id: string, dx: number, dy: number, alt = false) {
  const v = await viewOf(page, id);
  // Off the middle, clear of the centre lines and marks there.
  const [x, y] = await at(page, v.box.min[0] + 0.15 * (v.box.max[0] - v.box.min[0]), v.box.min[1] + 0.3 * (v.box.max[1] - v.box.min[1]));
  await page.mouse.move(x, y);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(x + dx / 3, y + dy / 3, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}

test("dragging views never changes the scale or a view's size; parents take their views; Fit views", async ({ page }) => {
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await expect(page.getByTestId("drawing-item-front")).toContainText("section A-A of top");
  const views = ["top", "front", "iso"];
  const before = Object.fromEntries(await Promise.all(views.map(async (id) => [id, await viewOf(page, id)] as const)));
  const scale = await titleScale(page);
  expect(scale).toBe("2:1");
  // New drawing stored it.
  expect(((await savedDocument(page)) as { drawing: { sheets: { scale?: string }[] } }).drawing.sheets[0].scale).toBe("2:1");

  // The iso half off the sheet's right edge (Alt: exactly where it is dropped).
  const iso = before.iso;
  const frameRight = await page.evaluate(() => (window as unknown as Record<string, SheetHook>).__cocaideSheet.titleBlock().max[0]);
  const [ix, iy] = await at(page, iso.centre[0], iso.centre[1]);
  const [tx] = await at(page, frameRight, iso.centre[1]);
  await drag(page, "iso", tx - ix, 0, true);
  void iy;
  await expect.poll(async () => (await viewOf(page, "iso")).centre[0]).toBeGreaterThan(iso.centre[0] + 20);
  const off = await viewOf(page, "iso");
  expect(size(off)).toEqual(size(iso));
  expect(off.scale).toBe(iso.scale);
  expect(await titleScale(page)).toBe(scale);
  for (const id of ["top", "front"]) expect((await viewOf(page, id)).centre).toEqual(before[id].centre);
  await page.screenshot({ path: "test-results/drawing-layout-off-sheet.png" });
  // The checks say where it is.
  await expect(page.getByTestId("drawing-checks")).toContainText(/view iso is (partly )?off the sheet/);

  // The top view dragged down and right: section A-A under it goes with it; the iso stays where it was put.
  await drag(page, "top", 40, 30);
  await expect.poll(async () => (await viewOf(page, "top")).centre[0]).toBeGreaterThan(before.top.centre[0] + 2);
  const top = await viewOf(page, "top");
  const front = await viewOf(page, "front");
  const dTop = [top.centre[0] - before.top.centre[0], top.centre[1] - before.top.centre[1]];
  expect(front.centre[0] - before.front.centre[0]).toBeCloseTo(dTop[0], 1);
  expect(front.centre[1] - before.front.centre[1]).toBeCloseTo(dTop[1], 1);
  expect(size(top)).toEqual(size(before.top));
  expect(size(front)).toEqual(size(before.front));
  expect((await viewOf(page, "iso")).centre).toEqual(off.centre);
  expect(await titleScale(page)).toBe(scale);

  // Every view moved: still the same scale (it went to 10:1 before, nothing being left to fit).
  await drag(page, "iso", -10, 0);
  expect(await titleScale(page)).toBe(scale);
  for (const id of views) expect(size(await viewOf(page, id))).toEqual(size(before[id]));

  // Fit views: laid out afresh, as New drawing had them, at the scale that fits.
  await page.getByTestId("dtab-layout").click();
  await page.getByTestId("tool-view-fit").click();
  await expect(page.getByTestId("notice")).toContainText("Fit views");
  for (const id of views) await expect.poll(async () => (await viewOf(page, id)).centre).toEqual(before[id].centre);
  expect(await titleScale(page)).toBe(scale);
  const doc = (await savedDocument(page)) as { drawing: { sheets: { scale?: string; views: { id: string; at?: number[] }[] }[] } };
  expect(doc.drawing.sheets[0].views.filter((v) => v.at)).toEqual([]);

  // Undo puts the moved places back in one step.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await viewOf(page, "top")).centre).toEqual(top.centre);
  await page.keyboard.press("Control+y");
  for (const id of views) await expect.poll(async () => (await viewOf(page, id)).centre).toEqual(before[id].centre);

  // A sheet stored without a scale (as before this wave) keeps the one it shows: the first edit stores it.
  await page.keyboard.press("Escape");
  await page.getByTestId("sheet-scale").selectOption("");
  await expect.poll(async () => ((await savedDocument(page)) as { drawing: { sheets: { scale?: string }[] } }).drawing.sheets[0].scale).toBeUndefined();
  expect(await titleScale(page)).toBe(scale);
  await drag(page, "iso", 0, 40, true);
  await expect.poll(async () => ((await savedDocument(page)) as { drawing: { sheets: { scale?: string }[] } }).drawing.sheets[0].scale).toBe("2:1");
  expect(await titleScale(page)).toBe(scale);
  expect(size(await viewOf(page, "iso"))).toEqual(size(before.iso));
});

test("manual mode: nothing moves when it is turned on or when a view is added; Fit views is off; one undo step", async ({ page }) => {
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await expect(page.getByTestId("drawing-item-front")).toContainText("section A-A of top");
  const views = ["top", "front", "iso"];
  const before = Object.fromEntries(await Promise.all(views.map(async (id) => [id, await viewOf(page, id)] as const)));

  const manual = page.getByTestId("drawing-manual");
  await manual.click();
  await expect(manual).toHaveAttribute("aria-pressed", "true");
  type Saved = { drawing: { sheets: { manual?: boolean; views: { id: string; at?: number[] }[]; annotations: { type: string; at?: unknown; offset?: unknown }[] }[] } };
  await expect.poll(async () => ((await savedDocument(page)) as Saved).drawing.sheets[0].manual).toBe(true);
  const s = ((await savedDocument(page)) as Saved).drawing.sheets[0];
  expect(s.views.every((v) => Array.isArray(v.at))).toBe(true);
  expect(s.annotations.filter((a) => a.type === "dimension").every((a) => a.at !== undefined || a.offset !== undefined)).toBe(true);
  const near = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 2));
  for (const id of views) near((await viewOf(page, id)).centre, before[id].centre);

  await page.getByTestId("dtab-layout").click();
  await expect(page.getByTestId("tool-view-fit")).toBeDisabled();

  // A projected view to the right of the top view, where it is clicked: nothing else moves.
  await page.getByTestId("tool-view-projected").click();
  const top = before.top;
  const [cx, cy] = await at(page, top.centre[0], top.centre[1]);
  await page.mouse.click(cx, cy);
  const [rx, ry] = await at(page, top.box.max[0] + 45, top.centre[1]);
  await page.mouse.click(rx, ry);
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => !!(window as unknown as Record<string, SheetHook>).__cocaideSheet.view("right")?.box)).toBe(true);
  for (const id of views) {
    const v = await viewOf(page, id);
    near(v.centre, before[id].centre);
    expect(v.scale).toBe(before[id].scale);
  }

  // Turning it off again is the button too.
  await manual.click();
  await expect(manual).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("tool-view-fit")).toBeEnabled();
});

test("a blank sheet starts in manual mode with nothing on it", async ({ page }) => {
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-blank").click();
  await expect(page.getByTestId("drawing-manual")).toHaveAttribute("aria-pressed", "true");
  type Saved = { drawing: { sheets: { manual?: boolean; views: unknown[]; annotations: unknown[] }[] } };
  await expect.poll(async () => ((await savedDocument(page)) as Saved).drawing?.sheets[0].manual).toBe(true);
  const s = ((await savedDocument(page)) as Saved).drawing.sheets[0];
  expect([s.views.length, s.annotations.length]).toEqual([0, 0]);
});
