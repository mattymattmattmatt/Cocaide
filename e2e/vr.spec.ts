// The VR walkthrough in a browser with an emulated Quest 3 (Meta's WebXR emulator, iwer): Settings > VR, the start
// point placed in the view (a floor, then a heading), the VR button, then in VR: standing at the start facing its way,
// teleporting along the floor with the trigger's arc, a snap turn, roof off, back to the start, and out again.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { openApp, savedDocument, waitForRebuild } from "./helpers";
import { boxGlb } from "../tests/glb-fixture";

type Hook = {
  project(p: number[]): [number, number];
  vr(): { active: boolean; standing?: { at: number[]; heading: number }; roofOff?: boolean; drawn?: { calls: number; triangles: number }; marker: { at: number[]; heading: number } | null };
};
const hook = <T,>(page: Page, f: (h: Hook) => T) => page.evaluate(`(${f.toString()})(window.__cocaideViewport)`) as Promise<T>;
const vr = (page: Page) => hook(page, (h) => h.vr());
const device = (page: Page, js: string) => page.evaluate(`(() => { const d = window.__xrDevice; ${js} })()`);

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: readFileSync("node_modules/iwer/build/iwer.min.js", "utf8") });
  await page.addInitScript({ content: "window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });" });
  await openApp(page);
  // A 10 × 10 m slab, a 600 high platform on it (another level), a wall.
  const doc = {
    version: 1, units: "mm", name: "site",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [5000, 5000], w: 10000, h: 10000 }] },
      { id: "slab", op: "extrude", sketch: "s1", distance: 100, newBody: "slab" },
      { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, entities: [{ id: "r", type: "rect", center: [7500, 8000], w: 3000, h: 3000 }] },
      { id: "deck", op: "extrude", sketch: "s2", distance: 500, newBody: "deck" },
      { id: "s3", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, entities: [{ id: "r", type: "rect", center: [2000, 3000], w: 3000, h: 200 }] },
      { id: "wall", op: "extrude", sketch: "s3", distance: 2600, newBody: "wall" },
    ],
  };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await waitForRebuild(page);
});

test("the start point placed in the view, then in VR: standing there, teleport, snap turn, roof off, back to the start, out", async ({ page }) => {
  // Settings > VR: this (emulated) headset can do VR; no start yet.
  await page.getByTestId("ask-settings-open").click();
  await page.getByTestId("settings-tab-vr").click();
  await expect(page.getByTestId("vr-support")).toContainText("This browser can do VR");
  await expect(page.getByTestId("vr-start-readout")).toContainText("Not set");
  await page.getByTestId("vr-start-place").click();
  await expect(page.getByTestId("vr-hint")).toContainText("Click the floor");
  // The floor at (3000, 6000) on the slab's top, then a point north of it: facing north (90°).
  const [x, y] = await hook(page, (h) => h.project([3000, 6000, 100]));
  await page.mouse.move(x, y);
  await expect.poll(async () => (await vr(page)).marker?.at.map((v) => Math.round(v / 50) * 50)).toEqual([3000, 6000, 100]);
  await page.mouse.click(x, y);
  await expect(page.getByTestId("vr-hint")).toContainText("the way you want to face");
  const [nx, ny] = await hook(page, (h) => h.project([3000, 9000, 100]));
  await page.mouse.move(nx, ny, { steps: 4 });
  await page.mouse.click(nx, ny);
  await expect(page.getByTestId("vr-hint")).toHaveCount(0);
  await expect.poll(async () => ((await savedDocument(page)) as { vr?: { start: { at: number[]; heading: number } } }).vr?.start.heading).toBe(90);
  const start = ((await savedDocument(page)) as { vr: { start: { at: number[]; heading: number } } }).vr.start;
  expect(start.at.map((v) => Math.round(v / 50) * 50)).toEqual([3000, 6000, 100]);
  // The marker stays, and nothing was selected by those clicks.
  await expect.poll(async () => (await vr(page)).marker?.heading).toBe(90);

  // The VR button (the emulator says this browser can do it): in VR, standing at the start, facing north.
  await page.getByTestId("view-vr").click();
  await expect.poll(async () => (await vr(page)).active).toBe(true);
  await page.waitForTimeout(500);
  let s = (await vr(page)).standing!;
  expect(Math.abs(s.at[0] - start.at[0])).toBeLessThan(60);
  expect(Math.abs(s.at[1] - start.at[1])).toBeLessThan(60);
  expect(Math.abs(s.heading - 90)).toBeLessThanOrEqual(2);
  // Looking up from where you stand still draws (nothing in the model is culled while you are in it).
  await device(page, "d.quaternion.set(0.3827, 0, 0, 0.9239);");
  await page.waitForTimeout(300);
  expect((await vr(page)).drawn!.calls).toBeGreaterThan(3);
  await device(page, "d.quaternion.set(0, 0, 0, 1);");

  // Teleport: the right controller (its tool is Teleport to begin with) pointed ahead and down, the trigger held then let go: about 1.5–2 m north.
  await device(page, "const c = d.controllers.right; c.position.set(0.2, 1.2, -0.3); c.quaternion.set(-0.2588, 0, 0, 0.9659); c.updateButtonValue('trigger', 1);");
  await page.waitForTimeout(400);
  await device(page, "d.controllers.right.updateButtonValue('trigger', 0);");
  await expect.poll(async () => (await vr(page)).standing!.at[1]).toBeGreaterThan(start.at[1] + 1000);
  s = (await vr(page)).standing!;
  expect(Math.abs(s.at[0] - start.at[0])).toBeLessThan(400);
  expect(Math.abs(s.at[2] - 100)).toBeLessThan(60); // still on the slab's level

  // A flick of the right stick: a 30° snap turn (to the right: facing 60°).
  await device(page, "d.controllers.right.updateAxes('thumbstick', 1, 0);");
  await page.waitForTimeout(250);
  await device(page, "d.controllers.right.updateAxes('thumbstick', 0, 0);");
  await expect.poll(async () => (await vr(page)).standing!.heading).toBe(60);

  // B (right): roof off; Y (left): back to the start, facing its way.
  await device(page, "d.controllers.right.updateButtonValue('b-button', 1);");
  await expect.poll(async () => (await vr(page)).roofOff).toBe(true);
  await device(page, "d.controllers.right.updateButtonValue('b-button', 0);");
  await device(page, "d.controllers.left.updateButtonValue('y-button', 1);");
  await expect.poll(async () => Math.abs((await vr(page)).standing!.at[1] - start.at[1])).toBeLessThan(60);
  await device(page, "d.controllers.left.updateButtonValue('y-button', 0);");
  expect(Math.abs((await vr(page)).standing!.heading - 90)).toBeLessThanOrEqual(2);
  // The headset's frames draw the model (the desktop view stays out of the way meanwhile).
  await page.waitForTimeout(300);
  expect((await vr(page)).drawn!.calls).toBeGreaterThan(3);

  // Out again: the desktop view as it was.
  await hook(page, (h) => (h as unknown as { exitVr(): void }).exitVr());
  await expect.poll(async () => (await vr(page)).active).toBe(false);
  await expect(page.getByTestId("status")).toContainText("Rebuilt");
});

