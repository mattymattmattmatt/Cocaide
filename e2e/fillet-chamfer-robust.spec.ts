// Fillets, chamfers and dimensions to model edges as a fabricator met them
// (user report: "I kept getting errors doing fillets and chamfers";
// "dimensioning to an edge of the part only went to the vertex"):
// an L-shaped bracket's inside corner with the outside edges that run into
// it, every edge of a face, a radius too large (the message names the edge
// and the radius that fits), the smooth edge beside a round, the three
// chamfer types, a member body, an upstream change; and in a sketch, Smart
// Dimension from a line to the part's edge (facing, zoomed out on a short
// edge, turned on an edge seen end-on), with the reference made for it, and
// relations to a model edge.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, okFeature, openApp, savedDocument, sketchClick, viewportClick, waitForRebuild } from "./helpers";

type Raw = Record<string, unknown>;
type Hook = { __cocaideViewport: { project(p: number[]): [number, number] } };
const CORNER = 1 - Math.PI / 4;

let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = await openApp(page);
});
test.afterEach(() => expect(problems).toEqual([]));

async function openDocument(page: Page, doc: unknown) {
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
}
const features = async (page: Page) => (await savedDocument(page)).features as Raw[];
const feature = async (page: Page, id: string) => (await features(page)).find((f) => f.id === id);
const volume = async (page: Page) => Number((await page.getByTestId("volume").textContent())!.replace(/[^\d.]/g, ""));
const example = (name: string) => JSON.parse(readFileSync(`examples/${name}.cocaide.json`, "utf8"));

const FRONT = { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] };
const line = (id: string, a: number[], b: number[]) => ({ id, type: "line", start: a, end: b });
const pts = [[0, 0], [60, 0], [60, 6], [6, 6], [6, 40], [0, 40]];
/** An L-shaped bracket 30 deep (y −15..15): a 60 × 6 foot along X, a 6 × 40 upright at x 0..6. */
const L_DOC = {
  version: 1,
  units: "mm",
  name: "L bracket",
  features: [
    { id: "s1", op: "sketch", plane: FRONT, entities: pts.map((p, i) => line(`l${i + 1}`, p, pts[(i + 1) % pts.length])), constraints: [] },
    { id: "ext_1", op: "extrude", sketch: "s1", distance: 30, extent: "midplane" },
  ],
};
const L_VOLUME = 60 * 6 * 30 + 6 * 34 * 30;

