// Wave 6A in the browser: the agent's build tools. A scripted model builds a
// flanged pipe fitting from empty space (a revolved half section and a bolt
// circle of holes) through one batch call, after planning it and dry-running
// the batch, then checks it with partSummary and a screenshot. The page runs
// the real SDK and the real kernel worker; Playwright plays the model.

import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument, scriptModel, text, tool, useKey, type Sent } from "./helpers";

const field = (value: number | null) => ({ value, evidence: "", source: value === null ? "missing" : "stated", confidence: value === null ? 0 : 1 });
const OTHER_INTENT = JSON.stringify({
  action: "create",
  kind: "other",
  name: "fitting",
  units: "mm",
  width: field(null),
  height: field(null),
  thickness: field(null),
  diameter: field(null),
  cornerRadius: field(null),
  holes: [],
  frame: null,
  description: "A flanged pipe fitting: Ø100 × 12 flange, Ø50 pipe 80 long with a Ø36 bore, six M8 clearance holes on a Ø76 circle.",
  questions: [],
});

// Volume = pi x [(50² - 18²) x 12 + (25² - 18²) x 68] - 6 x pi x 4.5² x 12 (M8 normal clearance is Ø9).
const VOLUME = Math.PI * ((50 ** 2 - 18 ** 2) * 12 + (25 ** 2 - 18 ** 2) * 68) - 6 * Math.PI * 4.5 ** 2 * 12;
const fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 3 });

const STEPS = [
  {
    tool: "sketchProfile",
    sketch: "sk_section",
    plane: { type: "ref", ref: { datum: "Front" } },
    shapes: [
      {
        polyline: [
          [18, 0],
          [50, 0],
          [50, 12],
          [25, 12],
          [25, 80],
          [18, 80],
        ],
      },
    ],
  },
  { tool: "addFeature", feature: { id: "body", op: "revolve", sketch: "sk_section", axis: { datum: "Z" } } },
  {
    tool: "holes",
    id: "bolt_hole",
    face: { type: "planar", normal: [0, 0, 1], rank: 2, pick: "largest" },
    size: "M8",
    at: { circle: { center: [0, 0], diameter: 76, count: 6, startAngle: 30 } },
  },
];

/** The tool results the model was sent in a request, by tool_use id order. */
function results(s: Sent): { content: string; is_error?: boolean }[] {
  return s.body.messages.at(-1)!.content as { content: string; is_error?: boolean }[];
}

async function rightClickEmpty(page: Page) {
  const box = (await page.getByTestId("viewport").boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + box.height - 120, { button: "right" });
  await page.getByTestId("ctx-ask").click();
}

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
  await useKey(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("a whole-part ask builds a revolved fitting with a bolt circle in one batch, and checks it", async ({ page }) => {
  await page.getByTestId("new-part").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  const sent = await scriptModel(page, [
    [text(OTHER_INTENT)],
    [
      tool("plan", {
        features: ["sk_section: half section on Front", "body: revolve sk_section about Z", "bolt_hole + circularPattern_1: 6 × M8 on Ø76"],
        checks: [
          { label: "Volume", measure: "volume", expected: VOLUME, tolerance: 0.001 },
          { label: "Six holes", measure: "holes", expected: 7 },
          { label: "Flange diameter", measure: "sizeX", expected: 100 },
          { label: "Length", measure: "sizeZ", expected: 80 },
        ],
      }),
    ],
    [tool("batch", { commands: STEPS, dryRun: true })],
    [tool("batch", { commands: STEPS })],
    [tool("partSummary", {}), tool("screenshot", { view: "iso" })],
    [text("Built the fitting: a revolved Ø100 flange and Ø50 pipe with six M8 holes on Ø76.")],
  ]);

  await rightClickEmpty(page);
  await expect(page.getByTestId("ask-target")).toHaveText("a new part");
  await page.getByTestId("ask-input").fill("a flanged pipe fitting, Ø100 flange 12 thick, Ø50 pipe 80 long, bore 36, six M8 holes on a 76 circle");
  await page.getByTestId("ask-input").press("Enter");

  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change", { timeout: 60_000 });
  await expectVolume(page, fmt(VOLUME).slice(0, 9));

  // The build turn offered plan, batch and the helpers, and asked for more room than a small edit.
  const build = sent[1].body;
  const names = build.tools.map((t) => t.name);
  for (const n of ["plan", "batch", "sketchProfile", "holes", "fullyDefine", "partSummary", "listFaces", "measureBetween", "screenshot", "reference"]) expect(names).toContain(n);
  expect(build.max_tokens as number).toBeGreaterThan(8000);

  // The dry run reported the volume without keeping anything; the real batch made each step's features.
  const dry = JSON.parse(results(sent[3])[0].content);
  expect(dry).toMatchObject({ ok: true, dryRun: true });
  const made = JSON.parse(results(sent[4])[0].content);
  expect(made.ok).toBe(true);
  expect(made.volume).toBeCloseTo(VOLUME, 1);
  expect(dry.volume).toBeCloseTo(made.volume, 6);

  // partSummary measured it; the screenshot came back as an image block.
  const [summary, shot] = results(sent[5]) as unknown as { content: unknown }[];
  const sum = JSON.parse(summary.content as string);
  expect(sum.measurements.volume).toBeCloseTo(VOLUME, 1);
  expect(sum.measurements.solids).toBe(1);
  expect(JSON.stringify(shot.content)).toContain('"type":"image"');

  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  await expectVolume(page, fmt(VOLUME).slice(0, 9));
  const doc = await savedDocument(page);
  const features = doc.features as { id: string; op?: string }[];
  expect(features.map((f) => f.id)).toEqual(expect.arrayContaining(["sk_section", "body", "bolt_hole"]));
  expect(features.find((f) => f.id === "body")!.op).toBe("revolve");
  expect(features.some((f) => f.op === "circularPattern")).toBe(true);
});

test("a batch with a failing step keeps nothing", async ({ page }) => {
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  const before = await savedDocument(page);
  const sent = await scriptModel(page, [
    [
      tool("batch", {
        commands: [
          { tool: "updateFeature", id: "hole_1", patch: { diameter: 8 } },
          { tool: "addFeature", feature: { id: "f1", op: "fillet", edges: { type: "line", parallel: [0, 0, 1] }, radius: 200 } },
        ],
      }),
    ],
    [text("The fillet is too big for the plate, so nothing was changed.")],
  ]);
  await page.getByTestId("feature-hole_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-ask").click();
  await expect(page.getByTestId("ask-scope")).toHaveText("may change: anything in the part");
  await page.getByTestId("ask-input").fill("make the hole 8 and round the corners 200");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-text")).toContainText("nothing was changed", { timeout: 60_000 });
  await expect(page.getByTestId("ask-accept")).toHaveCount(0);
  const r = results(sent[1])[0];
  expect(r.is_error).toBe(true);
  expect(r.content).toContain("f1");
  expect(await savedDocument(page)).toEqual(before);
  await expectVolume(page, "18,994.728");
});
