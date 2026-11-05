// The Claude subscription provider (Claude Code through the local bridge), in
// the browser. A real bridge (npm run bridge's code) is started with a
// stand-in for `claude` (tests/bridge/fake-claude.mjs) that drives the real
// Cocaide MCP server, slowed down so the live updates can be watched: the 3D
// view and the feature tree change while it works, the AI window lists its
// steps, edits are locked, and the result is a proposal to accept or discard.
// Live link follows a file that changes on disk. No real Claude Code login
// is involved.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp, savedDocument } from "./helpers";

const FAKE = join(process.cwd(), "tests", "bridge", "fake-claude.mjs");
let bridge: ChildProcess;
let url = "";
let token = "";
let dir = "";

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cocaide-e2e-bridge-"));
  bridge = spawn(process.execPath, ["--import", "tsx", "src/bridge/main.ts", "--port", "0", "--data-dir", join(dir, "data"), "--claude", FAKE], {
    env: { ...process.env, FAKE_CLAUDE_STEP_MS: "2500" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`the bridge did not start: ${out}`)), 60_000);
    bridge.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const port = /on http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1];
      const tok = /Pairing token[^\n]*\n\s+(\S+)/.exec(out)?.[1];
      if (port && tok && out.includes("Leave this window open")) {
        url = `http://127.0.0.1:${port}`;
        token = tok;
        clearTimeout(t);
        ok();
      }
    });
  });
});

test.afterAll(() => {
  bridge?.kill();
});

async function openAssistant(page: Page) {
  await page.getByTestId("ask-settings-open").click();
  await page.getByTestId("settings-tab-assistant").click();
}

async function useBridge(page: Page) {
  await openAssistant(page);
  await page.getByTestId("ask-provider").selectOption("claude-code");
  await expect(page.getByTestId("ask-api-key")).toHaveCount(0);
  await page.getByTestId("bridge-url").fill(url);
  await page.getByTestId("bridge-token").fill(token);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
});

test("settings: the setup steps, a wrong token, then Test shows the bridge, Claude Code and the login", async ({ page }) => {
  await openAssistant(page);
  await page.getByTestId("ask-provider").selectOption("claude-code");
  await expect(page.getByTestId("bridge-settings")).toContainText("npm install -g @anthropic-ai/claude-code");
  await expect(page.getByTestId("bridge-settings")).toContainText("npm run bridge");
  await expect(page.getByTestId("bridge-settings")).toContainText("MSYS_NO_PATHCONV=1");
  await page.getByTestId("bridge-url").fill(url);
  await page.getByTestId("bridge-token").fill("not-the-token-0123456789");
  await page.getByTestId("bridge-test").click();
  await expect(page.getByTestId("bridge-status")).toContainText("pairing token does not match");
  await page.getByTestId("bridge-token").fill(token);
  await page.getByTestId("bridge-test").click();
  await expect(page.getByTestId("bridge-status")).toContainText("answers and is paired");
  await expect(page.getByTestId("bridge-status")).toContainText("Claude Code 9.9.9");
  await expect(page.getByTestId("bridge-status")).toContainText("Logged in");
  await page.getByTestId("bridge-model").selectOption("sonnet");
  await page.getByTestId("ask-settings-save").click();
  await openAssistant(page);
  await expect(page.getByTestId("ask-provider")).toHaveValue("claude-code");
  await expect(page.getByTestId("bridge-model")).toHaveValue("sonnet");
});