test("no VR button where the browser can't do VR", async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __xrDevice: { uninstallRuntime(): void } }).__xrDevice.uninstallRuntime());
  await expect(page.getByTestId("view-fit")).toBeVisible();
  // (The check ran with the emulator in place; a page without it shows none.)
  const page2 = await page.context().newPage();
  await openApp(page2);
  await expect(page2.getByTestId("view-fit")).toBeVisible();
  await expect(page2.getByTestId("view-vr")).toHaveCount(0);
  await page2.close();
});

test("in VR: the menu, a measure, a pin, a sofa carried and turned, undo, the dollhouse (stood in, then held and sized); then the notes reviewed at the desk", async ({ page }) => {
  // A sofa 1.5 m in front of the start, on the slab.
  const doc = (await savedDocument(page)) as { features: unknown[] };
  doc.features.push(
    { id: "s4", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, entities: [{ id: "r", type: "rect", center: [3000, 4500], w: 2000, h: 900 }] },
    { id: "sofa", op: "extrude", sketch: "s4", distance: 800, newBody: "sofa" },
    // A red cushion on it: the sofa is two colours.
    { id: "s5", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 900] }, entities: [{ id: "r", type: "rect", center: [3000, 4500], w: 1600, h: 600 }] },
    { id: "cushion", op: "extrude", sketch: "s5", distance: 120, body: "sofa", appearance: { color: "#c0392b" } },
  );
  (doc as Record<string, unknown>).vr = { start: { at: [3000, 3000, 100], heading: 90 } };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await waitForRebuild(page);
  type State = { tool: string; snap: boolean; pinTag: string; menu: boolean; dollhouse: boolean; measures: number[]; pins: { tag: string }[]; moved: { key: string; move: number[]; turn: number }[]; carrying: string | null; selected: string[]; hidden: string[]; showList: string[]; knobs: { turn: number; at: number[] }[] };
  const st = () => page.evaluate("window.__cocaideViewport.vrState()") as Promise<State>;
  const press = (id: string) => page.evaluate(`window.__cocaideViewport.vrPress(${JSON.stringify(id)})`);
  await page.getByTestId("view-vr").click();
  await expect.poll(async () => (await vr(page)).active).toBe(true);

  // X opens the menu; X again closes it.
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await expect.poll(async () => (await st()).menu).toBe(true);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");
  // Pointed at the menu (in front of you, below your eyes): the ray stops on the panel, with a ball where it lands.
  {
    const from = [0.1, 1.2, -0.1];
    const to = [0, 1.4, -0.55];
    const d = to.map((v, i) => v - from[i]);
    const l = Math.hypot(...d);
    const b = d.map((v) => v / l);
    // The turn taking straight ahead (−Z) onto that way: axis (−Z × b), angle between them.
    const q = [b[1], -b[0], 0, 1 - b[2]];
    const ql = Math.hypot(...q);
    await device(page, `const c = d.controllers.right; c.position.set(${from.join(",")}); c.quaternion.set(${q.map((v) => v / ql).join(",")});`);
    type Dot = { menuDot: number[] | null; rayLength: number };
    await expect.poll(async () => ((await st()) as unknown as Dot).menuDot).not.toBeNull();
    const m = (await st()) as unknown as Dot;
    expect(Math.abs(m.menuDot![2] - -550)).toBeLessThan(80);
    expect(Math.abs(m.rayLength - l * 1000)).toBeLessThan(80);
  }
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await expect.poll(async () => (await st()).menu).toBe(false);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");

  // Measure: two clicks on the floor, the second further along: a length between them.
  await press("tool:measure");
  await press("snap");
  expect((await st()).snap).toBe(false);
  const pose = (q: number[]) => device(page, `const c = d.controllers.right; c.position.set(0.6, 1.2, -0.3); c.quaternion.set(${q.join(",")});`);
  const click = async (btn = "trigger") => {
    // Held long enough for a frame to see it down and another to see it up, even on a slow machine.
    await device(page, `d.controllers.right.updateButtonValue('${btn}', 1);`);
    await page.waitForTimeout(250);
    await device(page, `d.controllers.right.updateButtonValue('${btn}', 0);`);
    await page.waitForTimeout(250);
  };
  // Close the menu (pressing a button opened it): the right trigger then works the tool.
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await page.waitForTimeout(100);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");
  await expect.poll(async () => (await st()).menu).toBe(false);
  await pose([-0.5, 0, 0, 0.866]); // 60° down, to the right of the sofa
  await click();
  await pose([-0.3827, 0, 0, 0.9239]); // 45° down: further along
  await click();
  await expect.poll(async () => (await st()).measures.length).toBe(1);
  expect((await st()).measures[0]).toBeGreaterThan(300);

  // Pin: "too tight", where the ray meets the floor.
  await press("tag:tight");
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await page.waitForTimeout(100);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");
  await expect.poll(async () => (await st()).menu).toBe(false);
  expect((await st()).tool).toBe("pin");
  await click();
  await expect.poll(async () => (await st()).pins).toEqual([{ tag: "tight", at: expect.anything() }]);

  // A note pin: dropping it opens a keyboard on the menu; what is typed (a capital to start each sentence) goes on the pin.
  await press("tag:note");
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await page.waitForTimeout(100);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");
  await expect.poll(async () => (await st()).menu).toBe(false);
  await click();
  type Typing = { typing: string | null; menu: boolean; menuButtons: string[]; pins: { tag: string; text?: string }[] };
  const ts = () => st() as unknown as Promise<Typing>;
  await expect.poll(async () => (await ts()).typing).toBe("");
  expect((await ts()).menu).toBe(true);
  expect((await ts()).menuButtons).toEqual(expect.arrayContaining(["key:q", "key:space", "key:back", "key:done"]));
  for (const k of [..."door sticks."].map((c) => (c === " " ? "space" : c)).concat(["space", ..."fixx", "back"])) await press(`key:${k}`);
  expect((await ts()).typing).toBe("Door sticks. Fix");
  await press("key:done");
  await expect.poll(async () => (await ts()).menu).toBe(false);
  expect((await ts()).typing).toBe(null);
  expect((await ts()).pins).toEqual([{ tag: "tight", at: expect.anything() }, { tag: "note", at: expect.anything(), text: "Door sticks. Fix" }]);
  // A takes the note pin back (the rest goes on with the one pin).
  await click("a-button");
  await expect.poll(async () => (await ts()).pins.length).toBe(1);
  await press("tag:tight");
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await page.waitForTimeout(100);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");
  await expect.poll(async () => (await st()).menu).toBe(false);

  // The grip carries furniture only in Move: in Pin, gripping the sofa does nothing.
  await device(page, "const c = d.controllers.right; c.position.set(0, 1.2, -0.3); c.quaternion.set(-0.2588, 0, 0, 0.9659);");
  await device(page, "d.controllers.right.updateButtonValue('squeeze', 1);");
  await page.waitForTimeout(300);
  expect((await st()).carrying).toBe(null);
  await device(page, "d.controllers.right.updateButtonValue('squeeze', 0);");
  await page.waitForTimeout(100);
  await press("tool:move");
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await page.waitForTimeout(100);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");
  await expect.poll(async () => (await st()).menu).toBe(false);

  // The sofa, in Move: the right grip on it, the hand turned left, let go: moved west; the right stick while holding turns it.
  await device(page, "const c = d.controllers.right; c.position.set(0, 1.2, -0.3); c.quaternion.set(-0.2588, 0, 0, 0.9659);");
  await device(page, "d.controllers.right.updateButtonValue('squeeze', 1);");
  await expect.poll(async () => (await st()).carrying).toBe("sofa");
  await device(page, "d.controllers.right.quaternion.set(-0.2549, 0.1736 * 0.97, 0.0449, 0.9513);");
  await page.waitForTimeout(250);
  await device(page, "d.controllers.right.updateAxes('thumbstick', -1, 0);");
  await page.waitForTimeout(200);
  await device(page, "d.controllers.right.updateAxes('thumbstick', 0, 0);");
  await page.waitForTimeout(150);
  await device(page, "d.controllers.right.updateButtonValue('squeeze', 0);");
  await expect.poll(async () => (await st()).carrying).toBe(null);
  let moved = (await st()).moved;
  expect(moved.length).toBe(1);
  // Moved, it keeps its colours: the cushion's red as well as the sofa's own.
  expect(((await st()) as unknown as { colours: Record<string, number> }).colours.sofa).toBe(2);
  expect(moved[0].move[0]).toBeLessThan(-100);
  expect(moved[0].turn).toBe(10);
  // A second carry, then A undoes it: back to where the first left it.
  const first = moved[0];
  await device(page, "d.controllers.right.quaternion.set(-0.2588, 0, 0, 0.9659);");
  await device(page, "d.controllers.right.updateButtonValue('squeeze', 1);");
  await expect.poll(async () => (await st()).carrying).toBe("sofa");
  await device(page, "d.controllers.right.quaternion.set(-0.2549, -0.1736 * 0.97, -0.0449, 0.9513);");
  await page.waitForTimeout(250);
  await device(page, "d.controllers.right.updateButtonValue('squeeze', 0);");
  await expect.poll(async () => (await st()).moved[0].move[0]).not.toBe(first.move[0]);
  await click("a-button");
  await expect.poll(async () => (await st()).moved[0].move[0]).toBe(first.move[0]);

  // The trigger on the sofa lets it go (it stayed picked after the carry), again picks it (green).
  await press("tool:move");
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await page.waitForTimeout(100);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");
  await expect.poll(async () => (await st()).menu).toBe(false);
  expect((await st()).selected).toEqual(["sofa"]);
  await device(page, "d.controllers.right.quaternion.set(-0.2588, 0, 0, 0.9659);");
  await click();
  await expect.poll(async () => (await st()).selected).toEqual([]);
  expect((await st()).knobs).toEqual([]);
  await click();
  await expect.poll(async () => (await st()).selected).toEqual(["sofa"]);
  // A knob of the ring clicked: the sofa turns 10° its way; A undoes it.
  const knob = (await st()).knobs[0];
  expect((await st()).knobs.length).toBe(2);
  const from = [0, 1.2, -0.3];
  const dir = knob.at.map((v, i) => v - from[i]);
  const len = Math.hypot(...dir);
  const b = dir.map((v) => v / len);
  // The turn taking the controller's forward (0, 0, −1) onto the knob.
  const q = [b[1], -b[0], 0, 1 - b[2]];
  const ql = Math.hypot(...q);
  await device(page, `d.controllers.right.quaternion.set(${q.map((v) => v / ql).join(",")});`);
  await page.waitForTimeout(150);
  await click();
  await expect.poll(async () => (await st()).moved[0].turn).toBe(first.turn + 10 * knob.turn);
  await click("a-button");
  await expect.poll(async () => (await st()).moved[0].turn).toBe(first.turn);

  // Show / hide in the menu: the sofa hidden (and no longer picked), then everything shown again.
  await press("showhide");
  expect((await st()).showList).toContain("sofa");
  await press("show:sofa");
  await expect.poll(async () => (await st()).hidden).toEqual(["sofa"]);
  expect((await st()).selected).toEqual([]);
  await press("show:all");
  await expect.poll(async () => (await st()).hidden).toEqual([]);

  // The dollhouse: the model small in front of you; the left trigger on its floor puts you there, full size.
  await press("dollhouse");
  expect((await st()).dollhouse).toBe(true);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await page.waitForTimeout(100);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");
  await device(page, "const c = d.controllers.left; c.position.set(-0.1, 1.2, -0.3); c.quaternion.set(-0.3827, 0, 0, 0.9239);");
  await device(page, "d.controllers.left.updateButtonValue('trigger', 1);");
  await page.waitForTimeout(250);
  await device(page, "d.controllers.left.updateButtonValue('trigger', 0);");
  await expect.poll(async () => (await st()).dollhouse).toBe(false);

  // The dollhouse held like a part: a grip in it picks it up and carries it; both grips spread size it up.
  await press("dollhouse");
  type Held = { dollhouse: boolean; held: { scale: number; centre: number[]; holding: string[] } };
  const hs = () => page.evaluate("window.__cocaideViewport.vrState()") as Promise<Held>;
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await page.waitForTimeout(100);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");
  let h = await hs();
  expect(h.dollhouse).toBe(true);
  const k0 = h.held.scale;
  expect(k0).toBeLessThan(1);
  const d0 = h.held.centre;
  const hand = (side: string, p: number[]) => device(page, `const c = d.controllers.${side}; c.position.set(${p.map((v) => v / 1000).join(",")}); c.quaternion.set(0, 0, 0, 1);`);
  const squeeze = async (side: string, v: number) => {
    await device(page, `d.controllers.${side}.updateButtonValue('squeeze', ${v});`);
    await page.waitForTimeout(150);
  };
  await hand("right", d0);
  await page.waitForTimeout(100);
  await squeeze("right", 1);
  expect((await hs()).held.holding).toEqual(["right"]);
  await hand("right", [d0[0] + 150, d0[1] + 100, d0[2]]);
  await page.waitForTimeout(200);
  await squeeze("right", 0);
  h = await hs();
  expect(h.held.holding).toEqual([]);
  expect(Math.abs(h.held.centre[0] - (d0[0] + 150))).toBeLessThan(5);
  expect(Math.abs(h.held.centre[1] - (d0[1] + 100))).toBeLessThan(5);
  const d1 = h.held.centre;
  await hand("left", [d1[0] - 80, d1[1], d1[2]]);
  await hand("right", [d1[0] + 80, d1[1], d1[2]]);
  await page.waitForTimeout(100);
  await squeeze("left", 1);
  await squeeze("right", 1);
  await hand("left", [d1[0] - 160, d1[1], d1[2]]);
  await hand("right", [d1[0] + 160, d1[1], d1[2]]);
  await page.waitForTimeout(200);
  await squeeze("left", 0);
  await squeeze("right", 0);
  expect((await hs()).held.scale / k0).toBeCloseTo(2, 1);
  // Full size again: the model back in place, not held.
  await press("dollhouse");
  await expect.poll(async () => (await hs()).dollhouse).toBe(false);
  expect((await hs()).held.scale).toBe(1);

  // Out of VR: the pin and the move are in the file as proposals; the desktop shows the notes.
  await page.evaluate("window.__cocaideViewport.exitVr()");
  await expect.poll(async () => (await vr(page)).active).toBe(false);
  const saved = (await savedDocument(page)) as { vr: { pins: { tag: string; id: string }[]; moves: { id: string; body: string; turn?: number }[] } };
  expect(saved.vr.pins.map((p) => p.tag)).toEqual(["tight"]);
  expect(saved.vr.moves.map((m) => [m.body, m.turn])).toEqual([["sofa", 10]]);
  await expect(page.getByTestId("vr-review-chip")).toContainText("VR notes: 1 move, 1 pin");
  expect(await page.evaluate("window.__cocaideViewport.vrNotes()")).toBeGreaterThan(3);
  await page.getByTestId("vr-review-chip").click();
  // A note written on the pin; the move accepted: a Move feature, the proposal gone, the model rebuilt.
  const pinId = saved.vr.pins[0].id;
  await page.getByTestId(`vr-pin-text-${pinId}`).fill("door hits the sofa");
  await page.getByTestId(`vr-pin-text-${pinId}`).press("Enter");
  await expect.poll(async () => ((await savedDocument(page)) as typeof saved).vr.pins[0]).toMatchObject({ text: "door hits the sofa" });
  await page.getByTestId(`vr-accept-${saved.vr.moves[0].id}`).click();
  await expect.poll(async () => ((await savedDocument(page)) as { features: { op: string; bodies?: string[] }[] }).features.at(-1)).toMatchObject({ op: "move", bodies: ["sofa"] });
  await expect.poll(async () => ((await savedDocument(page)) as typeof saved).vr.moves).toBeUndefined();
  await waitForRebuild(page);
  await expect(page.getByTestId("status")).toContainText("Rebuilt");
  await expect(page.getByTestId("vr-review-chip")).toContainText("VR notes: 1 pin");
});

