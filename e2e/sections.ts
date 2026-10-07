// Drawing sections in the browser, for the weldment suites (Phases I and J).

import { expect, type Page } from "@playwright/test";
import { commit, sketchClick } from "./helpers";

export async function addParameter(page: Page, name: string, value: string) {
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
export async function drawSHS(page: Page) {
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
