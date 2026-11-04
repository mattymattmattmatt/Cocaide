// Phase Q wave Q2A in the browser: New drawing auto-dimensions the bracket
// (its size and the hole's place from datums, a numbered notes block); the
// AI adds an H7 fit to the hole through the command layer (setAnnotation,
// then editAnnotation) and a position frame under it; the sheet shows "H7"
// and the frame (drawn as lines); the PDF carries them. The kernel is real.

import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument, scriptModel, text, tool, useKey } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

const sheetTexts = (page: Page) => page.getByTestId("sheet").locator("text").allTextContents();
const group = (page: Page, id: string) => page.getByTestId("sheet").locator(`g[data-id="${id}"]`).first();

test("auto-dimension the bracket, add an H7 fit and a position frame through the command layer, export the PDF", async ({ page }) => {
  await useKey(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  // The auto-dimension engine: the plate's size in the plan view, the hole located from datum B, thickness in the section.
  await expect(group(page, "datum_B")).toBeAttached();
  await expect.poll(() => sheetTexts(page)).toEqual(expect.arrayContaining(["80", "40", "70", "6", "Ø6.6 THRU", "NOTES:"]));
  for (const id of ["datum_A", "datum_C", "general_notes"]) await expect(group(page, id)).toBeAttached();

  await scriptModel(page, [
    [
      tool("setAnnotation", { id: "fit", annotation: { type: "dimension", view: "top", kind: "diameter", refs: ["top:ehole_1/c0"] } }),
      tool("editAnnotation", { id: "fit", patch: { tolerance: { kind: "fitWithTol", fit: "H7" } } }),
      tool("setAnnotation", { id: "pos", annotation: { type: "gdt", view: "top", dimension: "fit", rows: [{ characteristic: "position", diameter: true, tolerance: 0.1, material: "M", datums: [{ label: "A" }, { label: "B" }, { label: "C" }] }] } }),
    ],
    [text("The hole is Ø6.6 H7, positioned within Ø0.1 at MMC to A, B, C.")],
  ]);
  const box = (await page.getByTestId("sheet").boundingBox())!;
  // Empty paper: the whole drawing is the scope.
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.55, { button: "right" });
  await page.getByTestId("ctx-ask").click();
  await page.getByTestId("ask-input").fill("Give the hole an H7 fit and a position tolerance to A, B, C");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  await page.getByTestId("ask-close").click();

  // The fit reads H7 with its deviations; the frame is drawn under it, its symbols as lines.
  await expect.poll(() => sheetTexts(page)).toEqual(expect.arrayContaining(["Ø6.6", " H7", "+0.015", "0", "A", "B", "C"]));
  await expect(group(page, "pos").locator("polygon, polyline")).not.toHaveCount(0);
  await expect(page.getByTestId("drawing-item-pos")).toBeVisible();
  const doc = (await savedDocument(page)) as { drawing: { sheets: { annotations: { id: string; tolerance?: unknown }[] }[] } };
  expect(doc.drawing.sheets[0].annotations.find((a) => a.id === "fit")!.tolerance).toEqual({ kind: "fitWithTol", fit: "H7" });

  const download = page.waitForEvent("download");
  await page.getByTestId("drawing-export-pdf").click();
  const pdf = await (await download).path();
  const words = execFileSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
  for (const w of ["Ø6.6", "H7", "+0.015", "NOTES:", "GENERAL TOLERANCES ISO 2768-mK."]) expect(words).toContain(w);
});
