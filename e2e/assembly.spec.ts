// The Assembly tab in the browser: this part put in twice, a face of each
// picked and mated by a distance, the distance changed (the second part
// moves), fixed and floated, hidden, the parts list, interference and the
// assembly's STEP file. The kernel is real.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Vec3 } from "../src/doc/types";
import { expectVolume, openApp, savedDocument } from "./helpers";
import { boxGlb } from "../tests/glb-fixture";

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
  await expectVolume(page, "18,994.728"); // the bracket: an 80 × 40 × 6 plate with a hole
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

type Asm = { components: { id: string; part: string; at?: number[]; rotation?: number[]; fixed?: boolean; hidden?: boolean; transparent?: boolean }[]; mates?: { id: string; type: string; value?: number; aligned?: boolean; suppressed?: boolean; min?: number; max?: number }[] };
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

test("the mates tree: says what each mate is and joins, lights it up when hovered, suppresses and deletes from its row, its menu and the Delete key; lock and limit mates", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId("asm-insert").click();
    await page.getByTestId("asm-insert-self").click();
  }
  await expect(page.getByTestId("asm-component-bracket-2")).toBeVisible();
  await page.waitForTimeout(1500);
  const peeked = () => page.evaluate("window.__cocaideViewport.peeked()") as Promise<{ faces: number; edges: number }>;
  const pickTops = async () => {
    await clickAt(page, [-20, 10, 6]);
    await clickAt(page, [70, 10, 6], true);
    await expect(page.getByTestId("asm-mate-panel")).toBeVisible();
  };
  await pickTops();
  await page.getByTestId("asm-mate-btn-distance").click();
  const mates = async () => (await assembly(page))?.mates ?? [];
  await expect.poll(async () => (await mates()).length).toBe(1);
  // The row: what it is, with its value, and what it joins.
  await expect(page.getByTestId("asm-mate-title-distance1")).toHaveText("Distance 10 mm");
  await expect(page.getByTestId("asm-mate-distance1")).toContainText("bracket-1 flat face ↔ bracket-2 flat face");
  // Hovered: its two faces light up; a component hovered: all of it.
  await page.mouse.click(5, 5);
  await page.getByTestId("asm-mate-distance1").hover();
  await expect.poll(async () => (await peeked()).faces).toBe(2);
  await page.getByTestId("asm-component-bracket-2").hover();
  await expect.poll(async () => (await peeked()).faces).toBeGreaterThan(5);
  // A limit: a range (min to max) instead of one value; the row says it.
  await page.getByTestId("asm-mate-distance1").locator(".asm-row").click();
  await page.getByTestId("asm-prop-mate-limit").check();
  await expect.poll(async () => (await mates())[0]).toMatchObject({ min: 0, max: 20 });
  await expect(page.getByTestId("asm-mate-title-distance1")).toHaveText("Distance 0–20 mm");
  await expect(page.getByTestId("asm-prop-mate-now")).toContainText("inside the limits");
  await page.getByTestId("asm-prop-mate-max").fill("40");
  await page.getByTestId("asm-prop-mate-max").press("Enter");
  await expect(page.getByTestId("asm-mate-title-distance1")).toHaveText("Distance 0–40 mm");
  // Suppress from its row; back again from its menu (right-click).
  await page.getByTestId("asm-mate-distance1").hover();
  await page.getByTestId("asm-suppress-distance1").click();
  await expect.poll(async () => (await mates())[0].suppressed).toBe(true);
  await expect(page.getByTestId("asm-mate-title-distance1")).toContainText("(suppressed)");
  await page.getByTestId("asm-mate-distance1").click({ button: "right" });
  await page.getByTestId("asm-ctx-suppress").click();
  await expect.poll(async () => (await mates())[0].suppressed).toBeUndefined();
  // Delete from its row.
  await page.getByTestId("asm-mate-distance1").hover();
  await page.getByTestId("asm-delete-distance1").click();
  await expect.poll(async () => (await mates()).length).toBe(0);
  // A lock: anything of each; the row names the two parts; hovered, both light up; the Delete key deletes it.
  await pickTops();
  await page.getByTestId("asm-mate-btn-lock").click();
  await expect.poll(async () => (await mates())[0]).toMatchObject({ type: "lock", relative: { at: expect.any(Array), rotation: expect.any(Array) } });
  const lock = (await mates())[0] as unknown as { id: string };
  await expect(page.getByTestId(`asm-mate-title-${lock.id}`)).toHaveText("Lock");
  await expect(page.getByTestId(`asm-mate-${lock.id}`)).toContainText("bracket-1 ↔ bracket-2");
  await page.getByTestId(`asm-mate-${lock.id}`).hover();
  await expect.poll(async () => (await peeked()).faces).toBeGreaterThan(10);
  await page.getByTestId(`asm-mate-${lock.id}`).locator(".asm-row").click();
  await expect(page.getByTestId("asm-prop-mate-relock")).toBeVisible();
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await mates()).length).toBe(0);
  // A component deleted from its row, and from its menu.
  await page.getByTestId("asm-component-bracket-2").hover();
  await page.getByTestId("asm-delete-bracket-2").click();
  await expect(page.getByTestId("asm-component-bracket-2")).toHaveCount(0);
  await page.getByTestId("asm-component-bracket-1").click({ button: "right" });
  await expect(page.getByTestId("context-menu")).toContainText("Edit part");
  await page.getByTestId("asm-ctx-delete").click();
  await expect(page.getByTestId("assembly-tree")).toContainText("No components yet");
});