test("a part in VR is held to inspect: in front of you at true size; grabbed, it follows the hand and stays when let go; two hands stretch it; a measure stays true; A undoes it, B back to 1:1, Y brings it back", async ({ page }) => {
  // A 200 × 100 × 50 block, no start point: VR holds it.
  const doc = { version: 1, units: "mm", name: "block", features: [
    { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [100, 50], w: 200, h: 100 }] },
    { id: "block", op: "extrude", sketch: "s1", distance: 50, newBody: "block" },
  ] };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await waitForRebuild(page);
  type Held = { scale: number; centre: number[]; holding: string[] };
  type State = { mode: string; tool: string; measures: number[]; menu: boolean; held: Held };
  const st = () => page.evaluate("window.__cocaideViewport.vrState()") as Promise<State>;
  const press = (id: string) => page.evaluate(`window.__cocaideViewport.vrPress(${JSON.stringify(id)})`);
  await page.getByTestId("view-vr").click();
  await expect.poll(async () => (await st()).mode).toBe("inspect");
  // In front of you (the emulated head at 0, 1.6, 0 looking along −Z), a little below the eyes, at true size.
  await expect.poll(async () => (await st()).held.centre[2]).toBeLessThan(-300);
  let s = await st();
  expect(s.held.scale).toBe(1);
  expect(s.tool).toBe("measure");
  const c0 = s.held.centre;
  expect(Math.abs(c0[0])).toBeLessThan(20);
  expect(c0[1]).toBeGreaterThan(1200);
  expect(c0[1]).toBeLessThan(1500);
  const at = (hand: string, p: number[], q = [0, 0, 0, 1]) => device(page, `const c = d.controllers.${hand}; c.position.set(${p.map((v) => v / 1000).join(",")}); c.quaternion.set(${q.join(",")});`);
  const grip = async (hand: string, v: number) => {
    await device(page, `d.controllers.${hand}.updateButtonValue('squeeze', ${v});`);
    await page.waitForTimeout(150);
  };
  // One hand in it, gripped, moved 200 mm right and 100 up: the part goes with it, and stays when let go.
  await at("right", c0);
  await page.waitForTimeout(100);
  await grip("right", 1);
  expect((await st()).held.holding).toEqual(["right"]);
  await at("right", [c0[0] + 200, c0[1] + 100, c0[2]]);
  await page.waitForTimeout(200);
  await grip("right", 0);
  s = await st();
  expect(s.held.holding).toEqual([]);
  expect(Math.abs(s.held.centre[0] - (c0[0] + 200))).toBeLessThan(5);
  expect(Math.abs(s.held.centre[1] - (c0[1] + 100))).toBeLessThan(5);
  await at("right", [500, 500, 500]);
  await page.waitForTimeout(300);
  expect(Math.abs((await st()).held.centre[0] - (c0[0] + 200))).toBeLessThan(5);
  // Two hands either side of it, spread to twice as far apart: twice the size, about the same middle.
  const c1 = (await st()).held.centre;
  await at("left", [c1[0] - 80, c1[1], c1[2]]);
  await at("right", [c1[0] + 80, c1[1], c1[2]]);
  await page.waitForTimeout(100);
  await grip("left", 1);
  await grip("right", 1);
  expect((await st()).held.holding).toEqual(["left", "right"]);
  await at("left", [c1[0] - 160, c1[1], c1[2]]);
  await at("right", [c1[0] + 160, c1[1], c1[2]]);
  await page.waitForTimeout(200);
  await grip("left", 0);
  await grip("right", 0);
  s = await st();
  expect(s.held.scale).toBeCloseTo(2, 1);
  expect(Math.abs(s.held.centre[0] - c1[0])).toBeLessThan(5);
  // A measure along its top at twice the size: 200 mm, as it is. (Straight down onto points near each end's edge: they snap to it.)
  const scale = s.held.scale;
  const world = (p: number[]) => [s.held.centre[0] + (p[0] - 100) * scale, s.held.centre[1] + (p[2] - 25) * scale, s.held.centre[2] - (p[1] - 50) * scale];
  const down = [-0.7071068, 0, 0, 0.7071068];
  const click = async () => {
    await device(page, "d.controllers.right.updateButtonValue('trigger', 1);");
    await page.waitForTimeout(250);
    await device(page, "d.controllers.right.updateButtonValue('trigger', 0);");
    await page.waitForTimeout(250);
  };
  for (const p of [[2, 50, 50], [198, 50, 50]]) {
    const w = world(p);
    await at("right", [w[0], w[1] + 250, w[2]], down);
    await page.waitForTimeout(150);
    await click();
  }
  await expect.poll(async () => (await st()).measures).toEqual([200]);
  // A undoes the last measure (only that one); B: back to true size where it is; Y: brought back in front of you.
  await device(page, "d.controllers.right.updateButtonValue('a-button', 1);");
  await page.waitForTimeout(150);
  await device(page, "d.controllers.right.updateButtonValue('a-button', 0);");
  await expect.poll(async () => (await st()).measures).toEqual([]);
  expect((await st()).held.scale).toBeCloseTo(2, 1);
  await device(page, "d.controllers.right.updateButtonValue('b-button', 1);");
  await page.waitForTimeout(150);
  await device(page, "d.controllers.right.updateButtonValue('b-button', 0);");
  await expect.poll(async () => (await st()).held.scale).toBe(1);
  await device(page, "d.controllers.left.updateButtonValue('y-button', 1);");
  await page.waitForTimeout(150);
  await device(page, "d.controllers.left.updateButtonValue('y-button', 0);");
  await expect.poll(async () => Math.abs((await st()).held.centre[0] - c0[0])).toBeLessThan(20);
  // Walk in it, and hold it again (the menu).
  await press("walk");
  expect((await st()).mode).toBe("walk");
  expect((await st()).held.scale).toBe(1);
  await press("inspect");
  expect((await st()).mode).toBe("inspect");
  await page.evaluate("window.__cocaideViewport.exitVr()");
  await expect.poll(async () => (await vr(page)).active).toBe(false);
});

