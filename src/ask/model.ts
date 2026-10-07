// The language model behind the right-click ask. Production uses the
// Anthropic SDK; tests use a scripted model that answers with fixed turns.

import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, MODELS, type Effort } from "./models";

export { DEFAULT_MODEL, MODELS, type Effort };

export interface ModelRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export interface AskModel {
  readonly name: string;
  next(req: ModelRequest, signal?: AbortSignal): Promise<Anthropic.Message>;
}

export interface ClientSettings {
  /** The user's key. In the browser it is sent to the API from the page. */
  apiKey?: string;
  /** A proxy that adds the key itself (the dev server's /anthropic). */
  baseURL?: string;
  /** Running in a browser page. */
  browser?: boolean;
}

export function anthropicClient(s: ClientSettings): Anthropic {
  return new Anthropic({
    apiKey: s.apiKey || (s.baseURL ? "set-by-proxy" : undefined),
    ...(s.baseURL ? { baseURL: s.baseURL } : {}),
    ...(s.browser ? { dangerouslyAllowBrowser: true } : {}),
    maxRetries: 1,
  });
}

export class AnthropicModel implements AskModel {
  constructor(
    private readonly client: Anthropic,
    readonly name: string = DEFAULT_MODEL,
    private readonly effort: Effort = "low",
  ) {}

  next(req: ModelRequest, signal?: AbortSignal): Promise<Anthropic.Message> {
    const effort = MODELS.find((m) => m.id === this.name)?.effort ?? false;
    return this.client.messages.create(
      {
        model: this.name,
        max_tokens: 8000,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        // The system prompt and tools are the same on every ask: cache them.
        cache_control: { type: "ephemeral" },
        ...(effort ? { output_config: { effort: this.effort } } : {}),
      },
      { signal },
    );
  }
}

// ------------------------------------------------------------------ tests

type Block = Anthropic.TextBlock | Anthropic.ToolUseBlock;
export type ScriptStep = (req: ModelRequest) => Block[];

export const say = (text: string): Anthropic.TextBlock => ({ type: "text", text, citations: null });
let callCount = 0;
export const use = (name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock =>
  ({ type: "tool_use", id: `toolu_${++callCount}`, name, input }) as Anthropic.ToolUseBlock;

/** Answers each request with the next scripted turn, and records what it was sent. */
export class ScriptedModel implements AskModel {
  readonly name = "scripted";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly steps: ScriptStep[]) {}

  async next(req: ModelRequest): Promise<Anthropic.Message> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error("the script has no more turns");
    const content = step(req);
    return {
      id: `msg_${this.requests.length}`,
      type: "message",
      role: "assistant",
      model: this.name,
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as Anthropic.Message;
  }
}
