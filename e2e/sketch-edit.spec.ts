// The sketch edit tools in the browser (Phase O wave 3): a rectangle with
// two corners filleted (one radius dimension), offset 3 mm inward, its band
// cut open by trimming, extruded to the volume the formula gives; power trim
// by dragging across pieces, with the status line and Check sketch saying
// what is open; a circular pattern of circles cut through a plate; and the
// toolbar, keys, shortcut bar and menus listing the edit tools.

import { expect, test, type Page } from "@playwright/test";
import type { Constraint, SketchEntity, Vec2 } from "../src/doc/types";
import { commit, expectVolume, openApp, savedDocument, sketchClick, viewportClick } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

const pressed = (page: Page, testId: string) => expect(page.getByTestId(testId)).toHaveAttribute("aria-pressed", "true");

async function sketchOnTop(page: Page) {
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
}

/** Screen pixels of a sketch point. */
async function toScreen(page: Page, [x, y]: Vec2): Promise<[number, number]> {
  return page.evaluate(
    ([x, y]) => {
      const m = (document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement).getScreenCTM()!;
      return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as [number, number];
    },
    [x, y] as Vec2,
  );
}

/** Drags the pointer through the sketch points given (a power-trim stroke). */
async function stroke(page: Page, points: Vec2[]) {
  const [first, ...rest] = await Promise.all(points.map((p) => toScreen(page, p)));
  await page.mouse.move(first[0], first[1]);
  await page.mouse.down();
  for (const p of rest) await page.mouse.move(p[0], p[1], { steps: 8 });
  await page.mouse.up();
}

/** The sketch as it stands in the document after Finish. */
async function savedSketch(page: Page, id = "sketch_1"): Promise<{ entities: SketchEntity[]; constraints: Constraint[] }> {
  const doc = (await savedDocument(page)) as { features: { id: string; entities: SketchEntity[]; constraints?: Constraint[] }[] };
  const s = doc.features.find((f) => f.id === id)!;
  return { entities: s.entities, constraints: s.constraints ?? [] };
}

test("a rectangle with two corners filleted, offset 3 mm inward and its band trimmed open, extrudes to the formula's volume", async ({ page }) => {
  await sketchOnTop(page);
  await page.keyboard.press("r");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 40, 30);
  await expect(page.getByTestId("profile-status")).toContainText("1 region, area 1200");

  // Fillet ▾ Fillet: the two right-hand corners, radius 5: one R5 dimension, the other fillet equal to it.
  await page.getByTestId("tool-fillet").click();
  await pressed(page, "tool-fillet");
  await expect(page.getByTestId("tool-prompt")).toHaveText("Click the corners to round (or the two entities, or a rectangle)");
  await sketchClick(page, 40, 0);
  await sketchClick(page, 40, 30);
  await commit(page, "tool-option-radius", "5");
  await expect(page.getByTestId("tool-prompt")).toContainText("2 picks");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-fillet-preview.png` });
  await page.getByTestId("tool-apply").click();
  await expect(page.locator("[data-testid=sketch-canvas] .dimensions text", { hasText: /^R5$/ })).toHaveCount(1);
  const outer = 1200 - 2 * (25 - (Math.PI * 25) / 4);
  await expect(page.getByTestId("profile-status")).toContainText(`area ${Math.round(outer * 1000) / 1000}`);
  await expect(page.getByTestId("constraint-list")).toContainText("a2 = a1");

  // Offset: click the bottom line, its whole chain comes; Reverse takes it inside; 3 mm.
  await page.getByTestId("tool-offset").click();
  await sketchClick(page, 20, 0);
  await commit(page, "tool-option-distance", "3");
  await page.getByTestId("tool-option-reverse").check();
  await page.getByTestId("tool-apply").click();
  // Inside: 34 × 24, its two right-hand corners rounded R2 (5 − 3).
  const inner = 34 * 24 - 2 * (4 - Math.PI);
  await expect(page.getByTestId("profile-status")).toContainText(`1 region, area ${Math.round((outer - inner) * 1000) / 1000}`);
  await expect(page.getByTestId("constraint-list")).toContainText("offset from");

  // Trim: two lines across the bottom of the band, cut back to it, and the band between them cut out: a C.
  await page.getByTestId("tool-select").click();
  await page.keyboard.press("l");
  await sketchClick(page, 20, -10);
  await sketchClick(page, 20, 10);
  await page.keyboard.press("Escape");
  await sketchClick(page, 25, -10);
  await sketchClick(page, 25, 10);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sketch-problems")).toBeVisible();
  await page.keyboard.press("t");
  await pressed(page, "tool-trim");
  for (const [x, y] of [[20, -5], [20, 7], [25, -5], [25, 7], [22.5, 0], [22.5, 3]] as Vec2[]) await sketchClick(page, x, y);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-trimmed-c.png` });
  await expect(page.getByTestId("sketch-problems")).toHaveCount(0);
  const area = outer - inner - 5 * 3;
  await expect(page.getByTestId("profile-status")).toContainText(`1 region, area ${Math.round(area * 1000) / 1000}`);

  // Undo steps back one edit at a time.
  await page.getByTestId("sketch-undo").click();
  await expect(page.getByTestId("sketch-problems")).toBeVisible();
  await page.getByTestId("sketch-redo").click();
  await expect(page.getByTestId("sketch-problems")).toHaveCount(0);

  await page.getByTestId("finish-sketch").click();
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "10");
  await expectVolume(page, (area * 10).toLocaleString("en-US", { maximumFractionDigits: 3 }));
  const s = await savedSketch(page);
  expect(s.constraints.filter((k) => k.type === "radius")).toHaveLength(1);
  expect(s.constraints.some((k) => k.type === "offset")).toBe(true);
});

