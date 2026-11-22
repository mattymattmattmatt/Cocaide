// The Member command in the browser: the Member tool opens it; pick a size,
// click sketch lines in the view (again: out), see the members built live,
// OK keeps them as one step (Esc takes them away). All of a sketch's lines at
// once (those with members left out), a custom place on the line and a turn,
// Sections' + Member, a frame on a plate's top face, and Sketch → Frame
// layout… from an empty part. The kernel is real.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { openApp, savedDocument, viewportClick, waitForRebuild } from "./helpers";

const table = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
const line = (id: string, start: [number, number], end: [number, number]) => ({ id, type: "line", start, end });
const layout = {
  version: 1,
  units: "mm",
  name: "frame",
  profiles: table.profiles,
  features: [
    {
      id: "layout",
      op: "sketch",
      plane: { type: "ref", ref: { datum: "Front" } },
      entities: [line("l1", [0, 0], [1000, 0]), line("l2", [1000, 0], [1000, 600]), line("l3", [1000, 600], [0, 600]), line("l4", [0, 600], [0, 0]), line("l5", [500, 0], [500, 600])],
    },
  ],
};

let problems: string[] = [];
async function open(page: Page, doc: unknown) {
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
}
test.beforeEach(async ({ page }) => {
  problems = await openApp(page);
  await page.evaluate(() => localStorage.removeItem("cocaide.memberCommand.v1"));
});
test.afterEach(() => {
  expect(problems).toEqual([]);
});

const saved = async (page: Page) => (await savedDocument(page)) as Record<string, any>;
const members = async (page: Page) => (await saved(page)).features.filter((f: any) => f.op === "member");
async function memberTool(page: Page) {
  await page.getByText("Weldments", { exact: true }).click();
  await page.getByTestId("tool-member").click();
  const cmd = page.getByTestId("member-cmd");
  await expect(cmd).toBeVisible();
  return cmd;
}

test("the Member tool: a size, lines clicked in the view, built live, OK keeps them", async ({ page }) => {
  await open(page, layout);
  const cmd = await memberTool(page);
  // The size picker: grouped, searchable.
  await cmd.getByTestId("member-cmd-size").click();
  await cmd.getByTestId("member-cmd-size-filter").fill("50x50");
  await cmd.getByTestId("member-cmd-size-part|SHS|SHS 50x50x3").click();
  await expect(cmd.getByTestId("member-cmd-size")).toContainText("SHS 50x50x3");
  // The rectangle's sides, clicked; one clicked again is out, and back.
  for (const p of [[250, 0, 0], [1000, 0, 300], [250, 0, 600], [0, 0, 300]] as [number, number, number][]) await viewportClick(page, p);
  await expect(cmd.getByTestId("member-cmd-picked")).toContainText("l4");
  await viewportClick(page, [250, 0, 0]);
  await viewportClick(page, [250, 0, 0]);
  // Built as they will be: four members, four mitres.
  await expect(cmd.getByTestId("member-cmd-summary")).toContainText("4 members");
  await expect(cmd.getByTestId("member-cmd-summary")).toContainText("4 joints");
  await expect(page.getByTestId("bodies")).toContainText("4");
  await cmd.getByTestId("member-cmd-ok").click();
  await expect(cmd).toHaveCount(0);
  const m = await members(page);
  expect(m.map((x: any) => x.size)).toEqual(["SHS 50x50x3", "SHS 50x50x3", "SHS 50x50x3", "SHS 50x50x3"]);
  expect((await saved(page)).features.filter((f: any) => f.op === "joint").map((j: any) => j.type)).toEqual(["mitre", "mitre", "mitre", "mitre"]);
  // One undo step takes them all away.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await members(page)).length).toBe(0);
});

