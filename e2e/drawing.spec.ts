// Phase F in the browser: drop a drawing. The real PDF is rasterised by
// pdf.js at 200 dpi with its text layer, legibility is measured on the
// pixels, and the real SDK sends the pages; Playwright answers the API with a
// scripted reading. The card, the review rules and the build are real.

import { expect, test } from "@playwright/test";
import { dropFile, expectVolume, openApp, savedDocument, scriptModel, text, useKey } from "./helpers";

const field = (value: number | null, evidence = String(value ?? ""), confidence = value === null ? 0 : 0.97) => ({
  value,
  evidence,
  source: value === null ? "missing" : "stated",
  confidence,
});
const sheet = (value: string, evidence: string) => ({ value, evidence, source: "stated", confidence: 0.95 });
const none = () => ({ value: null, evidence: "", source: "missing", confidence: 0 });

/** A good reading of examples/drawings/bracket.pdf. */
const bracketReading = JSON.stringify({
  partsShown: 1,
  views: [
    { kind: "top", label: "TOP VIEW", evidence: "TOP VIEW", confidence: 0.95 },
    { kind: "front", label: "FRONT VIEW", evidence: "FRONT VIEW", confidence: 0.95 },
  ],
  projection: sheet("third-angle", "THIRD ANGLE PROJECTION"),
  units: sheet("mm", "UNITS: mm"),
  title: sheet("BRACKET", "BRACKET"),
  drawingNumber: sheet("CD-0001", "CD-0001"),
  material: sheet("S275 STEEL", "MATERIAL: S275 STEEL"),
  notes: [],
  part: {
    action: "create",
    kind: "plate",
    name: "bracket",
    units: "mm",
    width: field(80),
    height: field(40),
    thickness: field(6),
    diameter: none(),
    cornerRadius: none(),
    holes: [
      {
        diameter: field(6.6, "Ø6.6 THRU"),
        count: field(1, "Ø6.6 THRU", 0.9),
        placement: "points",
        inset: none(),
        points: { value: [{ x: 70, y: 20 }], evidence: "70, 20", source: "stated", confidence: 0.95 },
        rows: none(),
        columns: none(),
        pitchX: none(),
        pitchY: none(),
        circleDiameter: none(),
        depth: none(),
      },
    ],
    frame: null,
    description: "",
    questions: [],
  },
});

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
  await useKey(page);
  await page.getByTestId("new-part").click();
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("a clean PDF of the bracket lands in the card with the right numbers, and builds after confirm", async ({ page }) => {
  const sent = await scriptModel(page, [[text(bracketReading)]]);
  await dropFile(page, "examples/drawings/bracket.pdf", "application/pdf");
  await expect(page.getByTestId("ask-drawing")).toHaveText("Drawing: bracket.pdf · 1 page at 200 dpi");
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-outcome")).toHaveText("Check the reading");
  await expect(page.getByTestId("drawing-thumb")).toBeVisible();
  const value = (path: string) => page.getByTestId(`intent-input-${path}`);
  await expect(value("width")).toHaveValue("80");
  await expect(value("height")).toHaveValue("40");
  await expect(value("thickness")).toHaveValue("6");
  await expect(value("holes[0].diameter")).toHaveValue("6.6");
  await expect(value("holes[0].points")).toHaveValue("70,20");
  await expect(value("drawing.units")).toHaveValue("mm");
  await expect(value("drawing.projection")).toHaveValue("third-angle");
  await expect(value("drawing.material")).toHaveValue("S275 STEEL");
  await expect(page.getByTestId("intent-card").locator("tr.blank")).toHaveCount(0);
  // Nothing is built before the user confirms.
  expect((await savedDocument(page)).features).toEqual([]);

  // What the page sent: the page as a 200 dpi PNG (A4 landscape: 2339 × 1655), the PDF's text layer, as structured output.
  const body = sent[0].body;
  expect((body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
  const content = body.messages[0].content as { type: string; source?: { data: string }; text?: string }[];
  const png = Buffer.from(content[0].source!.data, "base64");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([2339, 1655]);
  expect(content[1].text).toContain("Its text layer, exactly as printed on the sheet:\n80 40 70 20 Ø6.6 THRU TOP VIEW 6 FRONT VIEW BRACKET");

  await page.getByTestId("intent-build").click(); // "Confirm and build"
  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await expect(page.getByTestId("ask-checks").locator("li.ok")).toHaveCount(6);
  await page.getByTestId("ask-accept").click();
  await expectVolume(page, "18,994.728");
  const doc = await savedDocument(page);
  expect(doc.name).toBe("BRACKET");
  expect(doc.source).toEqual({ drawing: "bracket.pdf", projection: "third-angle", material: "S275 STEEL", units: "mm", drawingNumber: "CD-0001" });
});

test("a blurry drawing leaves fields blank rather than inventing them", async ({ page }) => {
  // The scripted model claims a confident, complete reading anyway.
  const sent = await scriptModel(page, [[text(bracketReading)]]);
  await dropFile(page, "examples/drawings/bracket-blurry.png", "image/png");
  await expect(page.getByTestId("ask-drawing")).toContainText("looks too blurry to read");
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-outcome")).toHaveText("Needs your numbers");
  await expect(page.getByTestId("ask-text")).toContainText("The drawing is too blurry to read numbers from");
  for (const path of ["width", "height", "thickness", "holes[0].diameter", "holes[0].placement", "holes[0].count", "drawing.units", "drawing.projection"]) {
    await expect(page.getByTestId(`intent-row-${path}`)).toHaveClass(/blank/);
    await expect(page.getByTestId(`intent-input-${path}`)).toHaveValue("");
  }
  await expect(page.getByTestId("intent-row-thickness")).toContainText("the drawing is too blurry to read this");
  await expect(page.getByTestId("intent-build")).toBeDisabled();
  expect((await savedDocument(page)).features).toEqual([]);
  const content = sent[0].body.messages[0].content as { type: string; text?: string }[];
  expect(content[1].text).toContain("It has no text layer");
  expect(content[1].text).toContain("The scan measures as blurry.");
});

test("the drawing opens full size from the card", async ({ page }) => {
  await scriptModel(page, [[text(bracketReading)]]);
  await dropFile(page, "examples/drawings/bracket-scan.png", "image/png");
  await expect(page.getByTestId("ask-drawing")).toHaveText("Drawing: bracket-scan.png · scan");
  await page.getByTestId("ask-submit").click();
  await page.getByTestId("drawing-thumb").click();
  await expect(page.getByTestId("drawing-zoom")).toBeVisible();
  await page.getByTestId("drawing-zoom").locator("img").click();
  await expect(page.getByTestId("drawing-zoom")).toHaveCount(0);
});
