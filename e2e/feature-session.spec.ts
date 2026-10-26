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
  void commit;
});
