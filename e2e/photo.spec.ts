// Phase G in the browser: drop a photo of the bracket. The photo is prepared
// and stored in the page, the real SDK sends it, and Playwright answers the
// API with a scripted reading in the photo's pixels. The plan, the underlay,
// the scale, the estimates and the export refusal are real.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { HOLE, PLATE, RULE } from "../scripts/make-photos";
import { dropFile, expectVolume, openApp, savedDocument, scriptModel, text, useKey, waitForRebuild } from "./helpers";

const reading = JSON.stringify({
  category: { value: "prismatic", evidence: "a flat rectangular steel plate with one round hole", confidence: 0.95 },
  description: "a flat steel plate with one hole near the right end",
  name: "bracket",
  view: "face-on",
  kind: "plate",
  outline: PLATE,
  holes: [{ x: HOLE.x, y: HOLE.y, diameter: HOLE.d }],
  thickness: null,
  typedThickness: { value: null, units: "mm", evidence: "" },
  scale: {
    what: "the plate's long edge",
    dimension: "width",
    from: { x: PLATE.left, y: 420 },
    to: { x: PLATE.right, y: 420 },
    length: 80,
    units: "mm",
    evidence: "the long edge is 80 mm",
    source: "typed",
  },
  notes: [],
});

/** Clicks the pinned photo at one of its pixels. */
async function clickPhoto(page: Page, px: [number, number]) {
  const at = await page.evaluate((px) => (window as unknown as { __cocaideViewport: { photoPoint(p: number[]): [number, number] | null } }).__cocaideViewport.photoPoint(px), px);
  expect(at).not.toBeNull();
  await page.mouse.click(at![0], at![1]);
}

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
  await useKey(page);
  await page.getByTestId("new-part").click();
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("the system refuses to export STEP until the user has confirmed the scale dimension", async ({ page }) => {
  const sent = await scriptModel(page, [[text(reading)]]);
  await dropFile(page, "examples/photos/bracket-photo.jpg", "image/jpeg");
  // An image could be a drawing or a photo: the pixels say photo, and the user can switch.
  await expect(page.getByTestId("ask-read-as-photo")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("ask-drawing")).toHaveText("Photo: bracket-photo.jpg · 1400 × 1000 px · sizes are estimated from one you know");
  await page.getByTestId("ask-input").fill("the long edge is 80 mm");
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await expect(page.getByTestId("ask-text")).toContainText("Export stays off until you confirm the scale on the photo and set the guesses. It is an estimate, not a part ready to make.");
  // What the page sent: the photo as a JPEG at its own size, with the note, as structured output.
  const content = sent[0].body.messages[0].content as { type: string; source?: { media_type: string; data: string }; text?: string }[];
  expect(content[0]).toMatchObject({ type: "image", source: { media_type: "image/jpeg" } });
  expect(content[1].text).toContain("bracket-photo.jpg, 1400 × 1000 pixels");
  expect(content[1].text).toContain("The user's note:\nthe long edge is 80 mm");
  await page.getByTestId("ask-accept").click();
  await expectVolume(page, "12,663.152"); // 80 × 40, with a guessed 4 mm thickness
  await page.getByTestId("ask-close").click();

  // Pinned: the scale is not confirmed, and the sizes say where they came from.
  await expect(page.getByTestId("photo-status")).toHaveText("Scale not confirmed: export is off");
  await expect(page.getByTestId("param-mark-plate_w")).toHaveText("scale");
  await expect(page.getByTestId("param-mark-plate_h")).toHaveText("≈ photo");
  await expect(page.getByTestId("param-mark-part_t")).toHaveText("guess");
  await expect(page.getByTestId("photo-guesses")).toHaveText("part_t is a guess: the photo doesn't show it. Set it in Parameters.");

  let downloads = 0;
  page.on("download", () => downloads++);
  const exportStep = page.getByRole("button", { name: "Export STEP" });
  await exportStep.click();
  await expect(page.getByTestId("notice")).toContainText(
    "Not exported. This part was estimated from a photo (bracket-photo.jpg), and its scale is not confirmed: check that the plate's long edge is 80 mm on the photo, then confirm it; " +
      "and part_t is a guess: the photo doesn't show it. Set it in Parameters.",
  );

  // The user measures the part: 6 thick. Still no export: the scale isn't confirmed.
  await page.getByTestId("param-value-part_t").fill("6");
  await page.getByTestId("param-value-part_t").press("Enter");
  await expect(page.getByTestId("param-mark-part_t")).toHaveCount(0);
  await expectVolume(page, "18,994.728");
  await exportStep.click();
  await expect(page.getByTestId("notice")).toHaveText(/^Not exported\. .*its scale is not confirmed/);
  expect(downloads).toBe(0);

  // They set the scale on the rule in the photo instead: its 0 and 100 marks.
  await page.getByTestId("photo-pick").click();
  await expect(page.getByTestId("photo-pick")).toHaveText("Click the first point on the photo… (Esc)");
  await clickPhoto(page, RULE.zero);
  await expect(page.getByTestId("photo-pick")).toHaveText("Click the second point… (Esc)");
  await clickPhoto(page, RULE.hundred);
  // 80 mm across 800 px: everything measured on the photo shrinks until the length is right.
  await expect(page.getByTestId("param-value-plate_w")).toHaveValue("64");
  await page.getByTestId("photo-length").fill("100");
  await page.getByTestId("photo-length").press("Enter");
  await expect(page.getByTestId("param-value-plate_w")).toHaveValue("80");
  await expect(page.getByTestId("param-value-hole_d")).toHaveValue("6.6");
  await expectVolume(page, "18,994.728");

  await page.getByTestId("photo-confirm").click();
  await expect(page.getByTestId("photo-status")).toHaveText("Scale confirmed");
  const download = page.waitForEvent("download");
  await exportStep.click();
  const step = readFileSync(await (await download).path(), "utf8");
  expect(step).toContain("FILE_DESCRIPTION(('Estimated from a photo (bracket-photo.jpg), scaled from one dimension the user confirmed: the line picked on the photo = 100 mm.");
  await expect(page.getByTestId("notice")).toContainText("Exported bracket.step. It was estimated from a photo: check every size against the part before making it.");

  const doc = await savedDocument(page);
  expect(doc.photo).toMatchObject({ image: "bracket-photo.jpg", scale: { length: 100, source: "typed", confirmed: true } });
  expect((doc.photo as { scale: { from: number[] } }).scale.from.map(Math.round)).toEqual(RULE.zero);
});

