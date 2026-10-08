// Phase J acceptance (docs/roadmap.md): a 1200 × 600 table frame, 900 high,
// in SHS 40×40×3 from the library, with mitred top corners. It builds with no
// interference, the cut list matches the bodies, and switching every member
// to SHS 50×50×3 rebuilds it and updates the cut list.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument } from "./helpers";
import { addParameter, saveSHS } from "./sections";

async function addNode(page: Page, name: string, at: string[]) {
  // A part with no nodes yet has the Nodes section folded.
  const toggle = page.getByTestId("nodes-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await page.getByTestId("node-new-name").fill(name);
  for (let k = 0; k < 3; k++) await commit(page, `node-new-${"xyz"[k]}`, at[k]);
  await page.getByTestId("node-add").click();
  await expect(page.getByTestId(`node-${name}`)).toBeVisible();
}

/** The cut list's rows, cell by cell. */
async function cutRows(page: Page): Promise<string[][]> {
  return page.getByTestId("cut-row").evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent ?? "")));
}

test("a table frame from nodes, mitred at the top, measured into a cut list, then switched to SHS 50", async ({ page }) => {
  const problems = await openApp(page);
  await saveSHS(page);

  // A new part: the frame's size as parameters, its eight corners as nodes.
  await page.getByTestId("new-part").click();
  await commit(page, "doc-name", "table");
  await addParameter(page, "frame_w", "1200");
  await addParameter(page, "frame_d", "600");
  await addParameter(page, "frame_h", "900");
  const top = "=frame_h";
  await addNode(page, "A", ["0", "0", top]);
  await addNode(page, "B", ["=frame_w", "0", top]);
  await addNode(page, "C", ["=frame_w", "=frame_d", top]);
  await addNode(page, "D", ["0", "=frame_d", top]);
  await addNode(page, "E", ["0", "0", "0"]);
  await addNode(page, "F", ["=frame_w", "0", "0"]);
  await addNode(page, "G", ["=frame_w", "=frame_d", "0"]);
  await addNode(page, "H", ["0", "=frame_d", "0"]);

  // The top rails round the corners, mitred; then the legs, up to the corners. Both from the library's SHS 40×40×3.
  await page.getByTestId("path-size").selectOption({ label: "SHS 40x40x3 (library)" });
  await page.getByTestId("path-text").fill("A B C D A");
  await page.getByTestId("path-add").click();
  await expect(page.getByTestId("notice")).toContainText("Added 4 members of SHS 40x40x3 and 4 mitres.");
  await page.getByTestId("path-size").selectOption({ label: "SHS 40x40x3 (in this part)" });
  await page.getByTestId("path-text").fill("E A, F B, G C, H D");
  await page.getByTestId("path-add").click();
  await expect(page.getByTestId("notice")).toContainText("Added 4 members of SHS 40x40x3.");

  // It builds, with no interference: rails 1200 and 600 long point to long point, legs under them.
  await expectVolume(page, "3,054,720");
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  await expect(page.getByTestId("bodies").locator("li")).toHaveCount(8);
  await expect(page.getByTestId("interference")).toHaveCount(0);
  await page.getByTestId("tab-cutlist").click();
  expect(await cutRows(page)).toEqual([
    ["1", "SHS 40x40x3", "1,200", "45° / 45°", "2", "8.09"],
    ["2", "SHS 40x40x3", "860", "square", "4", "11.99"],
    ["3", "SHS 40x40x3", "600", "45° / 45°", "2", "3.9"],
  ]);

  // The cut list is the bodies, measured: each body's volume is its section times its length at the centroid.
  await expect(page.getByTestId("body-AB")).toContainText("515,040 mm³"); // 444 × (1200 − 2 × 20)
  await expect(page.getByTestId("body-BC")).toContainText("248,640 mm³"); // 444 × (600 − 2 × 20)
  await expect(page.getByTestId("body-EA")).toContainText("381,840 mm³"); // 444 × 860

  // The document says what was built: nodes, members on them, mitres at the top corners.
  const doc = (await savedDocument(page)) as { nodes: Record<string, unknown>; features: Record<string, unknown>[]; profiles: Record<string, { library?: unknown }> };
  expect(doc.nodes.C).toEqual(["=frame_w", "=frame_d", "=frame_h"]);
  expect(doc.profiles.SHS.library).toBeTruthy();
  expect(doc.features.find((f) => f.id === "AB")).toEqual({ id: "AB", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "A", to: "B", align: [-1, 1] });
  expect(doc.features.find((f) => f.id === "corner_A")).toEqual({ id: "corner_A", op: "joint", node: "A", type: "mitre", members: ["DA", "AB"] });

  // The CSV is the same list.
  const download = page.waitForEvent("download");
  await page.getByTestId("cut-list-csv").click();
  const csv = readFileSync(await (await download).path(), "utf8");
  expect(csv.split("\r\n").slice(0, 2)).toEqual([
    "Item,Profile,Size,Length (mm),End 1 (deg),End 2 (deg),Qty,kg each,kg total,Members",
    "1,SHS,SHS 40x40x3,1200.0,45.0,45.0,2,4.043,8.086,AB CD",
  ]);

  // Switch every member to SHS 50×50×3, as one change: the outside stays 1200 × 600 × 900, the legs get shorter.
  await page.getByTestId("cut-row").first().click();
  await page.getByTestId("prop-size-all").selectOption("SHS 50x50x3");
  await expectVolume(page, "3,835,200");
  await page.getByTestId("tab-cutlist").click();
  expect(await cutRows(page)).toEqual([
    ["1", "SHS 50x50x3", "1,200", "45° / 45°", "2", "10.18"],
    ["2", "SHS 50x50x3", "850", "square", "4", "15.05"],
    ["3", "SHS 50x50x3", "600", "45° / 45°", "2", "4.87"],
  ]);
  await expect(page.getByTestId("interference")).toHaveCount(0);

  // One undo step puts SHS 40 back everywhere.
  await page.getByTestId("undo").click();
  await expectVolume(page, "3,054,720");
  expect(problems).toEqual([]);
});

