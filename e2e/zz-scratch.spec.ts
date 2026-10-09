import { test } from "@playwright/test";
import { openApp, sketchClick } from "./helpers";

const SHOTS = "/tmp/claude-0/-home-user-Cocaide/e5e32f9c-9616-5fee-876d-a1f9e07d0fcd/scratchpad/shots";

test("measure sketch toolbar", async ({ page }) => {
  const problems = await openApp(page);
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  const widths = await page.evaluate(() => {
    const bar = document.querySelector(".sketch-toolbar") as HTMLElement;
    const kids = [...bar.children].map((c) => `${(c.querySelector("[data-testid]") as HTMLElement | null)?.dataset.testid ?? (c as HTMLElement).dataset.testid ?? c.className}:${Math.round((c as HTMLElement).getBoundingClientRect().width)}`);
    return { bar: bar.getBoundingClientRect().width, h: bar.getBoundingClientRect().height, scroll: bar.scrollWidth, kids };
  });
  console.log(JSON.stringify(widths));
  await page.getByTestId("tool-rect-flyout").click();
  await page.screenshot({ path: `${SHOTS}/flyout-rect.png` });
  await page.getByTestId("flyout-polygon").count();
  await page.getByTestId("flyout-rect-center").click();
  await sketchClick(page, 0, 0);
  await sketchClick(page, 30, 20);
  await page.getByTestId("tool-polygon").click();
  await sketchClick(page, 60, 0);
  await page.mouse.move(700, 300, { steps: 5 });
  await page.screenshot({ path: `${SHOTS}/polygon-preview.png` });
  await sketchClick(page, 80, 0);
  await page.getByTestId("tool-arc-flyout").click();
  await page.screenshot({ path: `${SHOTS}/after.png` });
  console.log(problems);
});