test("a freeform part is refused, and a drawing dropped as an image stays a drawing", async ({ page }) => {
  const freeform = JSON.parse(reading);
  freeform.category = { value: "freeform", evidence: "a smooth, organic moulded shape", confidence: 0.9 };
  freeform.kind = "other";
  await scriptModel(page, [[text(JSON.stringify(freeform))]]);
  await dropFile(page, "examples/photos/freeform-photo.jpg", "image/jpeg");
  await page.getByTestId("ask-submit").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Out of scope");
  await expect(page.getByTestId("ask-text")).toHaveText("This looks freeform (a smooth, organic moulded shape). Cocaide builds prismatic and turned parts; model this one by hand, with the photo for reference.");
  expect((await savedDocument(page)).features).toEqual([]);
  await page.keyboard.press("Escape");

  await dropFile(page, "examples/drawings/bracket-scan.png", "image/png");
  await expect(page.getByTestId("ask-read-as-drawing")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("ask-drawing")).toHaveText("Drawing: bracket-scan.png · scan");
});

test("the photo stays in this browser; dropped again, it is pinned again", async ({ page }) => {
  await scriptModel(page, [[text(reading)]]);
  await dropFile(page, "examples/photos/bracket-photo.jpg", "image/jpeg");
  await page.getByTestId("ask-input").fill("the long edge is 80 mm");
  await page.getByTestId("ask-submit").click();
  await page.getByTestId("ask-accept").click();
  await page.getByTestId("ask-close").click();
  await expect(page.getByTestId("photo-pick")).toBeEnabled();

  // A reload finds it in IndexedDB.
  await page.reload();
  await waitForRebuild(page);
  await expect(page.getByTestId("photo-pick")).toBeEnabled();
  await expect(page.getByTestId("photo-missing")).toHaveCount(0);

  // Another browser wouldn't have it: the document still says which photo, and dropping it pins it again.
  await page.evaluate(() => new Promise((done) => (indexedDB.deleteDatabase("cocaide-photos").onsuccess = done)));
  await page.reload();
  await waitForRebuild(page);
  await expect(page.getByTestId("photo-missing")).toHaveText("This browser doesn't have the photo. Drop bracket-photo.jpg on the window to pin it again.");
  await expect(page.getByTestId("photo-pick")).toBeDisabled();
  await dropFile(page, "examples/photos/bracket-photo.jpg", "image/jpeg");
  await expect(page.getByTestId("notice")).toContainText("Pinned bracket-photo.jpg under the part again.");
  await expect(page.getByTestId("photo-missing")).toHaveCount(0);
  await expect(page.getByTestId("ask")).toHaveCount(0); // no ask: nothing to read
});
