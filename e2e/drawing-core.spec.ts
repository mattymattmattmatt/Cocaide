// Phase Q wave Q1A in the browser: New drawing on the flange gives an ISO
// sheet with the front view as section A-A; a second sheet is added from the
// tabs; a section and a detail are added from the views panel; the PDF has
// both sheets, its font embedded, and the DXF its layers. The kernel is real.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

const group = (page: Page, id: string) => page.getByTestId("sheet").locator(`g[data-id="${id}"]`).first();

type Doc = { drawing: { sheets: { id: string; name?: string; views: { id: string; kind?: string; parent?: string; label?: string }[] }[] } };

test("sheets, a section and a detail, and the PDF and DXF of them", async ({ page }) => {
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  // The bracket has insides: its front view is section A-A, cut along the top view through the hole.
  await expect(group(page, "front")).toBeAttached();
  await expect(page.getByTestId("sheet").locator("text", { hasText: "A–A" })).toHaveCount(1);
  await expect(page.getByTestId("drawing-item-front")).toContainText("section A-A of top");
  await expect(page.getByTestId("sheet-tab-sheet1")).toHaveText("Sheet 1");

  // A second sheet, renamed, with a front view, a section and a detail of it.
  await page.getByTestId("sheet-add").click();
  await expect(page.getByTestId("sheet-tab-sheet2")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("sheet-tab-sheet2").dblclick();
  await page.getByTestId("sheet-tab-name-sheet2").fill("Details");
  await page.getByTestId("sheet-tab-name-sheet2").press("Enter");
  await expect(page.getByTestId("sheet-tab-sheet2")).toHaveText("Details");
  await page.getByTestId("drawing-new-look").selectOption("front");
  await page.getByTestId("drawing-add-view").click();
  // The new view's id is free across the drawing (sheet 1 has a "front").
  await expect(page.getByTestId("drawing-item-front_1")).toBeVisible();
  await expect(group(page, "front_1")).toBeAttached();
  await page.getByTestId("drawing-new-kind").selectOption("section");
  await page.getByTestId("drawing-new-cut").selectOption("vertical");
  await page.getByTestId("drawing-add-view").click();
  await expect(page.getByTestId("drawing-item-section_1")).toContainText("section B-B of front_1");
  await page.getByTestId("drawing-item-front_1").click();
  await page.getByTestId("drawing-new-kind").selectOption("detail");
  await page.getByTestId("drawing-add-view").click();
  await expect(page.getByTestId("drawing-item-detail_1")).toContainText("detail C of front_1");
  await expect(page.getByTestId("sheet").locator("text", { hasText: "B–B" })).toHaveCount(1);
  await expect(page.getByTestId("sheet").locator("text", { hasText: /^C \(\d+ : \d\)$/ })).toHaveCount(1);
  // The section is hatched; its cutting line and the detail's circle are on the front view.
  await expect(group(page, "section_1").locator("polyline")).not.toHaveCount(0);
  const doc = (await savedDocument(page)) as unknown as Doc;
  expect(doc.drawing.sheets.map((s) => [s.id, s.name, s.views.map((v) => [v.id, v.kind ?? "model", v.label ?? ""])])).toEqual([
    ["sheet1", undefined, [["top", "model", ""], ["front", "section", "A"], ["right", "projected", ""], ["iso", "model", ""]]],
    ["sheet2", "Details", [["front_1", "model", ""], ["section_1", "section", "B"], ["detail_1", "detail", "C"]]],
  ]);

  // Undo takes the detail away; redo puts it back.
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("drawing-item-detail_1")).toHaveCount(0);
  await page.getByTestId("redo").click();
  await expect(page.getByTestId("drawing-item-detail_1")).toBeVisible();

  // The PDF: both sheets, the font embedded.
  let download = page.waitForEvent("download");
  await page.getByTestId("drawing-export-pdf").click();
  const pdf = await (await download).path();
  expect(execFileSync("pdfinfo", [pdf], { encoding: "utf8" })).toMatch(/Pages:\s+2/);
  expect(execFileSync("pdffonts", [pdf], { encoding: "utf8" })).toMatch(/LiberationSans\s+TrueType\s+WinAnsi\s+yes/);
  const words = execFileSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
  for (const w of ["A–A", "B–B", "bracket", "Ø6.6 THRU"]) expect(words).toContain(w);
  await expect(page.getByTestId("notice")).toContainText("(2 pages)");

  // The DXF of the sheet shown: a layer per kind of line.
  download = page.waitForEvent("download");
  await page.getByTestId("drawing-export-dxf").click();
  const dxf = readFileSync(await (await download).path(), "utf8");
  for (const layer of ["VISIBLE", "HATCH", "SECTION", "BORDER", "TITLE"]) expect(dxf).toContain(`\n${layer}\r\n`);
  expect(dxf).toContain("AC1015");

  // Back on sheet 1, the ISO title block says sheet 1 of 2.
  await page.getByTestId("sheet-tab-sheet1").click();
  await expect(page.getByTestId("sheet").locator('g[data-id="titleBlock"] text', { hasText: "1 / 2" })).toHaveCount(1);
  await page.screenshot({ path: "test-results/drawing-core-sheet1.png" });
});
