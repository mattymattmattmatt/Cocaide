// Share project: one browser gets a code, another types it and the project opens there. The two connect through a
// local PeerJS server here (the app uses PeerJS's public one), with no STUN: both are on this machine.
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { expect, test } from "@playwright/test";
import { PeerServer } from "peer";
import { openApp, waitForRebuild } from "./helpers";
import { boxGlb } from "../tests/glb-fixture";

let server: Server | null = null;
let port = 0;
test.beforeAll(async () => {
  port = 9300 + Math.floor(Math.random() * 500);
  await new Promise<void>((resolve) => {
    PeerServer({ host: "127.0.0.1", port, path: "/" }, (s) => {
      server = s as Server;
      resolve();
    });
  });
});
test.afterAll(() => {
  server?.close();
});

const local = () => `window.__cocaidePeer = { host: "127.0.0.1", port: ${port}, path: "/", secure: false, config: { iceServers: [] } };`;

test("share project: a code on one device, typed on another, opens the project there", async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  for (const p of [a, b]) await p.addInitScript({ content: local() });
  await openApp(a);
  await openApp(b);
  // The sender opens an example (the receiver keeps its blank part).
  await a.locator("select").first().selectOption("stand (two bodies)");
  await waitForRebuild(a);
  const name = await a.getByTestId("doc-name").inputValue();
  expect(name).not.toBe(await b.getByTestId("doc-name").inputValue());

  await a.getByTestId("share-open").click();
  await a.getByTestId("share-start").click();
  await expect(a.getByTestId("share-code")).toHaveText(/^\d{3} \d{3}$/, { timeout: 20_000 });
  const code = (await a.getByTestId("share-code").textContent())!;
  await expect(a.getByTestId("share-status")).toContainText("Waiting for the other device");

  // A wrong code says so (and nothing changes).
  await b.getByTestId("share-open").click();
  await expect(b.getByTestId("share-get")).toBeDisabled();
  const wrong = code === "999 999" ? "999 998" : "999 999";
  await b.getByTestId("share-code-input").fill(wrong);
  await b.getByTestId("share-get").click();
  await expect(b.getByTestId("share-get-status")).toContainText("no device is sharing with that code", { timeout: 25_000 });

  // The right one: the project opens on the other device, the sender sees it went.
  await b.getByTestId("share-code-input").fill(code.replace(" ", ""));
  await b.getByTestId("share-get").click();
  await expect(b.getByTestId("share-dialog")).toHaveCount(0, { timeout: 25_000 });
  await expect(b.getByTestId("doc-name")).toHaveValue(name);
  await waitForRebuild(b);
  await expect(b.getByTestId("notice")).toContainText("from another device");
  await expect(a.getByTestId("share-status")).toContainText("Sent ✓", { timeout: 10_000 });

  // Stop sharing: the code no longer works.
  await a.getByTestId("share-stop").click();
  await expect(a.getByTestId("share-start")).toBeVisible();
  await b.getByTestId("share-open").click();
  await b.getByTestId("share-code-input").fill(code);
  await b.getByTestId("share-get").click();
  await expect(b.getByTestId("share-get-status")).toContainText("no device is sharing with that code", { timeout: 25_000 });
});

test("a big project (one carrying a .glb model) goes in pieces, with how far it has got, and arrives whole", async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await browser.newPage();
  const b = await browser.newPage();
  for (const p of [a, b]) await p.addInitScript({ content: local() });
  await openApp(a);
  await openApp(b);
  // About 8 MB of .glb (a third more as text, and it doesn't compress): dozens of pieces.
  const glb = Buffer.from(boxGlb(2, 0.5, 1, [0, 0, 0], { padding: 8_000_000 })).toString("base64");
  const doc = {
    version: 1, units: "mm", name: "lounge", features: [],
    assembly: { parts: { sofa: { version: 1, units: "mm", name: "Sofa", features: [], mesh: { glb, scale: 1.5 } } }, components: [{ id: "sofa-1", part: "sofa", fixed: true }] },
  };
  const text = JSON.stringify(doc);
  await a.locator('input[type="file"][accept^=".json"]').first().setInputFiles({ name: "lounge.cocaide.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(a.getByTestId("doc-name")).toHaveValue("lounge", { timeout: 30_000 });

  await a.getByTestId("share-open").click();
  await a.getByTestId("share-start").click();
  await expect(a.getByTestId("share-code")).toHaveText(/^\d{3} \d{3}$/, { timeout: 20_000 });
  const code = (await a.getByTestId("share-code").textContent())!;
  await b.getByTestId("share-open").click();
  await b.getByTestId("share-code-input").fill(code);
  await b.getByTestId("share-get").click();
  // How far it has got, while it comes.
  await expect(b.getByTestId("share-get-progress")).toContainText(/\d+% of \d+\.\d MB/, { timeout: 30_000 });
  await expect(b.getByTestId("share-dialog")).toHaveCount(0, { timeout: 180_000 });
  await expect(b.getByTestId("doc-name")).toHaveValue("lounge");
  await expect(a.getByTestId("share-status")).toContainText("Sent ✓", { timeout: 30_000 });
  // Whole: the model arrived byte for byte.
  // (Too big for the browser's storage, so read it back by saving it.)
  const download = b.waitForEvent("download");
  await b.getByRole("button", { name: "Save", exact: true }).click();
  const parsed = JSON.parse(readFileSync(await (await download).path(), "utf8"));
  expect(parsed.assembly.parts.sofa.mesh.glb).toBe(glb);
});
