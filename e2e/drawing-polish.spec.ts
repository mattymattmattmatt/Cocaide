// Phase Q round 4, the polish pass, in the browser: the flows a user leans
// on, each checked by opening what it made. The export dialog (the PDF of
// both sheets read back with pdf.js, DXF R2000 and R12 parsed pair by pair,
// the SVG parsed, the PNG's size at the dpi asked, black and white); the
// sheet tabs (add, rename, reorder, delete, each undone); a grip dragged on
// every kind of annotation Auto-detail puts on a sheet; a view tool's Cancel
// and OK, and Undo after it. The kernel is real.

import { readFileSync } from "node:fs";
import { expect, test, type Download, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

type Doc = { drawing: { sheets: { id: string; name?: string; scale?: string; views: { id: string; kind?: string }[]; annotations: { id: string; type: string; at?: number[]; offset?: number; pts?: number[][] }[] }[] } };
const doc = async (page: Page) => (await savedDocument(page)) as Doc;

async function newDrawing(page: Page, example: string, volume: string) {
  await page.locator("select").first().selectOption(example);
  await expectVolume(page, volume);
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await expect.poll(async () => (await doc(page)).drawing?.sheets?.[0]?.views?.length ?? 0).toBeGreaterThan(1);
}

async function exported(page: Page, kind: "pdf" | "svg" | "dxf" | "png", set: (page: Page) => Promise<unknown> = async () => {}): Promise<{ name: string; data: Buffer }> {
  await page.getByTestId("drawing-export").click();
  await expect(page.getByTestId("export-dialog")).toBeVisible();
  await page.getByTestId(`export-format-${kind}`).click();
  await set(page);
  const download: Promise<Download> = page.waitForEvent("download");
  await page.getByTestId("export-go").click();
  const file = await download;
  return { name: file.suggestedFilename(), data: readFileSync((await file.path())!) };
}

/** A DXF's group code / value pairs; throws when a code isn't an integer. */
function dxfPairs(text: string): [number, string][] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  expect(lines.length % 2).toBe(0);
  const out: [number, string][] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new Error(`line ${i + 1}: group code "${lines[i]}"`);
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

function checkDxf(text: string, version: string) {
  const pairs = dxfPairs(text);
  // Sections open and close in pairs, the file ends with EOF.
  let open = 0;
  for (const [c, v] of pairs) {
    if (c === 0 && v === "SECTION") open++;
    if (c === 0 && v === "ENDSEC") open--;
    expect(open === 0 || open === 1).toBe(true);
  }
  expect(open).toBe(0);
  expect(pairs[pairs.length - 1]).toEqual([0, "EOF"]);
  expect(pairs.find(([c, v], i) => c === 9 && v === "$ACADVER" && pairs[i + 1]?.[1] === version)).toBeTruthy();
  const sections = pairs.filter(([c], i) => c === 2 && pairs[i - 1]?.[1] === "SECTION").map(([, v]) => v);
  expect(sections).toEqual(expect.arrayContaining(["HEADER", "ENTITIES"]));
  const entities = pairs.filter(([c]) => c === 0).map(([, v]) => v);
  return { pairs, entities };
}

test("export: the PDF of both sheets read back, a PNG at 100 dpi, the SVG parsed", async ({ page }) => {
  await newDrawing(page, "flange", "\\d");
  await page.getByTestId("sheet-add").click();
  await expect(page.getByTestId("sheet-tab-sheet2")).toBeVisible();
  await page.getByTestId("sheet-tab-sheet1").click();

  // The PDF: two pages, the title and the views' text on the first, read back with pdf.js.
  const pdf = await exported(page, "pdf");
  expect(pdf.name).toBe("flange-drawing.pdf");
  expect(pdf.data.subarray(0, 5).toString()).toBe("%PDF-");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const read = await pdfjs.getDocument({ data: new Uint8Array(pdf.data) }).promise;
  expect(read.numPages).toBe(2);
  const text = (await (await read.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
  expect(text).toContain("flange");
  expect(text).toContain("A–A");
  expect(text).toMatch(/ISO 2768-mK/);
  const view = (await read.getPage(1)).getViewport({ scale: 1 });
  // A3 landscape, in points.
  expect([Math.round(view.width), Math.round(view.height)]).toEqual([1191, 842]);

  // A PNG at 100 dpi: 420 × 297 mm is 1654 × 1169 pixels.
  const png = (await exported(page, "png", async (p) => p.getByTestId("export-dpi").selectOption("100"))).data;
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1654, 1169]);

  // The SVG: well-formed (the browser's parser), sized in mm, with the title.
  const svg = (await exported(page, "svg")).data.toString("utf8");
  const parsed = await page.evaluate((s) => {
    const d = new DOMParser().parseFromString(s, "image/svg+xml");
    return { error: d.getElementsByTagName("parsererror").length, root: d.documentElement.nodeName, width: d.documentElement.getAttribute("width") };
  }, svg);
  expect(parsed).toEqual({ error: 0, root: "svg", width: "420mm" });
  expect(svg).toContain("flange");

});

// (A page that downloads many files in a row is asked to allow it: the DXFs and the black-and-white SVG get a page of their own.)
test("export: DXF R2000 and R12 parsed pair by pair, and black and white", async ({ page }) => {
  await newDrawing(page, "flange", "\\d");
  // Black and white: a warning's colour (a dangling annotation is drawn red) is drawn black.
  const colours = (s: string) => [...new Set([...s.matchAll(/(?:stroke|fill)="(#[0-9a-fA-F]{3,6})"/g)].map((m) => m[1].toLowerCase()))];
  const mono = (await exported(page, "svg", async (p) => p.getByTestId("export-colour").selectOption("mono"))).data.toString("utf8");
  expect(colours(mono).filter((c) => !["#000", "#000000", "#fff", "#ffffff"].includes(c))).toEqual([]);

  // DXF R2000 (LWPOLYLINEs, layers) and R12 (no LWPOLYLINE: R12 has none).
  const r2000 = checkDxf((await exported(page, "dxf", async (p) => p.getByTestId("export-dxf-version").selectOption("R2000"))).data.toString("utf8"), "AC1015");
  expect(r2000.entities).toEqual(expect.arrayContaining(["LINE", "TEXT"]));
  // The layers the entities are on (group code 8).
  const layers = [...new Set(r2000.pairs.filter(([c]) => c === 8).map(([, v]) => v))];
  expect(layers).toEqual(expect.arrayContaining(["VISIBLE", "DIMENSION", "TITLE"]));
  const r12 = checkDxf((await exported(page, "dxf", async (p) => p.getByTestId("export-dxf-version").selectOption("R12"))).data.toString("utf8"), "AC1009");
  expect(r12.entities).not.toContain("LWPOLYLINE");
  expect(r12.entities.length).toBeGreaterThan(100);

});

test("sheet tabs: add, rename, reorder and delete, each undone", async ({ page }) => {
  await newDrawing(page, "bracket", "18,994.728");
  const order = async () => (await doc(page)).drawing.sheets.map((s) => s.id);
  await page.getByTestId("sheet-add").click();
  await expect(page.getByTestId("sheet-tab-sheet2")).toHaveAttribute("aria-selected", "true");
  expect(await order()).toEqual(["sheet1", "sheet2"]);
  await page.getByTestId("sheet-tab-sheet2").dblclick();
  await page.getByTestId("sheet-tab-name-sheet2").fill("Details");
  await page.getByTestId("sheet-tab-name-sheet2").press("Enter");
  await expect(page.getByTestId("sheet-tab-sheet2")).toHaveText("Details");
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("sheet-tab-sheet2")).toHaveText("Sheet 2");
  await page.getByTestId("redo").click();
  await expect(page.getByTestId("sheet-tab-sheet2")).toHaveText("Details");
  // Moved left from its menu, then undone.
  await page.getByTestId("sheet-tab-sheet2").click({ button: "right" });
  await page.getByTestId("ctx-sheet-left").click();
  await expect.poll(order).toEqual(["sheet2", "sheet1"]);
  await page.getByTestId("undo").click();
  await expect.poll(order).toEqual(["sheet1", "sheet2"]);
  // Deleted, then undone: back with its name.
  await page.getByTestId("sheet-tab-sheet2").click({ button: "right" });
  await page.getByTestId("ctx-sheet-delete").click();
  await expect(page.getByTestId("sheet-tab-sheet2")).toHaveCount(0);
  await expect.poll(order).toEqual(["sheet1"]);
  // The only sheet left can't be deleted.
  await page.getByTestId("sheet-tab-sheet1").click({ button: "right" });
  await expect(page.getByTestId("ctx-sheet-delete")).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("sheet-tab-sheet2")).toHaveText("Details");
  // The first sheet kept its scale through all of it.
  expect((await doc(page)).drawing.sheets[0].scale).toBe("2:1");
});

