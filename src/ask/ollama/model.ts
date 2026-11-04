// The Ollama provider: the ask's AskModel over a local Ollama server's
// /api/chat. The agent loop, the tools, the packets, the transactions and the
// proposals are the ones the Anthropic provider uses; this file only converts
// at the edge:
//
//   request:  system + Messages-API messages + tools  ->  Ollama messages (tool results as role "tool" with
//             tool_name, images in "images"), function tools (schema.ts), think, options.num_ctx, keep_alive
//   answer:   Ollama message (content, thinking, tool_calls)  ->  a Message with text and tool_use blocks, a stop
//             reason and usage. Thinking is dropped (the ask shows no reasoning). Tool calls written into the text
//             (<tool_call>…) are taken out and used; every call is repaired where it safely can be and checked
//             against its tool's schema (repair.ts); what is wrong goes back to the model as that call's error
//             (checkCall), never thrown.
//   readIntent: structured output with "format" (the intent, drawing, photo and profile schemas), checked with
//             zod, asked once more with the problems if it does not fit.
//
// Images (a visual ask, a screenshot, a dropped drawing or photo) need a model with the "vision" capability
// (/api/show). Without it, a screenshot is described as not shown, and reading a drawing or photo is refused
// with a message saying which models can.
//
// The type-only import keeps the Anthropic SDK out of the bundle for this provider.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AskModel, IntentRequest, ModelRequest, ProviderTraits } from "../model";
import { SCHEMAS } from "../schemas";
import { OllamaClient, OllamaError, classifyServerError, fixFor } from "./client";
import { extractTextCalls, parseLoose, repairCall, stripThinking } from "./repair";
import { formatSchema, toOllamaTool } from "./schema";
import type { OllamaChatRequest, OllamaMessage, OllamaShow, OllamaThink } from "./wire";

/** Thinking: off (fastest), on, or a level (low/medium/high: taken as a level by models that have levels, as on by the rest). */
export type ThinkSetting = "off" | "on" | "low" | "medium" | "high";

export interface OllamaOptions {
  model: string;
  /** Context length in tokens (Ollama's num_ctx). */
  numCtx?: number;
  think?: ThinkSetting;
  /** How long Ollama keeps the model loaded after an answer ("10m", "1h", "-1" for always). */
  keepAlive?: string;
  temperature?: number;
  /** No progress for this long ends a turn (ms). */
  idleTimeoutMs?: number;
  /** A whole turn (ms). */
  turnTimeoutMs?: number;
  /** Override the compact prompt and lean tools (on by default below 64k context). */
  compact?: boolean;
}

export const DEFAULT_NUM_CTX = 16384;

export interface ModelInfo {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  /** The model's own maximum context, when the server says. */
  contextLength?: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
}

/** What /api/show says a model can do. Older servers send no capabilities: tools are assumed, vision is not. */
export function modelInfo(show: OllamaShow): ModelInfo {
  const caps = show.capabilities;
  const ctxKey = Object.keys(show.model_info ?? {}).find((k) => k.endsWith(".context_length"));
  const ctx = ctxKey ? Number((show.model_info as Record<string, unknown>)[ctxKey]) : undefined;
  return {
    tools: caps ? caps.includes("tools") : true,
    vision: caps ? caps.includes("vision") : false,
    thinking: caps ? caps.includes("thinking") : false,
    ...(ctx && Number.isFinite(ctx) ? { contextLength: ctx } : {}),
    ...(show.details?.family ? { family: show.details.family } : {}),
    ...(show.details?.parameter_size ? { parameterSize: show.details.parameter_size } : {}),
    ...(show.details?.quantization_level ? { quantization: show.details.quantization_level } : {}),
  };
}

/** The "think" value for a request: off is an explicit false (Qwen models think by default), levels only where the model has them. */
export function thinkValue(setting: ThinkSetting | undefined, info: ModelInfo, model: string): OllamaThink | undefined {
  if (!info.thinking) return undefined;
  const s = setting ?? "off";
  if (s === "off") return false;
  if (s === "on") return true;
  return /gpt-oss/i.test(model) ? s : true;
}

export function noVisionMessage(model: string): string {
  return `The local model ${model} cannot read images (Ollama lists no vision capability for it). Choose a vision model such as qwen3.5:9b or qwen3.5:4b in Settings → Assistant, or switch the provider to Anthropic Claude for drawings and photos.`;
}

/** Rough tokens in a text: JSON and code run about 3 characters a token. */
const tokens = (chars: number) => Math.ceil(chars / 3);

export class OllamaModel implements AskModel {
  readonly provider = "ollama" as const;
  readonly name: string;
  readonly traits: ProviderTraits;
  private info: Promise<ModelInfo> | null = null;
  /** Problems with the calls of the last turns, by tool_use id: checkCall gives each back once. */
  private problems = new Map<string, string>();
  private seq = 0;
  /** Tokens the last turns used, for the log and the tests. */
  readonly usage: { input: number; output: number }[] = [];
  /** What was repaired, per call, for the log and the tests. */
  readonly repairs: { name: string; repairs: string[] }[] = [];

