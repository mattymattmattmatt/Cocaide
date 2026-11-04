// Settings → Assistant with the Ollama provider, in the browser. Playwright
// answers the page's requests to http://localhost:11434 with a stub that
// speaks Ollama's wire format (version, tags, show, a streamed pull, streamed
// chats); there is no Ollama here. It checks the provider switch, the status,
// the model list, pulling, the test chat, the fix shown when Ollama refuses the
// page, the Claude settings still being there, and one ask through Ollama.

import { expect, test, type Page, type Route } from "@playwright/test";
import { expectVolume, openApp, savedDocument } from "./helpers";

const BASE = "http://localhost:11434";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };

const MODELS = [
  { name: "qwen3.5:9b", model: "qwen3.5:9b", size: 6_600_000_000, details: { family: "qwen35", parameter_size: "9.7B", quantization_level: "Q4_K_M" } },
  { name: "qwen3.5:4b", model: "qwen3.5:4b", size: 3_300_000_000, details: { family: "qwen35", parameter_size: "4.7B", quantization_level: "Q4_K_M" } },
];

interface Stub {
  chats: Record<string, unknown>[];
}

/** The page's Ollama, stubbed. `replies` are the chat answers in order: content and/or tool calls. */
async function stubOllama(page: Page, replies: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] }[] = []): Promise<Stub> {
  const stub: Stub = { chats: [] };
  const ndjson = (lines: unknown[]) => ({
    status: 200,
    headers: { ...CORS, "content-type": "application/x-ndjson" },
    body: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  });
  await page.route(`${BASE}/**`, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const json = (v: unknown, status = 200) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(v) });
    if (path === "/api/version") return json({ version: "0.12.9" });
    if (path === "/api/tags") return json({ models: MODELS });
    if (path === "/api/show")
      return json({ details: MODELS[0].details, model_info: { "qwen35.context_length": 262144 }, capabilities: ["completion", "vision", "tools", "thinking"] });
    if (path === "/api/pull") {
      const total = 3_300_000_000;
      return route.fulfill(
        ndjson([
          { status: "pulling manifest" },
          { status: "pulling 81fb60c7daa8", total, completed: total },
          { status: "verifying sha256 digest" },
          { status: "writing manifest" },
          { status: "success" },
        ]),
      );
    }
    if (path === "/api/chat") {
      const body = req.postDataJSON() as Record<string, unknown>;
      stub.chats.push(body);
      const r = body.tools ? (replies.shift() ?? { content: "done" }) : { content: "OK" };
      return route.fulfill(
        ndjson([
          { model: body.model, message: { role: "assistant", content: r.content ?? "", ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) }, done: false },
          { model: body.model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 9000, eval_count: 40 },
        ]),
      );
    }
    return route.fulfill({ status: 404, headers: CORS, body: "404 page not found" });
  });
  return stub;
}

async function openAssistant(page: Page) {
  await page.getByTestId("ask-settings-open").click();
  await page.getByTestId("settings-tab-assistant").click();
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await page.locator("select").first().selectOption("bracket");
  await expectVolume(page, "18,994.728");
});

test("the provider switch: Claude's settings stay; Ollama shows its status, models, pull and test", async ({ page }) => {
  const stub = await stubOllama(page);
  await openAssistant(page);
  // Claude is the default, with its own settings as before.
  await expect(page.getByTestId("ask-provider")).toHaveValue("anthropic");
  await expect(page.getByTestId("ask-model")).toHaveValue("claude-opus-5-5");
  await page.getByTestId("ask-api-key").fill("sk-test");

  await page.getByTestId("ask-provider").selectOption("ollama");
  await expect(page.getByTestId("ask-api-key")).toHaveCount(0);
  await expect(page.getByTestId("ask-ollama-url")).toHaveValue(BASE);
  await expect(page.getByTestId("ask-ollama-status")).toHaveText("Connected to Ollama 0.12.9: 2 models installed.");
  await expect(page.getByTestId("ask-ollama-local")).toContainText("Runs locally");
  const options = page.getByTestId("ask-ollama-model").locator("option");
  await expect(options).toHaveText(["Choose an installed model…", "qwen3.5:9b · 6.6 GB · 9.7B · Q4_K_M", "qwen3.5:4b · 3.3 GB · 4.7B · Q4_K_M"]);
  await page.getByTestId("ask-ollama-model").selectOption("qwen3.5:9b");
  await expect(page.getByTestId("ask-ollama-selected")).toContainText("Using qwen3.5:9b, locally.");
  await expect(page.getByTestId("ask-ollama-selected")).toContainText("Tools ✓");
  await expect(page.getByTestId("ask-ollama-selected")).toContainText("Vision ✓");
  await expect(page.getByTestId("ask-ollama-ctx")).toHaveValue("16384");
  await expect(page.getByTestId("ask-ollama-think")).toHaveValue("off");

  // Pull a model, with progress, and test the chosen one.
  await page.getByTestId("ask-ollama-pull-name").fill("qwen3.5:4b");
  await page.getByTestId("ask-ollama-pull").click();
  await expect(page.getByTestId("ask-ollama-pull-progress")).toHaveText("success");
  await page.getByTestId("ask-ollama-model").selectOption("qwen3.5:9b");
  await page.getByTestId("ask-ollama-test").click();
  await expect(page.getByTestId("ask-ollama-test-result")).toContainText('The model answered "OK"');
  expect(stub.chats.at(-1)).toMatchObject({ model: "qwen3.5:9b", think: false });

  // Saved; reopened, it is still Ollama, and Claude's key was kept for when it's switched back.
  await page.getByTestId("ask-ollama-ctx").selectOption("24576");
  await page.getByTestId("ask-settings-save").click();
  await openAssistant(page);
  await expect(page.getByTestId("ask-provider")).toHaveValue("ollama");
  await expect(page.getByTestId("ask-ollama-ctx")).toHaveValue("24576");
  await page.getByTestId("ask-provider").selectOption("anthropic");
  await expect(page.getByTestId("ask-api-key")).toHaveValue("sk-test");
});