test("measuring faces in VR: point at a hole to read its size, click it and a post for the closest gap; two parallel faces give the gap square to them; A undoes", async ({ page }) => {
  // On the slab: a Ø100 hole through it, a 200 square post, and a screen 1050 behind the post's front.
  const doc = (await savedDocument(page)) as { features: unknown[] };
  doc.features.push(
    { id: "s4", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "c", type: "circle", center: [3000, 6000], radius: 50 }] },
    { id: "hole", op: "cut", sketch: "s4", distance: 100 },
    { id: "s5", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, entities: [{ id: "r", type: "rect", center: [4000, 6500], w: 200, h: 200 }] },
    { id: "post", op: "extrude", sketch: "s5", distance: 800, newBody: "post" },
    { id: "s6", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, entities: [{ id: "r", type: "rect", center: [2000, 7500], w: 1000, h: 100 }] },
    { id: "screen", op: "extrude", sketch: "s6", distance: 1200, newBody: "screen" },
  );
  (doc as Record<string, unknown>).vr = { start: { at: [3000, 4500, 100], heading: 90 } };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await waitForRebuild(page);
  type State = { menu: boolean; measureMode: string; cards: string[]; faceHover: string | null };
  const st = () => page.evaluate("window.__cocaideViewport.vrState()") as Promise<State>;
  const press = (id: string) => page.evaluate(`window.__cocaideViewport.vrPress(${JSON.stringify(id)})`);
  const click = async (btn = "trigger") => {
    await device(page, `d.controllers.right.updateButtonValue('${btn}', 1);`);
    await page.waitForTimeout(250);
    await device(page, `d.controllers.right.updateButtonValue('${btn}', 0);`);
    await page.waitForTimeout(250);
  };
  /** The right controller pointed at a point of the model (mm). */
  const aim = async (p: number[]) => {
    const w = (await page.evaluate(`window.__cocaideViewport.vrWorldOf(${JSON.stringify(p)})`)) as number[];
    const from = [0.3, 1.2, -0.3];
    const d = w.map((v, i) => v - from[i]);
    const l = Math.hypot(...d);
    const b = d.map((v) => v / l);
    const q = [b[1], -b[0], 0, 1 - b[2]];
    const ql = Math.hypot(...q);
    await device(page, `const c = d.controllers.right; c.position.set(${from.join(",")}); c.quaternion.set(${q.map((v) => v / ql).join(",")});`);
    await page.waitForTimeout(200);
  };
  await page.getByTestId("view-vr").click();
  await expect.poll(async () => (await vr(page)).active).toBe(true);
  await press("measure:faces");
  await device(page, "d.controllers.left.updateButtonValue('x-button', 1);");
  await page.waitForTimeout(100);
  await device(page, "d.controllers.left.updateButtonValue('x-button', 0);");
  await expect.poll(async () => (await st()).menu).toBe(false);
  expect((await st()).measureMode).toBe("faces");

  // Pointed at the hole's far wall: lit up and named with its size, before any click.
  await aim([3000, 6050, 70]);
  await expect.poll(async () => (await st()).faceHover).toBe("Ø100 hole");
  await click();
  await expect.poll(async () => (await st()).cards).toEqual(["Ø100 hole · 100 mm deep"]);
  // Then the post's front: the hole to the post, closest; the hover said so first.
  await aim([4000, 6400, 500]);
  await expect.poll(async () => (await st()).faceHover).toMatch(/^[\d,.]+ mm · (closest|from here) · click$/);
  await click();
  await expect.poll(async () => (await st()).cards[0]).toMatch(/^[\d,.]+ mm (closest|from here)/);

  // The post's front and the screen's: parallel, 1050 apart.
  await click();
  await expect.poll(async () => (await st()).cards.length).toBe(2);
  expect((await st()).cards[1]).toMatch(/ flat · plumb$/);
  await aim([1800, 7450, 600]);
  await click();
  await expect.poll(async () => (await st()).cards[1]).toBe("1,050 mm gap · offset, closest 1,750 mm");
  // A undoes the last measure; Points still measure point to point.
  await click("a-button");
  await expect.poll(async () => (await st()).cards.length).toBe(1);
  await press("measure:points");
  expect((await st()).measureMode).toBe("points");
});

