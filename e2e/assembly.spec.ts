// The Assembly tab in the browser: this part put in twice, a face of each
// picked and mated by a distance, the distance changed (the second part
// moves), fixed and floated, hidden, the parts list, interference and the
// assembly's STEP file. The kernel is real.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Vec3 } from "../src/doc/types";
import { expectVolume, openApp, savedDocument } from "./helpers";

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
  await expectVolume(page, "18,994.728"); // the bracket: an 80 × 40 × 6 plate with a hole
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

type Asm = { components: { id: string; part: string; at?: number[]; rotation?: number[]; fixed?: boolean; hidden?: boolean; transparent?: boolean }[]; mates?: { id: string; type: string; value?: number; aligned?: boolean }[] };
const assembly = async (page: Page) => (await savedDocument(page)).assembly as Asm | undefined;

async function clickAt(page: Page, p: Vec3, ctrl = false) {
  const [x, y] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), p);
  await page.mouse.move(x, y);
  if (ctrl) await page.keyboard.down("Control");
  await page.mouse.click(x, y);
  if (ctrl) await page.keyboard.up("Control");
}

test("this part twice, mated by a distance between their tops; the distance changed moves the second", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  await expect(page.getByTestId("assembly-tree")).toContainText("No components yet");
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await expect(page.getByTestId("asm-component-bracket-1")).toBeVisible();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await expect(page.getByTestId("asm-component-bracket-2")).toBeVisible();
  await expect.poll(async () => (await assembly(page))?.components).toEqual([
    { id: "bracket-1", part: "self", fixed: true },
    { id: "bracket-2", part: "self", at: [90, 0, 0] },
  ]);
  // The view has both: pick the first's top face, Ctrl-click the second's.
  await page.waitForTimeout(1500);
  await clickAt(page, [-20, 10, 6]);
  await clickAt(page, [70, 10, 6], true);
  await expect(page.getByTestId("asm-mate-panel")).toBeVisible();
  await expect(page.getByTestId("asm-mate-btn-distance")).toBeEnabled();
  await expect(page.getByTestId("asm-mate-btn-concentric")).toBeDisabled();
  await page.screenshot({ path: "test-results/assembly-picked.png" });
  await page.getByTestId("asm-mate-btn-distance").click();
  await expect(page.getByTestId("asm-mate-distance1")).toBeVisible();
  // The faces are level now (0 apart): a distance starts at 10, and the second rises to it.
  await expect.poll(async () => (await assembly(page))?.mates).toEqual([{ id: "distance1", type: "distance", a: expect.anything(), b: expect.anything(), value: 10, aligned: true }]);
  await expect.poll(async () => (await assembly(page))?.components[1].at).toEqual([90, 0, 10]);
  // 20 mm: the second rises 20 (the tops are aligned, the second's 20 above the first's).
  await page.getByTestId("asm-prop-mate-value").fill("20");
  await page.getByTestId("asm-prop-mate-value").press("Enter");
  await expect.poll(async () => (await assembly(page))?.components[1].at).toEqual([90, 0, 20]);
  await expect(page.getByTestId("asm-prop-mate-status")).toHaveText("Holds.");
  await page.screenshot({ path: "test-results/assembly-mated.png" });

  // Undo takes the edit back; the parts list counts the part twice.
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await assembly(page))?.components[1].at).toEqual([90, 0, 10]);
  await expect(page.getByTestId("asm-bom")).toContainText("bracket2");
  // Interference: side by side, nothing overlaps.
  await page.getByTestId("asm-interference").click();
  await expect(page.getByTestId("asm-clashes")).toContainText("No components overlap");
  // The assembly as STEP: two named solids.
  const download = page.waitForEvent("download");
  await page.getByTestId("asm-export-step").click();
  const step = readFileSync(await (await download).path(), "utf8");
  for (const name of ["bracket-1", "bracket-2"]) expect(step).toContain(`'${name}'`);
});

