// The standard section library: catalogue steel and timber every user has
// out of the box. Pick a 200UB25.4 and a 90x45 MGP10 by searching, make
// members of them, and read their masses (the timber weighs as pine).

import { expect, test } from "@playwright/test";
import { commit, openApp, savedDocument } from "./helpers";

test("members of a standard UB and an MGP10 stud, found by search", async ({ page }) => {
  const problems = await openApp(page);
  await page.getByTestId("new-part").click();
  await commit(page, "doc-name", "standard");
  await page.getByTestId("tab-sections").click();

  // Grouped by standard, built in, with no profiles of the user's own yet.
  await expect(page.getByTestId("sections-empty")).toBeVisible();
  for (const g of ["AS/NZS 3679.1", "AS/NZS 1163", "Purlins", "Timber"]) await expect(page.getByTestId(`sections-group-${g}`)).toBeVisible();
  await page.getByTestId("sections-group").selectOption("Timber");
  await expect(page.getByTestId("sections-group-AS/NZS 3679.1")).toHaveCount(0);
  await expect(page.getByTestId("section-MGP10 (Timber)")).toBeVisible();
  await page.getByTestId("sections-group").selectOption("");

  await page.getByTestId("sections-search").fill("200UB25.4");
  await expect(page.getByTestId("section-size-200UB25.4")).toContainText("3,229.7 mm²25.35 kg/m");
  await page.getByTestId("section-add-200UB25.4").click();
  await page.getByTestId("tab-sections").click();
  await page.getByTestId("sections-search").fill("90x45 mgp10");
  await expect(page.getByTestId("section-size-90x45 MGP10")).toContainText("4,050 mm²2.23 kg/m");
  await page.getByTestId("section-add-90x45 MGP10").click();

  const rows = page.getByTestId("member-row");
  await expect(rows).toHaveCount(2);
  // Listed by size; the UB weighs steel, the stud pine (550 kg/m³).
  await expect(rows.nth(0).locator("td")).toHaveText(["90x45 MGP10", "1,000", "1", "2.23"]);
  await expect(rows.nth(1).locator("td")).toHaveText(["200UB25.4", "1,000", "1", "25.35"]);

  const doc = (await savedDocument(page)) as { profiles: Record<string, { library: { id: string }; density: number }> };
  expect(doc.profiles["UB (AS/NZS 3679.1)"].library.id).toBe("std:ub");
  expect(doc.profiles["MGP10 (Timber)"].density).toBe(550);
  expect(problems).toEqual([]);
});
