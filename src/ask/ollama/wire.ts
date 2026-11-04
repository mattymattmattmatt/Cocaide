// The parts of Ollama's HTTP API the ask uses (https://github.com/ollama/ollama/blob/main/docs/api.md):
// GET /api/version, GET /api/tags, POST /api/show, POST /api/pull (streamed),
// POST /api/chat (streamed), GET /api/ps. Only the fields Cocaide reads or
// writes are typed; the server sends more.

export interface OllamaToolCall {
  /** Newer servers give each call an id; older ones don't. */
  id?: string;
  function: {
    index?: number;
    name: string;
    /** An object on a well-behaved server; small models sometimes produce a JSON string instead. */
    arguments: Record<string, unknown> | string;
  };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Base64 images (no data: prefix), for a vision model. */
  images?: string[];
  tool_calls?: OllamaToolCall[];
  /** A tool message: which tool it answers. */
  tool_name?: string;
  /** The model's reasoning, when thinking is on (never sent back). */
  thinking?: string;
}

/** A JSON-schema property as Ollama's tool definitions take it. */
export interface OllamaSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, OllamaSchema>;
  required?: string[];
  items?: OllamaSchema;
}

export interface OllamaTool {
  type: "function";
  function: { name: string; description: string; parameters: OllamaSchema & { type: "object" } };
}

/** "think": false / true, or a level (the models that take one: gpt-oss). */
export type OllamaThink = boolean | "low" | "medium" | "high";

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  /** "json", or a JSON schema the output must follow (structured outputs). */
  format?: "json" | Record<string, unknown>;
  stream?: boolean;
  think?: OllamaThink;
  keep_alive?: string | number;
  options?: { num_ctx?: number; num_predict?: number; temperature?: number; seed?: number };
}

/** One line of a streamed chat (the last one has done: true and the counts), or the whole non-streamed answer. */
export interface OllamaChatChunk {
  model: string;
  created_at?: string;
  message?: OllamaMessage;
  done: boolean;
  /** "stop", "length" (hit num_predict or the context), "load", "unload". */
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export interface OllamaModelEntry {
  name: string;
  model: string;
  modified_at?: string;
  size: number;
  digest?: string;
  details?: { family?: string; families?: string[] | null; parameter_size?: string; quantization_level?: string; format?: string };
}

export interface OllamaTags {
  models: OllamaModelEntry[];
}

export interface OllamaShow {
  details?: OllamaModelEntry["details"];
  /** "<arch>.context_length" among them. */
  model_info?: Record<string, unknown>;
  /** "completion", "tools", "insert", "vision", "embedding", "thinking". Older servers leave it out. */
  capabilities?: string[];
  parameters?: string;
  template?: string;
}

/** One line of a streamed pull. */
export interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

export interface OllamaRunning {
  models: { name: string; model: string; size: number; size_vram: number; expires_at?: string; context_length?: number }[];
}
