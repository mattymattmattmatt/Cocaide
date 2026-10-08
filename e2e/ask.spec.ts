// Phase D in the browser: right-click ask. The page uses the real Anthropic
// SDK; Playwright answers its requests to api.anthropic.com with scripted
// Messages API responses and records what was sent, so these tests check the
// packet, the tools offered, the scope, and what reaches the document.

import { expect, test } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, scriptModel, text, tool, useKey, type Sent } from "./helpers";

/** The text of the first user turn: the packet and the request. */
function packetText(s: Sent): string {
  const content = s.body.messages[0].content as { type: string; text?: string }[];
  return content.find((b) => b.type === "text")!.text!;
}
function packetOf(s: Sent): Record<string, unknown> {
  const t = packetText(s);
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
}

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test('right-click hole_1, "make it 8 mm": changes that diameter only', async ({ page }) => {
  // Set the key through the settings dialog, as a user would.
  await page.getByTestId("ask-settings-open").click();
  await page.getByTestId("settings-tab-assistant").click();
  await page.getByTestId("ask-api-key").fill("sk-test");
  await page.getByTestId("ask-settings-save").click();
  const sent = await scriptModel(page, [[tool("updateFeature", { id: "hole_1", patch: { diameter: 8 } })], [text("hole_1 is now Ø8, still through.")]]);
  const before = await savedDocument(page);

  await page.getByTestId("feature-hole_1").locator(".feature-row").click({ button: "right" });
  await expect(page.getByTestId("ask-target")).toHaveText("hole_1");
  await expect(page.getByTestId("ask-scope")).toHaveText("may change: hole_1");
  await page.getByTestId("ask-input").fill("make it 8 mm");
  await page.getByTestId("ask-input").press("Enter");

  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await expect(page.getByTestId("ask-text")).toHaveText("hole_1 is now Ø8, still through.");
  await expect(page.getByTestId("ask-proposal")).toContainText("hole_1 diameter: 6.6 → 8");
  // The viewport previews the proposal; the document is not touched yet.
  await expect(page.getByTestId("preview-banner")).toBeVisible();
  await expectVolume(page, "18,898.407");
  expect(await savedDocument(page)).toEqual(before);

  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  const after = await savedDocument(page);
  const features = after.features as Record<string, unknown>[];
  expect(features[2]).toEqual({ ...(before.features as Record<string, unknown>[])[2], diameter: 8 });
  expect(features.slice(0, 2)).toEqual((before.features as unknown[]).slice(0, 2));
  await expectVolume(page, "18,898.407");

  // What the page sent: the packet for hole_1 (parent ext_1, no children), not the whole tree; the text last.
  const first = sent[0];
  expect(first.body.model).toBe("claude-opus-5-5");
  expect(first.body.output_config).toEqual({ effort: "low" });
  expect(first.headers["x-api-key"]).toBe("sk-test");
  expect(first.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  const packet = packetOf(first);
  expect(packet.target).toMatchObject({ kind: "feature", id: "hole_1" });
  expect(packet.writeScope).toEqual(["hole_1"]);
  expect((packet.parent as { id: string }).id).toBe("ext_1");
  expect(packet.children).toEqual([]);
  expect(packetText(first)).not.toContain('"entities"');
  expect(packetText(first).endsWith("The user's request:\nmake it 8 mm")).toBe(true);
  expect(first.body.tools.map((t) => t.name)).toContain("updateFeature");

  // One undo step takes it back.
  await page.getByTestId("ask-close").click();
  await page.getByTestId("undo").click();
  await expectVolume(page, "18,994.728");
});

test('right-click a sketch entity, "pattern the part": refused as out of scope', async ({ page }) => {
  await useKey(page);
  const pattern = { op: "linearPattern", feature: "ext_1", direction: [1, 0, 0], spacing: 100, count: 2 };
  const sent = await scriptModel(page, [[tool("addFeature", { feature: pattern })], [text("Patterning the part is outside what a right-click on r1 may change.")]]);
  const before = await savedDocument(page);

  await page.getByTestId("feature-sketch_1").locator(".feature-row").dblclick();
  // Right-click the rectangle's right edge (x = 40 mm in the sketch).
  const [x, y] = await page.evaluate(() => {
    const g = document.querySelector("[data-testid=sketch-canvas] > g") as SVGGElement;
    const m = g.getScreenCTM()!;
    return [m.a * 40 + m.e, m.d * 0 + m.f];
  });
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.getByTestId("ask-target")).toHaveText("r1 in sketch_1");
  await expect(page.getByTestId("ask-scope")).toHaveText("may change: r1 in sketch_1 and its constraints");
  await page.getByTestId("ask-input").fill("pattern the part");
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-outcome")).toHaveText("Out of scope");
  await expect(page.getByTestId("ask-text")).toContainText("outside what a right-click on r1 may change");
  await expect(page.getByTestId("ask-accept")).toHaveCount(0);
  // The tool result the model saw was the scope rejection.
  const results = sent[1].body.messages.at(-1)!.content as { content: string; is_error?: boolean }[];
  expect(results[0].is_error).toBe(true);
  expect(results[0].content).toContain('writeScope: addFeature \\"linearPattern_1\\" is outside the scope [sketch_1/r1]');
  await page.getByTestId("ask-close").click();
  await page.getByTestId("cancel-sketch").click();
  expect(await savedDocument(page)).toEqual(before);
});

