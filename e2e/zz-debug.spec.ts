import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

test("debug", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const svg = document.querySelector("[data-testid=sketch-canvas]") as SVGSVGElement;
    const c = (svg.querySelector("g") as SVGGElement).getScreenCTM()!;
    const r = svg.getBoundingClientRect();
    return { a: c.a, b: c.b, c: c.c, d: c.d, e: c.e, f: c.f, r: [r.left, r.top, r.width, r.height], t: (svg.querySelector("g") as SVGGElement).getAttribute("transform") };
  });
  console.log(JSON.stringify(info));
});