test("a component dragged by its arrow moves, as one undo step; a fixed one has no handles", async ({ page }) => {
  type Hook = { project(p: number[]): [number, number]; handlePoint(id: string): [number, number] | null };
  await page.getByTestId("mode-assembly").click();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId("asm-insert").click();
    await page.getByTestId("asm-insert-self").click();
  }
  await expect(page.getByTestId("asm-component-bracket-2")).toBeVisible();
  await page.getByTestId("asm-component-bracket-1").locator(".asm-row").click();
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.handlePoint("bracket-1:move:z"))).toBeNull();
  await page.getByTestId("asm-component-bracket-2").locator(".asm-row").click();
  const point = () => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.handlePoint("bracket-2:move:z"));
  await expect.poll(point).not.toBeNull();
  const [x, y] = (await point())!;
  const [, y0] = await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.project([90, 0, 3]));
  const [, y30] = await page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.project([90, 0, 33]));
  const perMm = (y0 - y30) / 30;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - perMm * 10, { steps: 5 });
  await page.mouse.move(x, y - perMm * 25, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.round(((await assembly(page))?.components[1].at?.[2] ?? 0) / 5) * 5).toBe(25);
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await assembly(page))?.components[1].at).toEqual([90, 0, 0]);
});

test("an example part put in beside this one is carried in the file; a pin's hole to the bracket's by a concentric mate", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-example-flange").click();
  await expect(page.getByTestId("asm-component-flange-1")).toBeVisible();
  const a = await assembly(page);
  expect(Object.keys((a as unknown as { parts: Record<string, unknown> }).parts)).toEqual(["flange"]);
  expect(a?.components.map((k) => [k.id, k.part])).toEqual([
    ["bracket-1", "self"],
    ["flange-1", "flange"],
  ]);
  await expect(page.getByTestId("asm-bom")).toContainText("flange");
  // The Model tab is the bracket still: the assembly never changes the part.
  await page.getByTestId("mode-model").click();
  await expectVolume(page, "18,994.728");
  await page.getByTestId("mode-assembly").click();
  await expect(page.getByTestId("asm-component-flange-1")).toBeVisible();
  await page.screenshot({ path: "test-results/assembly-example.png" });
});

test("a STEP file put in: its hole found to line up with this part's (Suggested mates), applied in one click, then checked", async ({ page }) => {
  // The bracket as STEP, from the app's own export.
  const wait = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export STEP" }).click();
  const stepText = readFileSync((await (await wait).path())!, "utf8");
  await page.getByTestId("mode-assembly").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await page.getByTestId("asm-insert").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("asm-insert-file").click();
  await (await chooser).setFiles({ name: "bought-plate.step", mimeType: "application/octet-stream", buffer: Buffer.from(stepText) });
  await expect(page.getByTestId("asm-component-bought-plate-1")).toBeVisible();
  // Its part is the STEP, imported: carried in the file.
  const a = (await assembly(page)) as unknown as { parts: Record<string, { features: { op: string; format?: string }[] }> };
  expect(a.parts["bought-plate"].features[0]).toMatchObject({ op: "import", format: "step" });
  // Selected, it shows what it most likely mates with: the holes of one size in line.
  await page.getByTestId("asm-component-bought-plate-1").locator(".asm-row").click();
  await expect(page.getByTestId("asm-suggestions")).toContainText("Ø6.6 holes in line");
  await page.screenshot({ path: "test-results/assembly-suggest.png" });
  await page.getByTestId("asm-suggestions").locator("li", { hasText: "holes in line" }).first().getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => ((await assembly(page))?.mates ?? []).map((m) => m.type)).toEqual(["concentric", "coincident"]);
  // Checked: the mates hold; the plate can still turn about the hole's axis (one bolt hole: that's right).
  await page.getByTestId("asm-check").click();
  await expect(page.getByTestId("asm-check-results")).toContainText("Every mate holds, and every part is held.");
  await expect(page.getByTestId("asm-check-results")).toContainText(/bought-plate-1: can still turn about an axis along \[0, 0, -?1\] through \[30, 0,/);
  await expect(page.getByTestId("asm-clashes")).toContainText("No components overlap");
  await page.screenshot({ path: "test-results/assembly-checked.png" });
});