test("a part that isn't fixed is dragged in the view: free, it follows the mouse; mated, it slides only as its mates allow, and stops at a limit", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId("asm-insert").click();
    await page.getByTestId("asm-insert-self").click();
  }
  await expect(page.getByTestId("asm-component-bracket-2")).toBeVisible();
  await page.waitForTimeout(1500);
  const at = async () => ((await assembly(page))?.components[1].at ?? [0, 0, 0]) as number[];
  const screen = (p: Vec3) => page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), p);
  const drag = async (p: Vec3, dx: number, dy: number) => {
    const [x, y] = await screen(p);
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(x + (dx * k) / 8, y + (dy * k) / 8);
    await page.mouse.up();
  };
  // A click on it still selects it (and drags nothing).
  const before = await at();
  await clickAt(page, [70, 10, 6]);
  await expect(page.getByTestId("asm-component-props")).toContainText("bracket-2");
  expect(await at()).toEqual(before);
  // Free: dragged up the screen, it rises (and moves; nothing holds it).
  await drag([70, 10, 6], 0, -60);
  await expect.poll(async () => (await at())[2]).toBeGreaterThan(5);
  // The fixed one won't drag: the press only selects it.
  await drag([-20, 10, 6], 0, -60);
  expect(((await assembly(page))?.components[0].at ?? [0, 0, 0])).toEqual([0, 0, 0]);
  // Mated flush (tops coincident, aligned): dragged up the screen, it stays level and slides across.
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await at())[2]).toBe(0);
  await clickAt(page, [-20, 10, 6]);
  await clickAt(page, [70, 10, 6], true);
  await page.getByTestId("asm-mate-btn-coincident").click();
  await expect.poll(async () => (await assembly(page))?.mates?.length).toBe(1);
  const was = await at();
  await drag([70, 10, 6], 40, -60);
  await expect.poll(async () => JSON.stringify(await at())).not.toBe(JSON.stringify(was));
  expect(Math.abs((await at())[2])).toBeLessThan(0.01);
  // A distance limit of 0–20 between the tops instead: dragged far up, it stops at 20.
  await page.getByTestId(`asm-mate-${(await assembly(page))!.mates![0].id}`).locator(".asm-row").click();
  await page.getByTestId("asm-prop-mate-type").selectOption("distance");
  await expect.poll(async () => (await assembly(page))?.mates?.[0].type).toBe("distance");
  await page.getByTestId("asm-prop-mate-limit").check();
  await expect.poll(async () => (await assembly(page))?.mates?.[0]).toMatchObject({ min: expect.any(Number), max: expect.any(Number) });
  await page.getByTestId("asm-prop-mate-min").fill("0");
  await page.getByTestId("asm-prop-mate-min").press("Enter");
  await page.getByTestId("asm-prop-mate-max").fill("20");
  await page.getByTestId("asm-prop-mate-max").press("Enter");
  await expect.poll(async () => (await assembly(page))?.mates?.[0]).toMatchObject({ min: 0, max: 20 });
  const z0 = (await at())[2];
  const top = (await at()) as Vec3;
  await drag([top[0] - 20, top[1] + 10, top[2] + 6], 0, -400);
  await expect.poll(async () => (await at())[2]).toBeGreaterThan(z0 + 1);
  expect((await at())[2]).toBeLessThanOrEqual(20.01);
  expect((await at())[2]).toBeGreaterThan(19.9);
});