test.describe("fillets and chamfers", () => {
  test("L bracket: the inside corner, then the foot's thin edges: the radius comes down to suit them, and it builds", async ({ page }) => {
    await openDocument(page, L_DOC);
    await page.getByTestId("tool-fillet").click();
    await viewportClick(page, [6, 0, 6]);
    // The inside corner has 34 and 54 mm beside it: 3.
    await expect.poll(async () => (await feature(page, "fillet_1"))?.radius).toBe(3);
    await waitForRebuild(page);
    await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
    // The foot's top front edge has its 6 mm thickness beside it: 3 would not suit it; 0.5 does.
    await viewportClick(page, [33, -15, 6]);
    await expect.poll(async () => (await feature(page, "fillet_1"))?.radius).toBe(0.5);
    await viewportClick(page, [6, -15, 23]);
    await viewportClick(page, [60, -15, 3]);
    await expect(page.getByTestId("session-prompt-text")).toHaveText(/4 picked/);
    await waitForRebuild(page);
    await expect(page.getByTestId("session-prompt")).not.toContainText("It fails");
    await okFeature(page);
    await waitForRebuild(page);
    await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
    expect(await volume(page)).not.toBeCloseTo(L_VOLUME, 0);
  });

  test("L bracket: every edge of the foot's top face (an inside corner among outside edges) fillets and chamfers", async ({ page }) => {
    for (const tool of ["tool-fillet", "tool-chamfer"]) {
      await openDocument(page, L_DOC);
      await viewportClick(page, [33, 5, 6]);
      await expect(page.getByTestId("selection")).toContainText(/face/i);
      await page.getByTestId(tool).click();
      await waitForRebuild(page);
      await expect(page.getByTestId("session-prompt")).not.toContainText("It fails");
      await okFeature(page);
      await waitForRebuild(page);
      await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
    }
  });

  test("a radius too large: the message names the edge, the room beside it and the radius that fits; that radius builds", async ({ page }) => {
    await page.getByTestId("tool-fillet").click();
    await viewportClick(page, [0, -20, 6]);
    await expect.poll(async () => (await feature(page, "fillet_1"))?.radius).toBe(0.5);
    await commit(page, "prop-radius", "8");
    await waitForRebuild(page);
    const prompt = page.getByTestId("prop-feature-error").first();
    await expect(prompt).toContainText("radius 8 is too large for the 6 mm face beside it: the most that fits here is radius ≈ 5.");
    await expect(prompt).toContainText("(straight, +X, length 80, at [0, -20, 6])");
    const fits = Number(/≈ ([\d.]+) mm/.exec((await prompt.textContent())!)![1]);
    await commit(page, "prop-radius", String(fits));
    await waitForRebuild(page);
    await expect(page.getByTestId("prop-feature-error")).toHaveCount(0);
    await okFeature(page);
    await waitForRebuild(page);
    await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  });

  test("next to an earlier round: its smooth edge says why; the sharp top boundary as a tangent chain builds", async ({ page }) => {
    await openDocument(page, {
      version: 1,
      units: "mm",
      name: "rounded",
      features: [
        { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 30 }], constraints: [] },
        { id: "ext_1", op: "extrude", sketch: "s1", distance: 15 },
        { id: "corners", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" }, radius: 5 },
      ],
    });
    await page.getByTestId("tool-fillet").click();
    // Where the R5 round meets the front face: a smooth edge.
    await viewportClick(page, [-15, -15, 7.5]);
    await waitForRebuild(page);
    await expect(page.getByTestId("prop-feature-error").first()).toContainText("the faces meet smoothly there (it is the edge of a round), so there is no corner to round: pick the sharp edge beside it instead");
    // Cancel; the top front edge instead, with its tangency chain: the whole top boundary.
    await page.getByTestId("session-cancel").click();
    await expect(page.getByTestId("session-bar")).toHaveCount(0);
    await page.getByTestId("tool-fillet").click();
    await viewportClick(page, [0, -15, 15]);
    await expect(page.getByTestId("session-prompt-text")).toHaveText(/8 picked/);
    await waitForRebuild(page);
    await expect(page.getByTestId("session-prompt")).not.toContainText("It fails");
    await okFeature(page);
    await waitForRebuild(page);
    await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  });

  test("chamfer: equal, two distances flipped, distance and angle; exact volumes", async ({ page }) => {
    const BRACKET = 80 * 40 * 6 - Math.PI * 3.3 * 3.3 * 6;
    await page.getByTestId("tool-chamfer").click();
    await viewportClick(page, [0, -20, 6]);
    await expect.poll(async () => (await feature(page, "chamfer_1"))?.distance).toBe(0.5);
    await commit(page, "prop-chamfer-distance", "2");
    await page.getByTestId("prop-chamfer-type").selectOption("distances");
    await commit(page, "prop-chamfer-distance2", "4");
    await page.getByTestId("prop-chamfer-flip").check();
    await waitForRebuild(page);
    await expect(page.getByTestId("session-prompt")).not.toContainText("It fails");
    await page.getByTestId("prop-chamfer-type").selectOption("angle");
    await commit(page, "prop-chamfer-angle", "30");
    await waitForRebuild(page);
    await okFeature(page);
    await waitForRebuild(page);
    expect(await feature(page, "chamfer_1")).toMatchObject({ distance: 2, angle: 30, flip: true });
    // a·b·L/2 with b = 2·tan 30°, along the 80 mm edge.
    await expect.poll(() => volume(page)).toBeCloseTo(BRACKET - (2 * 2 * Math.tan(Math.PI / 6) * 80) / 2, 1);
  });

  test("a member body's end edge: the smart radius suits its 3 mm wall, and it builds", async ({ page }) => {
    await openDocument(page, example("frame-members"));
    await page.getByTestId("tool-fillet").click();
    await viewportClick(page, [0, -20, 900]);
    await expect.poll(async () => (await feature(page, "fillet_1"))?.radius).toBe(0.3);
    await waitForRebuild(page);
    await expect(page.getByTestId("session-prompt")).not.toContainText("It fails");
    await okFeature(page);
    await waitForRebuild(page);
    await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  });

  test("the bracket made thicker after a fillet on its top edge: the fillet follows the edge", async ({ page }) => {
    await page.getByTestId("tool-fillet").click();
    await viewportClick(page, [0, -20, 6]);
    await expect.poll(async () => (await feature(page, "fillet_1"))?.radius).toBe(0.5);
    await okFeature(page);
    await waitForRebuild(page);
    const before = await volume(page);
    await page.getByTestId("feature-ext_1").locator(".feature-row").dblclick();
    await expect(page.getByTestId("session-title")).toHaveText("Edit ext_1");
    await commit(page, "prop-distance", "10");
    await okFeature(page);
    await waitForRebuild(page);
    await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
    // 4 mm more plate (less the hole), the same round along the 80 mm top edge.
    expect(await volume(page)).toBeCloseTo(before + 80 * 40 * 4 - Math.PI * 3.3 * 3.3 * 4, 0);
    void CORNER;
  });
});

