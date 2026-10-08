// Phase L acceptance in the browser (docs/roadmap.md): New drawing on the
// table frame, the checks failing and passing, the sheet following a size
// switch, a dimension added from a right-click on the front view, and the
// PDF and SVG exports. The model is answered by a script; the kernel is real.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument, scriptModel, text, tool, useKey } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

/** The words on the sheet, in drawing order. */
async function sheetTexts(page: Page): Promise<string[]> {
  return page.getByTestId("sheet").locator("text").allTextContents();
}

/** The drawing checks as shown: "✓ label: actual". */
async function checks(page: Page): Promise<string[]> {
  return (await page.getByTestId("drawing-checks").locator("li").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
}

/** The centre of a group on the sheet, in page pixels. */
async function centreOf(page: Page, id: string): Promise<[number, number]> {
  const box = (await page.getByTestId("sheet").locator(`g[data-id="${id}"]`).first().boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2];
}

async function tableFrameDrawing(page: Page) {
  await page.locator("select").first().selectOption("table frame (weldment)");
  await expectVolume(page, "3,054,720");
  await page.getByTestId("mode-drawing").click();
  await expect(page.getByTestId("sheet-empty")).toBeVisible();
  await page.getByTestId("drawing-new-empty").click();
  await expect(page.getByTestId("sheet").locator('g[data-id="b6"]')).toHaveCount(1);
}

test("New drawing on the table frame: one A3 sheet, dimensioned 1200, 600 and 900, ballooned, and its checks pass", async ({ page }) => {
  await tableFrameDrawing(page);
  for (const id of ["front", "top", "right", "iso", "d1", "d2", "d3", "b4", "b5", "b6", "cut_list", "titleBlock"]) {
    await expect(page.getByTestId("sheet").locator(`g[data-id="${id}"]`).first()).toBeAttached();
  }
  const words = await sheetTexts(page);
  expect(words).toEqual(expect.arrayContaining(["1200", "900", "600", "1", "2", "3", "CUT LIST", "table-frame", "1:10", "A3", "THIRD ANGLE", "23.98 kg"]));
  await expect.poll(() => checks(page)).toEqual([
    "✓ Every view shows the part: front, top, right, iso",
    "✓ Every annotation is attached: 7 annotations",
    "✓ Every cut list item has a balloon: 3 of 3",
    "✓ The overall size is dimensioned: length, width and height",
    "✓ Nothing overlaps or runs off the sheet: clear",
  ]);
  const doc = (await savedDocument(page)) as { drawing: { sheet: { size: string; projection: string }; views: { id: string }[] } };
  expect(doc.drawing.sheet).toMatchObject({ size: "A3", projection: "third" });
  expect(doc.drawing.views.map((v) => v.id)).toEqual(["front", "top", "right", "iso"]);
  await page.screenshot({ path: "docs/phase-l-drawing.png" });
});

test("the checks fail when a balloon is deleted and when a view is dragged onto the title block", async ({ page }) => {
  await tableFrameDrawing(page);
  await page.getByTestId("drawing-item-b5").click();
  await expect(page.getByTestId("prop-annotation-says")).toHaveText("Reads: 2");
  await page.getByTestId("prop-annotation-delete").click();
  await expect.poll(() => checks(page)).toContain("✗ Every cut list item has a balloon: no balloon for item 2 (leg_a, leg_b, leg_c, leg_d)");
  await page.getByTestId("undo").click();
  await expect.poll(() => checks(page)).toContain("✓ Every cut list item has a balloon: 3 of 3");

  // Drag the top view onto the title block.
  const [x, y] = await centreOf(page, "top");
  const [tx, ty] = await centreOf(page, "titleBlock");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move((x + tx) / 2, (y + ty) / 2, { steps: 5 });
  await page.mouse.move(tx, ty, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await checks(page)).find((c) => c.startsWith("✗ Nothing overlaps"))).toContain("view top overlaps the title block");
  // Only the view that was moved: the others stay placed and clear of it.
  const overlap = (await checks(page)).find((c) => c.startsWith("✗ Nothing overlaps"))!;
  expect(overlap.split(": ")[1].split("; ").every((p) => p.startsWith("view top"))).toBe(true);
  const doc = (await savedDocument(page)) as { drawing: { views: { id: string; at?: number[] }[] } };
  expect(doc.drawing.views.find((v) => v.id === "top")!.at).toHaveLength(2);
  // Placed with the others again, it is clear.
  await page.getByTestId("drawing-item-top").click();
  await page.getByTestId("prop-view-auto").click();
  await expect.poll(() => checks(page)).toContain("✓ Nothing overlaps or runs off the sheet: clear");
});