test("walking off a table in VR brings you down to the floor", async ({ page }) => {
  // A slab (top at 100) and a table on it (top at 800).
  const doc = {
    version: 1,
    units: "mm",
    name: "room",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [3000, 5000], w: 8000, h: 10000 }] },
      { id: "slab", op: "extrude", sketch: "s1", distance: 100, newBody: "slab" },
      { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, entities: [{ id: "r", type: "rect", center: [3000, 5000], w: 1200, h: 1000 }] },
      { id: "bench", op: "extrude", sketch: "s2", distance: 700, newBody: "bench" },
    ],
    vr: { start: { at: [3000, 3000, 100], heading: 90 } },
  };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await waitForRebuild(page);
  await page.getByTestId("view-vr").click();
  await expect.poll(async () => (await vr(page)).active).toBe(true);
  // Standing on the table (y 4500–5500), facing north; the left stick held walks off its edge.
  await hook(page, (h) => (h as unknown as { vrStandAt(at: number[], heading: number): void }).vrStandAt([3000, 4800, 800], 90));
  await page.waitForTimeout(200);
  expect(Math.abs((await vr(page)).standing!.at[2] - 800)).toBeLessThan(20);
  await device(page, "d.controllers.left.updateAxes('thumbstick', 0, 1);");
  await expect.poll(async () => Math.abs((await vr(page)).standing!.at[1] - 4800), { timeout: 10_000 }).toBeGreaterThan(900);
  await device(page, "d.controllers.left.updateAxes('thumbstick', 0, 0);");
  // Down on the slab, not hanging at the table's height.
  await expect.poll(async () => Math.abs((await vr(page)).standing!.at[2] - 100), { timeout: 5_000 }).toBeLessThan(20);
});

