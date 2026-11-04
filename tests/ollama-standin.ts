// A SCRIPTED STAND-IN for an Ollama server, for tests. It is not Ollama and
// runs no model: it answers each /api/chat with the next scripted reply. What
// it does reproduce is the wire format, so the provider is tested against the
// same bytes a real server sends:
//
//   GET  /api/version  -> { "version": "..." }
//   GET  /api/tags     -> { "models": [{ name, model, size, digest, details: { family, parameter_size, quantization_level } }] }
//   POST /api/show     -> { details, model_info: { "<arch>.context_length": n }, capabilities: ["completion", "tools", ...] }
//                         404 { "error": "model \"x\" not found" } for a model it doesn't have
//   POST /api/pull     -> NDJSON lines: pulling manifest, pulling <digest> with total/completed, verifying, writing
//                         manifest, success (or { "error": ... })
//   POST /api/chat     -> NDJSON chunks { model, created_at, message: { role, content, thinking?, tool_calls? }, done:false }
//                         then { ..., done: true, done_reason, prompt_eval_count, eval_count, durations }
//                         400 "... does not support tools" / "\"x\" does not support thinking" as the real server refuses
//
// It also stands in for the browser's view of the network: `reachable: false` makes fetch fail as a refused
// connection does (TypeError), and `allowOrigin: false` makes a CORS-mode fetch fail the same way while a no-cors
// probe gets through (an opaque response), which is how a page sees Ollama refusing its origin.
//
// Each request it gets is checked against the format (roles, tool messages naming their tool, tools as functions)
// and recorded, so tests can look at exactly what the provider sent.

import type { OllamaChatRequest, OllamaMessage, OllamaToolCall } from "../src/ask/ollama/wire";

export interface StandInModel {
  name: string;
  size?: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  capabilities?: string[];
  contextLength?: number;
}

/** One scripted assistant reply: what the "model" says. arguments may be a string, as small models produce. */
export interface StandInReply {
  content?: string;
  thinking?: string;
  tool_calls?: { name: string; arguments: Record<string, unknown> | string }[];
  done_reason?: string;
  /** Wait this long (ms) before the first chunk, honouring the request's abort. */
  delayMs?: number;
}

export type StandInStep = StandInReply | ((req: OllamaChatRequest, n: number) => StandInReply);

export interface StandInOptions {
  models?: StandInModel[];
  version?: string;
  reachable?: boolean;
  allowOrigin?: boolean;
}

export const QWEN: StandInModel = {
  name: "qwen3.5:9b",
  size: 6_600_000_000,
  family: "qwen35",
  parameterSize: "9.7B",
  quantization: "Q4_K_M",
  capabilities: ["completion", "vision", "tools", "thinking"],
  contextLength: 262144,
};

export class OllamaStandIn {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  readonly chats: OllamaChatRequest[] = [];
  private steps: StandInStep[] = [];
  models: StandInModel[];
  reachable: boolean;
  allowOrigin: boolean;
  readonly version: string;
  private n = 0;

  constructor(opts: StandInOptions = {}) {
    this.models = opts.models ?? [QWEN];
    this.reachable = opts.reachable ?? true;
    this.allowOrigin = opts.allowOrigin ?? true;
    this.version = opts.version ?? "0.12.9-standin";
  }

  /** Queue the next replies to /api/chat. */
  script(...steps: StandInStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.steps.length;
  }

