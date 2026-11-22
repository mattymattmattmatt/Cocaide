// The touch viewer on a phone (an emulated Pixel 7): it opens instead of the full app; Views, Measure (a tap on the
// slab: its face and the piece's size), Section (a plan cut), Parts (hide a body), VR notes (accept a move), Share;
// one finger turns the view, a two-finger pinch zooms; Full app and back. A computer gets the full app.
import { devices, expect, test, type Page } from "@playwright/test";

const DOC = {
  version: 1, units: "mm", name: "site",
  features: [
    { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [5000, 5000], w: 10000, h: 10000 }] },
    { id: "slab", op: "extrude", sketch: "s1", distance: 100, newBody: "slab" },
    { id: "s3", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, entities: [{ id: "r", type: "rect", center: [2000, 3000], w: 3000, h: 200 }] },
    { id: "wall", op: "extrude", sketch: "s3", distance: 2600, newBody: "wall" },
    { id: "s4", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, entities: [{ id: "r", type: "rect", center: [6000, 6000], w: 2000, h: 900 }] },
    { id: "sofa", op: "extrude", sketch: "s4", distance: 800, newBody: "sofa" },
  ],
  vr: {
    pins: [{ id: "pin_1", at: [5000, 5000, 100], tag: "tight", text: "Check this gap" }],
    moves: [{ id: "move_1", body: "sofa", move: [500, 0, 0], centre: [6000, 6000, 500] }],
  },
};

async function openPhoneApp(page: Page) {
  await page.goto("/?e2e");
  await page.evaluate(() => localStorage.clear());
  const text = JSON.stringify(DOC);
  await page.evaluate((text) => localStorage.setItem("cocaide.document.v1", JSON.stringify({ text, savedText: text })), text);
  await page.goto("/?e2e");
  await expect(page.getByTestId("mobile-viewer")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".mv-status")).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => page.evaluate("(window.__cocaideViewport?.vrItems?.() ?? []).length"), { timeout: 60_000 }).toBeGreaterThan(2);
  await page.waitForTimeout(500);
}
const camera = (page: Page) => page.evaluate("window.__cocaideViewport.camera()") as Promise<{ position: number[]; target: number[] }>;
const dist = (c: { position: number[]; target: number[] }) => Math.hypot(...c.position.map((v, i) => v - c.target[i]));

test.describe("on a phone", () => {
  const { defaultBrowserType: _b, ...pixel } = devices["Pixel 7"];
  test.use(pixel);

  test("the touch viewer: views, measure, section, parts, VR notes, share; pinch to zoom; full app and back", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await openPhoneApp(page);
    await expect(page.getByTestId("doc-name-mobile")).toHaveText("site");
    // The full app's bars are not there.
    await expect(page.locator("header.topbar")).toHaveCount(0);
    const box = (await page.locator(".mv-view").boundingBox())!;
    const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // Views: the sheet's buttons turn the view.
    await page.getByTestId("mv-views").tap();
    const before = await camera(page);
    await page.getByTestId("mv-view.top").tap();
    await expect.poll(async () => JSON.stringify(await camera(page))).not.toBe(JSON.stringify(before));
    await page.getByTestId("mv-view.fit").tap();
    await page.waitForTimeout(600);

    // Pinch: two fingers spreading zoom in.
    const cdp = await page.context().newCDPSession(page);
    const zoomedFrom = dist(await camera(page));
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", pts: { x: number; y: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
    await touch("touchStart", [{ x: mid.x - 40, y: mid.y }, { x: mid.x + 40, y: mid.y }]);
    for (let k = 1; k <= 6; k++) await touch("touchMove", [{ x: mid.x - 40 - k * 15, y: mid.y }, { x: mid.x + 40 + k * 15, y: mid.y }]);
    await touch("touchEnd", []);
    await expect.poll(async () => dist(await camera(page))).toBeLessThan(zoomedFrom * 0.7);
    // The pinch selected nothing (it is not a tap).
    await page.getByTestId("mv-view.fit").tap();
    await page.waitForTimeout(600);

    // Measure: a tap on the slab, from above: its face, and the piece's size.
    await page.getByTestId("mv-view.top").tap();
    await page.waitForTimeout(600);
    await page.getByTestId("mv-measure").tap();
    await expect(page.getByTestId("mv-measure-result")).toContainText("Tap a face");
    const s = (await page.evaluate("window.__cocaideViewport.project([9000, 1000, 100])")) as [number, number];
    await page.touchscreen.tap(s[0], s[1]);
    await expect(page.getByTestId("mv-piece")).toHaveText("slab: 10,000 × 10,000 × 100 mm");
    await page.getByTestId("mv-measure-clear").tap();
    await expect(page.getByTestId("mv-measure-result")).toContainText("Tap a face");

    // Section: a plan cut, its slider; off again.
    await page.getByTestId("mv-section").tap();
    await page.getByTestId("mv-cut-Top").tap();
    await expect(page.getByTestId("mv-cut-slider")).toBeVisible();
    await expect(page.getByTestId("mv-cut-Top")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("mv-cut-off").tap();
    await expect(page.getByTestId("mv-cut-slider")).toHaveCount(0);

    // Parts: the three bodies; hiding the wall takes it out of the view.
    await page.getByTestId("mv-parts").tap();
    await expect(page.getByTestId("mv-part-wall")).toBeChecked();
    await page.getByTestId("mv-part-wall").tap();
    await expect(page.getByTestId("mv-part-wall")).not.toBeChecked();
    await page.getByTestId("mv-parts-all").tap();
    await expect(page.getByTestId("mv-part-wall")).toBeChecked();

    // VR notes: two (a badge), the panel open; accepting the move makes it a Move feature and leaves the pin.
    await expect(page.getByTestId("mv-notes")).toContainText("2");
    await page.getByTestId("mv-notes").tap();
    await expect(page.getByTestId("vr-pin-text-pin_1")).toHaveValue("Check this gap");
    await page.getByTestId("vr-accept-move_1").tap();
    await expect(page.getByTestId("mv-notes")).toContainText("1");
    const saved = await page.evaluate(() => JSON.parse(JSON.parse(localStorage.getItem("cocaide.document.v1")!).text));
    expect(saved.features.some((f: { op: string; bodies?: string[] }) => f.op === "move" && f.bodies?.[0] === "sofa")).toBe(true);

    // Share opens the share dialog.
    await page.getByTestId("mv-share").tap();
    await expect(page.getByTestId("share-dialog")).toBeVisible();
    await page.getByTestId("share-close").tap();

    // Full app, and back to the viewer (remembered on the phone).
    await page.getByTestId("mv-full").tap();
    await expect(page.locator("header.topbar")).toBeVisible();
    await expect(page.getByTestId("mobile-viewer")).toHaveCount(0);
    await page.reload();
    await expect(page.locator("header.topbar")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("layout-viewer").click();
    await expect(page.getByTestId("mobile-viewer")).toBeVisible();
    expect(problems).toEqual([]);
  });
});

test("a computer gets the full app (and no Viewer button)", async ({ page }) => {
  await page.goto("/?e2e");
  await expect(page.locator("header.topbar")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("mobile-viewer")).toHaveCount(0);
  await expect(page.getByTestId("layout-viewer")).toHaveCount(0);
});