  constructor(
    readonly client: OllamaClient,
    readonly options: OllamaOptions,
  ) {
    this.name = `ollama/${options.model}`;
    const compact = options.compact ?? this.numCtx < 65536;
    this.traits = { compactPrompt: compact, leanTools: compact, repeatLimit: 3 };
  }

  get numCtx(): number {
    return this.options.numCtx && this.options.numCtx > 0 ? this.options.numCtx : DEFAULT_NUM_CTX;
  }

  /** What the model can do (cached). A model that isn't installed fails here, with the pull command. */
  capabilities(signal?: AbortSignal): Promise<ModelInfo> {
    if (!this.info) {
      this.info = this.client.show(this.options.model, signal).then(modelInfo, (e) => {
        this.info = null;
        throw this.explained(e);
      });
    }
    return this.info;
  }

  /** An error with what to do about it (the loop shows it as "The ask failed: …"). */
  private explained(e: unknown): unknown {
    if (!(e instanceof OllamaError) || e.kind === "aborted" || e.message.includes(" Command: ")) return e;
    const fix = fixFor(e.kind, { baseUrl: this.client.baseUrl, origin: this.client.origin, model: this.options.model });
    return new OllamaError(e.kind, `${e.message}. ${fix.text}${fix.command ? ` Command: ${fix.command}` : ""}`, e.status);
  }

  async next(req: ModelRequest, signal?: AbortSignal): Promise<Anthropic.Message> {
    const info = await this.capabilities(signal);
    if (!info.tools)
      throw new OllamaError(
        "no-tools",
        `${this.options.model} cannot call tools (Ollama lists no tools capability for it), and the assistant works through tools. Choose a model with tool support, such as qwen3.5:9b or qwen3.5:4b.`,
      );
    const tools = req.tools.map(toOllamaTool);
    const numPredict = Math.max(1024, Math.min(req.maxTokens ?? 8000, Math.floor(this.numCtx / 4)));
    const toolChars = JSON.stringify(tools).length;
    const messages = fitContext(toOllamaMessages(req.system, req.messages, info.vision, this.options.model), this.numCtx - numPredict - tokens(toolChars));
    const body: OllamaChatRequest = {
      model: this.options.model,
      messages,
      tools,
      options: { num_ctx: this.numCtx, num_predict: numPredict, ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}) },
      ...(this.options.keepAlive ? { keep_alive: this.options.keepAlive } : {}),
    };
    const think = thinkValue(this.options.think, info, this.options.model);
    if (think !== undefined) body.think = think;
    const r = await this.chat(body, signal);

    // The answer: text (reasoning out), and the calls: the API's, else those written into the text.
    const { calls: textCalls, text } = extractTextCalls(stripThinking(r.content));
    const raw = r.toolCalls.length ? r.toolCalls.map((c) => ({ name: c.function.name, arguments: c.function.arguments })) : textCalls;
    const content: (Anthropic.TextBlock | Anthropic.ToolUseBlock)[] = [];
    if (text) content.push({ type: "text", text, citations: null });
    for (const c of raw) {
      const fixed = repairCall(c.name, c.arguments, req.tools);
      const id = `ollama_${++this.seq}`;
      if (fixed.repairs.length) this.repairs.push({ name: fixed.name, repairs: fixed.repairs });
      if (fixed.problem) this.problems.set(id, fixed.problem);
      content.push({ type: "tool_use", id, name: fixed.name, input: fixed.input } as Anthropic.ToolUseBlock);
    }
    this.usage.push({ input: r.promptTokens, output: r.outputTokens });
    const stop: Anthropic.Message["stop_reason"] = r.doneReason === "length" ? "max_tokens" : raw.length ? "tool_use" : "end_turn";
    return {
      id: `ollama_msg_${this.seq}`,
      type: "message",
      role: "assistant",
      model: this.options.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: r.promptTokens, output_tokens: r.outputTokens },
    } as unknown as Anthropic.Message;
  }

  checkCall(use: Anthropic.ToolUseBlock): string | null {
    const p = this.problems.get(use.id);
    if (p === undefined) return null;
    this.problems.delete(use.id);
    return p;
  }

  async readIntent(req: IntentRequest, signal?: AbortSignal): Promise<unknown> {
    const info = await this.capabilities(signal);
    const images = req.content.filter((b) => b.type === "image");
    if (images.length && !info.vision) throw new Error(noVisionMessage(this.options.model));
    const name = req.schema ?? "intent";
    const zodSchema = SCHEMAS[name] as z.ZodType;
    const format = formatSchema(z.toJSONSchema(zodSchema)) as Record<string, unknown>;
    const user: OllamaMessage = {
      role: "user",
      content: `${req.content
        .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
        .map((b) => b.text)
        .join("\n\n")}\n\nAnswer with the JSON object only.`,
      ...(images.length ? { images: images.map(imageData).filter((d): d is string => !!d) } : {}),
    };
    const messages: OllamaMessage[] = [{ role: "system", content: req.system }, user];
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const body: OllamaChatRequest = {
        model: this.options.model,
        messages,
        format,
        // A reading is a form to fill in: no reasoning, no randomness.
        options: { num_ctx: this.numCtx, temperature: 0 },
        ...(info.thinking ? { think: false } : {}),
        ...(this.options.keepAlive ? { keep_alive: this.options.keepAlive } : {}),
      };
      const r = await this.chat(body, signal);
      const text = stripThinking(r.content).replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
      last = parseLoose(text);
      const parsed = zodSchema.safeParse(last);
      if (parsed.success) return parsed.data;
      const issues =
        last === undefined
          ? "it was not JSON"
          : parsed.error.issues
              .slice(0, 6)
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ");
      messages.push(
        { role: "assistant", content: r.content },
        { role: "user", content: `That does not match the schema (${issues}). Answer again with the corrected JSON object only.` },
      );
    }
    if (last === undefined) throw new Error("the local model's reading of the request was not JSON");
    return last;
  }

  /** A chat turn; a model that turns out to have no thinking mode is asked again without it. */
  private async chat(body: OllamaChatRequest, signal?: AbortSignal) {
    const timeouts = { idleMs: this.options.idleTimeoutMs, totalMs: this.options.turnTimeoutMs };
    try {
      try {
        return await this.client.chat(body, signal, timeouts);
      } catch (e) {
        if (e instanceof OllamaError && e.kind === "no-thinking" && body.think !== undefined) {
          const { think: _, ...rest } = body;
          return await this.client.chat(rest, signal, timeouts);
        }
        throw e;
      }
    } catch (e) {
      throw this.explained(e);
    }
  }
}

