// The load bar: a thin bar along the top while a model opened from a link downloads and builds, gone once it's in.
// The kernel is real; the link's file (the engine assembly) is served slowly.

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ENGINE = readFileSync(new URL("../examples/engine.cocaide.json", import.meta.url), "utf8");
const URL_ = "https://files.example.test/engine.cocaide.json";

test("a model opened from a link shows the bar while it downloads and builds, then the bar goes", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.route(URL_, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: ENGINE });
  });
  await page.goto("/?e2e");
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?e2e&open=${encodeURIComponent(URL_)}`);
  const bar = page.getByTestId("load-bar");
  // While the file comes in: the bar, moving (how far can't be told yet), saying what it's doing.
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("aria-label", /Downloading the file|Loading the modelling kernel/);
  // The assembly's parts building: the bar fills, part by part (or the parts are in already), and then it goes.
  await expect(bar).toBeHidden({ timeout: 120_000 });
  await expect(page.getByTestId("notice")).toContainText("Opened engine.cocaide.json");
  expect(problems).toEqual([]);
});
