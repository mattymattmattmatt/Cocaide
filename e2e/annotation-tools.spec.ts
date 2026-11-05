// Phase Q wave Q3A in the browser: the annotation tools on real sheets (the
// kernel is real). On the bracket: Smart Dimension on the hole, Ø with an
// H7 fit whose limits show; a chain; a datum D; a GD&T position frame to
// A|B|C under the hole's size; a surface finish; a note with a linked
// property. On the flange: an angle by its quadrant, Model Items. On a
// table frame with a weld: the weld symbol from the weld, Auto Balloon.
// Each tool is photographed in use and each sheet when finished.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument, waitForRebuild } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

type V2 = [number, number];
type Box = { min: V2; max: V2 };
interface Target {
  ref: string;
  kind: string;
  at: V2;
  feature?: string;
  visible: boolean;
  circle?: { c: V2; r: number };
  pts?: V2[][];
  body?: string;
}
interface SheetHook {
  toScreen(x: number, y: number): V2;
  view(id: string): { centre: V2; box: Box; scale: number } | null;
  targets(view: string, kind?: string): Target[];
}
type Doc = { drawing: { sheets: { annotations: Record<string, unknown>[] }[] } };

/** Runs f on the sheet's automation hook in the page (null until the sheet is on screen). */
const hook = <T,>(page: Page, f: (h: SheetHook, arg: unknown) => T, arg?: unknown) =>
  page.evaluate(([src, a]) => {
    const h = (window as unknown as { __cocaideSheet?: SheetHook }).__cocaideSheet;
    return h ? new Function("h", "a", `return (${src})(h, a)`)(h, a) : null;
  }, [f.toString(), arg] as const) as Promise<T>;
const screen = (page: Page, p: V2) => hook(page, (h, a) => h.toScreen((a as V2)[0], (a as V2)[1]), p);
const target = async (page: Page, view: string, ref: string): Promise<Target> => {
  await expect.poll(() => hook(page, (h, a) => h.targets((a as string[])[0]).some((t) => t.ref === (a as string[])[1]), [view, ref])).toBe(true);
  return hook(page, (h, a) => h.targets((a as string[])[0]).find((t) => t.ref === (a as string[])[1])!, [view, ref]);
};
const viewOf = async (page: Page, id: string) => {
  await expect.poll(() => hook(page, (h, a) => !!h.view(a as string)?.box, id)).toBe(true);
  return hook(page, (h, a) => h.view(a as string)!, id);
};