/** Drags the first grip of the selected annotation by (dx, dy) pixels. */
async function dragGrip(page: Page, dx: number, dy: number) {
  const grip = page.getByTestId("sheet-overlay").locator("rect.grip").first();
  await expect(grip).toBeVisible();
  const g = (await grip.boundingBox())!;
  const [x, y] = [g.x + g.width / 2, g.y + g.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test("a grip dragged on every kind of annotation Auto-detail puts on the mounting plate; each drag is one undo", async ({ page }) => {
  await newDrawing(page, "mounting plate", "\\d");
  await page.getByTestId("dtab-annotation").click();
  await page.getByTestId("tool-ai-auto-detail").click();
  await expect(page.getByTestId("detail-plan")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("detail-run-rules").click();
  await expect(page.getByTestId("auto-detail-done")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("session-ok").click();
  await expect(page.getByTestId("drawing-session")).toHaveCount(0);
  const anns = (await doc(page)).drawing.sheets[0].annotations;
  const kinds = ["dimension", "hole", "gdt", "datum", "surface", "note"];
  const tried: string[] = [];
  for (const kind of kinds) {
    // One of the kind with a grip to drag (a dimension's text, a callout's knee, a frame, a datum's box, a symbol, a note).
    const a = anns.find((x) => x.type === kind && (kind !== "surface" || !("general" in x)));
    if (!a) continue;
    await page.getByTestId(`drawing-item-${a.id}`).click();
    const before = JSON.stringify((await doc(page)).drawing.sheets[0].annotations.find((x) => x.id === a.id));
    await dragGrip(page, 18, -14);
    await expect.poll(async () => JSON.stringify((await doc(page)).drawing.sheets[0].annotations.find((x) => x.id === a.id))).not.toBe(before);
    await page.getByTestId("undo").click();
    await expect.poll(async () => JSON.stringify((await doc(page)).drawing.sheets[0].annotations.find((x) => x.id === a.id))).toBe(before);
    tried.push(kind);
  }
  expect(tried).toEqual(kinds);
  await page.screenshot({ path: "test-results/drawing-polish-grips.png" });
});

test("a weldment's weld symbol and balloon by their grips", async ({ page }) => {
  await newDrawing(page, "table frame (weldment)", "3,054,720");
  await page.getByTestId("dtab-annotation").click();
  await page.getByTestId("tool-ai-auto-detail").click();
  await expect(page.getByTestId("detail-plan")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("detail-run-rules").click();
  await expect(page.getByTestId("auto-detail-done")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("session-ok").click();
  const anns = (await doc(page)).drawing.sheets[0].annotations;
  for (const kind of ["weld", "balloon"]) {
    const a = anns.find((x) => x.type === kind)!;
    expect(a).toBeTruthy();
    await page.getByTestId(`drawing-item-${a.id}`).click();
    const before = JSON.stringify(a);
    await dragGrip(page, 20, -16);
    await expect.poll(async () => JSON.stringify((await doc(page)).drawing.sheets[0].annotations.find((x) => x.id === a.id))).not.toBe(before);
  }
  // Auto-detail kept the frame at 1:10 (the cut list moved to the top right).
  expect((await doc(page)).drawing.sheets[0].scale).toBe("1:10");
});

test("a view tool: Cancel leaves the sheet as it was, OK adds the view, Undo takes it away", async ({ page }) => {
  await newDrawing(page, "bracket", "18,994.728");
  const ids = async () => (await doc(page)).drawing.sheets[0].views.map((v) => v.id);
  const was = await ids();
  await page.getByTestId("drawing-item-top").click();
  await page.getByTestId("tool-view-section").click();
  await page.getByTestId("section-quick-vertical").click();
  await page.getByTestId("session-cancel").click();
  await expect(page.getByTestId("drawing-session")).toHaveCount(0);
  expect(await ids()).toEqual(was);
  await page.getByTestId("drawing-item-top").click();
  await page.getByTestId("tool-view-section").click();
  await page.getByTestId("section-quick-vertical").click();
  await page.getByTestId("session-ok").click();
  await expect.poll(ids).toEqual([...was, "section_1"]);
  await expect(page.getByTestId("drawing-item-section_1")).toContainText("section B-B of top");
  await page.getByTestId("undo").click();
  await expect.poll(ids).toEqual(was);
  await expect(page.getByTestId("drawing-item-section_1")).toHaveCount(0);
  // Moving a view never changes the stored scale.
  expect((await doc(page)).drawing.sheets[0].scale).toBe("2:1");
});
