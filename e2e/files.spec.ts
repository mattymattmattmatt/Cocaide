// Files in and out (Phase P, DESIGN §2.9), in the browser: a STEP exported
// from the bracket opened as a new part (same volume) and inserted into a
// part as a second body; part properties set on the Document tab and read by
// a new drawing's title block; a sketch and a flat face exported as DXF (the
// downloads parsed and measured); a DXF inserted into a sketch and extruded.

import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { readDxf } from "../src/io/dxf";
import { commit, expectVolume, openApp, savedDocument, viewportClick } from "./helpers";

const SHOTS = process.env.COCAIDE_SHOTS ?? "out/e2e/files";
const fixture = (name: string) => new URL(`../tests/fixtures/dxf/${name}`, import.meta.url).pathname;

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  (page as unknown as { problems: string[] }).problems = problems;
  mkdirSync(SHOTS, { recursive: true });
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

/** Runs `act` and returns the text of the file it downloads. */
async function downloaded(page: Page, act: () => Promise<void>): Promise<{ name: string; text: string }> {
  const wait = page.waitForEvent("download");
  await act();
  const d = await wait;
  return { name: d.suggestedFilename(), text: readFileSync((await d.path())!, "utf8") };
}

/** Answers the file chooser `act` opens with a file. */
async function choose(page: Page, act: () => Promise<void>, file: { name: string; text: string }) {
  const wait = page.waitForEvent("filechooser");
  await act();
  await (await wait).setFiles({ name: file.name, mimeType: "application/octet-stream", buffer: Buffer.from(file.text) });
}

/** Drops a file on the viewport, as a user would. */
async function drop(page: Page, name: string, text: string) {
  await page.evaluate(
    ([name, text]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type: "" }));
      const target = document.querySelector("[data-testid=viewport]")!;
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 60 }));
    },
    [name, text],
  );
}

test("STEP: the bracket exported, opened as a new part, then inserted into a part as a second body", async ({ page }) => {
  const step = await downloaded(page, () => page.getByRole("button", { name: "Export STEP" }).click());
  expect(step.name).toBe("bracket.step");
  expect(step.text.startsWith("ISO-10303-21;")).toBe(true);

  // Open: a new part named after the file, holding one import, the same volume.
  await page.getByTestId("new-part").click();
  await choose(page, () => page.getByRole("button", { name: "Open" }).click(), { name: "bracket-copy.step", text: step.text });
  await expect(page.getByTestId("notice")).toContainText("Opened bracket-copy.step as a new part");
  await expectVolume(page, "18,994.728");
  await expect(page.getByTestId("doc-name")).toHaveValue("bracket-copy");
  await expect(page.getByTestId("feature-import_1")).toBeVisible();
  await expect(page.getByTestId("holes")).toHaveText("1 × Ø6.6");

  // Back to the bracket, and the STEP dropped on it goes in as a body of its own.
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  // Zoomed in close first: the view fits the part again once the import has built.
  // How far the camera stands from what it looks at.
  const distance = () =>
    page.evaluate(() => {
      const c = (window as unknown as { __cocaideViewport: { camera(): { position: number[]; target: number[] } } }).__cocaideViewport.camera();
      return Math.round(Math.hypot(...c.position.map((x, i) => x - c.target[i])));
    });
  const fitted = await distance();
  const box = (await page.getByTestId("viewport").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 300); // toward you: in
  await expect.poll(distance).toBeLessThan(fitted * 0.8);
  await drop(page, "bracket.step", step.text);
  await expect(page.getByTestId("step-drop-dialog")).toBeVisible();
  await page.getByTestId("step-insert-body").click();
  await expectVolume(page, "37,989.457");
  await expect.poll(distance).toBeGreaterThan(fitted * 0.95);
  await expect(page.getByTestId("body-bracket")).toBeVisible();
  // Its editor: the file, the body it made, where it sits. Moved up 50, it is clear of the first.
  await expect(page.getByTestId("prop-import-file")).toContainText("bracket.step");
  await expect(page.getByTestId("prop-import-body-0")).toContainText("bracket");
  await commit(page, "prop-import-at-z", "50");
  await expect.poll(async () => ((await savedDocument(page)).features as { at?: number[] }[])[3].at).toEqual([0, 0, 50]);
  await expectVolume(page, "37,989.457");
  await page.getByTestId("prop-import-turn-x").click();
  await expect.poll(async () => ((await savedDocument(page)).features as { rotate?: number[] }[])[3].rotate).toEqual([90, 0, 0]);
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  await page.getByTestId("tab-properties").screenshot({ path: `${SHOTS}/import-editor-tab.png` });
  await page.locator(".side.right").screenshot({ path: `${SHOTS}/import-editor.png` });
});

