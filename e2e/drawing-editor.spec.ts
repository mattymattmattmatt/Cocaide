// Phase Q wave Q2B in the browser: the drawing workspace. New drawing on the
// bracket, then by hand on the sheet: a section by drawing its cutting line,
// a detail by drawing its circle, a projected view dragged along its line
// (and refused across it), a hole table inserted, a title-block field edited
// in place, the export dialog. Hover finds the hole's centre by name. The
// kernel is real.

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

type Box = { min: [number, number]; max: [number, number] };
type ViewInfo = { centre: [number, number]; box: Box; scale: number; origin: [number, number] };
interface SheetHook {
  toScreen(x: number, y: number): [number, number];
  view(id: string): ViewInfo | null;
  targets(view: string, kind?: string): { ref: string; kind: string; at: [number, number]; feature?: string; label: string; visible: boolean }[];
  titleBlock(): Box;
}


/** A sheet point (mm, y up) in page pixels. */
async function at(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(([x, y]) => (window as unknown as { __cocaideSheet: SheetHook }).__cocaideSheet.toScreen(x, y), [x, y]);
}
async function viewOf(page: Page, id: string): Promise<ViewInfo> {
  await expect.poll(() => page.evaluate((id) => !!(window as unknown as { __cocaideSheet: SheetHook }).__cocaideSheet.view(id)?.box, id)).toBe(true);
  return page.evaluate((id) => (window as unknown as { __cocaideSheet: SheetHook }).__cocaideSheet.view(id)!, id);
}
async function clickSheet(page: Page, x: number, y: number) {
  const [px, py] = await at(page, x, y);
  await page.mouse.move(px - 3, py - 3);
  await page.mouse.move(px, py, { steps: 2 });
  await page.mouse.click(px, py);
}

const sheetTexts = (page: Page) => page.getByTestId("sheet").locator(".sheet-paper text").allTextContents();

async function bracketDrawing(page: Page) {
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await expect(page.getByTestId("drawing-item-front")).toContainText("section A-A of top");
  await viewOf(page, "top");
}

