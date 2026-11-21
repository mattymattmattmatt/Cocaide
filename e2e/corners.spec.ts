// A frame's corners in the browser: markers where members meet; a click opens
// the Corner panel: mitre, butt or none, the arrangement order (the first runs
// through), C to cycle, each change one undo step. The kernel is real.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { openApp, savedDocument, waitForRebuild } from "./helpers";

const table = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
const line = (id: string, start: [number, number], end: [number, number]) => ({ id, type: "line", start, end });

let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = await openApp(page);
  await page.evaluate(() => localStorage.removeItem("cocaide.memberCommand.v1"));
  const doc = {
    version: 1,
    units: "mm",
    name: "frame",
    profiles: table.profiles,
    features: [{ id: "layout", op: "sketch", plane: { type: "ref", ref: { datum: "Front" } }, entities: [line("l1", [0, 0], [1000, 0]), line("l2", [1000, 0], [1000, 600]), line("l3", [1000, 600], [0, 600]), line("l4", [0, 600], [0, 0])] }],
  };
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
  // The rectangle's members, butted with the posts through.
  await page.getByText("Weldments", { exact: true }).click();
  await page.getByTestId("tool-member").click();
  const cmd = page.getByTestId("member-cmd");
  await cmd.getByTestId("member-cmd-all").selectOption("layout");
  await cmd.getByTestId("member-cmd-corners-butt").click();
  await expect(cmd.getByTestId("member-cmd-summary")).toContainText("4 joints");
  await cmd.getByTestId("member-cmd-ok").click();
  await expect(cmd).toHaveCount(0);
});
test.afterEach(() => {
  expect(problems).toEqual([]);
});

const saved = async (page: Page) => (await savedDocument(page)) as Record<string, any>;
const joints = async (page: Page) => (await saved(page)).features.filter((f: any) => f.op === "joint");
async function clickCorner(page: Page, p: [number, number, number]) {
  // The view may still be gliding to frame the new members: wait until the corner stays put on screen.
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p).map(Math.round), p));
      const still = now === last;
      last = now;
      return still;
    }, { intervals: [250] })
    .toBe(true);
  const [x, y] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), p);
  await page.mouse.move(x, y);
  await expect(page.getByTestId("corner-tip")).toBeVisible();
  await page.mouse.click(x, y);
}

test("click a corner: its type, its arrangement, C to cycle, None and back", async ({ page }) => {
  // The bottom left corner: rail_1 (bottom) and post_2 (left) meet; the post runs through.
  await clickCorner(page, [0, 0, 0]);
  const panel = page.getByTestId("corner-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("corner-type-butt")).toHaveAttribute("aria-checked", "true");
  const first = panel.locator("li").first();
  await expect(first).toContainText("runs through");
  const through = (await first.locator(".mono").textContent())!;
  expect(through).toMatch(/^post_/);
  // The rail to the top of the order: now it runs through, the post trimmed to it.
  const rail = (await panel.locator("li").nth(1).locator(".mono").textContent())!;
  await panel.getByTestId(`corner-up-${rail}`).click();
  await expect.poll(async () => (await joints(page)).find((j: any) => j.through === rail)).toBeTruthy();
  // Mitre.
  await panel.getByTestId("corner-type-mitre").click();
  await expect.poll(async () => (await joints(page)).filter((j: any) => j.type === "mitre").length).toBe(1);
  // C: the next arrangement (butt, one through).
  await page.keyboard.press("c");
  await expect.poll(async () => (await joints(page)).filter((j: any) => j.type === "mitre").length).toBe(0);
  // None: the joint goes; the panel stays, to join it again.
  await page.getByTestId("corner-type-none").click();
  await expect.poll(async () => (await joints(page)).length).toBe(3);
  await expect(page.getByTestId("corner-panel")).toContainText("No joint here");
  await page.getByTestId("corner-type-mitre").click();
  await expect.poll(async () => (await joints(page)).length).toBe(4);
  // Every change was one undo step: undo brings the corner's joint back off again.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await joints(page)).length).toBe(3);
});
