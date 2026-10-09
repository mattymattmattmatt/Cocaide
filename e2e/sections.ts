// Drawing sections in the browser, for the weldment suites (Phases I and J).

import { expect, type Page } from "@playwright/test";
import { commit, sketchClick } from "./helpers";

export async function addParameter(page: Page, name: string, value: string) {
  await page.getByTestId("param-new-name").fill(name);
  await page.getByTestId("param-new-value").fill(value);
  await page.getByTestId("param-add").click();
}

/**
 * A centre rectangle on the origin, its sides' lengths written as an
 * expression that makes it `sized` across. The corner is clicked on the grid
 * (every 5 mm at this zoom) and off the other square's diagonals.
 */
async function squareAt(page: Page, corner: [number, number], size: string, sized: number) {
  await page.getByTestId("tool-rect-flyout").click();
  await page.getByTestId("flyout-rect-center").click();
  await sketchClick(page, 0, 0);
  await sketchClick(page, ...corner);
  await page.getByTestId("tool-select").click();
  await sketchClick(page, corner[0] / 3, corner[1]); // the top side
  await page.getByTestId("c-length-value").fill(size);
  await page.getByTestId("c-length").click();
  await sketchClick(page, sized / 2, corner[1] / 3); // the right side, where the top's length put it
  await page.getByTestId("c-length-value").fill(size);
  await page.getByTestId("c-length").click();
}

/** Draws SHS b × b × t as a normal sketch, ticks "Weldment profile" and finishes. */
export async function drawSHS(page: Page) {
  await page.getByTestId("new-part").click();
  await commit(page, "doc-name", "shs");
  await addParameter(page, "b", "40");
  await addParameter(page, "t", "3");
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("plane-top").click();
  await squareAt(page, [20, 15], "=b", 40);
  await squareAt(page, [15, 10], "=b - 2 * t", 34);
  await expect(page.getByTestId("profile-status")).toHaveText("Profile: 1 region, area 444 mm²");
  await expect(page.getByTestId("sketch-dof")).toHaveText("Fully defined");
  await page.getByTestId("sketch-weldment").check();
  await page.getByTestId("finish-sketch").click();
}

/** Draws SHS b × b × t, and saves it to the section library with the sizes 40 × 40 × 3 and 50 × 50 × 3. */
export async function saveSHS(page: Page) {
  await drawSHS(page);
  await page.getByTestId("profile-name").fill("SHS");
  await page.getByTestId("profile-size-0").fill("SHS 40x40x3");
  await page.getByTestId("profile-add-size").click();
  await page.getByTestId("profile-size-1").fill("SHS 50x50x3");
  await page.getByTestId("profile-size-1-b").fill("50");
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("section-SHS")).toBeVisible();
}