test("the workspace: tabs of tools, the tree, hover names the geometry, a section drawn on the view", async ({ page }) => {
  await bracketDrawing(page);
  // The toolbar's tabs, each with its tools (the ones still to come greyed).
  for (const t of ["layout", "annotation", "sketch", "tables", "format"]) await expect(page.getByTestId(`dtab-${t}`)).toBeVisible();
  await expect(page.getByTestId("tool-view-section")).toBeEnabled();
  await expect(page.getByTestId("tool-view-alternate")).toBeDisabled();
  await expect(page.getByTestId("tool-view-alternate")).toHaveAttribute("title", /coming/);
  await page.getByTestId("dtab-annotation").click();
  await expect(page.getByTestId("tool-annotation-gdt")).toBeDisabled();
  await expect(page.getByTestId("tool-annotation-dimension")).toBeEnabled();
  await page.getByTestId("dtab-layout").click();
  await page.screenshot({ path: "test-results/drawing-editor-workspace.png" });

  // Hover the hole's centre in the top view: its glyph, and its name in the tooltip and the status bar.
  const centre = (await page.evaluate(() => (window as unknown as { __cocaideSheet: SheetHook }).__cocaideSheet.targets("top", "centre"))).find((t) => t.feature === "hole_1" && t.visible)!;
  expect(centre.label).toBe("Centre of hole_1 (Ø6.6)");
  const [hx, hy] = await at(page, centre.at[0], centre.at[1]);
  await page.mouse.move(hx + 6, hy + 6);
  await page.mouse.move(hx + 1, hy, { steps: 3 });
  await expect(page.getByTestId("sheet-tip")).toHaveText("Centre of hole_1 (Ø6.6)");
  await expect(page.getByTestId("sheet-status-snap")).toHaveText("Centre of hole_1 (Ø6.6)");
  await expect(page.getByTestId("sheet-overlay").locator('[data-snap="centre"]')).toHaveCount(1);
  await page.screenshot({ path: "test-results/drawing-editor-hover.png" });

  // Section: the top view selected, the tool, a cutting line drawn up and down through the hole's centre, placed beside.
  await page.getByTestId("drawing-item-top").click();
  await page.getByTestId("tool-view-section").click();
  await expect(page.getByTestId("sheet-prompt")).toContainText("first point on top");
  const top = await viewOf(page, "top");
  await clickSheet(page, centre.at[0], top.box.max[1] + 4);
  await expect(page.getByTestId("sheet-prompt")).toContainText("other end");
  // The second point a little off vertical: it squares up.
  await clickSheet(page, centre.at[0] + 1.5, top.box.min[1] - 4);
  await expect(page.getByTestId("sheet-prompt")).toContainText("place the section", { timeout: 20_000 });
  await viewOf(page, "section_1");
  const [px, py] = await at(page, top.box.max[0] + 70, top.centre[1] + 30);
  await page.mouse.move(px - 10, py, { steps: 2 });
  await page.mouse.move(px, py, { steps: 3 });
  await page.screenshot({ path: "test-results/drawing-editor-section-place.png" });
  await page.mouse.click(px, py);
  await page.getByTestId("session-ok").click();
  await expect(page.getByTestId("drawing-session")).toHaveCount(0);
  await expect(page.getByTestId("drawing-item-section_1")).toContainText("section B-B of top");
  await expect.poll(() => sheetTexts(page)).toContain("B–B");
  const doc = (await savedDocument(page)) as { drawing: { sheets: { views: { id: string; kind?: string; line?: number[][]; at?: number[] }[] }[] } };
  const s = doc.drawing.sheets[0].views.find((v) => v.id === "section_1")!;
  // Vertical (squared up), through the hole's centre (x 30 in the top view: the plate is 80 long about its middle), run past the part at both ends.
  expect(s.line!.map((p) => p[0])).toEqual([30, 30]);
  expect(s.line![0][1]).toBeGreaterThan(20);
  expect(s.line![1][1]).toBeLessThan(-20);
  // Lined up with the top view: across, at the top view's line.
  const sv = await viewOf(page, "section_1");
  expect(Math.abs(sv.centre[1] - top.centre[1])).toBeLessThan(0.05);
  expect(sv.centre[0]).toBeGreaterThan(top.box.max[0]);
  // One undo step takes the whole section away.
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("drawing-item-section_1")).toHaveCount(0);
  await page.getByTestId("redo").click();
  await expect(page.getByTestId("drawing-item-section_1")).toBeVisible();
  await page.screenshot({ path: "test-results/drawing-editor-section.png" });
});