test("see-through, temporary axes, a transparent component and isolate", async ({ page }) => {
  // The part first: see-through and the axes are view toggles, the same in every tab.
  await page.getByTestId("view-xray").click();
  await expect(page.getByTestId("view-xray")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("view-axes").click();
  await expect(page.getByTestId("view-axes")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("view-xray").click();
  await page.getByTestId("mode-assembly").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-example-flange").click();
  await page.getByTestId("asm-component-flange-1").locator(".asm-row").click();
  // Transparent: kept in the file with the component.
  await page.getByTestId("asm-transparent").click();
  await expect.poll(async () => (await assembly(page))?.components.find((k) => k.id === "flange-1")).toMatchObject({ transparent: true });
  await expect(page.getByTestId("asm-transparent")).toHaveAttribute("aria-pressed", "true");
  // Isolate: only the flange drawn, a banner with the way out; a view state, not saved.
  await page.getByTestId("asm-isolate").click();
  await expect(page.getByTestId("asm-isolate-hint")).toContainText("Isolated: flange-1");
  await page.screenshot({ path: "test-results/assembly-isolate.png" });
  await page.getByTestId("asm-isolate-exit").click();
  await expect(page.getByTestId("asm-isolate-hint")).toHaveCount(0);
  expect((await assembly(page))?.components.map((k) => k.id)).toEqual(["bracket-1", "flange-1"]);
});

test("exploded in the Assembly tab, then drawn: the assembly's views, an exploded iso, its parts list and balloons", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-example-flange").click();
  await expect(page.getByTestId("asm-component-flange-1")).toBeVisible();
  await page.waitForTimeout(1500);
  // The flange's hole on the bracket's, as suggested: something to explode.
  await page.getByTestId("asm-component-flange-1").locator(".asm-row").click();
  await page.getByTestId("asm-suggestions").locator("li").first().getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => ((await assembly(page))?.mates ?? []).length).toBeGreaterThan(0);
  // Explode: the steps worked out from the mates, kept in the file; the view moves the flange off the bracket.
  await page.getByTestId("asm-explode").click();
  await expect(page.getByTestId("asm-explode-props")).toBeVisible();
  await expect.poll(async () => ((await assembly(page)) as unknown as { explode?: { components: string[] }[] })?.explode?.[0]?.components).toEqual(["flange-1"]);
  // Make drawing: two sheets, the second the exploded iso with the parts list and a balloon per part.
  await page.getByTestId("asm-make-drawing").click();
  await expect(page.getByTestId("sheet-tabs")).toContainText("Exploded view", { timeout: 30000 });
  const drawing = (await savedDocument(page)).drawing as { sheets: { name?: string; views: { id: string; source?: string; exploded?: boolean }[]; tables?: { kind: string }[]; annotations: { type: string; body?: string }[] }[] };
  const ex = drawing.sheets.find((s) => s.name === "Exploded view")!;
  expect(ex.views).toEqual([expect.objectContaining({ source: "assembly", exploded: true })]);
  expect(ex.tables?.map((t) => t.kind)).toEqual(["bom"]);
  expect(ex.annotations.map((a) => a.body).sort()).toEqual(["bracket-1", "flange-1"]);
  const asm = drawing.sheets.find((s) => s.name === "Assembly")!;
  expect(asm.views.map((v) => v.id)).toEqual(["asm_front", "asm_top", "asm_right"]);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "test-results/assembly-drawing.png" });
});

