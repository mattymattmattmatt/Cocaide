// The interface pass: millimetres everywhere and said so, a picture and a name
// on every tool, menus that close, tools that say why they're greyed out,
// sections that fold to what the part uses, and Ctrl+S.

import { expect, test } from "@playwright/test";
import { expectVolume, openApp } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("millimetres are the units, in the top bar, in Settings and on every length field", async ({ page }) => {
  await expect(page.getByTestId("units")).toHaveText("mm");
  await page.getByTestId("ask-settings-open").click();
  await expect(page.getByTestId("settings-units")).toHaveText("Millimetres (mm), metric");
  await page.getByRole("button", { name: "Cancel" }).click();
  // The bracket's hole: its centre and diameter in mm.
  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  for (const id of ["prop-center-x", "prop-diameter"]) {
    const field = page.getByTestId(id).locator("xpath=ancestor::label[contains(@class,'field')]");
    await expect(field.locator(".unit")).toHaveText("mm");
  }
  await expect(page.getByTestId("measurements")).toContainText("80 × 40 × 6 mm");
});

test("every tool has a picture and a name; Pattern and Sketch are menus that close on Escape or a click away", async ({ page }) => {
  const tools = page.getByRole("toolbar", { name: "Modelling" }).locator("button.tool");
  const count = await tools.count();
  expect(count).toBeGreaterThan(14);
  for (let i = 0; i < count; i++) {
    await expect(tools.nth(i).locator(":scope > svg.icon")).toHaveCount(1);
    await expect(tools.nth(i).locator(".tool-label")).not.toHaveText("");
  }
  await page.getByTestId("tool-pattern").click();
  await expect(page.getByRole("menuitem", { name: "Linear pattern" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Linear pattern" })).toHaveCount(0);
  await page.getByTestId("tool-sketch").click();
  await expect(page.getByRole("menuitem", { name: "Top (XY)" })).toBeVisible();
  await page.getByTestId("help").click();
  await expect(page.getByRole("menuitem", { name: "Top (XY)" })).toHaveCount(0);
});

test("the body tools say why they're greyed out; Nodes folds away until the part has nodes", async ({ page }) => {
  await expect(page.getByTestId("tool-combine")).toBeDisabled();
  await expect(page.getByTestId("tool-combine")).toHaveAttribute("title", "Combine needs two or more bodies");
  await expect(page.getByTestId("nodes-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("node-add")).toHaveCount(0);
  await page.locator("select").first().selectOption("table frame (weldment)");
  await expectVolume(page, "3,054,720");
  await expect(page.getByTestId("tool-combine")).toBeEnabled();
  await expect(page.getByTestId("nodes-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("nodes-toggle")).toContainText("8");
  await page.getByTestId("nodes-toggle").click();
  await expect(page.getByTestId("node-A")).toHaveCount(0);
  await page.screenshot({ path: "docs/interface.png" });
});

test("Ctrl+S saves the part", async ({ page }) => {
  await page.getByTestId("feature-ext_1").locator(".feature-row").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  expect(download.suggestedFilename()).toBe("bracket.cocaide.json");
});
