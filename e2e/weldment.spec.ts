// Phase I acceptance (docs/roadmap.md): a 40 × 40 × 3 square hollow section
// drawn as a normal sketch, with its sizes as parameters, becomes a weldment
// profile by a tick box; the card measures it; the section library keeps it;
// another part makes members of it, and keeps its own copy.

import { expect, test, type Page } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, sketchClick } from "./helpers";

async function addParameter(page: Page, name: string, value: string) {
  await page.getByTestId("param-new-name").fill(name);
  await page.getByTestId("param-new-value").fill(value);
  await page.getByTestId("param-add").click();
}

/** A rectangle centred on the origin, its width and height written as an expression. */
async function squareAt(page: Page, half: number, size: string) {
  await page.getByTestId("tool-rect").click();
  await sketchClick(page, -half, -half);
  await sketchClick(page, half, half);
  await page.getByTestId("tool-select").click();
  await sketchClick(page, 0, half);
  await page.getByTestId("c-center-origin").click();
  await sketchClick(page, 0, half);
  await page.getByTestId("c-width-value").fill(size);
  await page.getByTestId("c-width").click();
  await sketchClick(page, 0, half); // the top edge has not moved yet
  await page.getByTestId("c-height-value").fill(size);
  await page.getByTestId("c-height").click();
}

/** Draws SHS b × b × t as a normal sketch, ticks "Weldment profile" and finishes. */
async function drawSHS(page: Page) {
  await page.getByTestId("new-part").click();
  await commit(page, "doc-name", "shs");
  await addParameter(page, "b", "40");
  await addParameter(page, "t", "3");
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  await squareAt(page, 20, "=b");
  await squareAt(page, 14, "=b - 2 * t"); // the grid snaps to 2 mm
  await expect(page.getByTestId("profile-status")).toHaveText("Profile: 1 region, area 444 mm²");
  await expect(page.getByTestId("sketch-dof")).toHaveText("Fully defined");
  await page.getByTestId("sketch-weldment").check();
  await page.getByTestId("finish-sketch").click();
}

test("draw an SHS, save it to the section library, and make members of it in another part", async ({ page }) => {
  const problems = await openApp(page);
  await drawSHS(page);

  // The card: the size parameters found, the section measured, the tags suggested.
  const card = page.getByTestId("profile-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("profile-parameters")).toContainText("b = 40, t = 3");
  await expect(page.getByTestId("profile-area-0")).toHaveText("444 mm²");
  await expect(page.getByTestId("profile-kgm-0")).toHaveText("3.49");
  const tags = page.getByTestId("profile-tags");
  await expect(tags.getByRole("button", { name: "hollow" })).toHaveAttribute("aria-pressed", "true");
  await expect(tags.getByRole("button", { name: "square" })).toHaveAttribute("aria-pressed", "true");
  await expect(tags.getByRole("button", { name: "40x40" })).toBeVisible();
  await expect(page.getByTestId("profile-drawing")).toBeVisible();

  // Name it, give the first size its designation, add 50 × 50 × 3.
  await page.getByTestId("profile-name").fill("SHS");
  await page.getByTestId("profile-size-0").fill("SHS 40x40x3");
  await page.getByTestId("profile-add-size").click();
  await page.getByTestId("profile-size-1").fill("SHS 50x50x3");
  await page.getByTestId("profile-size-1-b").fill("50");
  await expect(page.getByTestId("profile-area-1")).toHaveText("564 mm²");
  await expect(page.getByTestId("profile-kgm-1")).toHaveText("4.43");
  await page.getByTestId("profile-favourite").click();
  await page.getByTestId("profile-save").click();
  await expect(card).toHaveCount(0);

  // It is in the library, and the sketch says what it is.
  const entry = page.getByTestId("section-SHS");
  await expect(entry).toBeVisible();
  await expect(entry).toHaveClass(/highlight/);
  await expect(page.getByTestId("section-size-SHS 40x40x3")).toContainText("444 mm²3.49 kg/m");
  await expect(page.getByTestId("section-size-SHS 50x50x3")).toContainText("564 mm²4.43 kg/m");
  await expect(page.getByTestId("section-favourite-SHS")).toHaveAttribute("aria-pressed", "true");
  const shs = (await savedDocument(page)) as { features: Record<string, unknown>[] };
  const sketch = shs.features.find((f) => f.id === "sketch_1")!;
  expect(sketch.profile).toMatchObject({ name: "SHS", library: { version: 1 } });
  expect(sketch.constraints).toContainEqual({ type: "distanceX", entity: "r2", value: "=b - 2 * t" });
  await page.getByTestId("sections-search").fill("hollow 50x50");
  await expect(entry).toBeVisible();
  await page.getByTestId("sections-search").fill("channel");
  await expect(entry).toHaveCount(0);
  await page.getByTestId("sections-search").fill("");

  // Another part: a 900 mm member of SHS 40x40x3, and a 600 mm one of SHS 50x50x3.
  await page.getByTestId("new-part").click();
  await commit(page, "doc-name", "frame");
  await page.getByTestId("tab-sections").click();
  await page.getByTestId("section-add-SHS 40x40x3").click();
  await commit(page, "prop-length", "900");
  await expectVolume(page, "399,600");
  await page.getByTestId("tab-sections").click();
  await page.getByTestId("section-add-SHS 50x50x3").click();
  await commit(page, "prop-length", "600");
  await expectVolume(page, "738,000");

  // Each is its own body, with the right volume; the members are listed with their lengths.
  await expect(page.getByTestId("body-member_1")).toContainText("399,600 mm³");
  await expect(page.getByTestId("body-member_2")).toContainText("338,400 mm³");
  await expect(page.getByTestId("interference")).toHaveCount(0);
  const rows = page.getByTestId("member-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td")).toHaveText(["SHS 40x40x3", "900", "1", "3.14"]);
  await expect(rows.nth(1).locator("td")).toHaveText(["SHS 50x50x3", "600", "1", "2.66"]);
  await expect(page.getByTestId("prop-member-measured")).toHaveText("SHS 50x50x3 · 600 mm · 2.66 kg");

  // The part keeps a copy of the profile, with the library id and version.
  const frame = (await savedDocument(page)) as { profiles: Record<string, { library: unknown; sizes: unknown[] }>; features: unknown[] };
  expect(frame.profiles.SHS.library).toEqual(sketch.profile && (sketch.profile as { library: unknown }).library);
  expect(frame.profiles.SHS.sizes).toHaveLength(2);
  expect(frame.features).toEqual([
    { id: "member_1", op: "member", profile: "SHS", size: "SHS 40x40x3", from: [0, 0, 0], to: [900, 0, 0] },
    { id: "member_2", op: "member", profile: "SHS", size: "SHS 50x50x3", from: [0, 100, 0], to: [600, 100, 0] },
  ]);

  // Clear the library: the part still opens and rebuilds from its own copy.
  await page.getByTestId("tab-sections").click();
  await page.getByTestId("section-delete-SHS").click();
  await page.getByTestId("section-delete-confirm-SHS").click();
  await expect(page.getByTestId("sections-empty")).toBeVisible();
  await page.reload();
  await expectVolume(page, "738,000");
  await page.getByTestId("tab-sections").click();
  await expect(page.getByTestId("sections-empty")).toBeVisible();
  expect(problems).toEqual([]);
});

