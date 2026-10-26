// Feature sessions (Phase P wave 2) in the browser, on the bracket (an 80 × 40
// × 6 plate centred on the origin, z 0..6, with a Ø6.6 hole at X 30): a tool
// opens its feature with OK and Cancel; picks in the view go into the active
// selection field; changes preview live (what the feature adds tinted, what it
// removes as a red ghost); drag handles change its numbers; OK keeps it as one
// undo step, Cancel leaves the part as it was. Screenshots go to SHOTS_DIR.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, viewportClick, waitForRebuild } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;
type Raw = Record<string, unknown>;
type Hook = {
  project(p: number[]): [number, number];
  handlePoint(id: string, at?: number): [number, number] | null;
  sessionPreview(): { added: boolean; removed: boolean; failed: boolean };
};
const hook = (page: Page) => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.sessionPreview());
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/session-${name}.png` });
};
const features = async (page: Page) => (await savedDocument(page)).features as Raw[];
const feature = async (page: Page, id: string) => (await features(page)).find((f) => f.id === id);
/** 80·40·6 − π·3.3²·6 */
const BRACKET = 80 * 40 * 6 - Math.PI * 3.3 * 3.3 * 6;
const vol = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 }).slice(0, 5);

/** Drags a handle `px` pixels along its arrow on screen (outward, from its shaft toward its head). */
async function dragHandle(page: Page, id: string, px: number) {
  const at = (t: number) => page.evaluate(([id, t]) => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.handlePoint(id as string, t as number), [id, t] as const);
  await expect.poll(() => at(0.6)).not.toBeNull();
  const a = (await at(0.4))!;
  const b = (await at(0.9))!;
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const [ux, uy] = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  const [x, y] = (await at(0.6))!;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (ux * px) / 2, y + (uy * px) / 2, { steps: 4 });
  await page.mouse.move(x + ux * px, y + uy * px, { steps: 4 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("Fillet: command-first, edges picked into the session, the radius handle dragged; OK is one undo step", async ({ page }) => {
  await page.getByTestId("tool-fillet").click();
  // Nothing was selected: the session opens with its edges field active, waiting.
  await expect(page.getByTestId("session-bar")).toBeVisible();
  await expect(page.getByTestId("session-title")).toHaveText("Add fillet_1");
  await expect(page.getByTestId("prop-edges-pick")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("session-prompt-text")).toHaveText("Pick edges to fillet");
  expect(await feature(page, "fillet_1")).toBeUndefined();
  // A long top edge goes in (with its tangency chain: just itself on a plain plate); the fillet goes into the document.
  await viewportClick(page, [0, -20, 6]);
  await expect.poll(async () => (await feature(page, "fillet_1"))?.edges).toBeTruthy();
  await expect(page.getByTestId("session-prompt-text")).toHaveText(/Pick edges to fillet — 1 picked/);
  await waitForRebuild(page);
  await expect.poll(async () => (await hook(page)).removed).toBe(true);
  // The radius handle: dragged along its arrow, the label follows and the fillet changes with it.
  const start = (await feature(page, "fillet_1"))!.radius as number;
  await expect(page.getByTestId("handle-label-fillet_1:radius")).toHaveText(`Radius ${start} mm`);
  await dragHandle(page, "fillet_1:radius", 18);
  await expect.poll(async () => (await feature(page, "fillet_1"))!.radius as number).toBeGreaterThan(start);
  await expect(page.getByTestId("handle-label-fillet_1:radius")).toHaveText(/^Radius \d+ mm$/);
  await waitForRebuild(page);
  await shot(page, "fillet-preview");
  await page.getByTestId("session-ok").click();
  await expect(page.getByTestId("session-bar")).toHaveCount(0);
  expect(await feature(page, "fillet_1")).toBeTruthy();
  // One undo takes the whole fillet away.
  await page.getByTestId("undo").click();
  await expect.poll(async () => await feature(page, "fillet_1")).toBeUndefined();
  await waitForRebuild(page);
  await expectVolume(page, vol(BRACKET));
});

test("Cancel a new extrude: no feature, no undo step", async ({ page }) => {
  const before = (await features(page)).map((f) => f.id);
  await page.getByTestId("feature-sketch_1").locator(".feature-row").click();
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("session-title")).toHaveText("Add extrude_1");
  await page.getByTestId("session-cancel").click();
  await expect(page.getByTestId("session-bar")).toHaveCount(0);
  expect((await features(page)).map((f) => f.id)).toEqual(before);
  await expect(page.getByTestId("undo")).toBeDisabled();
});

test("a new boss previews in the accent colour; Esc cancels it", async ({ page }) => {
  // A sketch on the top face: a 20 × 10 rectangle, extruded up.
  await openDocument(page, {
    ...(await savedDocument(page)),
    features: [
      ...(await features(page)),
      { id: "sketch_2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] }, entities: [{ id: "r2", type: "rect", center: [-15, 0], w: 20, h: 10 }], constraints: [] },
    ],
  });
  await page.getByTestId("feature-sketch_2").locator(".feature-row").click();
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("session-title")).toHaveText("Add extrude_1");
  await waitForRebuild(page);
  await expect.poll(async () => (await hook(page)).added).toBe(true);
  await expect(page.getByTestId("handle-label-extrude_1:distance")).toHaveText("Depth 10 mm");
  await shot(page, "boss-preview");
  await page.locator("body").click({ position: { x: 5, y: 890 } });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("session-bar")).toHaveCount(0);
  expect(await feature(page, "extrude_1")).toBeUndefined();
});

test("edit an extrude: the depth by its handle, the draft typed; Cancel puts it back exactly", async ({ page }) => {
  const before = JSON.stringify(await savedDocument(page));
  // Double-click in the tree: the extrude opens with OK and Cancel.
  await page.getByTestId("feature-ext_1").locator(".feature-row").dblclick();
  await expect(page.getByTestId("session-title")).toHaveText("Edit ext_1");
  await waitForRebuild(page);
  await expect(page.getByTestId("handle-label-ext_1:distance")).toHaveText("Depth 6 mm");
  await dragHandle(page, "ext_1:distance", 30);
  await expect.poll(async () => (await feature(page, "ext_1"))!.distance as number).toBeGreaterThan(6);
  await page.getByTestId("prop-draft").check();
  await commit(page, "prop-draft-angle", "4");
  await expect.poll(async () => ((await feature(page, "ext_1"))!.draft as Raw | undefined)?.angle).toBe(4);
  await waitForRebuild(page);
  await expect(page.getByTestId("handle-label-ext_1:draft.angle")).toHaveText("Draft 4°");
  await shot(page, "edit-extrude");
  // Undo inside the session takes back the last change only.
  await page.getByTestId("undo").click();
  await expect.poll(async () => ((await feature(page, "ext_1"))!.draft as Raw | undefined)?.angle).toBe(2);
  await page.getByTestId("session-cancel").click();
  await expect(page.getByTestId("session-bar")).toHaveCount(0);
  expect(JSON.stringify(await savedDocument(page))).toBe(before);
  await waitForRebuild(page);
  await expectVolume(page, vol(BRACKET));
});

test("shell: faces picked into its field (a click on a picked face takes it out again)", async ({ page }) => {
  await page.getByTestId("tool-shell").click();
  await expect(page.getByTestId("session-title")).toHaveText("Add shell_1");
  // A closed hollow body to start with; its faces field is active, waiting for the faces to open it at.
  await expect(page.getByTestId("prop-faces-pick")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("filter-faces")).toHaveAttribute("aria-pressed", "true");
  await waitForRebuild(page);
  await viewportClick(page, [-20, 10, 6]);
  await expect.poll(async () => ((await feature(page, "shell_1"))!.faces as unknown[]).length).toBe(1);
  await expect(page.getByTestId("prop-faces")).toContainText("planar face normal +Z");
  await viewportClick(page, [-20, 10, 6]);
  await expect.poll(async () => ((await feature(page, "shell_1"))!.faces as unknown[]).length).toBe(0);
  await viewportClick(page, [-20, 10, 6]);
  await expect.poll(async () => ((await feature(page, "shell_1"))!.faces as unknown[]).length).toBe(1);
  await waitForRebuild(page);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  await shot(page, "shell-faces");
  await page.getByTestId("session-ok").click();
  await expect(page.getByTestId("session-bar")).toHaveCount(0);
  // Picking in the view selects again, as usual.
  await expect(page.getByTestId("filter-faces")).toHaveAttribute("aria-pressed", "false");
});

test("a hole's centre dragged on its face; OK keeps it as one undo step", async ({ page }) => {
  await page.getByTestId("feature-hole_1").locator(".feature-row").dblclick();
  await expect(page.getByTestId("session-title")).toHaveText("Edit hole_1");
  await waitForRebuild(page);
  const at = () => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.handlePoint("hole_1:center:0"));
  await expect.poll(at).not.toBeNull();
  const [x, y] = (await at())!;
  // Toward −X on the screen (the iso view): the centre moves along −X on the face.
  const [x0, y0] = await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.project([30, 0, 6]));
  const [x1, y1] = await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.project([10, 0, 6]));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (x1 - x0) / 2, y + (y1 - y0) / 2, { steps: 4 });
  await page.mouse.move(x + (x1 - x0), y + (y1 - y0), { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => ((await feature(page, "hole_1"))!.center as number[])[0]).toBeLessThan(15);
  const moved = (await feature(page, "hole_1"))!.center as number[];
  expect(moved[0]).toBeGreaterThan(5);
  expect(Number.isInteger(moved[0])).toBe(true);
  await waitForRebuild(page);
  await shot(page, "hole-drag");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("session-bar")).toHaveCount(0);
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await feature(page, "hole_1"))!.center).toEqual([30, 0]);
});

test("a linear pattern's count dragged past the last copy", async ({ page }) => {
  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await page.getByTestId("tool-pattern").click();
  await page.getByTestId("tool-linear-pattern").click();
  await expect(page.getByTestId("session-title")).toHaveText("Add pattern_1");
  // Spaced half as much again as the hole is wide: Ø6.6 → 10.
  await expect.poll(async () => (await feature(page, "pattern_1"))?.spacing).toBe(10);
  await waitForRebuild(page);
  await expect(page.getByTestId("handle-label-pattern_1:count")).toHaveText("Count 3");
  await dragHandle(page, "pattern_1:count", -60);
  await expect.poll(async () => (await feature(page, "pattern_1"))!.count as number).not.toBe(3);
  await shot(page, "pattern-count");
  await page.getByTestId("session-ok").click();
  await expect(page.getByTestId("session-bar")).toHaveCount(0);
});

test("smart selection: a top edge's tangency chain on a box with rounded corners, in the view and into a fillet's field", async ({ page }) => {
  await openDocument(page, {
    version: 1,
    units: "mm",
    name: "rounded",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 20 }], constraints: [] },
      { id: "ext_1", op: "extrude", sketch: "s1", distance: 10 },
      { id: "corners", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" }, radius: 4 },
    ],
  });
  // Right-click a long top edge: Select tangency chain picks the whole rounded top boundary.
  const [x, y] = await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.project([0, -10, 10]));
  await page.mouse.click(x, y, { button: "right" });
  await page.getByTestId("ctx-select-tangency").click();
  await expect(page.getByTestId("selection")).toContainText("8 edges");
  await shot(page, "tangency-chain");
  // In a fillet session, one click with tangent propagation on takes the chain too.
  await page.keyboard.press("Escape");
  await page.getByTestId("tool-fillet").click();
  await expect(page.getByTestId("prop-edges-propagate")).toBeChecked();
  await viewportClick(page, [0, -10, 10]);
  await expect(page.getByTestId("session-prompt-text")).toHaveText(/8 picked/);
  await waitForRebuild(page);
  await shot(page, "fillet-chain");
  await page.getByTestId("session-ok").click();
  await waitForRebuild(page);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
});

test("selection-first fillet: the edge picked before the tool goes into it", async ({ page }) => {
  await viewportClick(page, [0, 20, 6]);
  await page.getByTestId("tool-fillet").click();
  await expect(page.getByTestId("session-title")).toHaveText("Add fillet_1");
  await expect(page.getByTestId("session-prompt-text")).toHaveText(/1 picked/);
  // The radius reads the part: a tenth of the 6 mm side beside the edge, rounded down to a round value.
  await expect.poll(async () => (await feature(page, "fillet_1"))?.radius).toBe(0.5);
  await shot(page, "session-panel");
  // Enter in the view is OK.
  await page.locator("body").click({ position: { x: 5, y: 890 } });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("session-bar")).toHaveCount(0);
  expect(await feature(page, "fillet_1")).toBeTruthy();
});

async function openDocument(page: Page, doc: Raw) {
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
}