test("dragging a part pulls the parts connected to it along, as far as their mates allow: a part locked to a slider brings the slider", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("asm-insert").click();
    await page.getByTestId("asm-insert-self").click();
  }
  await expect(page.getByTestId("asm-component-bracket-3")).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByTestId("view-fit").click();
  await page.waitForTimeout(800);
  const comps = async () => ((await assembly(page))?.components ?? []).map((k) => (k.at ?? [0, 0, 0]) as number[]);
  const x3 = (await comps())[2][0];
  // bracket-2 flush on bracket-1 (it slides on it); bracket-3 locked to bracket-2.
  await clickAt(page, [-20, 10, 6]);
  await clickAt(page, [70, 10, 6], true);
  await page.getByTestId("asm-mate-btn-coincident").click();
  await expect.poll(async () => (await assembly(page))?.mates?.length).toBe(1);
  await clickAt(page, [70, 10, 6]);
  await clickAt(page, [x3 + 25, 5, 6], true);
  await page.getByTestId("asm-mate-btn-lock").click();
  await expect.poll(async () => (await assembly(page))?.mates?.length).toBe(2);
  const before = await comps();
  // Drag bracket-3 to the right: bracket-2 comes with it, both staying level (on bracket-1's top plane).
  const [sx, sy] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), [x3 + 25, 5, 6]);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(sx + 8 * k, sy + 3 * k);
  await page.mouse.up();
  await expect.poll(async () => JSON.stringify((await comps())[2])).not.toBe(JSON.stringify(before[2]));
  const after = await comps();
  const moved3 = [0, 1, 2].map((i) => after[2][i] - before[2][i]);
  const moved2 = [0, 1, 2].map((i) => after[1][i] - before[1][i]);
  expect(Math.hypot(...moved3)).toBeGreaterThan(5);
  // The two moved together (locked), and stayed level.
  for (let i = 0; i < 3; i++) expect(Math.abs(moved2[i] - moved3[i])).toBeLessThan(0.01);
  expect(Math.abs(after[1][2])).toBeLessThan(0.01);
  expect(after[0]).toEqual([0, 0, 0]);
  // One undo puts both back.
  await page.getByTestId("undo").click();
  await expect.poll(async () => JSON.stringify(await comps())).toBe(JSON.stringify(before));
});

test("the engine example opens on its Assembly tab: eleven parts, every kind of mate, every mate holding", async ({ page }) => {
  await page.locator("select").first().selectOption("engine (assembly)");
  await expect(page.getByTestId("mode-assembly")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-testid^="asm-component-"]')).toHaveCount(11, { timeout: 120_000 });
  const mates = page.locator(".asm-mate-row");
  await expect.poll(async () => mates.count(), { timeout: 60_000 }).toBeGreaterThan(25);
  // Built and solved: no mate shows as failing.
  await expect.poll(async () => page.locator(".asm-mate-row.failed").count(), { timeout: 60_000 }).toBe(0);
  for (const kind of ["Coincident", "Distance", "Parallel", "Perpendicular", "Angle", "Concentric, rotation locked", "Tangent", "Lock"]) await expect(page.getByTestId("assembly-tree")).toContainText(kind);
});

test("a .glb model put in from a file: carried in the file as a mesh part, drawn, sized to its real width", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await expect(page.getByTestId("asm-component-bracket-1")).toBeVisible();
  // A 2 × 0.5 × 1 m box with a texture (glTF Y up), as a furniture maker's export would be.
  await page.getByTestId("asm-insert").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("asm-insert-file").click();
  await (await chooser).setFiles({ name: "Ivory_sofa.glb", mimeType: "model/gltf-binary", buffer: Buffer.from(boxGlb(2, 0.5, 1)) });
  const row = page.locator('[data-testid^="asm-component-Ivory"]');
  await expect(row).toHaveCount(1);
  await expect(page.getByTestId("notice")).toContainText("2000 × 1000 × 500 mm as modelled");
  // In the file: a part with no features and the .glb, base64.
  const parts = ((await assembly(page)) as unknown as { parts: Record<string, { name: string; features: unknown[]; mesh: { glb: string; scale?: number } }> }).parts;
  const [key, part] = Object.entries(parts)[0];
  expect(part.name).toBe("Ivory sofa");
  expect(part.features).toEqual([]);
  expect(Buffer.from(part.mesh.glb, "base64").subarray(0, 4).toString()).toBe("glTF");
  // Selected: its size, as modelled; typed to its real width, the rest follow.
  await row.locator(".asm-row").click();
  await expect(page.getByTestId("asm-mesh-size")).toBeVisible();
  await expect(page.getByTestId("asm-mesh-size-x")).toHaveValue("2000");
  await expect(page.getByTestId("asm-edit-part")).toHaveCount(0);
  await page.getByTestId("asm-mesh-size-x").fill("3380");
  await page.getByTestId("asm-mesh-size-x").press("Enter");
  await expect.poll(async () => ((await assembly(page)) as unknown as { parts: Record<string, { mesh: { scale?: number } }> }).parts[key].mesh.scale).toBeCloseTo(1.69, 3);
  await expect(page.getByTestId("asm-mesh-size-y")).toHaveValue("1690");
  await expect(page.getByTestId("asm-mesh-size-z")).toHaveValue("845");
  // Drawn: the joined view has its face, textured.
  await expect.poll(async () => page.evaluate("window.__cocaideViewport.meshLooks?.()")).toEqual([expect.objectContaining({ texture: true })]);
});

