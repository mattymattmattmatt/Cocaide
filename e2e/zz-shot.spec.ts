import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

test("shot", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  await page.screenshot({ path: `${process.env.SHOTS_DIR}/toolbar.png`, clip: { x: 0, y: 0, width: 1500, height: 160 } });
  const widths = await page.evaluate(() => [...document.querySelector(".sketch-toolbar")!.children].map((c) => `${(c as HTMLElement).dataset.testid ?? c.className}:${Math.round(c.getBoundingClientRect().width)}:${Math.round(c.getBoundingClientRect().top)}`));
  console.log(widths.join(" "));
});
