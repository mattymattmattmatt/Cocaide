// Phase K acceptance (docs/roadmap.md): the table frame prompt builds after
// the card, from the library's profile; a joint is mitred from a right-click;
// the profile card's Suggest fills its names. The model is answered by a
// script; the kernel is real.

import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument, scriptModel, text, tool, useKey } from "./helpers";
import { drawSHS, saveSHS } from "./sections";

const TEXT = "A 1200 × 600 table frame, 900 high, SHS 40×40×3";
const field = (value: number | string | null, evidence = "") => ({ value, evidence, source: value === null ? "missing" : "stated", confidence: value === null ? 0 : 1 });
const none = () => field(null);
const frameIntent = JSON.stringify({
  action: "create",
  kind: "frame",
  name: "table frame",
  units: "mm",
  width: none(),
  height: none(),
  thickness: none(),
  diameter: none(),
  cornerRadius: none(),
  holes: [],
  frame: {
    type: "table",
    length: field(1200, "1200 × 600"),
    width: field(600, "1200 × 600"),
    height: field(900, "900 high"),
    section: field("SHS 40×40×3", "SHS 40×40×3"),
    corners: "unspecified",
  },
  description: "",
  questions: [],
});

async function rightClickEmpty(page: Page) {
  const box = (await page.getByTestId("viewport").boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + box.height - 120, { button: "right" });
}

async function cutRows(page: Page): Promise<string[][]> {
  return page.getByTestId("cut-row").evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent ?? "")));
}

test.beforeEach(async ({ page }) => {
  const problems = await openApp(page);
  (page as unknown as { problems: string[] }).problems = problems;
  await useKey(page);
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);
});