test("part properties: set on the Document tab, shown in a new drawing's title block, and in the export names", async ({ page }) => {
  await page.getByTestId("tab-document").click();
  await expect(page.getByTestId("part-props")).toBeVisible();
  await commit(page, "part-prop-partNumber", "BR-1001");
  await commit(page, "part-prop-description", "Base bracket, 6 mm plate");
  await commit(page, "part-prop-revision", "B");
  await commit(page, "part-prop-author", "J. Smith");
  await commit(page, "part-prop-finish", "Hot-dip galvanised");
  await page.getByTestId("part-prop-custom-new-name").fill("Customer");
  await page.getByTestId("part-prop-custom-new-value").fill("Acme Pty Ltd");
  await page.getByTestId("part-prop-custom-add").click();
  await expect(page.getByTestId("part-prop-custom-value-0")).toHaveValue("Acme Pty Ltd");
  await expect.poll(async () => (await savedDocument(page)).properties).toEqual({
    partNumber: "BR-1001",
    description: "Base bracket, 6 mm plate",
    revision: "B",
    author: "J. Smith",
    finish: "Hot-dip galvanised",
    custom: { Customer: "Acme Pty Ltd" },
  });
  await page.locator(".side.right").screenshot({ path: `${SHOTS}/document-tab.png` });
  // A value the document refuses (too long) says why, and the box goes back to what is kept.
  await commit(page, "part-prop-finish", "x".repeat(600));
  await expect(page.getByTestId("notice")).toContainText("is 600 characters long; keep it to 500");
  await expect(page.getByTestId("part-prop-finish")).toHaveValue("Hot-dip galvanised");
  // One undo takes the custom property off again; redo puts it back.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await savedDocument(page)).properties).not.toHaveProperty("custom");
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => ((await savedDocument(page)).properties as { custom?: unknown }).custom).toEqual({ Customer: "Acme Pty Ltd" });

  // The STEP is named by the part number and revision.
  const step = await downloaded(page, () => page.getByRole("button", { name: "Export STEP" }).click());
  expect(step.name).toBe("BR-1001-revB.step");
  expect(step.text).toContain("PRODUCT('BR-1001','BR-1001','Base bracket, 6 mm plate'");

  // A new drawing's title block reads them.
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await expect
    .poll(() => page.getByTestId("sheet").locator('g[data-id="titleBlock"] text').allTextContents())
    .toEqual(expect.arrayContaining(["PART NO.", "BR-1001", "DESCRIPTION", "Base bracket, 6 mm plate", "REV", "B", "DRAWN", "J. Smith", "FINISH", "Hot-dip galvanised", "bracket"]));
  await page.getByTestId("sheet").locator('g[data-id="titleBlock"]').first().screenshot({ path: `${SHOTS}/title-block.png` });
});

