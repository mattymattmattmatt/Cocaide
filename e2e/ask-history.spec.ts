// The AI window in the browser: it stays open when the model or the view is
// clicked, Escape closes it only when nothing is typed, unsent text comes back
// as a draft, files attach (picked, pasted, dropped on the window) as chips
// that can be removed and go to the model, and every request is kept in the
// History tab, read again and followed up. The model is scripted (Playwright
// answers the page's Messages API calls).

import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, scriptModel, text, tool, useKey } from "./helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await useKey(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
});

async function askAbout(page: Page, id: string) {
  await page.getByTestId(`feature-${id}`).locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-ask").click();
  await expect(page.getByTestId("ask")).toBeVisible();
}

test("the window stays open on clicks elsewhere; Escape only closes it empty; the draft comes back", async ({ page }) => {
  await askAbout(page, "hole_1");
  await page.getByTestId("ask-input").fill("make it 8 mm and");
  // A click in the view, and one on the tree: still open, text still there.
  await page.getByTestId("viewport").click({ position: { x: 40, y: 40 } });
  await page.getByTestId("feature-ext_1").locator(".feature-row").click();
  await expect(page.getByTestId("ask")).toBeVisible();
  await expect(page.getByTestId("ask-input")).toHaveValue("make it 8 mm and");
  // Escape with text typed does nothing.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ask")).toBeVisible();
  // Closed with the button (via a right-click elsewhere reopening it), the text is kept as a draft.
  await page.getByTestId("ask").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("ask")).toHaveCount(0);
  await askAbout(page, "hole_1");
  await expect(page.getByTestId("ask-input")).toHaveValue("make it 8 mm and");
  // Emptied, Escape closes it.
  await page.getByTestId("ask-input").fill("");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ask")).toHaveCount(0);
});

test("attachments: picked, pasted and dropped files become chips, can be removed, and go to the model", async ({ page }) => {
  const sent = await scriptModel(page, [[text("The sketch shows a plate with one hole.")]]);
  await askAbout(page, "ext_1");
  await page.getByTestId("ask-attach-input").setInputFiles([
    { name: "sketch.png", mimeType: "image/png", buffer: PNG },
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\nM6 clearance holes.") },
  ]);
  await expect(page.getByTestId("ask-attachment-0")).toContainText("sketch.png");
  await expect(page.getByTestId("ask-attachment-1")).toContainText("notes.md");
  // A file the ask can't take says why.
  await page.getByTestId("ask-attach-input").setInputFiles([{ name: "tool.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") }]);
  await expect(page.getByTestId("ask-attach-error")).toContainText("tool.exe: attach images");
  // A pasted screenshot, and a file dropped on the window itself (not a drawing for a new part).
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const paste = new DataTransfer();
    paste.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    document.querySelector("[data-testid=ask-input]")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: paste, bubbles: true, cancelable: true }));
  }, PNG.toString("base64"));
  await expect(page.getByTestId("ask-attachment-2")).toContainText("pasted.png");
  await page.evaluate(() => {
    const drop = new DataTransfer();
    drop.items.add(new File(["a,b\n1,2"], "sizes.csv", { type: "text/csv" }));
    document.querySelector("[data-testid=ask]")!.dispatchEvent(new DragEvent("drop", { dataTransfer: drop, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("ask-attachment-3")).toContainText("sizes.csv");
  await page.getByTestId("ask-attachment-remove-2").click();
  await expect(page.getByTestId("ask-attachments").locator(".ask-chip")).toHaveCount(3);

  await page.getByTestId("ask-input").fill("What does the sketch show?");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-text")).toHaveText("The sketch shows a plate with one hole.");
  await expect(page.getByTestId("ask-sent-attachments")).toHaveText("Attached: sketch.png, notes.md, sizes.csv");
  const content = sent[0].body.messages[0].content as { type: string; text?: string; source?: { media_type: string } }[];
  expect(content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
  expect(content.some((b) => b.text?.includes("Attached file notes.md:\n# Notes"))).toBe(true);
  expect(content.some((b) => b.text?.includes("Attached file sizes.csv:\na,b"))).toBe(true);
});

test("history: kept after Accept and Close, read again, followed up with the earlier turns, cleared", async ({ page }) => {
  const sent = await scriptModel(page, [
    [tool("updateFeature", { id: "hole_1", patch: { diameter: 8 } })],
    [text("hole_1 is now Ø8.")],
    [text("It was 6.6 mm before; now it is 8.")],
  ]);
  await askAbout(page, "hole_1");
  await page.getByTestId("ask-reach-target").click();
  await page.getByTestId("ask-input").fill("make it 8 mm");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  // After Accept the conversation is still there.
  await expect(page.getByTestId("ask-text")).toHaveText("hole_1 is now Ø8.");
  await page.getByTestId("ask-close").click();

  // Reopened: the History tab has it, with the change and that it was accepted.
  await askAbout(page, "hole_1");
  await page.getByTestId("ask-tab-history").click();
  await expect(page.getByTestId("ask-history-0")).toContainText("make it 8 mm");
  await expect(page.getByTestId("ask-history-0")).toContainText("Proposed change, accepted");
  await page.getByTestId("ask-history-0").click();
  await expect(page.getByTestId("ask-history-entry")).toContainText("hole_1 is now Ø8.");
  await expect(page.getByTestId("ask-history-entry")).toContainText("hole_1 diameter: 6.6 → 8");
  await expect(page.getByTestId("ask-history-entry")).toContainText("1 tool call");

  // Follow up: the earlier turn goes with the new request.
  await page.getByTestId("ask-history-follow").click();
  await expect(page.getByTestId("ask-follow")).toContainText("Following up: make it 8 mm");
  await page.getByTestId("ask-input").fill("What was it before?");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-text")).toHaveText("It was 6.6 mm before; now it is 8.");
  const first = (sent[2].body.messages[0].content as { type: string; text?: string }[]).find((b) => b.type === "text")!.text!;
  expect(first).toContain("This follows up an earlier conversation about this part.");
  expect(first).toContain("1. The user asked: make it 8 mm\n   You answered: hole_1 is now Ø8.\n   Changes you proposed (accepted): hole_1 diameter: 6.6 → 8");

  // The follow-up's thread reads as one conversation; clearing empties the list.
  await page.getByTestId("ask-follow-up").click();
  await page.getByTestId("ask-tab-history").click();
  await expect(page.getByTestId("ask-history-list").locator("li")).toHaveCount(2);
  await page.getByTestId("ask-history-0").click();
  await expect(page.getByTestId("ask-history-entry").locator(".ask-history-turn")).toHaveCount(2);
  await page.getByTestId("ask-history-back").click();
  await page.getByTestId("ask-history-clear").click();
  await expect(page.getByTestId("ask-history-empty")).toBeVisible();
});