test("right-click the front view, ask for the leg height: accepted, it reads 860; SHS 50×50×3 makes it 850", async ({ page }) => {
  await useKey(page);
  await tableFrameDrawing(page);
  const sent = await scriptModel(page, [
    [tool("setAnnotation", { id: "d10", annotation: { type: "dimension", view: "front", member: "leg_a" } })],
    [text("Added d10: leg_a's cut length, 860, beside the front view.")],
  ]);
  const [x, y] = await centreOf(page, "front");
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.getByTestId("ask-target")).toHaveText("view front");
  await expect(page.getByTestId("ask-scope")).toHaveText("may change: view front and its annotations");
  await page.getByTestId("ask-input").fill("Dimension the leg height");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await expect(page.getByTestId("ask-proposal")).toContainText("+ dimension d10");
  await expect(page.getByTestId("ask-checks").locator("li.ok")).toHaveCount(5);
  // The preview shows it on the sheet before it is accepted.
  await expect.poll(() => sheetTexts(page)).toContain("860");
  await page.screenshot({ path: "docs/phase-l-ask.png" });
  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  await page.getByTestId("ask-close").click();
  await expect(page.getByTestId("drawing-item-d10")).toContainText("dimension 860");

  // The packet was the view, and the model was given the drawing's tools alone.
  const body = sent[0].body as { tools: { name: string }[]; messages: { content: { type: string; text?: string }[] }[] };
  expect(body.tools.map((t) => t.name)).toEqual(["escalate", "setAnnotation", "setView", "setSheet"]);
  const packet = body.messages[0].content.find((b) => b.type === "text")!.text!;
  expect(packet).toContain('"kind": "view"');
  expect(packet).toContain('"liesFlat": true');

  // Every member to SHS 50×50×3, in the model: the sheet follows.
  await page.getByTestId("mode-model").click();
  await page.getByTestId("tab-cutlist").click();
  await page.getByTestId("cut-row").first().click();
  await page.getByTestId("prop-size-all").selectOption("SHS 50x50x3");
  await expectVolume(page, "3,835,200");
  await page.getByTestId("mode-drawing").click();
  await expect(page.getByTestId("drawing-item-d10")).toContainText("dimension 850", { timeout: 30_000 });
  const words = await sheetTexts(page);
  expect(words).toEqual(expect.arrayContaining(["850", "SHS 50x50x3", "1200", "900", "600"]));
  expect(words).not.toContain("860");
  await expect.poll(() => checks(page)).toEqual([
    "✓ Every view shows the part: front, top, right, iso",
    "✓ Every annotation is attached: 8 annotations",
    "✓ Every cut list item has a balloon: 3 of 3",
    "✓ The overall size is dimensioned: length, width and height",
    "✓ Nothing overlaps or runs off the sheet: clear",
  ]);
  for (const [id, item] of [["b4", "1"], ["b5", "2"], ["b6", "3"]]) await expect(page.getByTestId(`drawing-item-${id}`)).toContainText(`balloon ${item}`);
});

test("Export PDF opens in poppler with the sheet's text; Export SVG is the sheet the app shows", async ({ page }) => {
  await tableFrameDrawing(page);
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("drawing-export-pdf").click()]);
  expect(pdf.suggestedFilename()).toBe("table-frame-drawing.pdf");
  const pdfPath = await pdf.path();
  expect(execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" })).toMatch(/Page size:\s+1190\.55 x 841\.89 pts \(A3\)/);
  const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
  for (const word of ["table-frame", "1200", "900", "600", "CUT LIST", "SHS 40x40x3", "45° / 45°", "23.98 kg"]) expect(text).toContain(word);

  const [svg] = await Promise.all([page.waitForEvent("download"), page.getByTestId("drawing-export-svg").click()]);
  expect(svg.suggestedFilename()).toBe("table-frame-drawing.svg");
  const file = readFileSync(await svg.path(), "utf8");
  expect(file).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="420mm" height="297mm"/);
  const exported = [...file.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  expect(exported).toEqual(await sheetTexts(page));
});