test("power trim: a drag across pieces trims each one; the status line and Check sketch say what is open", async ({ page }) => {
  await sketchOnTop(page);
  // One level line and three plumb lines across it.
  await page.keyboard.press("l");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 40, 0);
  await page.keyboard.press("Escape");
  for (const x of [10, 20, 30]) {
    await sketchClick(page, x, -10);
    await sketchClick(page, x, 10);
    await page.keyboard.press("Escape");
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sketch-problems")).toContainText(/open at l\d's (start|end)|l\d and l\d cross/);
  await expect(page.locator("[data-testid=sketch-warning]").first()).toBeVisible();

  // Trim ▾ shows Trim, Extend and Split; T is Trim.
  await page.getByTestId("tool-trim-flyout").click();
  for (const t of ["trim", "extend", "split"]) await expect(page.getByTestId(`flyout-${t}`)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("t");
  await pressed(page, "tool-trim");
  // One stroke under the level line, across the three plumb lines.
  await stroke(page, [[5, -5], [35, -5]]);
  await page.getByTestId("tool-select").click();
  await page.getByTestId("finish-sketch").click();
  const { entities } = await savedSketch(page);
  const plumb = entities.filter((e): e is Extract<SketchEntity, { type: "line" }> => e.type === "line" && e.start[0] === e.end[0]);
  expect(plumb).toHaveLength(3);
  // Each now runs from the level line up: its lower piece is gone.
  for (const l of plumb) expect([Math.min(l.start[1], l.end[1]), Math.max(l.start[1], l.end[1])].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 10]);

  // Check sketch lists what is open, with the fixes it can make.
  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  await page.getByTestId("tool-check").click();
  await expect(page.getByTestId("sketch-check")).toBeVisible();
  await expect(page.getByTestId("sketch-check")).toContainText("open at");
  await page.getByTestId("cancel-sketch").click();
});