test("Ollama refusing the page's origin, or not running: the status says so and shows the exact command", async ({ page }) => {
  // Answers, but without the CORS header: the page's request is blocked; a no-cors probe gets through.
  await page.route(`${BASE}/**`, (route) => route.fulfill({ status: 403, body: "" }));
  await openAssistant(page);
  await page.getByTestId("ask-provider").selectOption("ollama");
  await expect(page.getByTestId("ask-ollama-status")).toContainText("refuses requests from this page");
  await expect(page.getByTestId("ask-ollama-fix")).toContainText('setx OLLAMA_ORIGINS "https://mattymattmattmatt.github.io,http://localhost:*"');

  // Nothing there at all.
  await page.unroute(`${BASE}/**`);
  await page.route(`${BASE}/**`, (route) => route.abort("connectionrefused"));
  await page.getByTestId("ask-ollama-refresh").click();
  await expect(page.getByTestId("ask-ollama-status")).toContainText(`Nothing answers at ${BASE}`);
  await expect(page.getByTestId("ask-ollama-fix")).toContainText("setx OLLAMA_ORIGINS");
});

test("an ask through Ollama: the same tools, a proposal you accept", async ({ page }) => {
  const stub = await stubOllama(page, [
    { tool_calls: [{ function: { name: "updateFeature", arguments: { id: "hole_1", patch: { diameter: 8 } } } }] },
    { content: "hole_1 is now Ø8." },
  ]);
  await openAssistant(page);
  await page.getByTestId("ask-provider").selectOption("ollama");
  await page.getByTestId("ask-ollama-model").selectOption("qwen3.5:9b");
  await page.getByTestId("ask-settings-save").click();
  const before = await savedDocument(page);

  await page.getByTestId("feature-hole_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-ask").click();
  await page.getByTestId("ask-reach-target").click();
  await expect(page.getByTestId("ask")).toContainText("qwen3.5:9b (local, Ollama)");
  await page.getByTestId("ask-input").fill("make it 8 mm");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-outcome")).toHaveText("Proposed change");
  await expect(page.getByTestId("ask-text")).toHaveText("hole_1 is now Ø8.");
  await expect(page.getByTestId("ask-proposal")).toContainText("hole_1 diameter: 6.6 → 8");
  // Not applied until accepted.
  expect(await savedDocument(page)).toEqual(before);
  await page.getByTestId("ask-accept").click();
  await expect(page.getByTestId("ask-outcome")).toHaveText("Applied");
  await expectVolume(page, "18,898.407");

  // What the page sent: Ollama's chat, with the tools as functions, thinking off, the context length set.
  const first = stub.chats.find((c) => c.tools) as {
    model: string;
    tools: { type: string; function: { name: string } }[];
    think: boolean;
    options: { num_ctx: number };
    messages: { role: string }[];
  };
  expect(first.model).toBe("qwen3.5:9b");
  expect(first.think).toBe(false);
  expect(first.options.num_ctx).toBe(16384);
  expect(first.tools.every((t) => t.type === "function")).toBe(true);
  expect(first.tools.map((t) => t.function.name)).toContain("updateFeature");
  const second = stub.chats.filter((c) => c.tools)[1] as { messages: { role: string; tool_name?: string }[] };
  expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_name: "updateFeature" });
});

test("an attached PDF goes to a local model as its text layer and its pages as images", async ({ page }) => {
  const stub = await stubOllama(page, [{ content: "The drawing is the 80 × 40 bracket." }]);
  await openAssistant(page);
  await page.getByTestId("ask-provider").selectOption("ollama");
  await page.getByTestId("ask-ollama-model").selectOption("qwen3.5:9b");
  await page.getByTestId("ask-settings-save").click();
  await page.getByTestId("feature-ext_1").locator(".feature-row").click({ button: "right" });
  await page.getByTestId("ctx-ask").click();
  await page.getByTestId("ask-attach-input").setInputFiles("examples/drawings/bracket.pdf");
  await expect(page.getByTestId("ask-attachment-0")).toContainText("bracket.pdf");
  await page.getByTestId("ask-input").fill("What does the drawing show?");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-text")).toHaveText("The drawing is the 80 × 40 bracket.");
  const chat = stub.chats.find((c) => c.tools) as { messages: { role: string; content: string; images?: string[] }[] };
  const user = chat.messages[1];
  expect(user.images?.length).toBeGreaterThan(0);
  expect(user.images![0]).toMatch(/^iVBOR/);
  expect(user.content).toContain("Attached PDF bracket.pdf");
  expect(user.content).toContain("Its text layer:");
});
