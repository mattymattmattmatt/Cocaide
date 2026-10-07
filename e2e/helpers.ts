import { expect, type Page } from "@playwright/test";
import type { Vec3 } from "../src/doc/types";

/** Opens the app with the automation hook on, from a clean browser profile. */
export async function openApp(page: Page): Promise<string[]> {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  await page.goto("/?e2e");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/?e2e");
  await waitForRebuild(page);
  return problems;
}

export async function waitForRebuild(page: Page) {
  await expect(page.getByTestId("status")).toHaveText(/^(Rebuilt|\d+ errors?|No solid yet)/, { timeout: 60_000 });
}

export async function expectVolume(page: Page, prefix: string) {
  await expect(page.getByTestId("volume")).toHaveText(new RegExp(`^${prefix.replace(/[.,]/g, "\\$&")}`));
}

/** Clicks a point given in sketch-plane millimetres. */
export async function sketchClick(page: Page, x: number, y: number) {
  const [px, py] = await page.evaluate(
    ([x, y]) => {
      const g = document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement;
      const m = g.getScreenCTM()!;
      return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    },
    [x, y],
  );
  await page.mouse.click(px, py);
}

/** Clicks the 3D viewport where a world point appears. */
export async function viewportClick(page: Page, p: Vec3, opts: { shift?: boolean } = {}) {
  const [x, y] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), p);
  await page.mouse.move(x, y);
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.click(x, y);
  if (opts.shift) await page.keyboard.up("Shift");
}

/** Types into a field that commits on Enter. */
export async function commit(page: Page, testId: string, value: string) {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
}

/** The working document the app keeps in local storage. */
export async function savedDocument(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(JSON.parse(localStorage.getItem("cocaide.document.v1")!).text));
}