// ---------------------------------------------------------------- dimensions to model edges in a sketch

async function screenAt(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(
    ([x, y]) => {
      const m = (document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement).getScreenCTM()!;
      return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as [number, number];
    },
    [x, y],
  );
}

async function sketchOn(page: Page, at: [number, number, number]) {
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  await viewportClick(page, at);
  await expect(page.getByTestId("selection")).toContainText(/face/i);
  await page.getByTestId("tool-sketch").click();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
  await expect(page.getByTestId("sketch-canvas")).toHaveAttribute("data-facing", "true");
}

async function drawLine(page: Page, a: [number, number], b: [number, number]) {
  await page.getByTestId("tool-line").click();
  await sketchClick(page, ...a);
  await sketchClick(page, ...b);
  await page.getByTestId("tool-select").click();
}

/** The last sketch's line l1, as the solver left it. */
async function l1(page: Page): Promise<{ start: number[]; end: number[] }> {
  const d = await page.locator('[data-testid=sketch-canvas] path[data-entity="l1"]').getAttribute("d");
  const m = /^M(-?[\d.e-]+) (-?[\d.e-]+)L(-?[\d.e-]+) (-?[\d.e-]+)/.exec(d ?? "")!;
  return { start: [Number(m[1]), Number(m[2])], end: [Number(m[3]), Number(m[4])] };
}

