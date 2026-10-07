// Parameters in the browser: the human sees and edits what an agent may have
// parameterised, and the sketcher keeps expressions it did not change.

import { expect, test } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("a parameter drives a field, and changing it rebuilds the part", async ({ page }) => {
  await page.getByTestId("param-new-name").fill("plate_t");
  await page.getByTestId("param-new-value").fill("6");
  await page.getByTestId("param-add").click();
  await expect(page.getByTestId("param-plate_t")).toBeVisible();

  await page.getByTestId("feature-ext_1").locator(".feature-row").click();
  await commit(page, "prop-distance", "=plate_t");
  await expect(page.getByTestId("properties").locator(".expr-value")).toHaveText("= 6");
  expect(((await savedDocument(page)).features as Record<string, unknown>[])[1].distance).toBe("=plate_t");
  // In use, so it cannot be deleted.
  await expect(page.getByRole("button", { name: "Delete plate_t" })).toBeDisabled();

  await commit(page, "param-value-plate_t", "10");
  await expectVolume(page, "31,657.881");
  await expect(page.getByTestId("properties").locator(".expr-value")).toHaveText("= 10");

  // A bad expression is shown and not committed.
  await commit(page, "prop-distance", "=plate_q");
  await expect(page.getByTestId("properties").locator(".expr-error")).toHaveText('unknown parameter "plate_q" in "=plate_q"');
  expect(((await savedDocument(page)).features as Record<string, unknown>[])[1].distance).toBe("=plate_t");

  await page.getByTestId("undo").click();
  await expectVolume(page, "18,994.728");
});

test("the sketcher keeps a dimension's expression, and the parameter re-solves the sketch", async ({ page }) => {
  await page.getByTestId("tab-document").click();
  const editor = page.getByTestId("doc-editor");
  const text = (await editor.inputValue())
    .replace('"name": "bracket",', '"name": "bracket",\n  "parameters": { "w": 80 },')
    .replace('"value": 80', '"value": "=w"');
  await editor.fill(text);
  await expect(page.getByTestId("param-w")).toBeVisible();

  // Open and finish the sketch without touching the dimension.
  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  await page.getByTestId("finish-sketch").click();
  const sketch = ((await savedDocument(page)).features as { constraints?: { value: unknown }[] }[])[0];
  expect(sketch.constraints![0].value).toBe("=w");

  await commit(page, "param-value-w", "100");
  await expectVolume(page, "23,794.728");
  const resolved = ((await savedDocument(page)).features as { entities: { w: number }[] }[])[0];
  expect(resolved.entities[0].w).toBe(100);
});