test("the table frame prompt builds after the card, from the library's profile", async ({ page }) => {
  await saveSHS(page);
  await page.getByTestId("new-part").click();
  const sent = await scriptModel(page, [[text(frameIntent)]]);

  await rightClickEmpty(page);
  await page.getByTestId("ask-input").fill(TEXT);
  await page.getByTestId("ask-input").press("Enter");

  // The card: the sizes from the request, the section found in the library, the corners asked.
  await expect(page.getByTestId("ask-outcome")).toHaveText("Needs your numbers");
  await expect(page.getByTestId("ask-text")).toHaveText("I need one choice before I build this: corners.");
  await expect(page.getByTestId("intent-input-frame.length")).toHaveValue("1200");
  await expect(page.getByTestId("intent-input-frame.height")).toHaveValue("900");
  const section = page.getByTestId("intent-input-frame.section");
  await expect(section).toHaveValue(/^lib\|.+\|SHS 40x40x3$/);
  await expect(section.locator("option")).toHaveText(["choose…", "SHS 40x40x3", "SHS 50x50x3"]);
  await expect(page.getByTestId("intent-row-frame.section")).toContainText("SHS 40x40x3, from the section library");
  await expect(page.getByTestId("intent-row-frame.corners")).toHaveClass(/blank/);
  await expect(page.getByTestId("intent-build")).toHaveText("Confirm and build");
  await expect(page.getByTestId("intent-build")).toBeDisabled();
  expect((await savedDocument(page)).features).toEqual([]); // nothing built yet

  await page.getByTestId("intent-input-frame.corners").selectOption("mitre");
  await page.getByTestId("intent-build").click();

  // Planned, built and checked: the fabrication critic's checks all pass.
  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await expect(page.getByTestId("ask-text")).toHaveText("A 1200 × 600 × 900 mm table frame of SHS 40x40x3: 8 members, mitred corners. Checked against the request: 8 of 8 checks pass.");
  await expect(page.getByTestId("ask-checks").locator("li.ok")).toHaveCount(8);
  await expect(page.getByTestId("ask-checks")).toContainText("Every member connected");
  await expect(page.getByTestId("ask-checks")).toContainText("No member longer than stock bar");
  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  await page.getByTestId("ask-close").click();

  await expectVolume(page, "3,054,720");
  const doc = (await savedDocument(page)) as { profiles: Record<string, { library?: { version: number } }>; parameters: unknown };
  expect(doc.profiles.SHS.library).toMatchObject({ version: 1 });
  expect(doc.parameters).toEqual({ frame_w: 1200, frame_d: 600, frame_h: 900 });
  await page.getByTestId("tab-cutlist").click();
  expect(await cutRows(page)).toEqual([
    ["1", "SHS 40x40x3", "1,200", "45° / 45°", "2", "8.09"],
    ["2", "SHS 40x40x3", "860", "square", "4", "11.99"],
    ["3", "SHS 40x40x3", "600", "45° / 45°", "2", "3.9"],
  ]);

  // One request to the model: the reading, as structured output. The section was matched by code, not by it.
  expect(sent).toHaveLength(1);
  expect((sent[0].body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
});

test("right-click a butt joint and mitre it: a proposal that, accepted, cuts 45° ends", async ({ page }) => {
  await page.locator("select").first().selectOption("table frame (weldment)");
  await expectVolume(page, "3,054,720");
  // Make corner A a butt, the leg running through.
  await page.getByTestId("feature-corner_a").locator(".feature-row").click();
  await page.getByTestId("prop-joint-type").selectOption("butt");
  await page.getByTestId("prop-joint-through").selectOption("leg_a");
  await expect(page.getByTestId("prop-joint-butting")).toHaveText("rail_front, rail_left");

  const sent = await scriptModel(page, [
    [tool("updateFeature", { id: "corner_a", patch: { type: "mitre", through: null, members: ["rail_left", "rail_front"] } })],
    [text("Corner A is a mitre between rail_left and rail_front now; leg_a stops under them.")],
  ]);
  await page.getByTestId("feature-corner_a").locator(".feature-row").click({ button: "right" });
  await expect(page.getByTestId("ask-target")).toHaveText("corner_a");
  await expect(page.getByTestId("ask-scope")).toHaveText("may change: corner_a");
  await page.getByTestId("ask-action-mitre-it").click();

  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  await page.getByTestId("ask-close").click();
  await expectVolume(page, "3,054,720"); // the mitred frame again
  await page.getByTestId("tab-cutlist").click();
  expect(await cutRows(page)).toEqual([
    ["1", "SHS 40x40x3", "1,200", "45° / 45°", "2", "8.09"],
    ["2", "SHS 40x40x3", "860", "square", "4", "11.99"],
    ["3", "SHS 40x40x3", "600", "45° / 45°", "2", "3.9"],
  ]);
  // The packet was the joint: its node and the members there, and the scope was the joint alone.
  const packet = (sent[0].body.messages[0].content as { type: string; text?: string }[]).find((b) => b.type === "text")!.text!;
  expect(packet).toContain('"kind": "joint"');
  expect(packet).toContain('"through": "leg_a"');
  expect(packet).toContain('"endsHere": true');
});

test("the profile card's Suggest fills the name, the designations and the tags", async ({ page }) => {
  await drawSHS(page);
  const card = page.getByTestId("profile-card");
  await page.getByTestId("profile-add-size").click();
  await page.getByTestId("profile-size-1-b").fill("50");
  const sent = await scriptModel(page, [
    [text(JSON.stringify({ name: "SHS", designations: ["SHS 40x40x3", "SHS 50x50x3"], tags: ["hollow", "square", "tube"], anchor: "centroid", why: "A square hollow section, symmetric both ways." }))],
  ]);
  await page.getByTestId("profile-suggest").click();
  await expect(page.getByTestId("profile-suggested")).toHaveText("Suggested: A square hollow section, symmetric both ways. Change anything; the sizes are yours.");
  await expect(page.getByTestId("profile-name")).toHaveValue("SHS");
  await expect(page.getByTestId("profile-size-0")).toHaveValue("SHS 40x40x3");
  await expect(page.getByTestId("profile-size-1")).toHaveValue("SHS 50x50x3");
  await expect(page.getByTestId("profile-tags").getByRole("button", { name: "tube" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("profile-anchor-centroid")).toBeChecked();
  // The model was told the measured section, and nothing about the part.
  const asked = (sent[0].body.messages[0].content as { type: string; text: string }[])[0].text;
  expect(asked).toContain("Size 1: b = 40, t = 3; envelope 40 × 40 mm; area 444 mm²");
  expect(asked).toContain("The sketch origin is at the centre of the section.");
  await page.getByTestId("profile-save").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("section-SHS")).toContainText("tube");
});
