import { test } from "@playwright/test";
import { openApp, viewportClick } from "./helpers";

test("debug", async ({ page }) => {
  page.on("console", (m) => m.text().startsWith("DEBUG") && console.log(m.text().slice(0, 1500)));
  const problems = await openApp(page);
  await page.getByTestId("tool-fillet").click();
  await page.waitForTimeout(800);
  console.log("before click notice", (await page.getByTestId("notice").count()) ? await page.getByTestId("notice").innerText() : "(none)");
  const [x, y] = await page.evaluate(() => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project([0, -20, 6]));
  await page.mouse.move(x, y);
  console.log("after move notice", (await page.getByTestId("notice").count()) ? await page.getByTestId("notice").innerText() : "(none)");
  await page.mouse.down();
  console.log("after down notice", (await page.getByTestId("notice").count()) ? await page.getByTestId("notice").innerText() : "(none)");
  await page.mouse.up();
  void viewportClick;
  await page.waitForTimeout(1500);
  for (const id of ["notice", "pick-error", "session-pending", "session-prompt", "prop-edges", "selection"]) {
    const n = await page.getByTestId(id).count();
    console.log(id, n ? await page.getByTestId(id).first().innerText() : "(none)");
  }
  console.log("problems", problems);
  await page.screenshot({ path: "/tmp/claude-0/-home-user-Cocaide/e5e32f9c-9616-5fee-876d-a1f9e07d0fcd/scratchpad/p2b/debug.png" });
});
