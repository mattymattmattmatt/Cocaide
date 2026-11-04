// A small client for a local Ollama server, over fetch. The browser page
// calls it directly: http://localhost is a potentially trustworthy origin, so
// the hosted (https) site may call it, and Chrome may first ask the user to
// allow access to the local network. Ollama itself only answers pages whose
// origin OLLAMA_ORIGINS allows (localhost pages are allowed by default; the
// hosted site has to be added). Failures are classified so the settings can
// show the exact fix.
//
// fetch is injectable: the tests drive this client against a scripted
// stand-in that speaks the same wire format (tests/ollama-standin.ts).

import type { OllamaChatChunk, OllamaChatRequest, OllamaMessage, OllamaPullProgress, OllamaRunning, OllamaShow, OllamaTags, OllamaToolCall } from "./wire";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
/** Where the hosted app lives: the origin OLLAMA_ORIGINS has to allow for it. */
export const HOSTED_ORIGIN = "https://mattymattmattmatt.github.io";
/** The value of OLLAMA_ORIGINS the guidance gives: the hosted site, and any local dev or preview server. */
export const ORIGINS_VALUE = `${HOSTED_ORIGIN},http://localhost:*`;
export const WINDOWS_ORIGINS_COMMAND = `setx OLLAMA_ORIGINS "${ORIGINS_VALUE}"`;

export type OllamaProblemKind =
  /** Nothing answers at the base URL (Ollama not running, wrong URL, or local network access blocked). */
  | "unreachable"
  /** Ollama answers, but not to this page's origin. */
  | "origin"
  | "model-missing"
  | "no-tools"
  | "no-thinking"
  | "memory"
  | "timeout"
  | "aborted"
  | "http";

export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaProblemKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

/** What to tell the user for a problem: one or two sentences and, where there is one, the command that fixes it. */
export function fixFor(kind: OllamaProblemKind, ctx: { baseUrl: string; origin?: string; model?: string }): { text: string; command?: string } {
  switch (kind) {
    case "unreachable":
      return {
        text: `Nothing answers at ${ctx.baseUrl}. Start Ollama (on Windows from the Start menu: its icon appears in the tray; elsewhere \`ollama serve\`) and check the address. If the browser asked whether this site may access devices on your local network, allow it (site settings, Local network access). If Ollama is running and this still fails from the hosted site, it is probably refusing the site's origin: set OLLAMA_ORIGINS as below and restart Ollama.`,
        command: WINDOWS_ORIGINS_COMMAND,
      };
    case "origin":
      return {
        text: `Ollama is running but refuses requests from this page (${ctx.origin ?? "this origin"}). Allow it with OLLAMA_ORIGINS: on Windows run this in a terminal, then quit Ollama from its tray icon and start it again. macOS: launchctl setenv OLLAMA_ORIGINS "${ORIGINS_VALUE}" and restart the app; Linux: add Environment="OLLAMA_ORIGINS=${ORIGINS_VALUE}" with systemctl edit ollama.service, then restart it.`,
        command: WINDOWS_ORIGINS_COMMAND,
      };
    case "model-missing":
      return {
        text: `The model ${ctx.model ?? ""} is not installed in Ollama. Pull it here (Pull a model) or in a terminal:`,
        command: `ollama pull ${ctx.model ?? "<model>"}`,
      };
    case "no-tools":
      return {
        text: `${ctx.model ?? "This model"} cannot call tools, and the assistant works through tools. Choose a model with tool support, such as qwen3.5:9b or qwen3.5:4b.`,
      };
    case "no-thinking":
      return { text: `${ctx.model ?? "This model"} has no thinking mode; set Thinking to Off.` };
    case "memory":
      return {
        text: "Ollama ran out of memory loading the model. Lower the context length (8192 or 16384), close other GPU programs, or pick a smaller model. `ollama ps` shows how much of the model is on the GPU.",
      };
    case "timeout":
      return {
        text: "The model took too long to answer. A model that does not fit in video memory runs partly on the CPU and is much slower: lower the context length, pick a smaller model, or check `ollama ps` (the PROCESSOR column should say 100% GPU).",
      };
    case "aborted":
      return { text: "Cancelled." };
    default:
      return { text: "Ollama answered with an error." };
  }
}

export interface ClientOptions {
  /** fetch to use (the stand-in in tests). Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** The page's origin, for the messages (location.origin in the browser). */
  origin?: string;
}

