// The 3D sketch in the browser: start one from the Weldments tab, click
// points in the view (each measured from the last), Tab to a vertical work
// plane, Esc to end the line, type an exact offset, OK; then put members on
// a 3D sketch's lines from Members from sketch. The kernel is real.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { commit, openApp, savedDocument, sketchClick, waitForRebuild } from "./helpers";

let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = await openApp(page);
});
test.afterEach(() => {
  expect(problems).toEqual([]);
});

const saved = async (page: Page) => (await savedDocument(page)) as Record<string, any>;
const sketch3d = async (page: Page) => (await saved(page)).features.find((f: any) => f.op === "sketch3d");

async function clickAt(page: Page, fx: number, fy: number) {
  const box = (await page.locator("canvas").first().boundingBox())!;
  const [x, y] = [box.x + box.width * fx, box.y + box.height * fy];
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

test("draw a 3D sketch: points from the last, Tab to a vertical plane, an exact offset typed", async ({ page }) => {
  await page.getByText("Weldments", { exact: true }).click();
  await page.getByTestId("tool-sketch3d").click();
  const editor = page.getByTestId("sketch3d-editor");
  await expect(editor.getByTestId("sketch3d-draw")).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByTestId("sketch3d-plane-XY")).toHaveAttribute("aria-checked", "true");
  // Three clicks on the ground plane: a point, then two lines (the second off every axis's line on screen: straight
  // up the screen from a point is up the Z axis now, so it would rise).
  await clickAt(page, 0.5, 0.6);
  await clickAt(page, 0.65, 0.6);
  await clickAt(page, 0.75, 0.75);
  await expect(page.getByTestId("draw3d-tip")).toContainText("XY plane");
  // Tab: the vertical XZ plane through the last point; one more click goes up.
  await page.keyboard.press("Tab");
  await expect(editor.getByTestId("sketch3d-plane-XZ")).toHaveAttribute("aria-checked", "true");
  await clickAt(page, 0.6, 0.25);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sketch3d(page))?.lines?.length).toBe(3);
  const f = await sketch3d(page);
  expect(f.points.map((p: any) => p.from ?? "at")).toEqual(["at", "p1", "p2", "p3"]);
  // On the ground the heights don't change; on XZ the y doesn't.
  expect(f.points[1].by[2]).toBe(0);
  expect(f.points[2].by[2]).toBe(0);
  expect(f.points[3].by[1]).toBe(0);
  expect(f.points[3].by[2]).not.toBe(0);
  // An exact offset: p2 is 50 along x from p1; p3, measured from p2, moves with it.
  await commit(page, "sketch3d-p2-x", "50");
  await commit(page, "sketch3d-p2-y", "0");
  await expect.poll(async () => (await sketch3d(page)).points[1].by).toEqual([50, 0, 0]);
  await expect(editor.getByTestId("sketch3d-line-l1")).toContainText("50 mm");
  // OK keeps it: a 3D Sketch in the tree.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("feature-sketch3d_1")).toBeVisible();
});

