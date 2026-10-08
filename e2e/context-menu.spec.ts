// The right-click menu on everything, as SOLIDWORKS has it: a feature's
// edit, suppress, rename and delete; a face's sketch and hole; empty space's
// sketch planes and views; and on every one, "Ask AI…", which opens the ask
// panel. By default the AI may change the whole part from there.

import { expect, test } from "@playwright/test";
import { expectVolume, openApp, savedDocument, scriptModel, text, tool, useKey } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
});

test("a feature row: edit, suppress, rename, delete, and Ask AI", async ({ page }) => {
  const row = page.getByTestId("feature-hole_1").locator(".feature-row");
  await row.click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  for (const id of ["ctx-edit-feature", "ctx-suppress", "ctx-rename", "ctx-delete", "ctx-ask"]) await expect(page.getByTestId(id)).toBeVisible();

  await page.getByTestId("ctx-suppress").click();
  await expect(menu).toHaveCount(0);
  await expectVolume(page, "19,200"); // the plate without its hole
  await row.click({ button: "right" });
  await expect(page.getByTestId("ctx-suppress")).toHaveText("Unsuppress");
  await page.getByTestId("ctx-suppress").click();
  await expectVolume(page, "18,994.728");

  // Rename puts the cursor in the feature's name.
  await row.click({ button: "right" });
  await page.getByTestId("ctx-rename").click();
  await expect(page.getByTestId("prop-id")).toBeFocused();
  await page.getByTestId("prop-id").fill("bolt_hole");
  await page.getByTestId("prop-id").press("Enter");
  await expect(page.getByTestId("feature-bolt_hole")).toBeVisible();

  // Escape closes a menu without doing anything.
  await page.getByTestId("feature-ext_1").locator(".feature-row").click({ button: "right" });
  await expect(page.getByTestId("ctx-edit-sketch")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("a face: sketch on it; empty space: sketch on a plane", async ({ page }) => {
  const [x, y] = await page.evaluate(() => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project([-10, -10, 6]));
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.getByTestId("context-menu")).toContainText("this flat face");
  await expect(page.getByTestId("ctx-tool.hole")).toBeVisible();
  await expect(page.getByTestId("ctx-view.normal")).toBeVisible();
  await page.screenshot({ path: "docs/context-menu.png" });
  await page.getByTestId("ctx-sketch-face").click();
  await expect(page.getByTestId("sketch-panel")).toBeVisible();
  await page.getByTestId("cancel-sketch").click();

  const box = (await page.getByTestId("viewport").boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + box.height - 120, { button: "right" });
  await expect(page.getByTestId("context-menu")).toContainText("Part");
  await page.getByTestId("ctx-sketch-front").click();
  await expect(page.getByTestId("sketch-panel")).toContainText("sketch_2");
  await page.getByTestId("cancel-sketch").click();
});

test("Ask AI… from a sketch entity may change the whole part by default", async ({ page }) => {
  await useKey(page);
  const pattern = { op: "linearPattern", feature: "ext_1", direction: [1, 0, 0], spacing: 100, count: 2 };
  const sent = await scriptModel(page, [[tool("addFeature", { feature: pattern })], [text("Patterned the plate twice, 100 mm apart.")]]);
  const before = await savedDocument(page);

  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  const [x, y] = await page.evaluate(() => {
    const m = (document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement).getScreenCTM()!;
    return [m.a * 40 + m.e, m.d * 0 + m.f];
  });
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.getByTestId("context-menu")).toContainText("Rectangle r1");
  await page.getByTestId("ctx-ask").click();
  await expect(page.getByTestId("ask-target")).toHaveText("r1 in sketch_1");
  await expect(page.getByTestId("ask-reach-part")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("ask-scope")).toHaveText("may change: anything in the part");
  await page.getByTestId("ask-input").fill("pattern the part");
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  // The model saw the whole part beside the entity, and every tool.
  const first = sent[0].body;
  expect(first.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["addFeature", "addConstraint"]));
  const packet = (first.messages[0].content as { type: string; text?: string }[]).find((b) => b.type === "text")!.text!;
  expect(packet).toContain('"writeScope": [\n  "*"\n ]');
  expect(packet).toContain('"part"');
  await page.getByTestId("ask-discard").click();
  await page.getByTestId("cancel-sketch").click();
  expect(await savedDocument(page)).toEqual(before);
});