test("all of a sketch's lines, butted with the posts through; then Esc takes a group away", async ({ page }) => {
  await open(page, layout);
  const cmd = await memberTool(page);
  await cmd.getByTestId("member-cmd-all").selectOption("layout");
  await cmd.getByTestId("member-cmd-corners-butt").click();
  await expect(cmd.getByTestId("member-cmd-through-posts")).toHaveAttribute("aria-pressed", "true");
  await expect(cmd.getByTestId("member-cmd-summary")).toContainText("5 members");
  await cmd.getByTestId("member-cmd-ok").click();
  await expect.poll(async () => (await members(page)).length).toBe(5);
  // Again: every line has a member, so it says so and OK waits.
  const again = await memberTool(page);
  await again.getByTestId("member-cmd-all").selectOption("layout");
  await expect(again.getByTestId("member-cmd-summary")).toContainText("every line picked has a member on it already");
  await expect(again.getByTestId("member-cmd-ok")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(again).toHaveCount(0);
  expect(await members(page)).toHaveLength(5);
});

test("a custom place on the line and a turn; the pin keeps it open for the next group", async ({ page }) => {
  await open(page, layout);
  const cmd = await memberTool(page);
  await cmd.getByTestId("member-cmd-pin").click();
  await cmd.getByTestId("member-cmd-place-custom").click();
  await cmd.getByTestId("member-cmd-align--1_1").click();
  await cmd.getByTestId("member-cmd-rot-90").click();
  await viewportClick(page, [250, 0, 0]);
  await expect(cmd.getByTestId("member-cmd-summary")).toContainText("1 member");
  await cmd.getByTestId("member-cmd-ok").click();
  await expect.poll(async () => (await members(page)).length).toBe(1);
  const m = (await members(page))[0];
  expect(m.align).toEqual([-1, 1]);
  expect(m.rotation).toBe(90);
  // Still open, nothing picked, the same settings.
  await expect(cmd).toBeVisible();
  await expect(cmd.getByTestId("member-cmd-picked")).toContainText("Click sketch lines");
  await expect(cmd.getByTestId("member-cmd-rot-90")).toHaveAttribute("aria-pressed", "true");
});

test("Sections' + Member opens the command with that size", async ({ page }) => {
  await open(page, layout);
  await page.getByTestId("tab-sections").click();
  await page.getByTestId("sections-search").fill("50x50x3");
  const add = page.locator('[data-testid^="section-add-"]').first();
  const name = String(await add.getAttribute("data-testid")).replace("section-add-", "");
  await add.click();
  const cmd = page.getByTestId("member-cmd");
  await expect(cmd.getByTestId("member-cmd-size")).toContainText(name);
  // The part has sketch lines: the command waits for them.
  await expect(cmd.getByTestId("member-cmd-source-lines")).toHaveAttribute("aria-checked", "true");
  await viewportClick(page, [250, 0, 0]);
  await cmd.getByTestId("member-cmd-ok").click();
  await expect.poll(async () => (await members(page)).map((m: any) => m.size)).toEqual([name]);
});

test("a frame on a sketch on a plate's top face stands on the plate", async ({ page }) => {
  await open(page, {
    version: 1,
    units: "mm",
    name: "base",
    profiles: table.profiles,
    features: [
      { id: "plate_sk", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 1200, h: 800 }] },
      { id: "plate", op: "extrude", sketch: "plate_sk", distance: 10, direction: [0, 0, 1] },
      { id: "top_layout", op: "sketch", plane: { type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } }, entities: [line("t1", [-500, -300], [500, -300]), line("t2", [500, -300], [500, 300]), line("t3", [500, 300], [-500, 300]), line("t4", [-500, 300], [-500, -300])] },
    ],
  });
  const cmd = await memberTool(page);
  await cmd.getByTestId("member-cmd-all").selectOption("top_layout");
  await expect(cmd.getByTestId("member-cmd-summary")).toContainText("4 members");
  await cmd.getByTestId("member-cmd-ok").click();
  await expect.poll(async () => (await members(page)).length).toBe(4);
  await expect(page.getByTestId("bodies")).toContainText("5");
});

test("from an empty part: Sketch → Frame layout…, a box, its lines picked in the Member command", async ({ page }) => {
  await open(page, { version: 1, units: "mm", name: "stand", profiles: table.profiles, features: [] });
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("sketch-frame-layout").click();
  const dlg = page.getByTestId("frame-layout");
  await dlg.getByTestId("layout-kind-box").click();
  await dlg.getByTestId("layout-width").fill("1200");
  await dlg.getByTestId("layout-depth").fill("600");
  await dlg.getByTestId("layout-height").fill("750");
  await dlg.getByTestId("layout-add").click();
  const cmd = page.getByTestId("member-cmd");
  await expect(cmd.getByTestId("member-cmd-summary")).toContainText("12 members");
  expect((await saved(page)).parameters).toMatchObject({ frame_w: 1200, frame_d: 600, frame_h: 750 });
  await cmd.getByTestId("member-cmd-ok").click();
  await expect.poll(async () => (await members(page)).length).toBe(12);
  const d = await saved(page);
  expect(d.features.filter((f: any) => f.op === "joint").every((j: any) => String(j.through).startsWith("post"))).toBe(true);
  await expect(page.getByTestId("bodies")).toContainText("12");
});

test("a long pick folds to a row per sketch: opened, a line comes out; the row's × takes the sketch's lines out", async ({ page }) => {
  await open(page, { version: 1, units: "mm", name: "wall", profiles: table.profiles, features: [] });
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("sketch-frame-layout").click();
  const dlg = page.getByTestId("frame-layout");
  await dlg.getByTestId("layout-posts").fill("10");
  await dlg.getByTestId("layout-add").click();
  const cmd = page.getByTestId("member-cmd");
  await expect(cmd.getByTestId("member-cmd-summary")).toContainText("14 members");
  // 14 lines: one row, the sketch and its count, no chips.
  const folded = cmd.locator(".mc-chips-folded");
  await expect(folded).toHaveCount(1);
  await expect(folded).toContainText("14 lines");
  await expect(cmd.locator(".mc-chip")).toHaveCount(0);
  await folded.locator(".mc-fold").click();
  await expect(cmd.locator(".mc-chip")).toHaveCount(14);
  await cmd.locator(".mc-chip").first().getByRole("button").click();
  await expect(cmd.getByTestId("member-cmd-summary")).toContainText("13 members");
  // Folded again, its × clears it.
  await cmd.locator(".mc-chips .mc-fold").click();
  await cmd.locator(".mc-fold-x").click();
  await expect(cmd.getByTestId("member-cmd-picked")).toContainText("Click sketch lines");
});