test("a detail by drawing its circle; a projected view slides along its line and is refused across it", async ({ page }) => {
  await bracketDrawing(page);
  // Detail: a circle round the hole in the top view, placed to the right.
  const centre = (await page.evaluate(() => (window as unknown as { __cocaideSheet: SheetHook }).__cocaideSheet.targets("top", "centre"))).find((t) => t.feature === "hole_1" && t.visible)!;
  const top = await viewOf(page, "top");
  await page.getByTestId("drawing-item-top").click();
  await page.getByTestId("tool-view-detail").click();
  await clickSheet(page, centre.at[0], centre.at[1]);
  await clickSheet(page, centre.at[0] + 9, centre.at[1]);
  await expect(page.getByTestId("sheet-prompt")).toContainText("Click where the detail goes");
  const frame = await page.evaluate(() => (window as unknown as { __cocaideSheet: SheetHook }).__cocaideSheet.titleBlock());
  await clickSheet(page, frame.max[0] - 40, frame.max[1] + 50);
  await page.getByTestId("detail-scale").selectOption("5:1");
  await page.getByTestId("session-ok").click();
  await expect(page.getByTestId("drawing-item-detail_1")).toContainText("detail B of top");
  await expect.poll(() => sheetTexts(page)).toContainEqual(expect.stringMatching(/^B \(5 : 1\)$/));
  const doc = (await savedDocument(page)) as { drawing: { sheets: { views: { id: string; circle?: { at: number[]; r: number }; scale?: string }[] }[] } };
  const d = doc.drawing.sheets[0].views.find((v) => v.id === "detail_1")!;
  expect(d.circle!.at).toEqual([30, 0]);
  expect(d.circle!.r).toBeCloseTo(9 / top.scale, 1);
  expect(d.scale).toBe("5:1");

  // The right view is projected from the front: dragging it up is refused, dragging it right slides it.
  const right = await viewOf(page, "right");
  const [rx, ry] = await at(page, right.centre[0], right.centre[1]);
  await page.mouse.move(rx, ry);
  await page.mouse.down();
  await page.mouse.move(rx, ry - 30, { steps: 4 });
  await page.mouse.move(rx, ry - 70, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("notice")).toContainText("right stays lined up with front");
  expect((await viewOf(page, "right")).centre).toEqual(right.centre);
  await page.mouse.move(rx, ry);
  await page.mouse.down();
  await page.mouse.move(rx + 20, ry - 4, { steps: 4 });
  await page.mouse.move(rx + 50, ry - 9, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await viewOf(page, "right")).centre[0]).toBeGreaterThan(right.centre[0] + 5);
  const moved = await viewOf(page, "right");
  expect(moved.centre[1]).toBeCloseTo(right.centre[1], 6);
  // Break alignment from its menu: now it goes anywhere.
  await page.getByTestId("drawing-item-right").click({ button: "right" });
  await page.getByTestId("ctx-view-unalign").click();
  await expect(page.getByTestId("drawing-item-right")).toContainText("free");
  await page.screenshot({ path: "test-results/drawing-editor-detail.png" });
});

test("a hole table, a title-block field edited in place, and the export dialog", async ({ page }) => {
  await bracketDrawing(page);
  await page.getByTestId("drawing-item-top").click();
  await page.getByTestId("dtab-tables").click();
  await page.getByTestId("tool-table-holes").click();
  await expect(page.getByTestId("table-dialog")).toBeVisible();
  await expect(page.getByTestId("table-view")).toHaveValue("top");
  await page.getByTestId("table-corner").selectOption("topRight");
  await page.getByTestId("table-insert").click();
  await expect(page.getByTestId("drawing-item-holes_1")).toContainText("hole table of top");
  await expect.poll(() => sheetTexts(page)).toEqual(expect.arrayContaining(["HOLE TABLE", "A1", "Ø6.6 THRU"]));
  // Its panel: a column taken away.
  await expect(page.getByTestId("prop-table-col-size")).toBeChecked();
  await page.getByTestId("prop-table-col-size").uncheck();
  // The size column was the table's own "Ø6.6 THRU" (the callout on the view keeps its own).
  await expect.poll(async () => (await sheetTexts(page)).filter((t) => t === "Ø6.6 THRU").length).toBe(1);

  // The title block, double-clicked: its fields with what they read; the title typed.
  const tb = await page.evaluate(() => (window as unknown as { __cocaideSheet: SheetHook }).__cocaideSheet.titleBlock());
  const [tx, ty] = await at(page, tb.min[0] + 30, tb.min[1] + 6);
  await page.mouse.dblclick(tx, ty);
  await expect(page.getByTestId("title-block-dialog")).toBeVisible();
  await page.getByTestId("tb-title").fill('BRACKET $PRP:"partNumber"');
  await page.getByTestId("tb-company").fill("ACME FAB");
  await expect(page.getByTestId("tb-company-reads")).toHaveText("ACME FAB");
  await page.screenshot({ path: "test-results/drawing-editor-title-block.png" });
  await page.getByTestId("tb-save").click();
  await expect.poll(() => sheetTexts(page)).toContain("ACME FAB");
  const doc = (await savedDocument(page)) as { drawing: { sheets: { format: Record<string, string>; tables?: { id: string; kind: string; view?: string }[] }[] } };
  expect(doc.drawing.sheets[0].format.company).toBe("ACME FAB");
  expect(doc.drawing.sheets[0].tables).toEqual([expect.objectContaining({ id: "holes_1", kind: "holes", view: "top" })]);

  // Print preview and export: a page each, the DXF of the sheet in black and white.
  await page.getByTestId("drawing-export").click();
  await expect(page.getByTestId("export-dialog")).toBeVisible();
  await expect(page.getByTestId("export-preview").locator("svg")).toHaveCount(1);
  await page.getByTestId("export-format-dxf").click();
  await page.getByTestId("export-colour").selectOption("mono");
  await page.screenshot({ path: "test-results/drawing-editor-export.png" });
  const download = page.waitForEvent("download");
  await page.getByTestId("export-go").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("bracket-drawing.dxf");
  const dxf = readFileSync(await file.path(), "utf8");
  expect(dxf).toContain("AC1015");
  expect(dxf).toContain("HOLE TABLE");
});