async function clickAt(page: Page, p: V2) {
  const [x, y] = await screen(page, p);
  await page.mouse.move(x - 4, y - 4);
  await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.click(x, y);
}
async function hover(page: Page, p: V2) {
  const [x, y] = await screen(page, p);
  await page.mouse.move(x - 6, y - 3, { steps: 2 });
  await page.mouse.move(x, y, { steps: 3 });
}
/** A point on a target that snaps to the target itself: a circle off its quadrants, an edge between its ends and middle. */
function onTarget(t: Target, frac = 0.3): V2 {
  if (t.circle) return [t.circle.c[0] + t.circle.r * Math.cos(0.7), t.circle.c[1] + t.circle.r * Math.sin(0.7)];
  const pts = t.pts![0];
  const a = pts[0];
  const b = pts[pts.length - 1];
  return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac];
}
async function clickTarget(page: Page, view: string, ref: string, frac = 0.3) {
  await clickAt(page, onTarget(await target(page, view, ref), frac));
}
/** Zooms the sheet in about a sheet point until it is at least `percent`. */
async function zoomTo(page: Page, p: V2, percent: number) {
  const sheet = page.getByTestId("sheet");
  for (let i = 0; i < 30; i++) {
    const z = Number(await sheet.getAttribute("data-zoom"));
    if (z >= percent) return;
    const [x, y] = await screen(page, p);
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(30);
    const z2 = Number(await sheet.getAttribute("data-zoom"));
    if (z2 < z) {
      await page.mouse.wheel(0, -200);
      await page.mouse.wheel(0, -200);
      await page.mouse.wheel(0, -200);
    }
  }
}
const sheetTexts = (page: Page) => page.getByTestId("sheet").locator(".sheet-paper text").allTextContents();
const annotations = async (page: Page) => ((await savedDocument(page)) as Doc).drawing.sheets[0].annotations;
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/annotation-tools-${name}.png` });

async function newDrawing(page: Page, example: string, volume: string) {
  await page.locator("select").first().selectOption(example);
  await expectVolume(page, volume);
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await page.getByTestId("dtab-annotation").click();
}

test("the bracket detailed by hand: Ø with H7 and its limits, a chain, a datum, a position frame to A|B|C, a surface finish, a note with a linked property", async ({ page }) => {
  await newDrawing(page, "bracket", "18,994.728");
  const top = await viewOf(page, "top");
  const hole = await target(page, "top", "top:ehole_1/c1");
  await zoomTo(page, hole.circle!.c, 220);

  // Smart Dimension (D): the hole's circle, then where the text goes: Ø, the preview following the pointer.
  await page.keyboard.press("d");
  await expect(page.getByTestId("sheet-prompt")).toContainText("Click an edge, a circle");
  await clickTarget(page, "top", "top:ehole_1/c1");
  const place: V2 = [hole.circle!.c[0] - 14, hole.circle!.c[1] + 13];
  await hover(page, place);
  await expect(page.getByTestId("sheet-preview")).toBeVisible();
  await expect(page.getByTestId("sheet-preview").locator("text")).toContainText(["Ø6.6"]);
  await shot(page, "smart-dimension-preview");
  await clickAt(page, place);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("drawing-session")).toHaveCount(0);
  const dims = (await annotations(page)).filter((a) => a.type === "dimension" && a.kind === "diameter");
  expect(dims).toHaveLength(1);
  const did = String(dims[0].id);

  // Its panel: driven by the model; the fit editor shows ISO 286's values; limits on the sheet.
  await page.getByTestId(`drawing-item-${did}`).click();
  await expect(page.getByTestId("dim-value")).toHaveText("Ø6.6");
  await page.getByTestId("dim-tol-kind").selectOption("fitLimits");
  await expect(page.getByTestId("dim-fit-hole")).toHaveValue("H7");
  await expect(page.getByTestId("dim-fit-hole").locator("option", { hasText: "H7  +0.015 / 0" })).toHaveCount(1);
  await expect(page.getByTestId("dim-fit-summary")).toContainText("Hole Ø6.6 H7: 6.600 – 6.615 (+0.015 / 0)");
  await expect.poll(() => sheetTexts(page)).toEqual(expect.arrayContaining(["6.615", "6.600"]));
  await shot(page, "dimension-panel-fit");
  // A pair: the shaft's class too, and what fit they make.
  await page.getByTestId("dim-fit-H7-g6").click();
  await expect(page.getByTestId("dim-fit-summary")).toContainText("Clearance fit");
  await page.getByTestId("dim-tol-kind").selectOption("fitWithTol");
  await page.getByTestId("dim-fit-shaft").selectOption("");
  await expect.poll(async () => (await annotations(page)).find((a) => a.id === did)!.tolerance).toEqual({ kind: "fitWithTol", fit: "H7" });
  await expect.poll(() => sheetTexts(page)).toEqual(expect.arrayContaining([" H7", "+0.015"]));
  // Override with a warning, then driven again.
  await page.getByTestId("dim-override").fill("6.6 REF");
  await page.getByTestId("dim-override").press("Enter");
  await expect(page.getByTestId("dim-override-warning")).toContainText("won't follow changes");
  await page.getByTestId("dim-override").fill("");
  await page.getByTestId("dim-override").press("Enter");
  await expect(page.getByTestId("dim-override-warning")).toHaveCount(0);
  await page.getByTestId("sheet-fit").click();

  // A chain along the top: a corner, the hole's centre, the other corner, then above the view.
  await page.getByTestId("tool-annotation-chain").click();
  const corners = (await hook(page, (h) => h.targets("top", "vertex"))).filter((t) => t.visible).sort((a, b) => a.at[0] - b.at[0] || b.at[1] - a.at[1]);
  const topLeft = corners[0];
  const topRight = corners.filter((c) => Math.abs(c.at[1] - topLeft.at[1]) < 0.01).sort((a, b) => b.at[0] - a.at[0])[0];
  await clickAt(page, topLeft.at);
  await clickAt(page, (await target(page, "top", "top:chole_1/c1")).at);
  await clickAt(page, topRight.at);
  const above: V2 = [(top.box.min[0] + top.box.max[0]) / 2, top.box.max[1] + 8];
  await hover(page, above);
  await expect(page.getByTestId("sheet-preview")).toBeVisible();
  await shot(page, "chain-preview");
  await clickAt(page, above);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await annotations(page)).filter((a) => a.kind === "chain").length).toBe(1);
  const chain = (await annotations(page)).find((a) => a.kind === "chain")!;
  expect(chain).toMatchObject({ direction: "horizontal", origin: topLeft.ref, points: ["top:chole_1/c1", topRight.ref] });
  await expect.poll(() => sheetTexts(page)).toEqual(expect.arrayContaining(["70", "10"]));

  // A datum: the tool counts on from A, B, C (New drawing's); D on the plate's left edge.
  await page.getByTestId("tool-annotation-datum").click();
  await expect(page.getByTestId("datum-label")).toHaveValue("D");
  await clickTarget(page, "top", "top:eext_1/l2", 0.6);
  await clickAt(page, [top.box.min[0] - 10, top.centre[1] + 8]);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await annotations(page)).find((a) => a.type === "datum" && a.label === "D")?.on).toBe("top:eext_1/l2");

  // GD&T: position Ø0.1 Ⓜ to A|B|C (offered from the datums on the sheet), under the hole's size.
  await page.getByTestId("tool-annotation-gdt").click();
  await expect(page.getByTestId("gdt-char-position")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("gdt-datum-0-0")).toHaveValue("A");
  await expect(page.getByTestId("gdt-datum-0-1")).toHaveValue("B");
  await expect(page.getByTestId("gdt-datum-0-2")).toHaveValue("C");
  await expect(page.getByTestId("gdt-ok")).toBeVisible();
  // A rule broken shows at once: flatness takes no Ⓜ.
  await page.getByTestId("gdt-char-flatness").click();
  await page.getByTestId("gdt-mat-0").selectOption("M");
  await expect(page.getByTestId("gdt-problems")).toContainText("features of size only");
  await page.getByTestId("gdt-char-position").click();
  await page.getByTestId("gdt-dia-0").click();
  await page.getByTestId("gdt-mat-0").selectOption("M");
  await page.getByTestId("gdt-datum-0-0").selectOption("A");
  await page.getByTestId("gdt-datum-0-1").selectOption("B");
  await page.getByTestId("gdt-datum-0-2").selectOption("C");
  await expect(page.getByTestId("gdt-ok")).toBeVisible();
  const said = await page.getByTestId("sheet").locator(`g[data-id="${did}"] text`).first().boundingBox();
  await page.mouse.move(said!.x + said!.width / 2 - 3, said!.y + said!.height / 2);
  await page.mouse.move(said!.x + said!.width / 2, said!.y + said!.height / 2, { steps: 2 });
  await shot(page, "gdt-builder");
  await page.mouse.click(said!.x + said!.width / 2, said!.y + said!.height / 2);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await annotations(page)).filter((a) => a.type === "gdt").length).toBe(1);
  const frame = (await annotations(page)).find((a) => a.type === "gdt")!;
  expect(frame).toMatchObject({ dimension: did, rows: [{ characteristic: "position", diameter: true, tolerance: 0.1, material: "M", datums: [{ label: "A" }, { label: "B" }, { label: "C" }] }] });

  // Surface finish on the plate's bottom edge.
  await page.getByTestId("tool-annotation-surface").click();
  await page.getByTestId("surface-ra").selectOption("Ra 1.6");
  await page.getByTestId("surface-process").fill("ground");
  await page.getByTestId("surface-process").press("Enter");
  await clickTarget(page, "top", "top:eext_1/l5", 0.2);
  await hover(page, [top.box.min[0] + 30, top.box.min[1] - 12]);
  await shot(page, "surface-finish");
  await clickAt(page, [top.box.min[0] + 30, top.box.min[1] - 12]);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await annotations(page)).find((a) => a.type === "surface")).toMatchObject({ symbol: "removal", values: ["Ra 1.6"], process: "ground", on: "top:eext_1/l5" });

  // A note linking the model's material, with a leader to the plate's edge.
  await page.getByTestId("tool-annotation-note").click();
  const noteAt: V2 = [top.box.max[0] + 20, top.box.max[1] + 4];
  await clickAt(page, noteAt);
  await page.getByTestId("note-text").fill("FINISH: ZINC PLATE\nMATERIAL: ");
  await page.getByTestId("note-link").selectOption('$PRPMODEL:"material"');
  await expect(page.getByTestId("note-text")).toHaveValue('FINISH: ZINC PLATE\nMATERIAL: $PRPMODEL:"material"');
  await page.getByTestId("note-bold").click();
  await clickTarget(page, "top", "top:eext_1/l10", 0.25);
  await expect(page.getByTestId("note-leaders")).toHaveText("1 leader");
  await shot(page, "note");
  await page.getByTestId("session-ok").click();
  const note = (await annotations(page)).find((a) => a.type === "note" && String(a.text).startsWith("FINISH"))!;
  expect(note).toMatchObject({ bold: true, leaders: [{ to: "top:eext_1/l10" }] });
  await expect.poll(async () => (await sheetTexts(page)).join(" ")).toContain("FINISH: ZINC PLATE");
  expect((await sheetTexts(page)).join(" ")).not.toContain("$PRPMODEL");

  // Right-click on the dimension: quick tolerances; the format painter copies its format to another.
  await page.getByTestId(`drawing-item-${did}`).click({ button: "right" });
  await expect(page.getByTestId("ctx-tol-01")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("sheet-fit").click();
  await page.waitForTimeout(200);
  await shot(page, "bracket-finished");
  // Every edit is one undo step: the note goes, and comes back.
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await annotations(page)).some((a) => a.type === "note" && String(a.text).startsWith("FINISH"))).toBe(false);
  await page.getByTestId("redo").click();
  await expect.poll(async () => (await annotations(page)).some((a) => a.type === "note" && String(a.text).startsWith("FINISH"))).toBe(true);
});

test("the flange: an angle by the quadrant the pointer is in, Model Items brought into the plan view", async ({ page }) => {
  await newDrawing(page, "flange", "");
  const face = await target(page, "front", "front:ecut/l2");
  const pts = face.pts![0];
  const v: V2 = pts[0][0] < pts[pts.length - 1][0] ? pts[0] : pts[pts.length - 1];
  await zoomTo(page, v, 1500);
  await page.keyboard.press("d");
  await clickTarget(page, "front", "front:ecut/l2", 0.6);
  await clickTarget(page, "front", "front:ecut/l1", 0.3);
  // Over the narrow corner: 45°; below the face: 135°.
  await hover(page, [v[0] + 4, v[1] + 1.2]);
  await expect(page.getByTestId("sheet-preview").locator("text")).toHaveText(["45°"]);
  await shot(page, "angle-45");
  await hover(page, [v[0] + 3, v[1] - 2.5]);
  await expect(page.getByTestId("sheet-preview").locator("text")).toHaveText(["135°"]);
  await clickAt(page, [v[0] + 4, v[1] + 1.2]);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await annotations(page)).filter((a) => a.kind === "angular").length).toBe(1);
  await expect.poll(() => sheetTexts(page)).toContain("45°");
  await page.getByTestId("sheet-fit").click();

  // Model Items: everything New drawing put there taken away first, then brought from the model into the top view.
  const before = (await annotations(page)).length;
  await page.getByTestId("tool-annotation-model-items").click();
  for (const v of ["front", "right"]) {
    const box = page.getByTestId(`model-items-view-${v}`);
    if (await box.isChecked()) await box.uncheck();
  }
  await expect(page.getByTestId("model-items-view-top")).toBeChecked();
  await shot(page, "model-items");
  await page.getByTestId("model-items-import").click();
  await page.getByTestId("session-ok").click();
  // New drawing dimensioned it already: nothing twice.
  expect((await annotations(page)).length).toBe(before);

  // On a sheet without them: the holes' callout and the sketch's diameters come in.
  await page.getByTestId("dtab-layout").click();
  const doc = (await savedDocument(page)) as Doc & Record<string, unknown>;
  doc.drawing.sheets[0].annotations = [];
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await waitForRebuild(page);
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("dtab-annotation").click();
  await viewOf(page, "top");
  await page.getByTestId("tool-annotation-model-items").click();
  await page.getByTestId("model-items-import").click();
  await page.getByTestId("session-ok").click();
  await expect.poll(async () => (await annotations(page)).filter((a) => a.type === "hole").map((a) => a.hole)).toEqual(["bolt_hole"]);
  await expect.poll(async () => (await sheetTexts(page)).filter((t) => /^Ø(80|40|24)$/.test(t)).sort()).toEqual(["Ø24", "Ø40", "Ø80"]);
  await page.waitForTimeout(200);
  await shot(page, "flange-model-items");
});

test("a table frame with a weld: the weld symbol from the weld, Auto Balloon in a row", async ({ page }) => {
  const doc = JSON.parse(readFileSync("examples/table-frame.cocaide.json", "utf8"));
  doc.welds = [{ id: "w1", between: ["rail_front", "leg_a"], type: "fillet", size: 4, length: 160, process: "135", side: "both" }];
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await waitForRebuild(page);
  await expectVolume(page, "3,054,720");
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await page.getByTestId("dtab-annotation").click();
  const front = await viewOf(page, "front");

  // The weld symbol: click the leg the rail is welded to; the builder fills from w1 (fillet both sides, z4, 135 in the tail).
  const weldsBefore = (await annotations(page)).filter((a) => a.type === "weld").length;
  await page.getByTestId("tool-annotation-weld").click();
  const legEdge = (await hook(page, (h) => h.targets("front", "edge"))).find((t) => t.body === "leg_a" && t.visible && t.pts && Math.abs(t.pts[0][0][0] - t.pts[0][t.pts[0].length - 1][0]) < 0.01)!;
  await clickAt(page, onTarget(legEdge, 0.4));
  await expect(page.getByTestId("weld-from")).toHaveValue("w1");
  await expect(page.getByTestId("weld-arrow-symbol")).toHaveValue("fillet");
  await expect(page.getByTestId("weld-other-symbol")).toHaveValue("fillet");
  await expect(page.getByTestId("weld-arrow-size")).toHaveValue("z4");
  await expect(page.getByTestId("weld-process")).toHaveValue("135");
  await expect(page.getByTestId("weld-preview")).toBeVisible();
  await page.getByTestId("weld-field").check();
  await page.getByTestId("weld-standard-ASME").click();
  await expect(page.getByTestId("weld-preview")).toBeVisible();
  await page.getByTestId("weld-standard-ISO").click();
  const knee: V2 = [front.box.min[0] - 18, front.box.max[1] - 4];
  await hover(page, knee);
  await shot(page, "weld-builder");
  await clickAt(page, knee);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await annotations(page)).filter((a) => a.type === "weld").length).toBe(weldsBefore + 1);
  const weld = (await annotations(page)).filter((a) => a.type === "weld").pop()!;
  // Drawn as the table has it: it keeps up with the weld; only what was added by hand is its own.
  expect(weld).toMatchObject({ view: "front", weld: "w1", field: true });
  expect(weld.arrowSide).toBeUndefined();
  await expect.poll(async () => (await sheetTexts(page)).join(" ")).toContain("135");

  // Auto Balloon: the balloons New drawing made taken off, then every item of the front view in a row above it.
  const balloons = (await annotations(page)).filter((a) => a.type === "balloon").map((a) => String(a.id));
  for (const id of balloons) {
    await page.getByTestId(`drawing-item-${id}`).click();
    await page.keyboard.press("Delete");
  }
  await expect.poll(async () => (await annotations(page)).filter((a) => a.type === "balloon").length).toBe(0);
  await page.getByTestId(`drawing-item-front`).click();
  await page.getByTestId("drawing-balloon-all").click();
  await page.getByTestId("auto-balloon-layout-top").click();
  await expect(page.getByTestId("auto-balloon-count")).toHaveText("3 balloons to add in front");
  await shot(page, "auto-balloon");
  await page.getByTestId("session-ok").click();
  await expect.poll(async () => (await annotations(page)).filter((a) => a.type === "balloon").length).toBe(3);
  const added = (await annotations(page)).filter((a) => a.type === "balloon");
  for (const b of added) expect((b.at as V2)[1] + front.centre[1]).toBeGreaterThan(front.box.max[1]);
  await expect.poll(async () => (await sheetTexts(page)).filter((t) => ["1", "2", "3"].includes(t)).sort()).toEqual(expect.arrayContaining(["1", "2", "3"]));
  await page.getByTestId("sheet-fit").click();
  await page.waitForTimeout(200);
  await shot(page, "frame-finished");
});
