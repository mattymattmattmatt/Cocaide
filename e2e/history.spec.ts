// Phase P wave 3A: a deep, forgiving history. A reference that moves after an
// upstream edit is re-found (a warning to accept); one that cannot be re-found
// is fixed from What's wrong by re-picking it in the view; the tree refuses a
// move above what a feature uses, groups features in folders, copies a hole
// onto another face and renames in place; a field's value becomes a parameter
// that drives two features, managed in the parameters manager.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, okFeature, openApp, savedDocument, viewportClick, waitForRebuild } from "./helpers";

type Raw = Record<string, unknown>;

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

async function openDocument(page: Page, doc: Raw) {
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
}

const shot = (page: Page, name: string) => page.screenshot({ path: `out/e2e-shots/history-${name}.png` });
const feature = async (page: Page, id: string) => ((await savedDocument(page)).features as Raw[]).find((f) => f.id === id);
const row = (page: Page, id: string) => page.getByTestId(`feature-${id}`).locator(".feature-row");

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const topFace = { type: "planar", normal: [0, 0, 1], pick: "largest" };

/** An 80 x 40 x 10 block whose width is the parameter w. */
const block = (...more: Raw[]): Raw => ({
  version: 1,
  units: "mm",
  name: "history",
  parameters: { w: 80 },
  features: [
    { id: "sketch_1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w: "=w", h: 40 }] },
    { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: 10 },
    ...more,
  ],
});

test("a fillet whose edge moves when the block gets wider: re-found with a warning, accepted from What's wrong", async ({ page }) => {
  // The front top edge, picked when the block was 80 long: its length told it apart, and its hint says where it was.
  const edges = { type: "edge", kind: "line", length: 80, between: [topFace, { type: "planar", normal: [0, -1, 0], pick: "largest" }], pick: "all", createdBy: "ext_1", hint: { centroid: [0, -20, 10], normal: [1, 0, 0], size: 80 } };
  await openDocument(page, block({ id: "fillet_1", op: "fillet", edges, radius: 2 }));
  await expect(page.getByTestId("whats-wrong-badge")).toHaveText("All good");
  await commit(page, "param-value-w", "100");
  await waitForRebuild(page);
  await expect(page.getByTestId("whats-wrong-badge")).toHaveText("1 warning");
  await expect(page.getByTestId("feature-fillet_1")).toHaveAttribute("data-state", "warning");
  await page.getByTestId("whats-wrong-badge").click();
  await expect(page.getByTestId("problem-message-0")).toHaveText("an edge moved — re-found it (check)");
  await page.getByTestId("problem-0").locator(".problem-main").click();
  // Where it was: a ring in the view.
  await expect(page.getByTestId("ghost-label-0")).toHaveText("The edge was here");
  await shot(page, "whats-wrong-warning");
  await page.getByTestId("fix-accept-0").click();
  await waitForRebuild(page);
  await expect(page.getByTestId("whats-wrong-badge")).toHaveText("All good");
  await expect(page.getByTestId("whats-wrong-clean")).toBeVisible();
  const healed = (await feature(page, "fillet_1"))!.edges as Raw;
  expect(healed.length).toBeUndefined();
  expect(healed.hint).toMatchObject({ centroid: [0, -20, 10], size: 100 });
});

test("an edge that cannot be re-found: What's wrong lists it, Re-pick opens the fillet with its edges active, a click fixes it", async ({ page }) => {
  const hole = (id: string, x: number): Raw => ({ id, op: "hole", face: topFace, center: [x, 0], diameter: 6.6, depth: "through" });
  const edges = { type: "edge", kind: "circle", radius: 3.3, onFace: topFace, pick: "all", createdBy: "hole_2", hint: { centroid: [-30, 0, 10], normal: [0, 0, 1], size: 20.7345 } };
  await openDocument(page, block(hole("hole_1", 30), hole("hole_2", -30), { id: "fillet_1", op: "fillet", edges, radius: 1 }));
  await expect(page.getByTestId("whats-wrong-badge")).toHaveText("All good");
  // The hole the fillet rounds is deleted: its edge is gone, and the other hole's is too far to be it.
  await row(page, "hole_2").click();
  await page.getByLabel("Delete hole_2").click();
  await waitForRebuild(page);
  await expect(page.getByTestId("whats-wrong-badge")).toHaveText("1 error");
  await expect(page.getByTestId("feature-fillet_1")).toHaveAttribute("data-state", "error");
  await page.getByTestId("whats-wrong-badge").click();
  await expect(page.getByTestId("problem-0")).toHaveAttribute("data-feature", "fillet_1");
  await expect(page.getByTestId("problem-message-0")).toContainText("re-pick it");
  for (const fix of ["repick", "edit", "suppress", "rollback", "delete"]) await expect(page.getByTestId(`fix-${fix}-0`)).toBeVisible();
  await shot(page, "whats-wrong-error");
  await page.getByTestId("fix-repick-0").click();
  await expect(page.getByTestId("session-title")).toHaveText("Edit fillet_1");
  await expect(page.getByTestId("prop-edges-pick")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("ghost-label-0")).toHaveText("The edge was here");
  // The other hole's top edge, clicked in the view, takes the broken one's place.
  await viewportClick(page, [33.3, 0, 10]);
  await expect.poll(async () => JSON.stringify((await feature(page, "fillet_1"))!.edges)).toContain('"createdBy":"hole_1"');
  await waitForRebuild(page);
  await okFeature(page);
  await waitForRebuild(page);
  await expect(page.getByTestId("whats-wrong-badge")).toHaveText("All good");
  await expect(page.getByTestId("feature-fillet_1")).toHaveAttribute("data-state", "ok");
});

/** A plate with a boss on it and a hole in the plate. */
const plate = (): Raw =>
  block(
    { id: "sketch_2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] }, entities: [{ id: "c1", type: "circle", center: [-20, 0], radius: 10 }] },
    { id: "ext_2", op: "extrude", sketch: "sketch_2", distance: 8 },
    { id: "hole_1", op: "hole", face: topFace, center: [25, 0], diameter: 6.6, depth: "through" },
  );

/** Drags a tree row onto another (its upper or lower half), checking what the tree says while it is over it. */
async function dragRow(page: Page, from: string, to: string, half: "upper" | "lower", whileOver?: () => Promise<void>) {
  const a = await page.getByTestId(`feature-${from}`).boundingBox();
  const b = await page.getByTestId(`feature-${to}`).locator(".feature-row-wrap").boundingBox();
  await page.mouse.move(a!.x + 40, a!.y + 8);
  await page.mouse.down();
  await page.mouse.move(b!.x + 40, b!.y + (half === "upper" ? 3 : b!.height - 3), { steps: 8 });
  await page.mouse.move(b!.x + 44, b!.y + (half === "upper" ? 4 : b!.height - 4), { steps: 2 });
  if (whileOver) await whileOver();
  await page.mouse.up();
}

test("the tree: a move above what a feature uses is refused with the reason; a legal one goes; a folder suppressed; rename in place", async ({ page }) => {
  await openDocument(page, plate());
  const order = async () => ((await savedDocument(page)).features as Raw[]).map((f) => f.id);
  // The extrude dragged above its own sketch: the line turns red and says why; the drop is refused.
  await dragRow(page, "ext_1", "sketch_1", "upper", async () => {
    await expect(page.getByTestId("drop-reason")).toHaveText("ext_1 uses sketch_1, which would come after it");
  });
  expect(await order()).toEqual(["sketch_1", "ext_1", "sketch_2", "ext_2", "hole_1"]);
  // A legal one: the hole up above the boss and its sketch.
  await dragRow(page, "hole_1", "sketch_2", "upper");
  await expect.poll(order).toEqual(["sketch_1", "ext_1", "hole_1", "sketch_2", "ext_2"]);
  // Move to end, from its menu.
  await row(page, "hole_1").click({ button: "right" });
  await page.getByTestId("ctx-move-end").click();
  await expect.poll(order).toEqual(["sketch_1", "ext_1", "sketch_2", "ext_2", "hole_1"]);

  // A folder of the boss and its sketch, named in place, then suppressed as one.
  await row(page, "sketch_2").click();
  await row(page, "ext_2").click({ modifiers: ["Shift"] });
  await row(page, "ext_2").click({ button: "right" });
  await expect(page.getByTestId("ctx-new-folder")).toHaveText("New folder from 2 features");
  await page.getByTestId("ctx-new-folder").click();
  await commit(page, "folder-rename-folder_1", "Boss");
  await expect(page.getByTestId("folder-folder_1")).toContainText("Boss");
  expect((await savedDocument(page)).folders).toEqual([{ id: "folder_1", name: "Boss", features: ["sketch_2", "ext_2"] }]);
  const before = Number((await page.getByTestId("volume").textContent())!.replace(/[^\d.]/g, ""));
  await page.getByTestId("folder-folder_1").hover();
  await page.getByTestId("folder-suppress-folder_1").click();
  await waitForRebuild(page);
  await expect(page.getByTestId("feature-ext_2")).toHaveAttribute("data-state", "suppressed");
  await expect.poll(async () => Number((await page.getByTestId("volume").textContent())!.replace(/[^\d.]/g, ""))).toBeLessThan(before);
  await page.getByTestId("folder-suppress-folder_1").click();
  await waitForRebuild(page);
  await expect(page.getByTestId("feature-ext_2")).toHaveAttribute("data-state", "ok");

  // The filter finds by type; then the tree with its folder.
  await page.getByTestId("tree-filter").fill("type:hole");
  await expect(page.getByTestId("tree-filter-count")).toHaveText("1 of 5");
  await page.getByTestId("tree-filter").fill("");
  await page.getByTestId("feature-hole_1").hover();
  await shot(page, "tree");

  // F2 renames in place; what used it follows.
  await row(page, "ext_2").click();
  await page.keyboard.press("F2");
  await commit(page, "rename-ext_2", "boss");
  await expect(page.getByTestId("feature-boss")).toBeVisible();
  expect((await savedDocument(page)).folders).toEqual([{ id: "folder_1", name: "Boss", features: ["sketch_2", "boss"] }]);
});

test("copy a hole onto another face: Ctrl+C in the tree, click the boss's top, Paste", async ({ page }) => {
  await openDocument(page, plate());
  await expectVolume(page, "");
  const before = Number((await page.getByTestId("volume").textContent())!.replace(/[^\d.]/g, ""));
  await row(page, "hole_1").click();
  await page.keyboard.press("Control+c");
  await expect(page.getByTestId("notice")).toContainText("Copied hole_1");
  await viewportClick(page, [-20, 3, 18]);
  await row(page, "hole_1").click({ button: "right" });
  await page.getByTestId("ctx-paste").click();
  await waitForRebuild(page);
  await expect(page.getByTestId("feature-hole_2")).toBeVisible();
  const pasted = (await feature(page, "hole_2"))!;
  expect((pasted.face as Raw).normal).toEqual([0, 0, 1]);
  expect(pasted.center).toEqual([expect.closeTo(-20, 2), expect.closeTo(3, 2)]);
  await expect(page.getByTestId("whats-wrong-badge")).toHaveText("All good");
  // The copy went through the boss: π·3.3²·18 less.
  await expect.poll(async () => before - Number((await page.getByTestId("volume").textContent())!.replace(/[^\d.]/g, ""))).toBeCloseTo(Math.PI * 3.3 * 3.3 * 18, 0);
});

test("a field's value becomes a parameter that drives two features; the parameters manager shows where it is used", async ({ page }) => {
  await openDocument(page, plate());
  await row(page, "ext_1").dblclick();
  await page.getByTestId("prop-distance").click({ button: "right" });
  await page.getByTestId("ctx-create-parameter").click();
  await commit(page, "name-parameter-input", "plate_t");
  await expect(page.getByTestId("prop-distance")).toHaveValue("=plate_t");
  await okFeature(page);
  await row(page, "ext_2").dblclick();
  await page.getByTestId("prop-distance").click({ button: "right" });
  await page.getByTestId("ctx-link-parameter-plate_t").click();
  await expect(page.getByTestId("prop-distance")).toHaveValue("=plate_t");
  await okFeature(page);
  expect((await feature(page, "ext_1"))!.distance).toBe("=plate_t");
  expect((await feature(page, "ext_2"))!.distance).toBe("=plate_t");
  await page.getByTestId("param-manager-open").click();
  await expect(page.getByTestId("params-manager")).toBeVisible();
  await expect(page.getByTestId("pm-used-plate_t-ext_1")).toBeVisible();
  await expect(page.getByTestId("pm-used-plate_t-ext_2")).toBeVisible();
  await expect(page.getByTestId("pm-used-w-sketch_1")).toBeVisible();
  // An unused one is flagged.
  await page.getByTestId("pm-add-name").fill("spare");
  await page.getByTestId("pm-add-name").press("Enter");
  await expect(page.getByTestId("pm-add-value")).toBeFocused();
  await commit(page, "pm-add-value", "3");
  await expect(page.getByTestId("pm-unused-spare")).toBeVisible();
  // One change drives both: a 12 mm plate and a 12 mm boss.
  await commit(page, "pm-expr-plate_t", "12");
  await waitForRebuild(page);
  await expect(page.getByTestId("pm-value-plate_t")).toHaveText("12");
  await shot(page, "parameters-manager");
  // Renamed: both features follow.
  await page.getByTestId("pm-rename-plate_t").click();
  await commit(page, "pm-rename-input-plate_t", "thick");
  await expect(page.getByTestId("pm-row-thick")).toBeVisible();
  expect((await feature(page, "ext_2"))!.distance).toBe("=thick");
  await page.getByTestId("pm-used-thick-ext_2").click();
  await expect(page.getByTestId("params-manager")).toHaveCount(0);
  await expect(page.getByTestId("feature-ext_2")).toHaveClass(/selected/);
  // The undo history names the steps; a click goes back to one.
  await page.getByTestId("history-open").click();
  await expect(page.getByTestId("history-list")).toContainText("Rename parameter plate_t to thick");
  await expect(page.getByTestId("history-list")).toContainText("Edit ext_2");
});