test("an ask: the view and the tree change live, edits wait, then Discard restores and Accept is one undo step", async ({ page }) => {
  await useBridge(page);
  await page.getByTestId("ask-settings-save").click();
  const before = await savedDocument(page);

  await page.getByTestId("feature-hole_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-ask").click();
  await expect(page.getByTestId("ask")).toContainText("Claude subscription via Claude Code");
  await page.getByTestId("ask-input").fill("add a block under the bracket");
  await page.getByTestId("ask-input").press("Enter");

  // Live: the steps, the sketch in the tree before the block, the lock banner.
  await expect(page.getByTestId("ask-live")).toBeVisible();
  await expect(page.getByTestId("bridge-banner")).toBeVisible();
  await expect(page.getByTestId("feature-block_sketch")).toBeVisible();
  await expect(page.getByTestId("ask-live")).toBeVisible();
  await expect(page.getByTestId("feature-block")).toHaveCount(0);
  await expect(page.getByTestId("ask-live-step").first()).toContainText("addFeature");
  // Then the block, still while it works: the 3D view rebuilt it.
  await expect(page.getByTestId("feature-block")).toBeVisible();
  await expect(page.getByTestId("volume")).not.toHaveText(/^18,994\.728/);
  // The user's document is untouched meanwhile.
  expect(await savedDocument(page)).toEqual(before);

  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change", { timeout: 60_000 });
  await expect(page.getByTestId("bridge-banner")).toHaveCount(0);
  await expect(page.getByTestId("ask-text")).toHaveText("Done: a 40 × 20 × 10 block.");
  await expect(page.getByTestId("ask-proposal")).toContainText("+ block");
  await expect(page.getByTestId("ask-proposal")).toContainText("+ block_sketch");
  const proposed = (await page.getByTestId("volume").textContent())!;

  await page.getByTestId("ask-discard").click();
  await expectVolume(page, "18,994.728");
  await expect(page.getByTestId("feature-block")).toHaveCount(0);
  expect(await savedDocument(page)).toEqual(before);

  // Again, and Accept: one undo step takes it back.
  await page.getByTestId("feature-hole_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-ask").click();
  await page.getByTestId("ask-input").fill("add a block under the bracket");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change", { timeout: 60_000 });
  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  await expect(page.getByTestId("volume")).toHaveText(proposed);
  const after = await savedDocument(page);
  expect((after.features as { id: string }[]).map((f) => f.id).slice(-2)).toEqual(["block_sketch", "block"]);
  await page.getByTestId("ask-close").click();
  await page.getByTestId("undo").click();
  await expectVolume(page, "18,994.728");
  expect(await savedDocument(page)).toEqual(before);

  // The history has both asks.
  await page.getByTestId("feature-hole_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-ask").click();
  await page.getByTestId("ask-tab-history").click();
  await expect(page.getByTestId("ask-history-list").locator("li")).toHaveCount(2);
});

test("Stop ends the run and leaves the part as it was", async ({ page }) => {
  await useBridge(page);
  await page.getByTestId("ask-settings-save").click();
  await page.getByTestId("feature-hole_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-ask").click();
  await page.getByTestId("ask-input").fill("add a block");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("feature-block_sketch")).toBeVisible();
  await page.getByTestId("bridge-stop").click();
  await expect(page.getByTestId("ask")).toHaveCount(0);
  await expect(page.getByTestId("feature-block_sketch")).toHaveCount(0);
  await expectVolume(page, "18,994.728");
});

test("Live link: a file changed on disk shows in the view; Stop following brings back your part", async ({ page }) => {
  const file = join(dir, "followed.cocaide.json");
  const part = (features: unknown[]) => JSON.stringify({ version: 1, units: "mm", name: "followed", features });
  const sketch = { id: "plate_sketch", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 50, h: 40 }] };
  writeFileSync(file, part([sketch]));
  await useBridge(page);
  await page.getByTestId("follow-path").fill(file);
  await page.getByTestId("follow-start").click();
  await expect(page.getByTestId("follow-banner")).toContainText(`Following ${file}`);
  await expect(page.getByTestId("feature-plate_sketch")).toBeVisible();
  await expect(page.getByTestId("feature-hole_1")).toHaveCount(0);

  writeFileSync(file, part([sketch, { id: "plate", op: "extrude", sketch: "plate_sketch", distance: 5, direction: [0, 0, 1] }]));
  await expect(page.getByTestId("feature-plate")).toBeVisible();
  await expectVolume(page, "10,000");

  await page.getByTestId("follow-stop").click();
  await expect(page.getByTestId("follow-banner")).toHaveCount(0);
  await expect(page.getByTestId("feature-hole_1")).toBeVisible();
  await expectVolume(page, "18,994.728");
});