test('"what is this face" returns text and does not write', async ({ page }) => {
  await useKey(page);
  const sent = await scriptModel(page, [[text("The top face of the 80 × 40 plate, at Z = 6. hole_1 goes through it.")]]);
  const before = await savedDocument(page);

  const [x, y] = await page.evaluate(() => (window as unknown as { __cocaideViewport: { project(p: number[]): [number, number] } }).__cocaideViewport.project([-10, -10, 6]));
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.getByTestId("ask-target")).toHaveText("this flat face");
  await expect(page.getByTestId("ask-scope")).toHaveText("may change: add one feature that uses it");
  await page.getByTestId("ask-action-what-is-this-face").click();

  await expect(page.getByTestId("ask-outcome")).toHaveText("Answer");
  await expect(page.getByTestId("ask-text")).toContainText("top face of the 80 × 40 plate");
  await expect(page.getByTestId("ask-proposal")).toHaveCount(0);
  expect(await savedDocument(page)).toEqual(before);

  // An explain-only ask is offered no write tools, and gets one picture framed on the face.
  expect(sent).toHaveLength(1);
  expect(sent[0].body.tools.map((t) => t.name)).toEqual(["measure", "getFeature", "escalate"]);
  const content = sent[0].body.messages[0].content as { type: string }[];
  expect(content.filter((b) => b.type === "image")).toHaveLength(1);
  expect(packetOf(sent[0])).toMatchObject({ target: { kind: "face" }, writeScope: ["+"], selection: { type: "planar", normal: [0, 0, 1], pick: "largest" } });
});

test("a user edit to the feature drops the open proposal and keeps the prompt", async ({ page }) => {
  await useKey(page);
  await scriptModel(page, [[tool("updateFeature", { id: "hole_1", patch: { diameter: 8 } })], [text("Set Ø8.")], [tool("updateFeature", { id: "hole_1", patch: { diameter: 8 } })], [text("Set Ø8 again.")]]);
  await page.getByTestId("feature-hole_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ask-input").fill("make it 8 mm");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");

  // Turn the preview off, then edit hole_1 by hand.
  await page.getByTestId("ask-preview").uncheck();
  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await commit(page, "prop-diameter", "5");
  await expect(page.getByTestId("ask-dropped")).toContainText("You changed hole_1, so the proposal was dropped");
  await expect(page.getByTestId("ask-accept")).toHaveCount(0);
  expect(((await savedDocument(page)).features as Record<string, unknown>[])[2].diameter).toBe(5);

  // The prompt is kept: run it again.
  await page.getByTestId("ask-again").click();
  await expect(page.getByTestId("ask-input")).toHaveValue("make it 8 mm");
});

test("fix this error, with apply immediately", async ({ page }) => {
  await useKey(page);
  await page.getByTestId("feature-hole_1").locator(".feature-row").click();
  await commit(page, "prop-center-x", "300");
  await expect(page.getByTestId("feature-error-hole_1")).toBeVisible();
  const sent = await scriptModel(page, [[tool("updateFeature", { id: "hole_1", patch: { center: [30, 0] } })], [text("Moved hole_1 back onto the plate at [30, 0].")]]);

  await page.getByTestId("feature-error-hole_1").click({ button: "right" });
  await expect(page.getByTestId("ask-scope")).toHaveText("may change: hole_1");
  await page.getByTestId("ask-apply-now").check();
  await page.getByTestId("ask-action-fix-this-error").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  await expectVolume(page, "18,994.728");
  expect(((await savedDocument(page)).features as Record<string, unknown>[])[2].center).toEqual([30, 0]);
  expect(packetOf(sent[0]).error).toMatch(/^hole_1: center \[300, 0\] is not on the selected face/);
  expect(packetOf(sent[0]).target).toMatchObject({ kind: "failed", id: "hole_1" });
});