test("Check sketch merges ends that nearly meet and deletes a doubled line, in one click", async ({ page }) => {
  // A 30 × 20 outline whose last side stops 0.2 mm short of the start, and its bottom drawn twice.
  const line = (id: string, start: Vec2, end: Vec2) => ({ id, type: "line", start, end });
  const text = JSON.stringify({
    version: 1,
    units: "mm",
    name: "part",
    features: [
      {
        id: "sketch_1",
        op: "sketch",
        plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
        entities: [line("l1", [0, 0], [30, 0]), line("l2", [30, 0], [30, 20]), line("l3", [30, 20], [0, 20]), line("l4", [0, 20], [0, 0.2]), line("l5", [30, 0], [0, 0])],
        constraints: [],
      },
    ],
  });
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await expect(page.getByTestId("feature-sketch_1")).toBeVisible();
  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  await expect(page.getByTestId("sketch-problems")).toContainText("l5 lies on top of l1");
  await page.getByTestId("tool-check").click();
  await expect(page.getByTestId("sketch-check")).toContainText("nearly meet (0.2 mm apart)");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-check.png` });
  await page.getByTestId("check-fix-all").click();
  await expect(page.getByTestId("check-clean")).toContainText("1 closed contour");
  await expect(page.getByTestId("profile-status")).toContainText("1 region");
  await expect(page.getByTestId("sketch-regions")).toHaveAttribute("data-count", "1");
  await expect(page.getByTestId("sketch-problems")).toHaveCount(0);
  await page.getByTestId("finish-sketch").click();
  const { entities, constraints } = await savedSketch(page);
  expect(entities.map((e) => e.id)).toEqual(["l1", "l2", "l3", "l4"]);
  expect(constraints.filter((k) => k.type === "coincident").map((k) => [...(k as { points: string[] }).points].sort())).toEqual([["l1.start", "l4.end"]]);
});

test("a circular pattern of circles cuts through a plate", async ({ page }) => {
  // A 60 × 60 plate, 10 thick.
  await sketchOnTop(page);
  await page.keyboard.press("Shift+R");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 30, 30);
  await page.getByTestId("finish-sketch").click();
  await page.getByTestId("tool-extrude").click();
  await commit(page, "prop-distance", "10");
  await expectVolume(page, "36,000");

  // On its top face: a circle of radius 4 at [20, 0], six of them round the origin.
  await viewportClick(page, [-25, 25, 10]);
  await page.getByTestId("tool-sketch").click();
  await page.keyboard.press("c");
  await sketchClick(page, 20, 0);
  await sketchClick(page, 24, 0);
  await page.getByTestId("tool-select").click();
  await sketchClick(page, 20, 4);
  await page.getByTestId("tool-pattern-flyout").click();
  await page.getByTestId("flyout-circular-pattern").click();
  await pressed(page, "tool-circular-pattern");
  await expect(page.getByTestId("tool-prompt")).toContainText("1 entity round the origin");
  await commit(page, "tool-option-count", "6");
  await expect(page.locator("[data-testid=edit-mark]")).toHaveCount(5);
  // Skip the fourth, then put it back.
  await sketchClick(page, -20, 0);
  await expect(page.locator("[data-testid=edit-mark][data-off=true]")).toHaveCount(1);
  await sketchClick(page, -20, 0);
  await expect(page.locator("[data-testid=edit-mark][data-off=true]")).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-circular-pattern.png` });
  await page.getByTestId("tool-apply").click();
  await expect(page.getByTestId("profile-status")).toContainText("6 regions");
  await expect(page.locator("[data-testid=sketch-canvas] .dimensions text", { hasText: /^60°$/ })).toHaveCount(1);
  await page.getByTestId("finish-sketch").click();
  await page.getByTestId("tool-cut").click();
  await page.getByTestId("prop-extent").selectOption("throughAll");
  await expectVolume(page, (36000 - 6 * Math.PI * 16 * 10).toLocaleString("en-US", { maximumFractionDigits: 3 }));
});