test("DXF out: a sketch from the tree and a flat face from its right-click, parsed and measured", async ({ page }) => {
  await page.getByTestId("feature-sketch_1").locator(".feature-row").click({ button: "right" });
  const sketch = await downloaded(page, () => page.getByTestId("ctx-export-dxf").click());
  expect(sketch.name).toBe("bracket-sketch_1.dxf");
  const s = readDxf(sketch.text);
  expect(s.version).toBe("AC1015");
  expect(s.units).toMatchObject({ code: 4, scale: 1, assumed: false });
  expect(s.entities.map((e) => [e.type, e.layer])).toEqual([["polyline", "PROFILE"]]);
  const outline = s.entities[0] as { points: number[][]; closed?: boolean };
  expect(outline.closed).toBe(true);
  expect(outline.points.map((p) => p.map((x) => Math.round(x * 1e6) / 1e6 + 0))).toEqual([[-40, -20], [40, -20], [40, 20], [-40, 20]]);

  // The top face, right-clicked away from the hole.
  await viewportClick(page, [-20, 0, 6]);
  const [x, y] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), [-20, 0, 6]);
  await page.mouse.click(x, y, { button: "right" });
  const face = await downloaded(page, () => page.getByTestId("ctx-export-face-dxf").click());
  expect(face.name).toBe("bracket-face.dxf");
  const f = readDxf(face.text);
  expect(f.entities.map((e) => e.type).sort()).toEqual(["circle", "polyline"]);
  const hole = f.entities.find((e) => e.type === "circle") as { c: number[]; r: number };
  expect(hole.r).toBeCloseTo(3.3, 9);
  expect(hole.c[0]).toBeCloseTo(30, 9);
  expect(hole.c[1]).toBeCloseTo(0, 9);
});

test("DXF in: inserted into a sketch on Top (ends joined) and extruded to the right volume; opened as a new part", async ({ page }) => {
  await page.getByTestId("new-part").click();
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  const dxf = { name: "rounded-plate.dxf", text: readFileSync(fixture("rounded-plate-r2010.dxf"), "utf8") };
  await choose(page, () => page.getByTestId("tool-insert-dxf").click(), dxf);
  await expect(page.getByTestId("dxf-dialog")).toBeVisible();
  await expect(page.getByTestId("dxf-summary")).toContainText("3 entities, 100 × 60 mm");
  await page.getByTestId("dxf-insert").click();
  await expect(page.getByTestId("notice")).toContainText("Inserted 10 entities from rounded-plate.dxf");
  // 100 x 60 with R10 corners, less two Ø12 holes: one region.
  const area = 100 * 60 - 4 * (100 - (Math.PI * 100) / 4) - 2 * Math.PI * 36;
  await expect(page.getByTestId("profile-status")).toContainText(`1 region, area ${Math.round(area * 1000) / 1000}`);
  await page.getByTestId("sketch-canvas").screenshot({ path: `${SHOTS}/inserted-dxf-sketch.png` });
  await page.screenshot({ path: `${SHOTS}/inserted-dxf-app.png` });
  await page.getByTestId("finish-sketch").click();
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "10");
  await expectVolume(page, "56,879.6"); // the area above x 10

  // Open a DXF: a new part named after it, a sketch on Top holding it.
  const slot = { name: "slot-plate.dxf", text: readFileSync(fixture("slot-plate-r12.dxf"), "utf8") };
  // Escape leaves the dialog without doing anything.
  await choose(page, () => page.getByRole("button", { name: "Open" }).click(), slot);
  await expect(page.getByTestId("dxf-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("dxf-dialog")).toBeHidden();
  await choose(page, () => page.getByRole("button", { name: "Open" }).click(), slot);
  await expect(page.getByTestId("dxf-dialog")).toBeVisible();
  // The centre line's layer was off in the file: it starts unticked.
  await expect(page.getByTestId("dxf-layer-CENTRE")).not.toBeChecked();
  await expect(page.getByTestId("dxf-layer-OUTLINE")).toBeChecked();
  await page.getByTestId("dxf-insert").click();
  await expect(page.getByTestId("doc-name")).toHaveValue("slot-plate");
  await expect(page.getByTestId("feature-sketch_1")).toBeVisible();
  const doc = (await savedDocument(page)) as { features: { entities: unknown[]; constraints: { type: string }[] }[] };
  expect(doc.features[0].entities).toHaveLength(5);
  // The slot's sides run on into its ends: tangent there, as well as joined.
  expect(doc.features[0].constraints.filter((k) => k.type === "tangent")).toHaveLength(4);
});