test.describe("dimensions to the part's edges in a sketch", () => {
  test("facing the top face: a line's distance to the part's front edge, the edge made a reference; then a point to the right edge", async ({ page }) => {
    await sketchOn(page, [0, 12, 6]);
    await drawLine(page, [-20, 6], [20, 6]);
    await page.getByTestId("tool-dimension").click();
    // Hovering the edge lights the whole edge.
    const [ex, ey] = await screenAt(page, 0, -20);
    await page.mouse.move(ex, ey);
    await expect(page.locator("[data-testid=model-edges] path.hover")).toHaveCount(1);
    await sketchClick(page, 0, 6);
    await sketchClick(page, 0, -20);
    await expect(page.getByTestId("modify-box")).toContainText("Distance between");
    await expect(page.getByTestId("modify-value")).toHaveValue("26");
    await page.getByTestId("modify-value").fill("12");
    await page.getByTestId("modify-value").press("Enter");
    await expect(page.getByTestId("constraint-list")).toContainText("model edge (straight, 80 mm, +X)");
    await expect(page.locator("[data-testid=sketch-canvas] path.entity.reference")).toHaveCount(1);
    expect((await l1(page)).start[1]).toBeCloseTo(-8, 6);
    // The line's end to the right-hand edge (x = 40): 20.
    await sketchClick(page, 20, -8);
    await sketchClick(page, 40, 10);
    await expect(page.getByTestId("modify-box")).toContainText("Distance to line");
    await expect(page.getByTestId("modify-value")).toHaveValue("20");
    await page.getByTestId("modify-value").fill("15");
    await page.getByTestId("modify-value").press("Enter");
    expect((await l1(page)).end[0]).toBeCloseTo(25, 6);
    await page.getByTestId("finish-sketch").click();
    await waitForRebuild(page);
    const sketch = (await features(page)).at(-1) as { entities: Raw[] };
    expect(sketch.entities.filter((e) => e.ref)).toHaveLength(2);
  });

  test("zoomed out on the front face: the middle of a 6 mm edge is the edge, not its corner; right by the corner, the corner", async ({ page }) => {
    await sketchOn(page, [0, -20, 3]);
    await drawLine(page, [-10, 2], [10, 2]);
    const box = (await page.getByTestId("sketch-canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -400);
    await page.waitForTimeout(500);
    const [ax] = await screenAt(page, 0, 0);
    const [bx] = await screenAt(page, 1, 0);
    expect(bx - ax).toBeLessThan(3);
    // The line's end, then the middle of the right-hand upright edge (x = 40, 0..6): the point's distance to the edge.
    await page.getByTestId("tool-dimension").click();
    await sketchClick(page, 10, 2);
    await sketchClick(page, 40, 3);
    await expect(page.getByTestId("modify-box")).toContainText("Distance to line");
    await expect(page.getByTestId("modify-value")).toHaveValue("30");
    await page.keyboard.press("Escape");
    // Right on the corner: the corner (a point to point distance).
    await page.getByTestId("tool-dimension").click();
    await sketchClick(page, 10, 2);
    await sketchClick(page, 40, 6);
    await page.waitForTimeout(300);
    await expect(page.getByTestId("dimension-placing")).toHaveCount(1);
  });

  test("turned: an upright edge seen end-on stands for the corner it projects to", async ({ page }) => {
    await sketchOn(page, [0, 12, 6]);
    await drawLine(page, [-20, 6], [20, 6]);
    // Turn the view (middle button) so the plate's near corner's upright edge shows.
    const box = (await page.getByTestId("sketch-canvas").boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(x - 60, y - 60, { steps: 6 });
    await page.mouse.move(x - 120, y - 120, { steps: 6 });
    await page.mouse.up({ button: "middle" });
    await expect(page.getByTestId("sketch-canvas")).toHaveAttribute("data-facing", "false");
    await page.getByTestId("tool-dimension").click();
    await sketchClick(page, 20, 6);
    // The upright edge at (40, −20), half way down.
    const [ux, uy] = await page.evaluate((q) => (window as unknown as Hook).__cocaideViewport.project(q), [40, -20, 3] as number[]);
    await page.mouse.move(ux, uy);
    await expect(page.getByTestId("scene-hover")).toHaveCount(1);
    await page.mouse.click(ux, uy);
    await expect(page.getByTestId("dimension-placing").or(page.getByTestId("modify-box"))).toHaveCount(1);
  });

  test("Add Relations: a line with the part's edge: collinear puts it on the edge", async ({ page }) => {
    await sketchOn(page, [0, 12, 6]);
    await drawLine(page, [-20, 6], [20, 6]);
    await sketchClick(page, 0, 6);
    await page.keyboard.down("Control");
    await sketchClick(page, 0, -20);
    await page.keyboard.up("Control");
    const buttons = page.getByTestId("relation-buttons");
    await expect(buttons).toContainText("Parallel");
    await expect(buttons).toContainText("Collinear");
    await buttons.getByText("Collinear").click();
    await expect(page.getByTestId("constraint-list")).toContainText("model edge (straight, 80 mm, +X)");
    expect((await l1(page)).start[1]).toBeCloseTo(-20, 6);
  });
});
