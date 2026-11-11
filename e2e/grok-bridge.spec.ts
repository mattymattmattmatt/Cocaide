// Grok (xAI's Grok Build CLI) through the local bridge, in the browser: a real
// bridge started with no Claude Code and a stand-in for `grok`
// (tests/bridge/fake-grok.mjs) that drives the real Cocaide MCP server. The
// launcher's link (engine=grok) pairs the app, Settings shows Grok Build found
// and signed in, and an ask builds the part through it. No real xAI login.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectVolume, openApp } from "./helpers";

const FAKE = join(process.cwd(), "tests", "bridge", "fake-grok.mjs");
let bridge: ChildProcess;
let url = "";
let token = "";

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocaide-e2e-grok-"));
  bridge = spawn(process.execPath, ["--import", "tsx", "src/bridge/main.ts", "--port", "0", "--data-dir", join(dir, "data"), "--claude", join(dir, "no-claude"), "--grok", FAKE], {
    env: { ...process.env, XAI_API_KEY: "test-key" },
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
        expect(out).toContain("Grok Build 9.9.9 (test stand-in): signed in");
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

test("the launcher's link picks Grok; Settings shows it signed in; an ask builds the part through it", async ({ page }) => {
  await openApp(page);
  await page.goto(`/?e2e&launch#bridge=${encodeURIComponent(url)}&token=${token}&engine=grok`);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
  await openAssistant(page);
  await expect(page.getByTestId("ask-provider")).toHaveValue("claude-code");
  await expect(page.getByTestId("bridge-engine")).toHaveValue("grok");
  await expect(page.getByTestId("bridge-status")).toContainText("Grok Build 9.9.9 (test stand-in): signed in (XAI_API_KEY)");
  await expect(page.getByTestId("bridge-status")).toContainText("Claude Code: not installed");
  await expect(page.getByTestId("bridge-using")).toContainText("Grok Build");
  await page.getByTestId("ask-settings-save").click();

  await page.getByTestId("feature-hole_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-ask").click();
  await expect(page.getByTestId("ask")).toContainText("Grok subscription via Grok Build");
  const input = page.getByTestId("ask-input");
  await expect(input).toBeVisible();
  await input.fill("add a block under the bracket");
  await input.press("Enter");
  await expect(page.getByTestId("ask-proposal")).toContainText("+ block", { timeout: 90_000 });
  await expect(page.getByTestId("ask-proposal")).toContainText("+ block_sketch");
});