test("the toolbar's Member adds another like the selected one; undo takes the member and the copy together", async ({ page }) => {
  const problems = await openApp(page);
  await drawSHS(page);
  await page.getByTestId("profile-name").fill("SHS");
  await page.getByTestId("profile-size-0").fill("SHS 40x40x3");
  await page.getByTestId("profile-save").click();

  await page.getByTestId("new-part").click();
  await page.getByTestId("tool-member").click(); // nothing to copy yet: the library opens
  await expect(page.getByTestId("notice")).toContainText("Pick a size in Sections");
  await page.getByTestId("section-add-SHS 40x40x3").click();
  await expectVolume(page, "444,000");
  await page.getByTestId("tool-member").click();
  await expectVolume(page, "888,000");
  await expect(page.getByTestId("member-row").locator("td")).toHaveText(["SHS 40x40x3", "1,000", "2", "6.97"]);

  await page.getByTestId("undo").click();
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("status")).toHaveText("No solid yet");
  expect((await savedDocument(page)).profiles).toBeUndefined();
  expect(problems).toEqual([]);
});

test("editing a profile sketch keeps its expressions, and the card saves the next version", async ({ page }) => {
  const problems = await openApp(page);
  await drawSHS(page);
  await page.getByTestId("profile-name").fill("SHS");
  await page.getByTestId("profile-size-0").fill("SHS 40x40x3");
  await page.getByTestId("profile-save").click();

  // Edit the sketch: its dimensions still read =b, the box is still ticked.
  await page.getByTestId("tab-properties").click();
  await page.getByTestId("edit-sketch").click();
  await expect(page.getByTestId("constraint-value-1")).toHaveValue("=b");
  await expect(page.getByTestId("sketch-weldment")).toBeChecked();
  await page.getByTestId("finish-sketch").click();
  const card = page.getByTestId("profile-card");
  await expect(card).toContainText("Saves version 2 of SHS.");
  await page.getByTestId("profile-add-size").click();
  await page.getByTestId("profile-size-1").fill("SHS 40x40x4");
  await page.getByTestId("profile-size-1-t").fill("4");
  await expect(page.getByTestId("profile-area-1")).toHaveText("576 mm²");
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("section-SHS")).toContainText("v2");
  await expect(page.getByTestId("section-size-SHS 40x40x4")).toBeVisible();
  expect(problems).toEqual([]);
});
