import { expect, test, type Page } from "@playwright/test";
import type { Vec2 } from "../src/doc/types";
import { commit, openApp, savedDocument, sketchClick } from "./helpers";

const SHOTS = "out/shots";
let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = await openApp(page);
  await page.getByTestId("new-part").click();
});
test.afterEach(async () => {
  console.log("PROBLEMS", JSON.stringify(problems));
});

async function toScreen(page: Page, [x, y]: Vec2): Promise<[number, number]> {
  return page.evaluate(
    ([x, y]) => {
      const m = (document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement).getScreenCTM()!;
      return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as [number, number];
    },
    [x, y] as Vec2,
  );
}
async function line(page: Page, a: Vec2, b: Vec2) {
  await page.keyboard.press("l");
  await sketchClick(page, ...a);
  await sketchClick(page, ...b);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}
async function state(page: Page, label: string) {
  const s = await page.evaluate(() => ({
    status: document.querySelector("[data-testid=profile-status]")?.textContent,
    sk: document.querySelector("[data-testid=sketch-status]")?.textContent,
    problems: document.querySelector("[data-testid=sketch-problems]")?.textContent,
    message: document.querySelector("[data-testid=sketch-message]")?.textContent ?? document.querySelector(".sketch-message")?.textContent,
    prompt: document.querySelector("[data-testid=tool-prompt]")?.textContent,
    problem: document.querySelector("[data-testid=tool-problem]")?.textContent,
    list: [...document.querySelectorAll("[data-testid=constraint-list] li")].map((x) => x.textContent).join(" | "),
  }));
  console.log(label, JSON.stringify(s));
}

test("explore", async ({ page }) => {
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  // L chain
  await page.keyboard.press("l");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 30, 0);
  await sketchClick(page, 30, 20);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await state(page, "L");
  await page.getByTestId("tool-offset").click();
  await sketchClick(page, 15, 0);
  await commit(page, "tool-option-distance", "4");
  await page.getByTestId("tool-option-both").check();
  await page.getByTestId("tool-option-cap-arcs").click();
  await page.screenshot({ path: `${SHOTS}/offset-preview.png` });
  await state(page, "offset preview");
  await page.getByTestId("tool-apply").click();
  await state(page, "offset applied");
  await page.screenshot({ path: `${SHOTS}/offset-applied.png` });
  // edit the offset dimension
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByTestId("sketch-undo").click();
  await state(page, "undone");

  // chamfer on the L corner
  await page.getByTestId("tool-fillet-flyout").click();
  await page.getByTestId("flyout-chamfer").click();
  await page.screenshot({ path: `${SHOTS}/chamfer-strip.png` });
  await sketchClick(page, 30, 0);
  await page.getByTestId("tool-apply").click();
  await state(page, "chamfered");
  await page.screenshot({ path: `${SHOTS}/chamfer-applied.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // circle crossed by two lines, trim to arc
  await page.keyboard.press("c");
  await sketchClick(page, -30, 0);
  await sketchClick(page, -20, 0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await line(page, [-45, 5], [-15, 5]);
  await line(page, [-45, -5], [-15, -5]);
  await page.keyboard.press("t");
  const [hx, hy] = await toScreen(page, [-30, 10]);
  await page.mouse.move(hx, hy);
  await page.screenshot({ path: `${SHOTS}/trim-hover.png` });
  await sketchClick(page, -30, 10);
  await state(page, "circle trimmed");
  await page.screenshot({ path: `${SHOTS}/trim-circle.png` });

  // Extend
  await page.getByTestId("tool-select").click();
  await line(page, [-30, -20], [-30, -10]);
  await page.keyboard.press("e");
  const [ex, ey] = await toScreen(page, [-30, -11]);
  await page.mouse.move(ex, ey);
  await page.screenshot({ path: `${SHOTS}/extend-hover.png` });
  await sketchClick(page, -30, -11);
  await state(page, "extended");

  // Split
  await page.getByTestId("tool-trim-flyout").click();
  await page.getByTestId("flyout-split").click();
  await sketchClick(page, -40, 5);
  await state(page, "split");
  await page.screenshot({ path: `${SHOTS}/split.png` });

  // Linear pattern of a circle
  await page.getByTestId("tool-select").click();
  await page.keyboard.press("c");
  await sketchClick(page, 0, 40);
  await sketchClick(page, 5, 40);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await sketchClick(page, 5, 40);
  console.log("SEL", await page.getByTestId("sketch-selection").textContent().catch(() => "none"));
  await page.getByTestId("tool-pattern-flyout").click();
  await page.getByTestId("flyout-linear-pattern").click();
  await commit(page, "tool-option-spacing", "10");
  await page.screenshot({ path: `${SHOTS}/linear-preview.png` });
  await page.getByTestId("tool-apply").click();
  await state(page, "linear");
  await page.screenshot({ path: `${SHOTS}/linear.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Move by typing
  await sketchClick(page, 5, 40);
  await page.getByTestId("tool-move-flyout").click();
  await page.getByTestId("flyout-move").click();
  await state(page, "move start");
  await page.screenshot({ path: `${SHOTS}/move-strip.png` });
  await page.getByTestId("tool-apply").click();
  await state(page, "moved");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Rotate
  await sketchClick(page, -30, -15);
  await page.getByTestId("tool-move-flyout").click();
  await page.getByTestId("flyout-rotate").click();
  await page.getByTestId("tool-apply").click();
  await state(page, "rotated");
  await page.screenshot({ path: `${SHOTS}/rotated.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Scale
  await sketchClick(page, 15, 40);
  await page.getByTestId("tool-move-flyout").click();
  await page.getByTestId("flyout-scale").click();
  await page.getByTestId("tool-apply").click();
  await state(page, "scaled");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // check panel
  await page.getByTestId("tool-check").click();
  await page.screenshot({ path: `${SHOTS}/check.png` });
  await page.getByTestId("finish-sketch").click();
  const doc = await savedDocument(page);
  console.log("DOC", JSON.stringify(doc).slice(0, 4000));
});