test("members on a 3D sketch's lines: a pitched portal frame, mitred at the knees and the ridge", async ({ page }) => {
  const table = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
  const doc = {
    version: 1,
    units: "mm",
    name: "portal",
    profiles: table.profiles,
    features: [
      {
        id: "frame3d",
        op: "sketch3d",
        points: [
          { id: "p1", at: [0, 0, 0] },
          { id: "p2", from: "p1", by: [0, 0, 1500] },
          { id: "p3", from: "p2", by: [1000, 0, 300] },
          { id: "p4", from: "p3", by: [1000, 0, -300] },
          { id: "p5", from: "p4", by: [0, 0, -1500] },
        ],
        lines: [
          { id: "l1", start: "p1", end: "p2" },
          { id: "l2", start: "p2", end: "p3" },
          { id: "l3", start: "p3", end: "p4" },
          { id: "l4", start: "p4", end: "p5" },
        ],
      },
    ],
  };
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
  await page.getByText("Weldments", { exact: true }).click();
  await page.getByTestId("tool-member").click();
  const cmd = page.getByTestId("member-cmd");
  await cmd.getByTestId("member-cmd-all").selectOption("frame3d");
  await expect(cmd.getByTestId("member-cmd-summary")).toContainText("4 members");
  await cmd.getByTestId("member-cmd-ok").click();
  await expect.poll(async () => (await saved(page)).features.filter((f: any) => f.op === "member").length).toBe(4);
  const d = await saved(page);
  expect(d.features.filter((f: any) => f.op === "joint").map((j: any) => j.type)).toEqual(["mitre", "mitre", "mitre"]);
  expect(Object.values(d.nodes).map((n: any) => n.point)).toEqual(["p1.at", "p2.at", "p3.at", "p4.at", "p5.at"]);
  await expect(page.getByTestId("bodies")).toContainText("4");
  // The view frames the new frame: its feet and ridge are on screen.
  const box = (await page.locator("canvas").first().boundingBox())!;
  const inView = async (p: number[]) => {
    const [x, y] = await page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), p);
    return x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height;
  };
  await expect.poll(async () => (await inView([0, 0, 0])) && (await inView([2000, 0, 0])) && (await inView([1000, 0, 1820]))).toBe(true);
});

async function screenOf(page: Page, p: number[]): Promise<[number, number]> {
  return page.evaluate((p) => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project(p), p);
}

test("snap onto a corner of the part, drag a point, and click a point to go on from it", async ({ page }) => {
  await page.getByText("Weldments", { exact: true }).click();
  await page.getByTestId("tool-sketch3d").click();
  // The bracket's top corner at (40, 20, 6): the tip says what it snaps to, and the point lands exactly there.
  const [cx, cy] = await screenOf(page, [40, 20, 6]);
  await page.mouse.move(cx + 3, cy + 2);
  await expect(page.getByTestId("draw3d-tip")).toContainText("On a corner of the part");
  await page.mouse.click(cx + 3, cy + 2);
  await expect.poll(async () => (await sketch3d(page))?.points?.[0]).toEqual({ id: "p1", at: [40, 20, 6] });
  // A second point on the plane through it (z stays 6).
  await clickAt(page, 0.35, 0.55);
  await expect.poll(async () => (await sketch3d(page))?.points?.length).toBe(2);
  const before = (await sketch3d(page)).points[1].by;
  expect(before[2]).toBe(0);
  // Drag p2 somewhere else: its offset from p1 changes, still on the plane.
  const p2 = [40 + before[0], 20 + before[1], 6];
  const [x2, y2] = await screenOf(page, p2);
  await page.mouse.move(x2, y2);
  await page.mouse.down();
  await page.mouse.move(x2 - 40, y2 + 30, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => JSON.stringify((await sketch3d(page)).points[1].by)).not.toBe(JSON.stringify(before));
  expect((await sketch3d(page)).points[1].by[2]).toBe(0);
  expect((await sketch3d(page)).points[1].from).toBe("p1");
  // Esc ends the line; a click on p1 starts from it again, and the next click draws l2 from p1.
  await page.keyboard.press("Escape");
  const [x1, y1] = await screenOf(page, [40, 20, 6]);
  await page.mouse.move(x1, y1);
  await page.mouse.click(x1, y1);
  await clickAt(page, 0.6, 0.3);
  await expect.poll(async () => (await sketch3d(page))?.lines?.length).toBe(2);
  expect((await sketch3d(page)).lines[1]).toMatchObject({ start: "p1", end: "p3" });
});