test("a .glb model in an assembly keeps its texture in VR, beside a plain white part", async ({ page }) => {
  // A white slab (this part) and a textured 2 × 0.5 × 1 m model, white too under its texture: VR must not take one for the other.
  const doc = {
    version: 1, units: "mm", name: "room", appearance: { color: "#ffffff" },
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [3000, 5000], w: 8000, h: 10000 }] },
      { id: "slab", op: "extrude", sketch: "s1", distance: 100, newBody: "slab" },
    ],
    assembly: {
      parts: { sofa: { version: 1, units: "mm", name: "Sofa", features: [], mesh: { glb: Buffer.from(boxGlb(2, 0.5, 1)).toString("base64") } } },
      components: [{ id: "room", part: "self", fixed: true }, { id: "sofa-1", part: "sofa", at: [3000, 5000, 100] }],
    },
    vr: { start: { at: [3000, 3000, 100], heading: 90 } },
  };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await waitForRebuild(page);
  await page.getByTestId("mode-assembly").click();
  await expect.poll(async () => page.evaluate("window.__cocaideViewport.meshLooks()"), { timeout: 60_000 }).toEqual([expect.objectContaining({ texture: true, loaded: true, uv: true })]);
  await page.getByTestId("view-vr").click();
  await expect.poll(async () => (await vr(page)).active).toBe(true);
  type T = { textured: number; drawUv: boolean };
  await expect.poll(async () => ((await page.evaluate("window.__cocaideViewport.vrState()")) as T).textured).toBe(1);
  expect(((await page.evaluate("window.__cocaideViewport.vrState()")) as T).drawUv).toBe(true);
  // And it is furniture: it moves.
  expect(((await page.evaluate("window.__cocaideViewport.vrItems()")) as string[]).filter((s) => s.startsWith("sofa-1"))).toEqual(["sofa-1/model:true"]);
});

