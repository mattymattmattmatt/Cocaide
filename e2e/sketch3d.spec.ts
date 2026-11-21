// The 3D sketch in the browser: start one from the Weldments tab, click
// points in the view (each measured from the last), Tab to a vertical work
// plane, Esc to end the line, type an exact offset, OK; then put members on
// a 3D sketch's lines from Members from sketch. The kernel is real.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { commit, openApp, savedDocument, waitForRebuild } from "./helpers";

let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = await openApp(page);
});
test.afterEach(() => {
  expect(problems).toEqual([]);
});

const saved = async (page: Page) => (await savedDocument(page)) as Record<string, any>;
const sketch3d = async (page: Page) => (await saved(page)).features.find((f: any) => f.op === "sketch3d");

async function clickAt(page: Page, fx: number, fy: number) {
  const box = (await page.locator("canvas").first().boundingBox())!;
  const [x, y] = [box.x + box.width * fx, box.y + box.height * fy];
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

test("draw a 3D sketch: points from the last, Tab to a vertical plane, an exact offset typed", async ({ page }) => {
  await page.getByText("Weldments", { exact: true }).click();
  await page.getByTestId("tool-sketch3d").click();
  const editor = page.getByTestId("sketch3d-editor");
  await expect(editor.getByTestId("sketch3d-draw")).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByTestId("sketch3d-plane-XY")).toHaveAttribute("aria-checked", "true");
  // Three clicks on the ground plane: a point, then two lines.
  await clickAt(page, 0.5, 0.6);
  await clickAt(page, 0.65, 0.6);
  await clickAt(page, 0.65, 0.4);
  await expect(page.getByTestId("draw3d-tip")).toContainText("XY plane");
  // Tab: the vertical XZ plane through the last point; one more click goes up.
  await page.keyboard.press("Tab");
  await expect(editor.getByTestId("sketch3d-plane-XZ")).toHaveAttribute("aria-checked", "true");
  await clickAt(page, 0.6, 0.25);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sketch3d(page))?.lines?.length).toBe(3);
  const f = await sketch3d(page);
  expect(f.points.map((p: any) => p.from ?? "at")).toEqual(["at", "p1", "p2", "p3"]);
  // On the ground the heights don't change; on XZ the y doesn't.
  expect(f.points[1].by[2]).toBe(0);
  expect(f.points[2].by[2]).toBe(0);
  expect(f.points[3].by[1]).toBe(0);
  expect(f.points[3].by[2]).not.toBe(0);
  // An exact offset: p2 is 50 along x from p1; p3, measured from p2, moves with it.
  await commit(page, "sketch3d-p2-x", "50");
  await commit(page, "sketch3d-p2-y", "0");
  await expect.poll(async () => (await sketch3d(page)).points[1].by).toEqual([50, 0, 0]);
  await expect(editor.getByTestId("sketch3d-line-l1")).toContainText("50 mm");
  // OK keeps it: a 3D Sketch in the tree.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("feature-sketch3d_1")).toBeVisible();
});

test("members on a 3D sketch's lines: a pitched portal frame, mitred at the knees and the ridge", async ({ page }) => {
  const table = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
  const doc = {
    version: 1,
    units: "mm",
    name: "portal",
    profiles: table.profiles,
    features: [
      {
        id: "frame3d",
        op: "sketch3d",
        points: [
          { id: "p1", at: [0, 0, 0] },
          { id: "p2", from: "p1", by: [0, 0, 1500] },
          { id: "p3", from: "p2", by: [1000, 0, 300] },
          { id: "p4", from: "p3", by: [1000, 0, -300] },
          { id: "p5", from: "p4", by: [0, 0, -1500] },
        ],
        lines: [
          { id: "l1", start: "p1", end: "p2" },
          { id: "l2", start: "p2", end: "p3" },
          { id: "l3", start: "p3", end: "p4" },
          { id: "l4", start: "p4", end: "p5" },
        ],
      },
    ],
  };
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
  const panel = page.getByTestId("sketch-members");
  await panel.getByTestId("sketch-members-all").selectOption("frame3d");
  await expect(panel.getByTestId("sketch-members-picked")).toContainText("4 lines");
  await panel.getByTestId("sketch-members-add").click();
  await expect.poll(async () => (await saved(page)).features.filter((f: any) => f.op === "member").length).toBe(4);
  const d = await saved(page);
  expect(d.features.filter((f: any) => f.op === "joint").map((j: any) => j.type)).toEqual(["mitre", "mitre", "mitre"]);
  expect(Object.values(d.nodes).map((n: any) => n.point)).toEqual(["p1.at", "p2.at", "p3.at", "p4.at", "p5.at"]);
  await expect(page.getByTestId("bodies")).toContainText("4");
});
