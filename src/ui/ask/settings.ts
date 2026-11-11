// Ask settings: which provider and model, and how the page reaches it.
//
// Anthropic Claude: the API key stays in this browser (localStorage) and is
// sent only to the Anthropic API. With `npm run dev` and ANTHROPIC_API_KEY
// set, the dev server proxies the API and adds the key itself, so the page
// needs none.
//
// Ollama (local): the page talks to the Ollama server on this computer
// (default http://localhost:11434). No key; nothing leaves the computer.
//
// Claude subscription (Claude Code, local bridge): the page talks to the
// bridge on this computer (npm run bridge, default http://127.0.0.1:8787),
// which runs the user's own logged-in Claude Code with Cocaide's MCP tools.
// No key; the pairing token the bridge printed is kept in this browser.

import type { AskReach } from "../../ask/agent";
import type { AskModel } from "../../ask/model";
import { DEFAULT_MODEL, type Effort } from "../../ask/models";
import { DEFAULT_URL, ENGINE_LABEL, type BridgeEngine, type BridgeModel } from "../../bridge/protocol";

export type Provider = "anthropic" | "ollama" | "claude-code";
export type ThinkSetting = "off" | "on" | "low" | "medium" | "high";

export interface OllamaSettings {
  baseUrl: string;
  /** The installed model to use ("qwen3.5:9b"). */
  model: string;
  /** Context length in tokens (num_ctx). */
  numCtx: number;
  think: ThinkSetting;
  /** How long Ollama keeps the model in memory after an ask ("10m", "1h", "-1": always). */
  keepAlive: string;
  temperature: number;
}

export interface AskSettings {
  provider: Provider;
  apiKey: string;
  model: string;
  effort: Effort;
  /** What a right-click ask may change by default: anything in the part, or only what was right-clicked. */
  reach: AskReach;
  ollama: OllamaSettings;
  bridge: BridgeAskSettings;
}

export interface BridgeAskSettings {
  /** The bridge's address ("http://127.0.0.1:8787"). */
  url: string;
  /** The pairing token the bridge printed in its terminal. */
  token: string;
  model: BridgeModel;
  /** Which assistant the bridge runs: Claude Code, xAI's Grok Build, or whichever is installed and signed in. */
  engine: BridgeEngine;
  /** Grok Build's model ("default": its own). */
  grokModel: string;
  /** The last file followed with Live link. */
  followPath: string;
}

export const BRIDGE_DEFAULTS: BridgeAskSettings = { url: DEFAULT_URL, token: "", model: "default", engine: "auto", grokModel: "default", followPath: "" };

/** What the bridge answers as, in words: "Claude Code", "Grok Build", or "your subscription" for auto. */
export function bridgeName(b: Pick<BridgeAskSettings, "engine">): string {
  return b.engine === "auto" ? "your Claude or Grok subscription" : ENGINE_LABEL[b.engine];
}

const KEY = "cocaide.ask.settings.v1";

export const OLLAMA_DEFAULTS: OllamaSettings = {
  baseUrl: "http://localhost:11434",
  model: "",
  numCtx: 16384,
  think: "off",
  keepAlive: "10m",
  temperature: 0.2,
};

/** True when the dev server proxies the API with its own key. */
export const HAS_PROXY = import.meta.env.VITE_COCAIDE_ANTHROPIC_PROXY === "1";

/**
 * The one-click launcher (start-cocaide.bat) opens the app with
 * "#bridge=<address>&token=<pairing token>": that pairs the app with the
 * bridge and selects it, then the fragment is wiped from the address bar so
 * the token isn't left on screen or in the history.
 */
function pairFromLink(s: AskSettings): AskSettings {
  try {
    const hash = typeof location === "undefined" ? "" : location.hash.replace(/^#/, "");
    if (!hash.includes("token=")) return s;
    const q = new URLSearchParams(hash);
    const token = q.get("token")?.trim() ?? "";
    const url = q.get("bridge")?.trim() || s.bridge.url;
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(token) || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) return s;
    // The launcher says which assistant it found ("engine=grok" when only Grok Build is installed).
    const e = q.get("engine");
    const engine: BridgeEngine = e === "claude" || e === "grok" || e === "auto" ? e : s.bridge.engine;
    const next: AskSettings = { ...s, provider: "claude-code", bridge: { ...s.bridge, url, token, engine } };
    saveSettings(next);
    history.replaceState(null, "", location.pathname + location.search);
    return next;
  } catch {
    return s;
  }
}

export function loadSettings(): AskSettings {
  return pairFromLink(loadStoredSettings());
}

function loadStoredSettings(): AskSettings {
  const defaults: AskSettings = { provider: "anthropic", apiKey: "", model: DEFAULT_MODEL, effort: "low", reach: "part", ollama: OLLAMA_DEFAULTS, bridge: BRIDGE_DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<AskSettings>;
    return { ...defaults, ...saved, ollama: { ...OLLAMA_DEFAULTS, ...(saved.ollama ?? {}) }, bridge: { ...BRIDGE_DEFAULTS, ...(saved.bridge ?? {}) } };
  } catch {
    return defaults;
  }
}

export function saveSettings(s: AskSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage disabled: the settings last for this page only
  }
}

export function canAsk(s: AskSettings): boolean {
  if (s.provider === "ollama") return s.ollama.model.trim() !== "" && s.ollama.baseUrl.trim() !== "";
  if (s.provider === "claude-code") return s.bridge.url.trim() !== "" && s.bridge.token.trim() !== "";
  return HAS_PROXY || s.apiKey.trim() !== "";
}

/** The model client. The SDK (or the Ollama provider) is loaded on the first ask, not with the app. */
export async function modelFor(s: AskSettings): Promise<AskModel> {
  if (s.provider === "claude-code") throw new Error("Claude Code answers through the bridge (src/ask/bridge/run.ts), not as a model of the loop.");
  if (s.provider === "ollama") {
    const { OllamaModel, OllamaClient } = await import("../../ask/ollama/model");
    const o = s.ollama;
    return new OllamaModel(new OllamaClient(o.baseUrl, { origin: location.origin }), {
      model: o.model.trim(),
      numCtx: o.numCtx,
      think: o.think,
      keepAlive: o.keepAlive,
      temperature: o.temperature,
    });
  }
  const { AnthropicModel, anthropicClient } = await import("../../ask/model");
  const client = anthropicClient(s.apiKey.trim() ? { apiKey: s.apiKey.trim(), browser: true } : { baseURL: `${location.origin}/anthropic`, browser: true });
  return new AnthropicModel(client, s.model, s.effort);
}
