// Phase Q wave Q3B in the browser: AI full drawing detailing. "Detail with
// AI…" on the bracket's sheet with a SCRIPTED model (the Messages API is
// answered by a script, not a model): the plan card (an item unticked, the
// tolerance class changed), the model refining from the applied plan, the
// proposal accepted, the annotations on the sheet. Then Auto-detail by rules
// only (no model): the plan in the tool's panel, applied, OK. The kernel is
// real.

import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument, scriptModel, text, tool, useKey } from "./helpers";

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

async function bracketDrawing(page: Page) {
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  await page.getByTestId("mode-drawing").click();
  await page.getByTestId("drawing-new-empty").click();
  await expect(page.getByTestId("drawing-item-front")).toContainText("section A-A of top");
  await page.getByTestId("dtab-annotation").click();
}

type Ann = { id: string; type: string; rows?: { characteristic: string }[] };
const annotationsOf = async (page: Page) => {
  const d = (await savedDocument(page)).drawing as { generalTolerance?: string; revisions?: unknown[]; sheets: { annotations: Ann[] }[] };
  return { d, anns: d.sheets.flatMap((s) => s.annotations) };
};

test("Detail with AI…: the plan card, the model refines from it, the proposal accepted onto the sheet", async ({ page }) => {
  await useKey(page);
  const sent = await scriptModel(page, [[tool("checkDrawing", {})], [text("Datum A is the mounting face, B and C the left and bottom edges; the M6 clearance hole is positioned Ø0.1 Ⓜ to A|B|C.")], [text("Done.")], [text("Done.")]]);
  await bracketDrawing(page);
  await page.getByTestId("tool-ai-detail").click();
  // The plan by rules, before any model is asked.
  const card = page.getByTestId("detail-plan");
  await expect(card).toBeVisible();
  await expect(card).toContainText("clearance M6");
  await expect(card).toContainText("Position Ø0.1 Ⓜ A|B|C");
  expect(sent.length).toBe(0);
  await page.getByTestId("detail-item-revision").uncheck();
  await page.getByTestId("detail-tolerance").selectOption("ISO 2768-fH");
  await page.getByTestId("detail-run-ai").click();
  await expect(page.getByTestId("ask-proposal")).toBeVisible({ timeout: 60_000 });
  // The model started from the applied plan and had the detailing tools.
  expect(JSON.stringify(sent[0].body.messages[0].content)).toContain("applied");
  expect(sent[0].body.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["applyDetailPlan", "checkDrawing", "renderSheet"]));
  await expect(page.getByTestId("ask-text")).toContainText("Datum A is the mounting face");
  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  const { d, anns } = await annotationsOf(page);
  expect(d.generalTolerance).toBe("ISO 2768-fH");
  expect(d.revisions).toBeUndefined();
  expect(anns.some((a) => a.type === "gdt" && a.rows?.some((r) => r.characteristic === "position"))).toBe(true);
  expect(anns.some((a) => a.type === "gdt" && a.rows?.some((r) => r.characteristic === "flatness"))).toBe(true);
  expect(anns.some((a) => a.type === "surface")).toBe(true);
  // On the sheet: the frames and the general tolerance in the notes.
  await expect(page.getByTestId("sheet").locator(".sheet-paper")).toContainText("ISO 2768-fH");
});

test("Auto-detail by rules: the plan in the tool's panel, applied on the sheet, OK keeps it; right-click a view to detail it", async ({ page }) => {
  await bracketDrawing(page);
  await page.getByTestId("tool-ai-auto-detail").click();
  const card = page.getByTestId("detail-plan");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("detail-run-ai")).toHaveCount(0);
  await page.getByTestId("detail-item-surface_general").uncheck();
  await page.getByTestId("detail-run-rules").click();
  await expect(page.getByTestId("auto-detail-done")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("session-ok").click();
  await expect(page.getByTestId("drawing-session")).toHaveCount(0);
  const { d, anns } = await annotationsOf(page);
  expect(d.generalTolerance).toBe("ISO 2768-mK");
  expect(anns.filter((a) => a.type === "gdt").length).toBeGreaterThanOrEqual(2);
  expect(anns.some((a) => a.type === "surface" && (a as { general?: boolean }).general)).toBe(false);
  await expect(page.getByTestId("sheet").locator(".sheet-paper")).toContainText("FIRST ISSUE");
  // The view's right-click menu offers to detail it with the AI.
  await page.getByTestId("drawing-item-top").click({ button: "right" });
  await expect(page.getByTestId("ctx-ai-detail-view")).toBeVisible();
  await expect(page.getByTestId("ctx-ai-gdt")).toBeVisible();
  await page.keyboard.press("Escape");
});

type V2 = [number, number];
type Target = { ref: string; kind: string; at: V2; feature?: string; visible: boolean; circle?: { c: V2; r: number } };
const hook = <T,>(page: Page, f: (h: { toScreen(x: number, y: number): V2; targets(view: string, kind?: string): Target[] }, arg: unknown) => T, arg?: unknown) =>
  page.evaluate(([src, a]) => {
    const h = (window as unknown as { __cocaideSheet?: unknown }).__cocaideSheet;
    return h ? new Function("h", "a", `return (${src})(h, a)`)(h, a) : null;
  }, [f.toString(), arg] as const) as Promise<T>;

test("contextual asks: right-click a hole's circle in a view: Add a fit… opens the AI on it; a callout: Add a fit…, a dimension: Tolerance this…", async ({ page }) => {
  await useKey(page);
  await bracketDrawing(page);
  // The bracket's hole, seen round in the top view.
  await expect.poll(() => hook(page, (h) => h.targets("top", "circle").filter((t) => t.visible && t.circle).length)).toBeGreaterThan(0);
  const hole = (await hook(page, (h) => h.targets("top", "circle").find((t) => t.visible && t.circle)!))!;
  // At 45° on the circle: off the centre mark's lines.
  const edge = [hole.circle!.c[0] + hole.circle!.r * Math.SQRT1_2, hole.circle!.c[1] + hole.circle!.r * Math.SQRT1_2] as V2;
  const [x, y] = await hook(page, (h, a) => h.toScreen((a as V2)[0], (a as V2)[1]), edge);
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.getByTestId("ctx-ai-fit-geo")).toBeVisible();
  await page.getByTestId("ctx-ai-fit-geo").click();
  // The ask opens on the view with the circle selected and the prompt to finish (nothing sent yet).
  await expect(page.getByTestId("ask-input")).toHaveValue(/ISO 286 fit/);
  expect(await page.getByTestId("ask-input").inputValue()).toContain(hole.ref);
  await page.keyboard.press("Escape");
  // A hole callout and a dimension in the tree.
  const doc = (await savedDocument(page)).drawing as { sheets: { annotations: { id: string; type: string }[] }[] };
  const anns = doc.sheets.flatMap((s) => s.annotations);
  const callout = anns.find((a) => a.type === "hole")!;
  const dim = anns.find((a) => a.type === "dimension")!;
  await page.getByTestId(`drawing-item-${callout.id}`).click({ button: "right" });
  await expect(page.getByTestId("ctx-ai-fit")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId(`drawing-item-${dim.id}`).click({ button: "right" });
  await expect(page.getByTestId("ctx-ai-tolerance")).toBeVisible();
});
