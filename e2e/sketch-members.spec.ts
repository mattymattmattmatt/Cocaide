// Members from a layout sketch in the browser: pick a size, click the
// sketch's lines in the view (a second click takes one out), add them, and
// the frame is built on nodes that follow the sketch, its corners mitred;
// then all of a sketch's lines at once, the ones with members skipped and the
// post butted. The kernel is real.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { openApp, savedDocument, viewportClick, waitForRebuild } from "./helpers";

const table = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
const line = (id: string, start: [number, number], end: [number, number]) => ({ id, type: "line", start, end });
const doc = {
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
test.beforeEach(async ({ page }) => {
  problems = await openApp(page);
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
});
test.afterEach(() => {
  expect(problems).toEqual([]);
});

const saved = async (page: Page) => (await savedDocument(page)) as Record<string, any>;

test("pick lines in the view, add them: members on nodes that follow the sketch, the corners mitred", async ({ page }) => {
  const panel = page.getByTestId("sketch-members");
  await expect(panel).toBeVisible();
  await panel.getByTestId("sketch-members-pick").click();
  await expect(panel.getByTestId("sketch-members-pick")).toHaveAttribute("aria-pressed", "true");
  // The rectangle's four sides, clicked at their middles (away from the post).
  for (const p of [
    [250, 0, 0],
    [1000, 0, 300],
    [250, 0, 600],
    [0, 0, 300],
  ] as [number, number, number][])
    await viewportClick(page, p);
  await expect(panel.getByTestId("sketch-members-picked")).toContainText("4 lines");
  // Clicked again: out; and again: back in.
  await viewportClick(page, [250, 0, 0]);
  await expect(panel.getByTestId("sketch-members-picked")).toContainText("3 lines");
  await viewportClick(page, [250, 0, 0]);
  await expect(panel.getByTestId("sketch-members-picked")).toContainText("4 lines");
  await panel.getByTestId("sketch-members-add").click();
  await expect.poll(async () => (await saved(page)).features.filter((f: any) => f.op === "member").length).toBe(4);
  const d = await saved(page);
  expect(d.features.filter((f: any) => f.op === "joint").map((j: any) => j.type)).toEqual(["mitre", "mitre", "mitre", "mitre"]);
  expect(Object.values(d.nodes).every((n: any) => n.sketch === "layout")).toBe(true);
  // Picking stopped; the nodes list says what each follows.
  await expect(panel.getByTestId("sketch-members-pick")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("node-link-A")).toContainText("l2.start");

  // All of the sketch's lines: the four with members are skipped, the post goes in and butts at both ends.
  await panel.getByTestId("sketch-members-all").selectOption("layout");
  await expect(panel.getByTestId("sketch-members-picked")).toContainText("5 lines");
  await panel.getByTestId("sketch-members-add").click();
  await expect.poll(async () => (await saved(page)).features.filter((f: any) => f.op === "member").length).toBe(5);
  const after = await saved(page);
  expect(after.features.filter((f: any) => f.op === "joint" && f.type === "butt").map((j: any) => j.through).sort()).toEqual(["rail_1", "rail_2"]); // the bottom (l1) and top (l3) rails
  await expect(page.getByTestId("notice")).toContainText("Skipped");
  // The frame builds: five bodies.
  await expect(page.getByTestId("bodies")).toContainText("5");
});

test("a frame on a sketch on a plate's top face: it stands on the plate", async ({ page }) => {
  const onPlate = {
    version: 1,
    units: "mm",
    name: "base",
    profiles: table.profiles,
    features: [
      { id: "plate_sk", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 1200, h: 800 }] },
      { id: "plate", op: "extrude", sketch: "plate_sk", distance: 10, direction: [0, 0, 1] },
      {
        id: "top_layout",
        op: "sketch",
        plane: { type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } },
        entities: [line("t1", [-500, -300], [500, -300]), line("t2", [500, -300], [500, 300]), line("t3", [500, 300], [-500, 300]), line("t4", [-500, 300], [-500, -300])],
      },
    ],
  };
  const text = JSON.stringify(onPlate, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
  const panel = page.getByTestId("sketch-members");
  await panel.getByTestId("sketch-members-all").selectOption("top_layout");
  await panel.getByTestId("sketch-members-add").click();
  await expect.poll(async () => (await saved(page)).features.filter((f: any) => f.op === "member").length).toBe(4);
  // Plate and four members, and nothing wrong.
  await expect(page.getByTestId("bodies")).toContainText("5");
  await expect(page.getByTestId("node-link-A")).toContainText("t1.start");
  await expect(page.getByTestId("node-link-A")).not.toHaveClass(/broken/);
});