function imageData(b: Anthropic.ContentBlockParam): string | null {
  if (b.type !== "image") return null;
  const src = b.source as { type: string; data?: string };
  return src.type === "base64" && src.data ? src.data : null;
}

/**
 * The conversation as Ollama messages. Tool results become role "tool" messages naming their tool (in the
 * order of the calls); a screenshot in a result goes after them as a user message with the image (or a note
 * that it isn't shown, without vision).
 */
export function toOllamaMessages(system: string, messages: Anthropic.MessageParam[], vision: boolean, model = "this model"): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  const toolNames = new Map<string, string>();
  const noImage = `(an image is not shown: ${model} has no vision)`;
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const calls = m.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
      for (const c of calls) toolNames.set(c.id, c.name);
      out.push({
        role: "assistant",
        content: text,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: (c.input ?? {}) as Record<string, unknown> } })) } : {}),
      });
      continue;
    }
    const texts: string[] = [];
    const images: string[] = [];
    const later: OllamaMessage[] = [];
    for (const b of m.content) {
      if (b.type === "text") texts.push(b.text);
      else if (b.type === "image") {
        const d = imageData(b);
        if (vision && d) images.push(d);
        else texts.push(noImage);
      } else if (b.type === "tool_result") {
        const parts = typeof b.content === "string" ? [{ type: "text" as const, text: b.content }] : (b.content ?? []);
        const text = parts
          .filter((p): p is Anthropic.TextBlockParam => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        const pics = parts
          .filter((p) => p.type === "image")
          .map((p) => imageData(p as Anthropic.ContentBlockParam))
          .filter((d): d is string => !!d);
        const name = toolNames.get(b.tool_use_id) ?? "tool";
        out.push({ role: "tool", tool_name: name, content: pics.length && !vision ? `${text}\n${noImage}` : text });
        if (pics.length && vision) later.push({ role: "user", content: `The picture from ${name}:`, images: pics });
      }
    }
    out.push(...later);
    if (texts.length || images.length) out.push({ role: "user", content: texts.join("\n\n"), ...(images.length ? { images } : {}) });
  }
  return out;
}

/**
 * Keeps the conversation inside the context: when it would not fit in `budget` tokens, the oldest tool results
 * are cut to their first lines (the latest round is never cut), then older pictures dropped. The system prompt and
 * the first user turn (the packet) are kept whole.
 */
export function fitContext(messages: OllamaMessage[], budget: number): OllamaMessage[] {
  const size = (ms: OllamaMessage[]) =>
    tokens(ms.reduce((n, m) => n + m.content.length + JSON.stringify(m.tool_calls ?? "").length, 0)) +
    ms.reduce((n, m) => n + (m.images?.length ?? 0) * 800, 0);
  if (size(messages) <= budget) return messages;
  const out = messages.map((m) => ({ ...m }));
  // The latest round: everything after the last assistant message.
  const lastAssistant = out.map((m) => m.role).lastIndexOf("assistant");
  for (let i = 2; i < lastAssistant && size(out) > budget; i++) {
    const m = out[i];
    if (m.role === "tool" && m.content.length > 400) m.content = `${m.content.slice(0, 300)}… (trimmed to fit the context: call the tool again if you need it)`;
    if (m.images?.length) {
      delete m.images;
      m.content += " (picture dropped to fit the context)";
    }
  }
  return out;
}

export { classifyServerError, OllamaClient };