test("box select, Delete, copy and paste a note, and Ask AI from a table's menu", async ({ page }) => {
  await bracketDrawing(page);
  // A note by the Note tool.
  await page.getByTestId("dtab-annotation").click();
  await page.getByTestId("tool-annotation-note").click();
  const tb = await page.evaluate(() => (window as unknown as { __cocaideSheet: SheetHook }).__cocaideSheet.titleBlock());
  await clickSheet(page, tb.min[0] - 120, tb.min[1] + 30);
  await page.getByTestId("note-text").fill("DEBURR ALL EDGES");
  await page.getByTestId("note-text").press("Enter");
  await expect(page.getByTestId("drawing-item-n1")).toContainText("DEBURR ALL EDGES");
  // Copied and pasted beside: a second note.
  await page.getByTestId("sheet").focus();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(page.getByTestId("drawing-item-n2")).toBeVisible();
  // A box round both selects them; Delete takes them away, one undo brings them back.
  const [x0, y0] = await at(page, tb.min[0] - 130, tb.min[1] + 45);
  const [x1, y1] = await at(page, tb.min[0] - 40, tb.min[1] + 5);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("drawing-item-n1")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("drawing-item-n2")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("drawing-item-n1")).toHaveCount(0);
  await expect(page.getByTestId("drawing-item-n2")).toHaveCount(0);
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("drawing-item-n2")).toBeVisible();
  // F fits the sheet.
  await page.keyboard.press("f");
  await expect(page.getByTestId("sheet")).toHaveAttribute("data-zoom", /\d+/);
  // A view's menu has Ask AI, scoped to it.
  await page.getByTestId("drawing-item-top").click({ button: "right" });
  await expect(page.getByTestId("ctx-view-autodim")).toBeVisible();
  await expect(page.getByTestId("ctx-ask")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a weldment's sheet: a balloon dragged by its grip", async ({ page }) => {
  await page.locator("select").first().selectOption("table frame (weldment)");
  await expectVolume(page, "3,054,720");
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await expect(page.getByTestId("drawing-item-b5")).toContainText("balloon 2");
  await page.getByTestId("drawing-item-b5").click();
  await expect(page.getByTestId("prop-annotation-says")).toHaveText("Reads: 2");
  const grip = page.getByTestId("sheet-overlay").locator("rect.grip");
  await expect(grip).toHaveCount(1);
  const g = (await grip.boundingBox())!;
  const [x, y] = [g.x + g.width / 2, g.y + g.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y - 10, { steps: 4 });
  await page.mouse.move(x + 40, y - 30, { steps: 4 });
  await page.mouse.up();
  type Doc = { drawing: { sheets: { annotations: { id: string; at?: number[] }[] }[] } };
  await expect.poll(async () => ((await savedDocument(page)) as Doc).drawing.sheets[0].annotations.find((a) => a.id === "b5")?.at?.length).toBe(2);
  await page.screenshot({ path: "test-results/drawing-editor-weldment.png" });
});