test("draw onto another sketch: partway along its line, and on its end, the points follow it", async ({ page }) => {
  const doc = {
    version: 1,
    units: "mm",
    name: "roof",
    features: [{ id: "gable", op: "sketch", plane: { type: "ref", ref: { datum: "Front" } }, entities: [{ id: "r1", type: "line", start: [0, 1500], end: [1000, 1800] }] }],
  };
  const text = JSON.stringify(doc, null, 2);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
  await page.getByText("Weldments", { exact: true }).click();
  await page.getByTestId("tool-sketch3d").click();
  // 30% up the rafter (halfway would be its midpoint, a point of its own): the tip names it, and the point follows it.
  const [mx, my] = await screenOf(page, [300, 0, 1590]);
  await page.mouse.move(mx + 2, my + 1);
  await expect(page.getByTestId("draw3d-tip")).toContainText("gable's r1");
  await page.mouse.click(mx + 2, my + 1);
  await expect.poll(async () => (await sketch3d(page))?.points?.length).toBe(1);
  const p1 = (await sketch3d(page)).points[0];
  expect(p1.at).toMatchObject({ sketch: "gable", point: "r1" });
  expect(Math.abs(p1.at.t - 0.3)).toBeLessThan(0.03);
  // On the rafter's top end: follows r1.end, and a line joins the two.
  const [ex, ey] = await screenOf(page, [1000, 0, 1800]);
  await page.mouse.move(ex + 2, ey);
  await expect(page.getByTestId("draw3d-tip")).toContainText("gable's r1.end");
  await page.mouse.click(ex + 2, ey);
  await expect.poll(async () => (await sketch3d(page))?.lines?.length).toBe(1);
  expect((await sketch3d(page)).points[1]).toEqual({ id: "p2", at: { sketch: "gable", point: "r1.end" } });
  // Properties says what each follows.
  await expect(page.getByTestId("sketch3d-follows-p2")).toContainText("gable's r1.end");
});

test("posts up from another sketch's corners without Tab: the line locks along Z, a typed length places it, the tops join into a frame", async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 1100 });
  const P = [[-300, -200], [300, -200], [300, 200], [-300, 200]];
  const doc = { version: 1, units: "mm", name: "frame", features: [{ id: "base", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: P.map((a, i) => ({ id: `l${i + 1}`, type: "line", start: a, end: P[(i + 1) % 4] })) }] };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
  await page.getByTestId("view-fit").click();
  const cb = (await page.locator("canvas").first().boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(600);
  await page.getByText("Weldments", { exact: true }).click();
  await page.getByTestId("tool-sketch3d").click();
  const H = 200;
  // Every corner and the point above it in clear view (off the toolbars), to point at.
  const inView = async (p: number[]) => {
    const [x, y] = await screenOf(page, p);
    expect(x).toBeGreaterThan(cb.x + 60);
    expect(x).toBeLessThan(cb.x + cb.width - 60);
    expect(y).toBeGreaterThan(cb.y + 40);
    expect(y).toBeLessThan(cb.y + cb.height - 80);
    return [x, y] as const;
  };
  for (const c of P) {
    const [cx, cy] = await inView([c[0], c[1], 0]);
    await page.mouse.move(cx + 2, cy + 1);
    await page.mouse.click(cx + 2, cy + 1);
    // Pointed straight up, on the XY work plane still: it locks along Z.
    const [ux, uy] = await inView([c[0], c[1], H]);
    await page.mouse.move(ux + 1, uy - 3);
    await expect(page.getByTestId("draw3d-tip")).toContainText("Along Z");
    // A typed length: exactly that far up.
    await page.keyboard.type(String(H));
    await expect(page.getByTestId("draw3d-typed")).toContainText(`Length ${H} mm`);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
  }
  // The tops joined, round and back to the first: a frame.
  for (const c of [...P, P[0]]) {
    const [tx, ty] = await inView([c[0], c[1], H]);
    await page.mouse.move(tx + 1, ty);
    await page.mouse.click(tx + 1, ty);
  }
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sketch3d(page))?.lines?.length).toBe(8);
  const f = await sketch3d(page);
  // Each corner follows the rectangle; each top is measured straight up from its corner, so the posts follow it too.
  const tops = f.points.filter((p: any) => p.from);
  expect(tops).toHaveLength(4);
  for (const t of tops) expect(t.by).toEqual([0, 0, H]);
  expect(f.points.filter((p: any) => p.at?.sketch === "base")).toHaveLength(4);
});