  /** The fetch the client is given. */
  readonly fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!this.reachable) throw new TypeError("fetch failed");
    if (init.mode === "no-cors") return new Response(null, { status: 200 });
    if (!this.allowOrigin) throw new TypeError("Failed to fetch");
    if (init.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname, body });
    switch (`${method} ${url.pathname}`) {
      case "GET /api/version":
        return json({ version: this.version });
      case "GET /api/tags":
        return json({ models: this.models.map(tagEntry) });
      case "GET /api/ps":
        return json({ models: [] });
      case "POST /api/show": {
        const m = this.find(body?.model);
        if (!m) return json({ error: `model "${body?.model}" not found` }, 404);
        return json({
          details: tagEntry(m).details,
          model_info: { "general.architecture": m.family, [`${m.family}.context_length`]: m.contextLength ?? 32768 },
          capabilities: m.capabilities ?? ["completion"],
          template: "{{ .Messages }}",
        });
      }
      case "POST /api/pull":
        return this.pull(String(body?.model ?? body?.name ?? ""));
      case "POST /api/chat":
        return this.chat(body as OllamaChatRequest, init.signal ?? undefined);
      default:
        return new Response("404 page not found", { status: 404 });
    }
  }) as typeof fetch;

  private find(name: string): StandInModel | undefined {
    return this.models.find((m) => m.name === name || m.name === `${name}:latest`);
  }

  private pull(name: string): Response {
    if (!/^[a-z0-9._-]+(:[a-z0-9._-]+)?$/i.test(name) || name.startsWith("nope")) {
      return ndjson([{ status: "pulling manifest" }, { error: "pull model manifest: file does not exist" }]);
    }
    const total = 6_600_000_000;
    const lines = [
      { status: "pulling manifest" },
      { status: "pulling 3e4cb1417446", digest: "sha256:3e4cb1417446", total, completed: 0 },
      { status: "pulling 3e4cb1417446", digest: "sha256:3e4cb1417446", total, completed: total / 2 },
      { status: "pulling 3e4cb1417446", digest: "sha256:3e4cb1417446", total, completed: total },
      { status: "verifying sha256 digest" },
      { status: "writing manifest" },
      { status: "success" },
    ];
    if (!this.find(name)) this.models.push({ ...QWEN, name });
    return ndjson(lines);
  }

  private async chat(req: OllamaChatRequest, signal?: AbortSignal): Promise<Response> {
    const problem = checkChat(req);
    if (problem) return json({ error: problem }, 400);
    const m = this.find(req.model);
    if (!m) return json({ error: `model "${req.model}" not found, try pulling it first` }, 404);
    const caps = m.capabilities ?? ["completion"];
    if (req.tools?.length && !caps.includes("tools")) return json({ error: `registry.ollama.ai/library/${req.model} does not support tools` }, 400);
    if (req.think !== undefined && req.think !== false && !caps.includes("thinking")) return json({ error: `"${req.model}" does not support thinking` }, 400);
    this.chats.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) return json({ error: "the stand-in has no more scripted replies" }, 500);
    const reply = typeof step === "function" ? step(req, this.n++) : (this.n++, step);
    if (reply.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, reply.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    }
    const created_at = new Date().toISOString();
    const chunks: unknown[] = [];
    if (reply.thinking) chunks.push({ model: req.model, created_at, message: { role: "assistant", content: "", thinking: reply.thinking }, done: false });
    // Text streams in pieces, as the real server sends tokens.
    const text = reply.content ?? "";
    for (let i = 0; i < text.length; i += 24)
      chunks.push({ model: req.model, created_at, message: { role: "assistant", content: text.slice(i, i + 24) }, done: false });
    if (reply.tool_calls?.length) {
      const calls: OllamaToolCall[] = reply.tool_calls.map((c, index) => ({
        id: `call_${this.n}_${index}`,
        function: { index, name: c.name, arguments: c.arguments },
      }));
      chunks.push({ model: req.model, created_at, message: { role: "assistant", content: "", tool_calls: calls }, done: false });
    }
    const promptChars = JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length;
    chunks.push({
      model: req.model,
      created_at,
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: reply.done_reason ?? "stop",
      total_duration: 1_000_000,
      load_duration: 1000,
      prompt_eval_count: Math.ceil(promptChars / 4),
      prompt_eval_duration: 1000,
      eval_count: Math.ceil((text.length + JSON.stringify(reply.tool_calls ?? []).length) / 4),
      eval_duration: 1000,
    });
    return ndjson(chunks);
  }
}

/** What the real server would refuse in a chat request's shape. */
function checkChat(req: OllamaChatRequest): string | null {
  if (!req || typeof req.model !== "string" || !req.model) return "model is required";
  if (!Array.isArray(req.messages)) return "messages must be an array";
  for (const [i, m] of req.messages.entries()) {
    const msg = m as OllamaMessage;
    if (!["system", "user", "assistant", "tool"].includes(msg.role)) return `messages[${i}]: invalid role "${msg.role}"`;
    if (typeof msg.content !== "string") return `messages[${i}]: content must be a string`;
    if (msg.images && !msg.images.every((x) => typeof x === "string" && !x.startsWith("data:"))) return `messages[${i}]: images must be base64 strings`;
    if (msg.role === "tool" && !msg.tool_name) return `messages[${i}]: a tool message names its tool (tool_name)`;
    for (const c of msg.tool_calls ?? [])
      if (typeof c.function?.name !== "string" || typeof c.function.arguments !== "object")
        return `messages[${i}]: tool_calls need function.name and object arguments`;
  }
  for (const t of req.tools ?? []) {
    if (t.type !== "function" || !t.function?.name || t.function.parameters?.type !== "object") return `invalid tool ${JSON.stringify(t).slice(0, 80)}`;
  }
  return null;
}

function tagEntry(m: StandInModel) {
  return {
    name: m.name,
    model: m.name,
    modified_at: "2026-11-01T10:00:00Z",
    size: m.size ?? 1_000_000_000,
    digest: "3e4cb14174460404e7a233e531675303b2fbf7749c02f91864fe311ab6344e4f",
    details: {
      parent_model: "",
      format: "gguf",
      family: m.family ?? "qwen3",
      families: [m.family ?? "qwen3"],
      parameter_size: m.parameterSize ?? "8B",
      quantization_level: m.quantization ?? "Q4_K_M",
    },
  };
}

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function ndjson(lines: unknown[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

/** The packet a chat request carries (the first user message's JSON). */
export function packetOf(req: OllamaChatRequest): Record<string, unknown> {
  const t = req.messages.find((m) => m.role === "user")!.content;
  // The packet is JSON indented by one space: its closing brace is the first one at the start of a line.
  return JSON.parse(t.slice(t.indexOf("{"), t.indexOf("\n}") + 2));
}

/** The tool results a chat request carries since the last assistant turn, parsed. */
export function lastResults(req: OllamaChatRequest): { tool: string; result: Record<string, unknown> }[] {
  const out: { tool: string; result: Record<string, unknown> }[] = [];
  for (let i = req.messages.length - 1; i >= 0 && req.messages[i].role !== "assistant"; i--) {
    const m = req.messages[i];
    if (m.role === "tool") out.unshift({ tool: m.tool_name!, result: JSON.parse(m.content.split("\n(")[0]) });
  }
  return out;
}
