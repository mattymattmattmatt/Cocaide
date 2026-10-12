import { test, type Page } from "@playwright/test";
import type { Vec2 } from "../src/doc/types";
import { commit, openApp, savedDocument, sketchClick } from "./helpers";

const SHOTS = "out/shots";
let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = await openApp(page);
  await page.getByTestId("new-part").click();
});
test.afterEach(async () => console.log("PROBLEMS", JSON.stringify(problems)));

async function toScreen(page: Page, [x, y]: Vec2): Promise<[number, number]> {
  return page.evaluate(([x, y]) => {
    const m = (document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement).getScreenCTM()!;
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as [number, number];
  }, [x, y] as Vec2);
}
async function state(page: Page, label: string) {
  const s = await page.evaluate(() => ({
    status: document.querySelector("[data-testid=profile-status]")?.textContent,
    sk: document.querySelector("[data-testid=sketch-status]")?.textContent,
    dof: document.querySelector("[data-testid=sketch-panel] h2, [data-testid=sketch-dof]")?.textContent,
    problems: document.querySelector("[data-testid=sketch-problems]")?.textContent,
    msg: [...document.querySelectorAll(".sketch-message, [data-testid=sketch-message]")].map((x) => x.textContent).join(" / "),
    prompt: document.querySelector("[data-testid=tool-prompt]")?.textContent,
    problem: document.querySelector("[data-testid=tool-problem]")?.textContent,
    list: [...document.querySelectorAll("[data-testid=constraint-list] li")].map((x) => x.textContent).join(" | "),
  }));
  console.log(label, JSON.stringify(s));
}

test("explore 2", async ({ page }) => {
  // A legacy rectangle and slot: explode from the menu
  const text = JSON.stringify({
    version: 1, units: "mm", name: "part",
    features: [{ id: "sketch_1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
      entities: [{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 20 }, { id: "l1", type: "line", start: [30, -20], end: [30, 20], construction: true }, { id: "a1", type: "arc", center: [10, 20], start: [20, 20], end: [10, 30] }],
      constraints: [{ type: "distanceX", entity: "r1", value: 40 }, { type: "coincident", points: ["r1.center", "origin"] }] }],
  });
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  await state(page, "loaded");
  const [x, y] = await toScreen(page, [0, 10]);
  await page.mouse.click(x, y, { button: "right" });
  await page.screenshot({ path: `${SHOTS}/ctx-rect.png` });
  await page.getByTestId("ctx-explode").click();
  await state(page, "exploded");
  // fillet two sides by clicking entities
  await page.getByTestId("tool-fillet").click();
  await sketchClick(page, 0, 10);
  await sketchClick(page, 20, 0);
  await page.screenshot({ path: `${SHOTS}/fillet-two-entities.png` });
  await page.keyboard.press("Enter");
  await state(page, "filleted by entities");
  // edit the radius dim to 7 from the list
  // mirror arc about construction line l1, copy off
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("m");
  await page.getByTestId("tool-option-copy").uncheck();
  const [ax, ay] = await toScreen(page, [10 + 10 * Math.SQRT1_2, 20 + 10 * Math.SQRT1_2]);
  await page.mouse.click(ax, ay);
  await sketchClick(page, 30, 15);
  await state(page, "mirror picks");
  await page.screenshot({ path: `${SHOTS}/mirror-nocopy-preview.png` });
  await page.keyboard.press("Enter");
  await state(page, "mirrored nocopy");
  await page.screenshot({ path: `${SHOTS}/mirror-nocopy.png` });
  // Escape and Q on the line l1 (construction) -> profile
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // offset dimension edit: offset the exploded rect outward 2 then change to 4 in list
  await page.getByTestId("tool-offset").click();
  await sketchClick(page, 0, -10);
  await commit(page, "tool-option-distance", "2");
  await page.screenshot({ path: `${SHOTS}/offset-rect-preview.png` });
  await page.keyboard.press("Enter");
  await state(page, "offset rect");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const row = page.getByTestId("constraint-list").locator("li", { hasText: "offset from" });
  const input = row.locator("input");
  await input.fill("4");
  await input.press("Enter");
  await state(page, "offset 4");
  await page.screenshot({ path: `${SHOTS}/offset-rect-4.png` });
  // Move with keep relations: move the arc (mirrored) by clicks
  await page.getByTestId("tool-move-flyout").click();
  await page.getByTestId("flyout-copy").click();
  await sketchClick(page, 0, -12);
  await state(page, "copy picked");
  await sketchClick(page, -40, -40);
  await state(page, "copy picking done");
  await sketchClick(page, 0, 0);
  await page.mouse.move(...(await toScreen(page, [0, -30])));
  await page.screenshot({ path: `${SHOTS}/copy-rubber.png` });
  await sketchClick(page, 0, -40);
  await state(page, "copied");
  await page.screenshot({ path: `${SHOTS}/copied.png` });
  await page.getByTestId("finish-sketch").click();
  const doc = await savedDocument(page);
  console.log("DOC", JSON.stringify(doc).slice(0, 3000));
  await page.waitForTimeout(1500);
  console.log("STATUS", await page.getByTestId("status").textContent());
});