test("the edit tools: flyouts, keys, the shortcut bar and the right-click menu; the toolbar stays on one row", async ({ page }) => {
  await sketchOnTop(page);
  const rows = await page.evaluate(() => {
    const bar = document.querySelector(".sketch-toolbar") as HTMLElement;
    const middles = new Set([...bar.children].map((c) => c.getBoundingClientRect()).map((r) => Math.round(r.top + r.height / 2)));
    return { rows: middles.size, overflow: bar.scrollWidth - bar.clientWidth };
  });
  expect(rows).toEqual({ rows: 1, overflow: 0 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-edit-toolbar.png` });
  for (const [flyout, items] of [
    ["trim", ["trim", "extend", "split"]],
    ["fillet", ["fillet", "chamfer"]],
    ["pattern", ["linear-pattern", "circular-pattern"]],
    ["move", ["move", "copy", "rotate", "scale"]],
  ] as const) {
    await page.getByTestId(`tool-${flyout}-flyout`).click();
    for (const t of items) await expect(page.getByTestId(`flyout-${t}`)).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await expect(page.getByTestId("tool-offset")).toBeVisible();
  await expect(page.getByTestId("tool-mirror")).toBeVisible();
  // Keys: E extend, M mirror.
  await page.keyboard.press("e");
  await pressed(page, "tool-extend");
  await page.keyboard.press("m");
  await pressed(page, "tool-mirror");
  await page.keyboard.press("Escape");
  await pressed(page, "tool-select");

  // A centreline, a slot (exploded into lines and arcs), mirrored about the centreline from the menu.
  await page.keyboard.press("Shift+L");
  await sketchClick(page, 0, -20);
  await sketchClick(page, 0, 20);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByTestId("tool-slot-flyout").click();
  await page.getByTestId("flyout-slot").click();
  await sketchClick(page, 10, 0);
  await sketchClick(page, 30, 0);
  await sketchClick(page, 30, 5);
  await page.getByTestId("tool-select").click();
  // A window round the slot selects its pieces; the menu on one of them acts on them all.
  const [ax, ay] = await toScreen(page, [3, 12]);
  const [bx, by] = await toScreen(page, [40, -12]);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("sketch-selection")).toContainText("5 selected");
  const [x, y] = await toScreen(page, [20, 5]);
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.getByTestId("ctx-tool-trim")).toHaveCount(0); // an entity's menu: its own actions
  await page.getByTestId("ctx-mirror").click();
  await pressed(page, "tool-mirror");
  await sketchClick(page, 0, 10); // the centreline: taken as the mirror line at once
  await expect(page.getByTestId("tool-prompt")).toContainText("about l1");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("profile-status")).toContainText("2 regions");
  await expect(page.getByTestId("constraint-list")).toContainText("symmetric about");

  // The shortcut bar and the empty-space menu list the edit tools.
  await page.keyboard.press("Escape");
  await sketchClick(page, -30, 30);
  await page.keyboard.press("s");
  for (const t of ["trim", "extend", "split", "fillet", "chamfer", "offset", "mirror", "linear-pattern", "circular-pattern", "move", "copy", "rotate", "scale"]) await expect(page.getByTestId(`bar-${t}`)).toBeVisible();
  await page.keyboard.press("Escape");
  const [ex, ey] = await toScreen(page, [-30, 30]);
  await page.mouse.click(ex, ey, { button: "right" });
  // Each flyout's as it shows: Extend, the one used last (by its key) for Trim ▾.
  for (const t of ["extend", "fillet", "offset", "mirror", "linear-pattern", "move"]) await expect(page.getByTestId(`ctx-tool-${t}`)).toBeVisible();
  await page.getByTestId("ctx-tool-offset").click();
  await pressed(page, "tool-offset");
  await page.getByTestId("cancel-sketch").click();
});

test("Q turns any selection construction as one, and back; with nothing selected, the next shapes", async ({ page }) => {
  await sketchOnTop(page);
  await page.keyboard.press("l");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 20, 0);
  await page.keyboard.press("Escape");
  await sketchClick(page, 0, 10);
  await sketchClick(page, 20, 10);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // One line, and the other by its end point: both go construction.
  await sketchClick(page, 10, 0);
  await page.keyboard.down("Control");
  await sketchClick(page, 20, 10);
  await page.keyboard.up("Control");
  await page.keyboard.press("q");
  await expect(page.locator("[data-entity=l1].construction")).toHaveCount(1);
  await expect(page.locator("[data-entity=l2].construction")).toHaveCount(1);
  await page.keyboard.press("q");
  await expect(page.locator("[data-entity].construction")).toHaveCount(0);
  // Nothing selected: the next line drawn is construction.
  await page.keyboard.press("Escape");
  await page.keyboard.press("q");
  await pressed(page, "tool-construction");
  await page.keyboard.press("l");
  await sketchClick(page, 0, 20);
  await sketchClick(page, 20, 20);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-entity=l3].construction")).toHaveCount(1);
  await page.getByTestId("cancel-sketch").click();
});

test("an undo while an edit tool holds picks drops the picks it took away; Undo after an edit is one step", async ({ page }) => {
  await sketchOnTop(page);
  await page.keyboard.press("r");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 40, 30);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Fillet one corner from its right-click menu, with Enter: one undo puts the corner back.
  const [cx, cy] = await toScreen(page, [40, 0]);
  await page.mouse.click(cx, cy, { button: "right" });
  await page.getByTestId("ctx-fillet").click();
  await pressed(page, "tool-fillet");
  await expect(page.getByTestId("tool-prompt")).toContainText("1 pick");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-entity=a1]")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-entity=a1]")).toHaveCount(0);
  await expect(page.locator("[data-entity^=l]")).toHaveCount(4);
  // Offset picks the top side; undoing the rectangle takes that pick with it, and Apply has nothing stale to say.
  await page.getByTestId("tool-offset").click();
  await sketchClick(page, 20, 30);
  await expect(page.getByTestId("tool-prompt")).toContainText("1 entity picked");
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-entity]")).toHaveCount(0);
  await expect(page.getByTestId("tool-prompt")).toHaveText("Click a line, arc or circle: its chain is offset");
  await expect(page.getByTestId("tool-problem")).toHaveCount(0);
  await expect(page.getByTestId("tool-apply")).toBeDisabled();
  await page.getByTestId("cancel-sketch").click();
});