test("the right stick held up or down lifts you like a lift (a quick flick doesn't), walking keeps you at that height, and a teleport puts you back on the floor", async ({ page }) => {
  const doc = {
    version: 1,
    units: "mm",
    name: "room",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [3000, 5000], w: 8000, h: 10000 }] },
      { id: "slab", op: "extrude", sketch: "s1", distance: 100, newBody: "slab" },
    ],
    vr: { start: { at: [3000, 3000, 100], heading: 90 } },
  };
  const text = JSON.stringify(doc);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.reload();
  await waitForRebuild(page);
  await page.getByTestId("view-vr").click();
  await expect.poll(async () => (await vr(page)).active).toBe(true);
  const lift = () => page.evaluate("window.__cocaideViewport.vrState().lift") as Promise<number>;
  const z = async () => (await vr(page)).standing!.at[2];
  await expect.poll(z).toBeLessThan(120);
  // A quick flick (under a quarter second, as on the way to a turn) doesn't lift you.
  await device(page, "d.controllers.right.updateAxes('thumbstick', 0, -1);");
  await page.waitForTimeout(80);
  await device(page, "d.controllers.right.updateAxes('thumbstick', 0, 0);");
  await page.waitForTimeout(300);
  expect(await lift()).toBe(0);
  // Up: the right stick held forward lifts you; let go, you stay there (not dropped back to the floor).
  await device(page, "d.controllers.right.updateAxes('thumbstick', 0, -1);");
  await expect.poll(lift, { timeout: 15_000 }).toBeGreaterThan(250);
  await device(page, "d.controllers.right.updateAxes('thumbstick', 0, 0);");
  await page.waitForTimeout(300);
  const up = await lift();
  await page.waitForTimeout(500);
  expect(await lift()).toBe(up);
  expect(Math.abs((await z()) - (100 + up))).toBeLessThan(25);
  // Down past the floor: lowered, as if sitting low.
  await device(page, "d.controllers.right.updateAxes('thumbstick', 0, 1);");
  await expect.poll(lift, { timeout: 15_000 }).toBeLessThan(-150);
  await device(page, "d.controllers.right.updateAxes('thumbstick', 0, 0);");
  await page.waitForTimeout(300);
  const down = await lift();
  // Walking keeps you lowered that far above (below) the floor.
  await device(page, "d.controllers.left.updateAxes('thumbstick', 0, -1);");
  await expect.poll(async () => (await vr(page)).standing!.at[1], { timeout: 5_000 }).toBeGreaterThan(3600);
  await device(page, "d.controllers.left.updateAxes('thumbstick', 0, 0);");
  await page.waitForTimeout(300);
  expect(await lift()).toBe(down);
  expect(Math.abs((await z()) - (100 + down))).toBeLessThan(25);
  // A teleport: back on the floor at your own height.
  await device(page, "const c = d.controllers.left; c.position.set(-0.2, 1.2, -0.3); c.quaternion.set(-0.2588, 0, 0, 0.9659); c.updateButtonValue('trigger', 1);");
  await page.waitForTimeout(400);
  await device(page, "d.controllers.left.updateButtonValue('trigger', 0);");
  await expect.poll(lift).toBe(0);
  await expect.poll(async () => Math.abs((await z()) - 100)).toBeLessThan(25);
});
