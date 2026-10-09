// Phase H in the browser: a part of two named bodies (examples/stand.cocaide.json),
// a base plate with an upright plate standing on it.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument, scriptModel, text, tool, useKey } from "./helpers";

async function openStand(page: Page) {
  await page.locator("select").first().selectOption("stand (two bodies)");
  await expectVolume(page, "133,143.363");
}

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
  await openStand(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("two named bodies: each measured, coloured, hideable, and exported as named solids", async ({ page }) => {
  const bodies = page.getByTestId("bodies");
  await expect(bodies.locator("li")).toHaveCount(2);
  await expect(page.getByTestId("body-base")).toContainText("base75,543.363 mm³");
  await expect(page.getByTestId("body-upright")).toContainText("upright57,600 mm³");
  await expect(page.getByTestId("interference")).toHaveCount(0);

  // Hide the upright, show it again.
  await page.getByTestId("body-toggle-upright").click();
  await expect(page.getByTestId("body-upright")).toHaveClass(/hidden/);
  await page.getByTestId("body-toggle-upright").click();
  await expect(page.getByTestId("body-upright")).not.toHaveClass(/hidden/);

  // A thicker base pushes into the upright, which still stands at 8: the overlap is reported on the rebuild.
  await page.getByTestId("param-value-base_t").fill("10");
  await page.getByTestId("param-value-base_t").press("Enter");
  await expect(page.getByTestId("interference")).toHaveText("base and upright overlap by 1,920 mm³");
  await page.getByTestId("param-value-base_t").fill("8");
  await page.getByTestId("param-value-base_t").press("Enter");
  await expect(page.getByTestId("interference")).toHaveCount(0);

  // The hole lists the base: the property panel shows which bodies it cuts.
  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await expect(page.getByTestId("prop-bodies-base")).toBeChecked();
  await expect(page.getByTestId("prop-bodies-upright")).not.toBeChecked();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export STEP" }).click();
  const step = readFileSync(await (await download).path(), "utf8");
  for (const name of ["stand", "base", "upright"]) expect(step).toContain(`PRODUCT('${name}','${name}'`);
});

test("combine joins the upright into the base", async ({ page }) => {
  await page.getByTestId("tab-bodies").click();
  await page.getByTestId("tool-combine").click();
  await expect(page.getByTestId("bodies")).toHaveCount(0); // one body left: no list to show
  await expectVolume(page, "133,143.363");
  const doc = await savedDocument(page);
  expect(doc.features).toContainEqual({ id: "combine_1", op: "combine", operation: "add", target: "base", tools: ["upright"] });
});

test("right-click a body: the ask is about that body only, and an edit to the other is rejected", async ({ page }) => {
  await useKey(page);
  const cutBase = { op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest", body: "base" }, center: [0, 30], diameter: 4, depth: 3, bodies: ["base"] };
  const sent = await scriptModel(page, [[tool("addFeature", { feature: cutBase })], [text("The base is outside what a right-click on the upright may change.")]]);
  const before = await savedDocument(page);

  await page.getByTestId("body-upright").click({ button: "right" });
  await page.getByTestId("ctx-ask").click(); // the right-click menu's last entry
  await page.getByTestId("ask-reach-target").click(); // just what was right-clicked: its own scope
  await expect(page.getByTestId("ask-target")).toHaveText("body upright");
  await expect(page.getByTestId("ask-scope")).toHaveText("may change: ext_2, new features on body upright alone");
  await page.getByTestId("ask-input").fill("drill a 4 mm hole in the base");
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-outcome")).toHaveText("Out of scope");
  const results = sent[1].body.messages.at(-1)!.content as { content: string; is_error?: boolean }[];
  expect(results[0].is_error).toBe(true);
  expect(results[0].content).toContain('is outside the scope [ext_2, body:upright]');
  // The packet was the upright: its size, the feature that makes it, and nothing of the base's features.
  const packet = (sent[0].body.messages[0].content as { type: string; text?: string }[]).find((b) => b.type === "text")!.text!;
  expect(packet).toContain('"name": "upright"');
  expect(packet).toContain('"newBody": "upright"');
  expect(packet).not.toContain('"newBody": "base"');
  await page.getByTestId("ask-close").click();
  expect(await savedDocument(page)).toEqual(before);
});
