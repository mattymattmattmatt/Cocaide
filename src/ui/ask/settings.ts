// Ask settings: which provider and model, and how the page reaches it.
//
// Anthropic Claude: the API key stays in this browser (localStorage) and is
// sent only to the Anthropic API. With `npm run dev` and ANTHROPIC_API_KEY
// set, the dev server proxies the API and adds the key itself, so the page
// needs none.
//
// Ollama (local): the page talks to the Ollama server on this computer
// (default http://localhost:11434). No key; nothing leaves the computer.

import type { AskReach } from "../../ask/agent";
import type { AskModel } from "../../ask/model";
import { DEFAULT_MODEL, type Effort } from "../../ask/models";

export type Provider = "anthropic" | "ollama";
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

export function loadSettings(): AskSettings {
  const defaults: AskSettings = { provider: "anthropic", apiKey: "", model: DEFAULT_MODEL, effort: "low", reach: "part", ollama: OLLAMA_DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<AskSettings>;
    return { ...defaults, ...saved, ollama: { ...OLLAMA_DEFAULTS, ...(saved.ollama ?? {}) } };
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
  return HAS_PROXY || s.apiKey.trim() !== "";
}

/** The model client. The SDK (or the Ollama provider) is loaded on the first ask, not with the app. */
export async function modelFor(s: AskSettings): Promise<AskModel> {
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