test("the assembly sectioned: a plane through both components, caps in each one's colour, one left whole, dragged and off", async ({ page }) => {
  type Hook = { section(): { normal: number[]; constant: number; capped: boolean } | null; sections(): { planes: unknown[]; bodies: string[] | null; capped: boolean; planesDrawn: number } };
  const hook = () => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.sections());
  await page.getByTestId("mode-assembly").click();
  await expect(page.getByTestId("asm-section")).toBeDisabled();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId("asm-insert").click();
    await page.getByTestId("asm-insert-self").click();
  }
  await expect(page.getByTestId("asm-component-bracket-2")).toBeVisible();
  await page.getByTestId("asm-section").click();
  await expect(page.getByTestId("asm-section-dock").getByTestId("section-panel")).toBeVisible();
  await expect(page.getByTestId("asm-section")).toHaveAttribute("aria-pressed", "true");
  // Front through the middle of the assembly, capped, the caps each component's colour.
  await expect.poll(async () => (await hook()).planes.length).toBe(1);
  await expect.poll(async () => (await hook()).capped).toBe(true);
  await expect(page.getByTestId("section-cap-colour")).toHaveValue("bodies");
  await expect(page.getByTestId("section-cap-colour").locator("option[value=bodies]")).toHaveText("Each component's colour");
  // The second component left whole.
  await page.getByTestId("section-bodies").locator("summary").click();
  await expect(page.getByTestId("section-bodies").locator("summary")).toHaveText("Section components: all");
  await page.getByTestId("section-body-bracket-2").uncheck();
  await expect.poll(async () => (await hook()).bodies).toEqual(["bracket-1"]);
  // Moved by its offset, then off from the toolbar.
  await page.getByTestId("section-offset").fill("3");
  await page.getByTestId("section-offset").press("Enter");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.section()?.constant)).toBe(3);
  await page.getByTestId("asm-section").click();
  await expect(page.getByTestId("asm-section-dock")).toHaveCount(0);
  await expect.poll(async () => (await hook()).planes.length).toBe(0);
  // The part's own section (Model tab) is its own: still off.
  await page.getByTestId("mode-model").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cocaideViewport: Hook }).__cocaideViewport.section())).toBeNull();
});

test("measuring in the assembly: a face of one component, then the gap to a face of another", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  await expect(page.getByTestId("asm-measure")).toBeDisabled();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId("asm-insert").click();
    await page.getByTestId("asm-insert-self").click();
  }
  await expect(page.getByTestId("asm-component-bracket-2")).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByTestId("asm-measure").click();
  await expect(page.getByTestId("asm-measure")).toHaveAttribute("aria-pressed", "true");
  const panel = page.getByTestId("asm-measure-dock").getByTestId("measure-panel");
  await expect(panel).toContainText("one for its size, two for the distance");
  // One face: its size, named with its component.
  await clickAt(page, [-20, 10, 6]);
  await expect(panel).toContainText("Flat face of bracket-1");
  // A second click adds (no Ctrl): the second bracket's top, 10 apart (one ends at x 40, the other starts at 50).
  await clickAt(page, [70, 10, 6]);
  await expect(panel).toContainText("Flat face of bracket-1 to flat face of bracket-2");
  await expect(panel).toContainText("10 mm");
  // Measuring picks don't make mates or select components; Clear starts again, the button turns it off.
  await expect(page.getByTestId("asm-mate-panel")).toHaveCount(0);
  await panel.getByTestId("measure-clear").click();
  await expect(panel).toContainText("one for its size, two for the distance");
  await page.getByTestId("asm-measure").click();
  await expect(page.getByTestId("asm-measure-dock")).toHaveCount(0);
});