test("the timber shed example opens on its Assembly tab with all 64 components built", async ({ page }) => {
  await page.locator("select").first().selectOption("timber shed (assembly)");
  await expect(page.getByTestId("mode-assembly")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-testid^="asm-component-"]')).toHaveCount(64, { timeout: 120_000 });
  // Every part built: the load bar fills and goes.
  await expect(page.getByTestId("load-bar")).toBeHidden({ timeout: 180_000 });
  await expect(page.getByTestId("status")).not.toHaveClass(/bad/);
});

test("each part put in is brought into view; Ctrl held, the handles' labels let clicks through; a mate hovered shows each side's direction", async ({ page }) => {
  await page.getByTestId("mode-assembly").click();
  const cam = () => page.evaluate("window.__cocaideViewport.camera()") as Promise<{ position: number[] }>;
  const inView = async (id: string) => {
    const at = (await assembly(page))!.components.find((k) => k.id === id)!.at ?? [0, 0, 0];
    const [x, y] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), at);
    const box = (await page.locator("canvas").first().boundingBox())!;
    return x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height;
  };
  for (let i = 1; i <= 3; i++) {
    const before = await cam();
    await page.getByTestId("asm-insert").click();
    await page.getByTestId("asm-insert-self").click();
    await expect(page.getByTestId(`asm-component-bracket-${i}`)).toBeVisible();
    if (i > 1) await expect.poll(async () => (await cam()).position).not.toEqual(before.position);
    await expect.poll(() => inView(`bracket-${i}`)).toBe(true);
  }
  // A part selected has its handles, labelled; with Ctrl down the labels take no clicks (a Ctrl-click picks what's under).
  await page.getByTestId("asm-component-bracket-2").click();
  await expect(page.locator(".eval-labels .eval-label").first()).toBeVisible();
  await page.mouse.move(5, 5);
  await page.keyboard.down("Control");
  await expect(page.locator(".eval-labels")).toHaveClass(/pass-through/);
  await page.keyboard.up("Control");
  await expect(page.locator(".eval-labels")).not.toHaveClass(/pass-through/);
  // A mate between two tops; hovered in the tree, an arrow for each side's direction, labelled.
  await page.mouse.click(5, 5);
  await page.waitForTimeout(800);
  await clickAt(page, [-20, 10, 6]);
  const b2 = (await assembly(page))!.components.find((k) => k.id === "bracket-2")!.at ?? [0, 0, 0];
  await clickAt(page, [b2[0] - 20, b2[1] + 10, b2[2] + 6], true);
  await expect(page.getByTestId("asm-mate-panel")).toBeVisible();
  await page.getByTestId("asm-mate-btn-parallel").click();
  await expect.poll(async () => ((await assembly(page))?.mates ?? []).length).toBe(1);
  await page.mouse.click(5, 5);
  const row = page.locator(".asm-mate-row").first();
  await row.hover();
  await expect(page.locator(".eval-label.arrow-label")).toHaveCount(2);
  await expect(page.locator(".eval-label.arrow-label").first()).toContainText("bracket-1");
  await page.screenshot({ path: "out/mate-arrows.png" });
});

