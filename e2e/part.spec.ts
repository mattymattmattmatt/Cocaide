// Phase E in the browser: the part-level prompt from empty space, the
// confirmation card, and a dropped drawing. The page runs the real SDK;
// Playwright answers api.anthropic.com with a scripted intent reading.

import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument, scriptModel, text, useKey } from "./helpers";

const BRACKET_TEXT = "80 x 40 x 6 plate, four 6.6 holes 8 mm from corners";
const FOUR_HOLES = (80 * 40 - 4 * Math.PI * 3.3 ** 2) * 6;

const field = (value: number | null, evidence = "", source = value === null ? "missing" : "stated", confidence = value === null ? 0 : 1) => ({ value, evidence, source, confidence });
const holeGroup = (g: Record<string, unknown>) => ({
  diameter: field(null),
  count: field(null),
  placement: "unspecified",
  inset: field(null),
  points: field(null),
  rows: field(null),
  columns: field(null),
  pitchX: field(null),
  pitchY: field(null),
  circleDiameter: field(null),
  depth: field(null),
  ...g,
});
const intent = (o: Record<string, unknown>) =>
  JSON.stringify({
    action: "create",
    kind: "plate",
    name: "plate",
    units: "mm",
    width: field(null),
    height: field(null),
    thickness: field(null),
    diameter: field(null),
    cornerRadius: field(null),
    holes: [],
    description: "",
    questions: [],
    ...o,
  });

const bracketIntent = intent({
  name: "bracket",
  width: field(80, "80 x 40 x 6"),
  height: field(40, "80 x 40 x 6"),
  thickness: field(6, "80 x 40 x 6"),
  holes: [holeGroup({ diameter: field(6.6, "6.6 holes"), count: field(4, "four"), placement: "corners", inset: field(8, "8 mm from corners") })],
});

/** Right-click empty space in the viewport (a corner, away from the part). */
async function rightClickEmpty(page: Page) {
  const box = (await page.getByTestId("viewport").boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + box.height - 120, { button: "right" });
}

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
  await useKey(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test('"80 x 40 x 6 plate, four 6.6 holes 8 mm from corners" produces the plate without a human fix', async ({ page }) => {
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  const sent = await scriptModel(page, [[text(bracketIntent)]]);

  await rightClickEmpty(page);
  await expect(page.getByTestId("ask-target")).toHaveText("a new part");
  await expect(page.getByTestId("ask-apply-now")).toHaveCount(0); // from empty space, always a proposal
  await page.getByTestId("ask-input").fill(BRACKET_TEXT);
  await page.getByTestId("ask-input").press("Enter");

  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await expect(page.getByTestId("ask-text")).toHaveText('An 80 × 40 × 6 mm plate with 4 holes ("bracket"). Checked against the request: 6 of 6 checks pass.');
  await expect(page.getByTestId("ask-checks").locator("li.ok")).toHaveCount(6);
  await expect(page.getByTestId("intent-card")).toHaveCount(0); // nothing to ask
  await expectVolume(page, FOUR_HOLES.toLocaleString("en-US", { maximumFractionDigits: 3 }));

  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  const doc = await savedDocument(page);
  expect(doc.parameters).toEqual({ plate_w: 80, plate_h: 40, part_t: 6, hole_d: 6.6, hole_inset: 8 });
  await expect(page.getByTestId("holes")).toHaveText("4 · Ø 6.6 × 4");

  // One request: the intent reading, as structured output, the user's words last.
  expect(sent).toHaveLength(1);
  expect((sent[0].body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
  const content = sent[0].body.messages[0].content as { type: string; text: string }[];
  expect(content.at(-1)!.text.endsWith(`The request:\n${BRACKET_TEXT}`)).toBe(true);
});

test('"a plate with some holes" asks instead of guessing, then builds from the answers', async ({ page }) => {
  await page.getByTestId("new-part").click();
  const vague = intent({ holes: [holeGroup({ count: field(null, "some holes") })], questions: ["How big?", "How thick?", "Which holes?"] });
  await scriptModel(page, [[text(vague)]]);
  const before = await savedDocument(page);

  await rightClickEmpty(page);
  await page.getByTestId("ask-input").fill("a plate with some holes");
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-outcome")).toHaveText("Needs your numbers");
  await expect(page.getByTestId("ask-text")).toHaveText("I need 6 things before I build this: width (x), height (y), thickness, holes: diameter, holes: where, holes: count.");
  const card = page.getByTestId("intent-card");
  await expect(card.locator("tr.blank")).toHaveCount(6);
  await expect(page.getByTestId("intent-build")).toBeDisabled();
  expect(await savedDocument(page)).toEqual(before); // nothing built

  await page.getByTestId("intent-input-width").fill("80");
  await page.getByTestId("intent-input-height").fill("40");
  await page.getByTestId("intent-input-thickness").fill("6");
  await page.getByTestId("intent-input-holes[0].diameter").fill("6.6");
  await page.getByTestId("intent-input-holes[0].placement").selectOption("corners");
  await page.getByTestId("intent-input-holes[0].count").fill("4");
  await page.getByTestId("intent-build").click();

  // Corners need a distance from the edges: asked next.
  await expect(card.locator("tr.blank")).toHaveCount(1);
  await expect(page.getByTestId("intent-row-holes[0].inset")).toHaveClass(/blank/);
  await page.getByTestId("intent-input-holes[0].inset").fill("8");
  await page.getByTestId("intent-build").click();

  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await expect(page.getByTestId("ask-checks").locator("li.ok")).toHaveCount(6);
  await page.getByTestId("ask-accept").click();
  await expectVolume(page, FOUR_HOLES.toLocaleString("en-US", { maximumFractionDigits: 3 }));
});

test("a question about the whole part is answered without writing", async ({ page }) => {
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  const sent = await scriptModel(page, [[text("An 80 × 40 × 6 plate with one Ø6.6 through hole: sketch_1, ext_1, hole_1.")]]);
  await rightClickEmpty(page);
  await expect(page.getByTestId("ask-target")).toHaveText("the whole part");
  await page.getByTestId("ask-action-explain-this-part").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Answer");
  await expect(page.getByTestId("ask-text")).toContainText("80 × 40 × 6 plate");
  expect(sent[0].body.tools.map((t) => t.name)).toEqual(["measure", "getFeature", "escalate"]);
});