test("a part carried in the file: Edit part opens it on the Model tab, Done puts it back (Cancel doesn't, a reload keeps the edit); Replace from file swaps in a newer copy where it is", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-example-flange").click();
  await expect(page.getByTestId("asm-component-flange-1")).toBeVisible();
  const parts = async () => ((await savedDocument(page)).assembly as { parts: Record<string, { name: string; features: unknown[] }> }).parts;
  await page.getByTestId("asm-component-flange-1").locator(".asm-row").click();
  // Edit part: the flange on the Model tab, the bar saying so; renamed, then Done.
  await page.getByTestId("asm-edit-part").click();
  await expect(page.getByTestId("part-edit-bar")).toContainText("flange");
  await expect(page.getByTestId("doc-name")).toHaveValue("flange");
  await expect(page.getByTestId("mode-model")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("doc-name").fill("flange-mk2");
  await page.getByTestId("doc-name").press("Enter");
  await page.getByTestId("part-edit-done").click();
  await expect(page.getByTestId("part-edit-bar")).toHaveCount(0);
  await expect(page.getByTestId("doc-name")).toHaveValue("bracket");
  await expect(page.getByTestId("mode-assembly")).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await parts()).flange.name).toBe("flange-mk2");
  await expect(page.getByTestId("asm-bom")).toContainText("flange-mk2");
  // Undo takes the edit back in one step.
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await parts()).flange.name).toBe("flange");
  await page.getByTestId("redo").click();
  await expect.poll(async () => (await parts()).flange.name).toBe("flange-mk2");
  // Edited again and Cancelled: nothing changes. Reloaded in the middle: still editing, the assembly kept aside.
  await page.getByTestId("asm-component-flange-1").locator(".asm-row").click();
  await page.getByTestId("asm-edit-part").click();
  await page.getByTestId("doc-name").fill("scrap");
  await page.getByTestId("doc-name").press("Enter");
  await page.reload();
  await expect(page.getByTestId("part-edit-bar")).toContainText("flange-mk2");
  await expect(page.getByTestId("doc-name")).toHaveValue("scrap");
  await page.getByTestId("part-edit-cancel").click();
  await expect(page.getByTestId("doc-name")).toHaveValue("bracket");
  await expect.poll(async () => (await parts()).flange.name).toBe("flange-mk2");
  // Replace from file: a newer flange (renamed) in its place; the components stay where they are.
  const before = ((await savedDocument(page)).assembly as Asm).components;
  const newer = { ...(await parts()).flange, name: "flange-mk3" };
  await page.getByTestId("asm-component-flange-1").locator(".asm-row").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("asm-replace-part").click();
  await (await chooser).setFiles({ name: "flange-mk3.cocaide.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(newer)) });
  await expect.poll(async () => (await parts()).flange.name).toBe("flange-mk3");
  await expect(page.getByTestId("notice")).toContainText("Replaced flange-mk2 with flange-mk3.cocaide.json");
  expect(((await savedDocument(page)).assembly as Asm).components).toEqual(before);
  // This part's own component: Edit part goes to the Model tab; no Replace.
  await page.getByTestId("asm-component-bracket-1").locator(".asm-row").click();
  await expect(page.getByTestId("asm-replace-part")).toHaveCount(0);
  await page.getByTestId("asm-edit-part").click();
  await expect(page.getByTestId("mode-model")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("part-edit-bar")).toHaveCount(0);
});

test("a parallel mate starts the way the faces sit (aligned) and Flip turns the second part over (anti-aligned)", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId("asm-insert").click();
    await page.getByTestId("asm-insert-self").click();
  }
  await expect(page.getByTestId("asm-component-bracket-2")).toBeVisible();
  await page.waitForTimeout(1500);
  await clickAt(page, [-20, 10, 6]);
  await clickAt(page, [70, 10, 6], true);
  await expect(page.getByTestId("asm-mate-btn-parallel")).toBeEnabled();
  await expect(page.getByTestId("asm-mate-btn-tangent")).toBeDisabled();
  await page.getByTestId("asm-mate-btn-parallel").click();
  await expect.poll(async () => (await assembly(page))?.mates?.[0]).toMatchObject({ type: "parallel", aligned: true });
  await expect(page.getByTestId("asm-prop-mate-way")).toHaveText("Aligned (the same way)");
  await page.getByTestId("asm-prop-mate-flip").click();
  await expect.poll(async () => (await assembly(page))?.mates?.[0]).toMatchObject({ type: "parallel", opposed: true });
  await expect(page.getByTestId("asm-prop-mate-way")).toHaveText("Anti-aligned (opposite ways)");
  // The second bracket is upside down now: turned half round about X or Y.
  await expect.poll(async () => {
    const r = (await assembly(page))?.components[1].rotation ?? [0, 0, 0];
    return Math.round(Math.abs(Math.cos((r[0] * Math.PI) / 180) * Math.cos((r[1] * Math.PI) / 180)));
  }).toBe(1);
  const r = (await assembly(page))?.components[1].rotation ?? [0, 0, 0];
  expect(Math.cos((r[0] * Math.PI) / 180) * Math.cos((r[1] * Math.PI) / 180)).toBeLessThan(-0.99);
});
