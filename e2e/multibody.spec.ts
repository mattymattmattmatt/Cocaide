// Phase M acceptance in the browser (docs/roadmap.md): mirror a feature and a
// body, move, split and delete bodies from the toolbar and the Bodies panel,
// give a body its own material, save one as a part and open it, and mirror
// half a frame back into the whole, with the cut list to match.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

const bodyNames = (page: Page) => page.getByTestId("bodies").locator("li .body-name").allTextContents();
const pickBody = (page: Page, name: string) => page.getByTestId(`body-${name}`).locator(".body-name").click();

async function cutRows(page: Page): Promise<string[][]> {
  return page.getByTestId("cut-row").evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent ?? "")));
}

test("on the stand: mirror a hole and a body, move, split and delete bodies, a body's material, and a body saved as a part", async ({ page }) => {
  await page.locator("select").first().selectOption("stand (two bodies)");
  await expectVolume(page, "133,143.363");

  // 1. Mirror hole_1 about the XZ plane: three holes in the base.
  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await page.getByTestId("tool-mirror").click();
  await page.getByTestId("prop-mirror-plane-normal").selectOption("+Y");
  await expectVolume(page, "132,515.044");

  // 2. Move the upright 30 mm along Y, then mirror it about the XZ plane.
  await pickBody(page, "upright");
  await page.getByTestId("tool-move").click();
  await page.getByTestId("prop-move-copy").uncheck();
  await commit(page, "prop-move-translate-x", "0");
  await commit(page, "prop-move-translate-y", "30");
  await expectVolume(page, "132,515.044");
  await pickBody(page, "upright");
  await page.getByTestId("tool-mirror").click();
  await page.getByTestId("prop-mirror-plane-normal").selectOption("+Y");
  await expectVolume(page, "190,115.044");
  await expect.poll(() => bodyNames(page)).toEqual(["base", "upright", "upright_mirror"]);
  await expect(page.getByTestId("interference")).toHaveCount(0);
  await expect(page.getByTestId("feature-mirror_2")).toContainText("upright");

  // 3. Split the base at x = 0, and 4. delete one half from the Bodies panel.
  await pickBody(page, "base");
  await page.getByTestId("tool-split").click();
  await expect.poll(() => bodyNames(page)).toEqual(["base", "upright", "upright_mirror", "base_split"]);
  await expectVolume(page, "190,115.044");
  await page.getByTestId("body-more-base_split").click();
  await page.getByTestId("body-delete-base_split").click();
  await expect.poll(() => bodyNames(page)).toEqual(["base", "upright", "upright_mirror"]);
  await expect(page.getByTestId("feature-delete_1")).toContainText("base_split");

  // 5. The upright in aluminium.
  await page.getByTestId("body-more-upright").click();
  await page.getByTestId("body-material-upright").selectOption({ label: "aluminium 6061 (2700 kg/m³)" });
  await expect(page.getByTestId("body-details-upright")).toContainText("0.156 kg, aluminium 6061");
  await page.screenshot({ path: "docs/phase-m-bodies.png" });
  // "other…" opens the preset to edit: a density of its own. The part's mass is each body's, added up.
  await page.getByTestId("body-material-upright").selectOption({ label: "other…" });
  await expect(page.getByTestId("body-density-upright")).toHaveValue("2700");
  await page.getByTestId("body-density-upright").fill("5400");
  await page.getByTestId("body-density-upright").blur();
  await expect(page.getByTestId("body-details-upright")).toContainText("0.311 kg, aluminium 6061");
  await expect(page.getByTestId("mass")).toHaveAttribute("title", /each body in its own/);
  await page.getByTestId("body-material-upright").selectOption({ label: "aluminium 6061 (2700 kg/m³)" });
  await expect(page.getByTestId("body-details-upright")).toContainText("0.156 kg, aluminium 6061");

  // 6. Saved as a part, the upright opens alone, in aluminium.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("body-save-upright").click()]);
  expect(download.suggestedFilename()).toBe("stand-upright.cocaide.json");
  const path = await download.path();
  const part = JSON.parse(readFileSync(path, "utf8"));
  expect(part).toMatchObject({ name: "upright", material: { name: "aluminium 6061", densityKgPerM3: 2700 } });
  expect(part.features.at(-1)).toEqual({ id: "keep_1", op: "deleteBody", keep: ["upright"] });
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles(path);
  await expectVolume(page, "57,600");
  await expect(page.getByTestId("doc-name")).toHaveValue("upright");
});

test("half the table frame, its legs mirrored, is the whole frame again, with the same cut list", async ({ page }) => {
  await page.locator("select").first().selectOption("table frame (weldment)");
  await expectVolume(page, "3,054,720");
  for (const leg of ["leg_b", "leg_c"]) {
    await page.getByTestId(`feature-${leg}`).locator(".feature-row").click();
    await page.getByTestId("properties").getByRole("button", { name: "Delete" }).click();
  }
  await expect(page.getByTestId("feature-leg_b")).toHaveCount(0);
  await pickBody(page, "leg_a");
  await page.getByTestId("tool-mirror").click();
  await page.getByTestId("prop-mirror-bodies-leg_d").check();
  await commit(page, "prop-mirror-plane-origin-x", "=frame_w / 2");
  await expectVolume(page, "3,054,720");
  await page.getByTestId("tab-cutlist").click();
  await expect.poll(() => cutRows(page)).toEqual([
    ["1", "SHS 40x40x3", "1,200", "45° / 45°", "2", "8.09"],
    ["2", "SHS 40x40x3", "860", "square", "4", "11.99"],
    ["3", "SHS 40x40x3", "600", "45° / 45°", "2", "3.9"],
  ]);
  await expect(page.getByTestId("cut-row").nth(1)).toHaveAttribute("title", "leg_a, leg_d, leg_a_mirror, leg_d_mirror");
});