test("a weld at a joint, an end cap and a gusset: notes in the weld table, plates as bodies", async ({ page }) => {
  const problems = await openApp(page);
  await page.locator("select").first().selectOption("table frame (weldment)");
  await expectVolume(page, "3,054,720");

  // The weld at corner A: all round the mitre face, and round the leg under it.
  await page.getByTestId("feature-corner_a").locator(".feature-row").click();
  await expect(page.getByTestId("prop-joint-butting")).toHaveText("leg_a");
  await page.getByTestId("prop-joint-weld").click();
  await page.getByTestId("tab-cutlist").click();
  await expect(page.getByTestId("weld-w1")).toContainText("rail_front + rail_left + leg_a");
  await expect(page.getByTestId("weld-w1-length")).toHaveValue("353.1"); // 40 + 40 + 2 × 40√2 for the mitre, 4 × 40 for the leg
  await commit(page, "weld-w1-size", "4");
  const doc = (await savedDocument(page)) as { welds: unknown[] };
  expect(doc.welds).toEqual([{ id: "w1", between: ["rail_front", "rail_left", "leg_a"], type: "fillet", size: 4, length: 353.1, allRound: true, note: "joint corner_a at A" }]);
  const download = page.waitForEvent("download");
  await page.getByTestId("welds-csv").click();
  expect(readFileSync(await (await download).path(), "utf8")).toBe(
    "Weld,Between,Type,Size (mm),Length (mm),All round,Note\r\nw1,rail_front + rail_left + leg_a,fillet,4,353.1,yes,joint corner_a at A\r\n",
  );

  // A foot on leg a: a 40 × 40 × 3 plate under it.
  await page.getByTestId("feature-leg_a").locator(".feature-row").click();
  await page.getByTestId("prop-cap-start").click();
  await expectVolume(page, "3,059,520");
  await expect(page.getByTestId("body-cap_1")).toContainText("4,800 mm³");

  // A gusset in the corner of leg a and the left rail: 100 legs, 6 thick, its corner clipped 10.
  await page.getByTestId("feature-corner_a").locator(".feature-row").click();
  await page.getByTestId("prop-joint-gusset").click();
  await expect(page.getByTestId("body-gusset_1")).toContainText("29,700 mm³");
  await expect(page.getByTestId("interference")).toHaveCount(0);

  // A cap on a mitred end is refused, and says why.
  await page.getByTestId("feature-rail_front").locator(".feature-row").click();
  await page.getByTestId("prop-cap-start").click();
  await expect(page.getByTestId("prop-feature-error")).toHaveText("the start of rail_front is cut by corner_a; an end cap goes on a square end");
  expect(problems).toEqual([]);
});
