// Ask settings: which model, and how the page reaches it. The API key stays
// in this browser (localStorage) and is sent only to the Anthropic API. With
// `npm run dev` and ANTHROPIC_API_KEY set, the dev server proxies the API and
// adds the key itself, so the page needs none.

import type { AskModel } from "../../ask/model";
import { DEFAULT_MODEL, type Effort } from "../../ask/models";

export interface AskSettings {
  apiKey: string;
  model: string;
  effort: Effort;
}

const KEY = "cocaide.ask.settings.v1";

/** True when the dev server proxies the API with its own key. */
export const HAS_PROXY = import.meta.env.VITE_COCAIDE_ANTHROPIC_PROXY === "1";

export function loadSettings(): AskSettings {
  const defaults: AskSettings = { apiKey: "", model: DEFAULT_MODEL, effort: "low" };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
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
  return HAS_PROXY || s.apiKey.trim() !== "";
}

/** The model client. The SDK is loaded on the first ask, not with the app. */
export async function modelFor(s: AskSettings): Promise<AskModel> {
  const { AnthropicModel, anthropicClient } = await import("../../ask/model");
  const client = anthropicClient(
    s.apiKey.trim() ? { apiKey: s.apiKey.trim(), browser: true } : { baseURL: `${location.origin}/anthropic`, browser: true },
  );
  return new AnthropicModel(client, s.model, s.effort);
}
