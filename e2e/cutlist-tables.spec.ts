// Phase Q wave 1B: the cut list workspace. The table frame with an end cap
// on each leg: members grouped with their end cuts, the caps as a plate
// item; text typed on an item and a custom property kept in the document;
// stock and kerf feeding the nesting plan; CSV and XLSX out.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { unzipStored } from "../src/io/zip";
import { commit, expectVolume, okFeature, openApp, savedDocument } from "./helpers";

const SHOTS = process.env.CUTLIST_SHOTS;

async function capLeg(page: Page, leg: string) {
  await page.getByTestId(`feature-${leg}`).locator(".feature-row").click();
  await page.getByTestId("prop-cap-start").click();
  await okFeature(page);
}

test("the cut list workspace: items, typed text, nesting, CSV and XLSX", async ({ page }) => {
  const problems = await openApp(page);
  await page.locator("select").first().selectOption("table frame (weldment)");
  await expectVolume(page, "3,054,720");
  for (const leg of ["leg_a", "leg_b", "leg_c", "leg_d"]) await capLeg(page, leg);
  await expect(page.getByTestId("body-cap_4")).toBeVisible();

  // The panel: three member items and the four caps as one plate item.
  await page.getByTestId("tab-cutlist").click();
  const rows = page.getByTestId("cut-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3)).toContainText("End cap PL 3 × 40 × 40");
  await expect(page.getByTestId("cut-total-qty")).toHaveText("12");

  // The workspace: every column, the end cuts with their orientation.
  await page.getByTestId("cut-list-open").click();
  const ws = page.getByTestId("cut-workspace");
  await expect(ws).toBeVisible();
  const first = ws.locator('[data-testid="cut-ws-row"][data-item="1"]');
  await expect(first).toContainText("same plane, trapezoid");
  await expect(first).toContainText("1200.0");

  // A row picks its members in the view.
  await first.click();
  await expect(first).toHaveClass(/selected/);

  // Type a description, and a custom property in a column of its own.
  await commit(page, "cut-edit-1-description", "Top rail, long");
  await page.getByTestId("cut-new-prop").fill("Supplier");
  await page.getByTestId("cut-add-prop").click();
  await commit(page, "cut-edit-1-prop:Supplier", "Steel & Co");
  await commit(page, "cut-edit-2-finish", "Hot-dip galvanised");
  await expect(page.getByTestId("cut-edit-1-description")).toHaveValue("Top rail, long");
  const doc = (await savedDocument(page)) as { cutList: { items: { item: number; members: string[]; description?: string; finish?: string; properties?: Record<string, string> }[] } };
  expect(doc.cutList.items.find((e) => e.item === 1)).toEqual({ item: 1, members: ["rail_front", "rail_back"], description: "Top rail, long", properties: { Supplier: "Steel & Co" } });
  expect(doc.cutList.items.find((e) => e.item === 2)).toMatchObject({ finish: "Hot-dip galvanised" });

  // Sort by length, longest first.
  await page.getByTestId("cut-sort-length").click();
  await page.getByTestId("cut-sort-length").click();
  await expect(ws.getByTestId("cut-ws-row").first()).toHaveAttribute("data-item", "1");
  if (SHOTS) await ws.screenshot({ path: `${SHOTS}/cutlist-items.png` });

  // CSV: the columns shown, with the typed text.
  let download = page.waitForEvent("download");
  await page.getByTestId("cut-ws-csv").click();
  const csv = readFileSync(await (await download).path(), "utf8").split("\r\n");
  expect(csv[0]).toBe("Item,Qty,Description,Size,Material,Length (mm),Angle 1,Angle 2,Orientation,kg each,kg total,Paint area (m²),Finish,Notes,Supplier");
  expect(csv[1]).toMatch(/^1,2,"Top rail, long",SHS 40x40x3,steel \(default\),1200\.0,45°,45°,"same plane, trapezoid",4\.04,8\.09,0\.689,,,Steel & Co$/);

  // XLSX: a workbook that opens (its parts are there and well formed).
  download = page.waitForEvent("download");
  await page.getByTestId("cut-ws-xlsx").click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe("table-frame-cut-list.xlsx");
  const files = unzipStored(new Uint8Array(readFileSync(await dl.path())));
  expect(files.map((f) => f.name)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"]));
  const sheet1 = new TextDecoder().decode(files.find((f) => f.name === "xl/worksheets/sheet1.xml")!.data);
  expect(sheet1).toContain("Top rail, long");

  // Stock and nesting: 7040 mm of SHS in two 6 m bars at 3 mm kerf; 8 m bars make it one.
  await page.getByTestId("cut-ws-tab-nesting").click();
  await expect(page.getByTestId("nest-buy-count")).toHaveText("2 × 6000");
  await expect(page.getByTestId("nest-bar")).toHaveCount(2);
  await commit(page, "nest-stock", "8000");
  await expect(page.getByTestId("nest-buy-count")).toHaveText("1 × 8000");
  await commit(page, "nest-kerf", "4");
  await expect(page.getByTestId("nest-bar")).toHaveCount(1);
  const saved = (await savedDocument(page)) as { cutList: { stock: unknown } };
  expect(saved.cutList.stock).toEqual({ lengths: [8000], kerf: 4 });
  await commit(page, "nest-stock", "6000, 6100");
  await expect(page.getByTestId("nest-buy-count")).toHaveText(/2 × /);
  if (SHOTS) await page.getByTestId("cut-workspace").screenshot({ path: `${SHOTS}/cutlist-nesting.png` });

  // Plates: the end caps laid flat.
  await page.getByTestId("cut-ws-tab-plates").click();
  await expect(page.getByTestId("cut-plates")).toContainText("End cap PL 3 × 40 × 40");
  await page.getByTestId("cut-ws-close").click();
  await expect(page.getByTestId("cut-workspace")).toHaveCount(0);
  // The panel shows the typed description.
  await expect(rows.first()).toContainText("Top rail, long");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cutlist-app.png` });
  expect(problems).toEqual([]);
});