export interface ChatTimeouts {
  /** No byte from the server for this long ends the turn (ms). The first token can take a while: loading, a long prompt. */
  idleMs?: number;
  /** The whole turn (ms). */
  totalMs?: number;
}

/** A streamed chat, put back together: the text, the reasoning, the tool calls, and the last line's counts. */
export interface ChatResult {
  content: string;
  thinking: string;
  toolCalls: OllamaToolCall[];
  doneReason: string;
  promptTokens: number;
  outputTokens: number;
}

export interface Connection {
  ok: boolean;
  version?: string;
  problem?: OllamaProblemKind;
  message?: string;
}

export class OllamaClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  readonly origin?: string;

  constructor(baseUrl: string = DEFAULT_OLLAMA_URL, opts: ClientOptions = {}) {
    this.baseUrl = (baseUrl.trim() || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.origin = opts.origin;
  }

  /** Is Ollama there, and does it answer this page? Tells "not running" from "refuses this origin" with an opaque probe. */
  async connect(signal?: AbortSignal): Promise<Connection> {
    try {
      const r = await this.json<{ version: string }>("GET", "/api/version", undefined, signal);
      return { ok: true, version: r.version };
    } catch (e) {
      const err = asOllamaError(e, this.baseUrl);
      if (err.kind === "unreachable" && !signal?.aborted) {
        // A no-cors request is not subject to the origin check: if it gets through, Ollama is up and refuses the origin.
        try {
          await this.fetchFn(`${this.baseUrl}/api/version`, { mode: "no-cors", signal });
          return { ok: false, problem: "origin", message: `Ollama is running at ${this.baseUrl} but refuses this page's origin.` };
        } catch {
          // nothing there at all
        }
      }
      return { ok: false, problem: err.kind, message: err.message };
    }
  }

  tags(signal?: AbortSignal): Promise<OllamaTags> {
    return this.json<OllamaTags>("GET", "/api/tags", undefined, signal);
  }

  show(model: string, signal?: AbortSignal): Promise<OllamaShow> {
    return this.json<OllamaShow>("POST", "/api/show", { model }, signal, model);
  }

  running(signal?: AbortSignal): Promise<OllamaRunning> {
    return this.json<OllamaRunning>("GET", "/api/ps", undefined, signal);
  }

  /** Downloads a model, reporting each progress line. Resolves on "success"; throws the server's error otherwise. */
  async pull(model: string, onProgress?: (p: OllamaPullProgress) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.request("POST", "/api/pull", { model, stream: true }, signal, model);
    let last = "";
    await readLines(res, signal, undefined, (line) => {
      const p = JSON.parse(line) as OllamaPullProgress;
      if (p.error) throw classifyServerError(p.error, 500, model);
      last = p.status;
      onProgress?.(p);
    });
    if (last !== "success") throw new OllamaError("http", `the pull of ${model} ended without success (${last || "no status"})`);
  }

  /** One chat turn, streamed and put back together. */
  async chat(body: OllamaChatRequest, signal?: AbortSignal, timeouts: ChatTimeouts = {}, onChunk?: (c: OllamaChatChunk) => void): Promise<ChatResult> {
    const idle = timeouts.idleMs ?? 180_000;
    const total = timeouts.totalMs ?? 15 * 60_000;
    // One controller for the user's cancel and the timeouts.
    const ctl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) ctl.abort();
    const totalTimer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, total);
    const out: ChatResult = { content: "", thinking: "", toolCalls: [], doneReason: "", promptTokens: 0, outputTokens: 0 };
    const stalled = () => {
      timedOut = true;
      ctl.abort();
    };
    try {
      const res = await this.request("POST", "/api/chat", { ...body, stream: true }, ctl.signal, body.model, idle, stalled);
      const handle = (c: OllamaChatChunk) => {
        if (c.error) throw classifyServerError(c.error, 500, body.model);
        onChunk?.(c);
        const m = c.message;
        if (m?.content) out.content += m.content;
        if (m?.thinking) out.thinking += m.thinking;
        if (m?.tool_calls?.length) out.toolCalls.push(...m.tool_calls);
        if (c.done) {
          out.doneReason = c.done_reason ?? "stop";
          out.promptTokens = c.prompt_eval_count ?? 0;
          out.outputTokens = c.eval_count ?? 0;
        }
      };
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("application/json") && !type.includes("ndjson")) handle((await res.json()) as OllamaChatChunk);
      else await readLines(res, ctl.signal, idle, (line) => handle(JSON.parse(line) as OllamaChatChunk), stalled);
      return out;
    } catch (e) {
      if (timedOut)
        throw new OllamaError(
          "timeout",
          `the model did not answer in time (no progress for ${Math.round(idle / 1000)} s, or longer than ${Math.round(total / 1000)} s in all)`,
        );
      if (signal?.aborted) throw new OllamaError("aborted", "cancelled");
      throw asOllamaError(e, this.baseUrl, body.model);
    } finally {
      clearTimeout(totalTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async json<T>(method: string, path: string, body: unknown, signal?: AbortSignal, model?: string): Promise<T> {
    const res = await this.request(method, path, body, signal, model);
    return (await res.json()) as T;
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    model?: string,
    idleMs?: number,
    onTimeout?: () => void,
  ): Promise<Response> {
    let res: Response;
    // Until the headers come back (the model loading, the prompt being read) the idle timer runs too.
    const ctl = new AbortController();
    const relay = () => ctl.abort();
    signal?.addEventListener("abort", relay);
    if (signal?.aborted) ctl.abort();
    const timer = idleMs
      ? setTimeout(() => {
          onTimeout?.();
          ctl.abort();
        }, idleMs)
      : null;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        signal: ctl.signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new OllamaError("aborted", "cancelled");
      throw asOllamaError(e, this.baseUrl, model);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    }
    if (!res.ok) {
      let text = "";
      try {
        const j = (await res.json()) as { error?: string };
        text = j.error ?? "";
      } catch {
        // not JSON
      }
      // A server-side origin check refuses with 403 (a request from Node, or a proxy that kept the Origin header).
      if (res.status === 403)
        throw new OllamaError("origin", `Ollama refused the request (403${text ? `: ${text}` : ""}); its OLLAMA_ORIGINS does not allow this origin`, 403);
      throw classifyServerError(text || `HTTP ${res.status}`, res.status, model);
    }
    return res;
  }
}