test("a stringer's ends cut in its properties: the foot on Top, the head on a plane, a gap; back to square", async ({ page }) => {
  await open(page, {
    version: 1, units: "mm", name: "stringer", profiles: table.profiles,
    features: [
      { id: "head", op: "plane", mode: "parallelThroughPoint", refs: [{ datum: "Right" }, { point: [1000, 0, 0] }] },
      { id: "stringer", op: "member", profile: "SHS", size: "SHS 40x40x3", from: [0, 0, 0], to: [1000, 0, 700] },
    ],
  });
  await page.getByTestId("feature-stringer").locator(".feature-row").click();
  await page.getByTestId("prop-cutStart").selectOption("Top");
  await expect.poll(async () => (await saved(page)).features[1].cutStart).toEqual({ to: { datum: "Top" } });
  await page.getByTestId("prop-cutEnd").selectOption("head");
  await expect.poll(async () => (await saved(page)).features[1].cutEnd).toEqual({ to: { datum: "head" } });
  await waitForRebuild(page);
  // Both ends cut at the slope: 35° and 55° from square in the measurement.
  await expect(page.getByTestId("prop-member-measured")).toContainText("55° / 35°");
  await page.getByTestId("prop-cutStart-offset").fill("10");
  await page.getByTestId("prop-cutStart-offset").press("Enter");
  await expect.poll(async () => (await saved(page)).features[1].cutStart).toEqual({ to: { datum: "Top" }, offset: 10 });
  await page.getByTestId("prop-cutEnd").selectOption("");
  await expect.poll(async () => (await saved(page)).features[1].cutEnd).toBeUndefined();
});

test("Weldments → Stair: the numbers as it is set up, a warning for a short opening, an L stair added in one step", async ({ page }) => {
  await open(page, { version: 1, units: "mm", name: "stair", features: [] });
  await page.getByText("Weldments", { exact: true }).click();
  await page.getByTestId("tool-stair").click();
  const dlg = page.getByTestId("stair-dialog");
  await dlg.getByTestId("stair-rise").fill("3079");
  await expect(dlg.getByTestId("stair-summary")).toContainText("17 risers of 181.1 · 16 treads of 260 · 2R + G 622");
  await dlg.getByTestId("stair-opening").fill("1500");
  await expect(dlg.getByTestId("stair-warnings")).toContainText("headroom is");
  await dlg.getByTestId("stair-opening").fill("3800");
  await expect(dlg.getByTestId("stair-warnings")).toHaveCount(0);
  await dlg.getByTestId("stair-type-L").click();
  await dlg.getByTestId("stair-turn").selectOption("left");
  await dlg.getByTestId("stair-add").click();
  await expect(dlg).toHaveCount(0);
  await waitForRebuild(page);
  const d = await saved(page);
  const ids = d.features.map((f: any) => f.id);
  expect(ids).toEqual(expect.arrayContaining(["stair_f1_stringer_left", "stair_f2_stringer_right", "stair_landing"]));
  expect(d.features.find((f: any) => f.id === "stair_f1_stringer_left").cutStart).toEqual({ to: { datum: "stair_f1_foot_plane" } });
  await expect(page.getByTestId("notice")).toContainText("Stair: 17 risers of 181.1");
  await expect(page.getByTestId("status")).toContainText("Rebuilt");
});

test("Weldments → Wall frame: counts as it is set up, a warning for an opening at the end, the frame added in one step", async ({ page }) => {
  await open(page, { version: 1, units: "mm", name: "wall", features: [] });
  await page.getByText("Weldments", { exact: true }).click();
  await page.getByTestId("tool-wall-frame").click();
  const dlg = page.getByTestId("wall-dialog");
  await expect(dlg.getByTestId("wall-summary")).toContainText("members");
  await expect(dlg.getByTestId("wall-warnings")).toHaveCount(0);
  await dlg.getByTestId("wall-opening-0-at").fill("20");
  await expect(dlg.getByTestId("wall-warnings")).toBeVisible();
  await dlg.getByTestId("wall-opening-0-at").fill("900");
  await expect(dlg.getByTestId("wall-warnings")).toHaveCount(0);
  await dlg.getByTestId("wall-add").click();
  await expect(dlg).toHaveCount(0);
  await waitForRebuild(page);
  const d = await saved(page);
  const ids = d.features.map((f: any) => f.id);
  expect(ids).toEqual(expect.arrayContaining(["wall_frame", "wall_lintel_w1_a", "wall_sill_w1", "wall_lining_in"]));
  await expect(page.getByTestId("notice")).toContainText("Wall frame wall:");
  await expect(page.getByTestId("status")).toContainText("Rebuilt");
});