test("a view picked while an assembly is still loading stays: its parts coming in don't frame the view again", async ({ page }) => {
  // A light part and a heavy one (200 boxes): the light one is drawn first, the heavy one comes in later.
  const box = (i: number) => [
    { id: `s${i}`, op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [(i % 20) * 120, Math.floor(i / 20) * 120], w: 100, h: 100 }] },
    { id: `e${i}`, op: "extrude", sketch: `s${i}`, distance: 50 + (i % 7) * 10, newBody: `b${i}` },
  ];
  const heavy = { version: 1, units: "mm", name: "heavy", features: Array.from({ length: 200 }, (_, i) => box(i)).flat() };
  const doc = { version: 1, units: "mm", name: "site", features: box(0), assembly: { parts: { heavy }, components: [{ id: "site", part: "self", fixed: true }, { id: "heavy-1", part: "heavy", at: [0, 500, 0], fixed: true }] } };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await page.getByTestId("mode-assembly").click();
  const drawn = async () => ((await page.evaluate("window.__cocaideViewport.vrItems()")) as string[]).length;
  await expect.poll(drawn, { timeout: 60_000, intervals: [100] }).toBeGreaterThan(0);
  const atPress = await drawn();
  await page.locator("canvas").first().click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+1");
  const front = async () => {
    const c = (await page.evaluate("window.__cocaideViewport.camera()")) as { position: number[]; target: number[] };
    const d = c.position.map((v, i) => v - c.target[i]);
    return Math.round((-d[1] / Math.hypot(...d)) * 100) / 100; // 1: looking north, from the front
  };
  await expect.poll(front).toBe(1);
  // The heavy part in: still from the front.
  await expect.poll(drawn, { timeout: 120_000 }).toBeGreaterThan(atPress + 100);
  await page.waitForTimeout(1500);
  expect(await front()).toBe(1);
});

test("an assembly put into an assembly: in as one sub-assembly, listed once, mated by a face of one of its parts, moving whole", async ({ page }) => {
  // A small "shed": two 100 cube walls 300 apart, in a document of its own.
  const wall = { version: 1, units: "mm", name: "wall", features: [
    { id: "s", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [
      { id: "a", type: "line", start: [0, 0], end: [100, 0] }, { id: "b", type: "line", start: [100, 0], end: [100, 100] },
      { id: "c", type: "line", start: [100, 100], end: [0, 100] }, { id: "e", type: "line", start: [0, 100], end: [0, 0] }] },
    { id: "x", op: "extrude", sketch: "s", distance: 100 }] };
  const shed = { version: 1, units: "mm", name: "shed", features: [], assembly: { parts: { wall }, components: [{ id: "wall-1", part: "wall", fixed: true }, { id: "wall-2", part: "wall", at: [300, 0, 0], fixed: true }] } };
  await page.getByTestId("mode-assembly").click();
  await page.getByTestId("asm-insert").click();
  await page.getByTestId("asm-insert-self").click();
  await page.getByTestId("asm-insert").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("asm-insert-file").click();
  await (await chooser).setFiles({ name: "shed.cocaide.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(shed)) });
  await expect(page.getByTestId("asm-component-shed-1")).toBeVisible();
  await expect(page.getByTestId("notice")).toContainText("sub-assembly (2 components, one piece)");
  // Carried whole (its own assembly in it), listed as one row.
  const a = (await assembly(page)) as unknown as { parts: Record<string, { assembly?: { components: unknown[] } }>; components: { id: string; at?: number[] }[] };
  expect(a.parts.shed.assembly?.components).toHaveLength(2);
  await expect(page.getByTestId("asm-bom")).toContainText("shed (sub-assembly, 2 components)");
  const at = a.components.find((k) => k.id === "shed-1")!.at ?? [0, 0, 0];
  // The bracket's top, then the shed's far wall's top: coincident; the whole shed comes down to the bracket's top.
  await page.waitForTimeout(1500);
  await clickAt(page, [-20, 10, 6]);
  await clickAt(page, [at[0] + 350, at[1] + 50, at[2] + 100], true);
  await expect(page.getByTestId("asm-mate-btn-coincident")).toBeEnabled();
  await page.getByTestId("asm-mate-btn-coincident").click();
  await expect.poll(async () => ((await assembly(page))?.components.find((k) => k.id === "shed-1")?.at ?? [0, 0, 0])[2]).toBeCloseTo(-94, 3);
  // The kernel takes it as one component: interference runs over it.
  await page.getByTestId("asm-interference").click();
  await expect(page.getByTestId("asm-clashes")).toBeVisible();
});