test("a plane parallel to Top up to another sketch's vertex: selected first, or by Up to a point on an offset plane", async ({ page }) => {
  // A sketch on Front: an L, its top end 500 up.
  const doc = { version: 1, units: "mm", name: "p", features: [{ id: "side", op: "sketch", plane: { type: "ref", ref: { datum: "Front" } }, entities: [{ id: "l1", type: "line", start: [0, 0], end: [300, 0] }, { id: "l2", type: "line", start: [300, 0], end: [300, 500] }] }] };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
  await page.getByTestId("view-fit").click();
  // Selected first: Top, then (Shift) the sketch's corner, picked in the view; Plane goes through it, parallel to Top.
  await page.getByText("Top plane", { exact: true }).click();
  const [vx, vy] = await screenOf(page, [300, 0, 500]);
  await page.mouse.move(vx, vy);
  await expect(page.getByTestId("sketch-pick-tip")).toContainText("the end of side's l2");
  await page.keyboard.down("Shift");
  await page.mouse.click(vx, vy);
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("selection")).toContainText("1 plane + 1 sketch point");
  await page.getByTestId("tab-reference").click();
  await page.getByTestId("tool-plane").click();
  await expect(page.getByTestId("prop-datum-where")).toHaveText("through 0, 0, 500 · normal +Z");
  const planeOf = async () => (await saved(page)).features.find((f: any) => f.op === "plane");
  expect(await planeOf()).toEqual({ id: "plane_1", op: "plane", mode: "parallelThroughPoint", refs: [{ datum: "Top" }, { sketch: "side", entity: "l2", at: "end" }] });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  await expect.poll(planeOf).toBeUndefined();
  // Or: Plane from Top (10 above it), then Up to a point, and the corner clicked in the view.
  await page.getByText("Top plane", { exact: true }).click();
  await page.getByTestId("tool-plane").click();
  await expect(page.getByTestId("prop-datum-where")).toHaveText("through 0, 0, 10 · normal +Z");
  await page.getByTestId("prop-plane-upto").first().click();
  await page.mouse.move(vx, vy);
  await expect(page.getByTestId("sketch-pick-tip")).toContainText("Up to a point");
  await page.mouse.click(vx, vy);
  await expect(page.getByTestId("prop-datum-where")).toHaveText("through 0, 0, 500 · normal +Z");
  expect((await planeOf()).mode).toBe("parallelThroughPoint");
});

test("a sketch's line snapped onto a 3D sketch's points: each end follows the point it is on", async ({ page }) => {
  const doc = { version: 1, units: "mm", name: "x", features: [
    { id: "s3", op: "sketch3d", points: [{ id: "p1", at: [10, 0, 0] }, { id: "p2", from: "p1", by: [0, 0, 50] }, { id: "p3", at: [-20, 15, 0] }], lines: [{ id: "l1", start: "p1", end: "p2" }, { id: "l2", start: "p1", end: "p3" }] },
  ] };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await waitForRebuild(page);
  await page.getByText("Top plane", { exact: true }).click();
  await page.getByTestId("tool-sketch").click();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
  await page.getByTestId("tool-line").click();
  await sketchClick(page, -19.7, 15.3);
  await sketchClick(page, 10.3, 0.3);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sketch-status")).toContainText("Fully defined");
  await page.getByTestId("finish-sketch").click();
  await waitForRebuild(page);
  const f = (await saved(page)).features.find((x: any) => x.op === "sketch");
  expect(f.entities.filter((e: any) => e.ref).map((e: any) => e.ref)).toEqual([{ sketch: "s3", entity: "p3" }, { sketch: "s3", entity: "p1" }]);
  await expect(page.getByTestId("status")).not.toContainText(/error/i);
});