/** The server's error text as a problem kind, with a message that says what to do. */
export function classifyServerError(text: string, status: number, model?: string): OllamaError {
  const t = text.toLowerCase();
  if (status === 404 || /not found|try pulling it first|file does not exist/.test(t))
    return new OllamaError(
      "model-missing",
      `model ${model ? `"${model}" ` : ""}not found in Ollama: pull it first (ollama pull ${model ?? "<model>"}). Server said: ${text}`,
      status,
    );
  if (/does not support tools/.test(t)) return new OllamaError("no-tools", `${model ?? "the model"} does not support tools (server said: ${text})`, status);
  if (/does not support thinking/.test(t))
    return new OllamaError("no-thinking", `${model ?? "the model"} does not support thinking (server said: ${text})`, status);
  if (/out of memory|cuda error|insufficient memory|requires more system memory|cudamalloc|failed to allocate/.test(t))
    return new OllamaError("memory", `Ollama ran out of memory for ${model ?? "the model"}: ${text}`, status);
  return new OllamaError("http", `Ollama error (${status}): ${text}`, status);
}

function asOllamaError(e: unknown, baseUrl: string, model?: string): OllamaError {
  if (e instanceof OllamaError) return e;
  const err = e as Error;
  if (err?.name === "AbortError") return new OllamaError("aborted", "cancelled");
  // fetch's network failure (refused, DNS, CORS, blocked) is a TypeError with no detail, by design.
  if (err instanceof TypeError || /fetch failed|failed to fetch|networkerror|econnrefused|load failed/i.test(String(err?.message)))
    return new OllamaError("unreachable", `could not reach Ollama at ${baseUrl} (${err.message})`);
  return new OllamaError("http", `Ollama request failed${model ? ` (${model})` : ""}: ${err?.message ?? String(e)}`);
}

/** Reads a newline-delimited JSON body line by line; an idle timeout aborts a stalled stream. */
async function readLines(
  res: Response,
  signal: AbortSignal | undefined,
  idleMs: number | undefined,
  onLine: (line: string) => void,
  onTimeout?: () => void,
): Promise<void> {
  if (!res.body) {
    for (const line of (await res.text()).split("\n")) if (line.trim()) onLine(line);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { done, value } = idleMs ? await withIdle(reader.read(), idleMs, signal, onTimeout) : await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) onLine(buf.trim());
  } finally {
    reader.releaseLock?.();
  }
}

function withIdle<T>(p: Promise<T>, ms: number, signal?: AbortSignal, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.();
      reject(new DOMException("idle timeout", "AbortError"));
    }, ms);
    const abort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal?.removeEventListener("abort", abort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        signal?.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}

export type { OllamaMessage };
