// Tool calls from small local models, made usable or refused with a reason.
//
// What gets repaired (each is common with 4-9B models):
// - arguments as a JSON string instead of an object, or with text after it;
// - a nested object or array argument given as a JSON string ("patch": "{\"diameter\": 8}");
// - a number or a boolean given as a string where the schema takes only that type ("index": "2");
// - the arguments wrapped in {"arguments": ...} / {"parameters": ...} / {"input": ...};
// - the tool name in the wrong case, snake_case, or with a "functions." prefix;
// - tool calls written into the text as <tool_call>{"name": ..., "arguments": ...}</tool_call> (Qwen/Hermes style),
//   or as a fenced JSON block holding only such a call, instead of the API's tool_calls.
// What is refused: a name that matches no tool, arguments that are not JSON even after the repairs, and arguments
// that still do not fit the tool's schema. The model gets the exact reason back as the call's error.

import { typesOf, validateArgs } from "./schema";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

interface ToolLike {
  name: string;
  input_schema: unknown;
}

export interface RepairedCall {
  name: string;
  input: Json;
  /** Why the call cannot run, for the model; null when it can. */
  problem: string | null;
  /** What was repaired, for the log. */
  repairs: string[];
}

/** Text with the model's reasoning taken out: <think>…</think> blocks (an unclosed one runs to the end). */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, "")
    .replace(/^[\s\S]*?<\/think>/, "")
    .trim();
}

/** Tool calls written into the text instead of the API's tool_calls, and the text without them. */
export function extractTextCalls(text: string): { calls: { name: string; arguments: unknown }[]; text: string } {
  const calls: { name: string; arguments: unknown }[] = [];
  let rest = text.replace(/<tool_call>\s*([\s\S]*?)\s*(<\/tool_call>|$)/g, (_, body: string) => {
    const v = parseLoose(body);
    if (isObj(v) && typeof v.name === "string") calls.push({ name: v.name, arguments: v.arguments ?? v.parameters ?? v.input ?? {} });
    return "";
  });
  if (!calls.length) {
    // A reply that is only a call, bare or in a ```json fence.
    const bare = rest.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
    const v = bare.startsWith("{") ? parseLoose(bare) : undefined;
    if (isObj(v) && typeof v.name === "string" && ("arguments" in v || "parameters" in v) && Object.keys(v).length <= 3) {
      calls.push({ name: v.name, arguments: v.arguments ?? v.parameters });
      rest = "";
    }
  }
  return { calls, text: rest.trim() };
}

/** JSON, or the first complete JSON value in the text (text before or after it ignored); undefined if none. */
export function parseLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // look for the first balanced value
  }
  const start = t.search(/[{[]/);
  if (start < 0) return undefined;
  const end = balancedEnd(t, start);
  if (end < 0) return undefined;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function balancedEnd(t: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The tool a name means: exact, then by case, prefix and separators ("functions.update_feature" is updateFeature). */
export function matchTool<T extends ToolLike>(name: string, tools: T[]): T | null {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  const bare = name.replace(/^(functions?|tools?)[.:]/i, "");
  const key = squash(bare);
  return tools.find((t) => squash(t.name) === key) ?? null;
}

/** One call made usable against the tools offered, or refused with the reason. */
export function repairCall(name: string, rawArgs: unknown, tools: ToolLike[]): RepairedCall {
  const repairs: string[] = [];
  const tool = matchTool(name, tools);
  if (!tool) {
    return { name, input: {}, repairs, problem: `unknown tool "${name}". The tools you can call: ${tools.map((t) => t.name).join(", ")}.` };
  }
  if (tool.name !== name) repairs.push(`name "${name}" → "${tool.name}"`);
  let args: unknown = rawArgs ?? {};
  if (typeof args === "string") {
    const parsed = args.trim() === "" ? {} : parseLoose(args);
    if (parsed === undefined)
      return {
        name: tool.name,
        input: {},
        repairs,
        problem: `the arguments of ${tool.name} are not valid JSON: ${JSON.stringify(args.slice(0, 120))}. Send them as a JSON object.`,
      };
    repairs.push("arguments parsed from a string");
    args = parsed;
  }
  if (!isObj(args))
    return {
      name: tool.name,
      input: {},
      repairs,
      problem: `the arguments of ${tool.name} must be a JSON object, got ${Array.isArray(args) ? "an array" : typeof args}`,
    };
  const schema = isObj(tool.input_schema) ? tool.input_schema : {};
  const props = isObj(schema.properties) ? schema.properties : {};
  // {"arguments": {...}} around the real ones.
  const keys = Object.keys(args);
  if (
    keys.length === 1 &&
    ["arguments", "parameters", "input", "args"].includes(keys[0]) &&
    !(keys[0] in props) &&
    (isObj(args[keys[0]]) || typeof args[keys[0]] === "string")
  ) {
    const inner = typeof args[keys[0]] === "string" ? parseLoose(args[keys[0]] as string) : args[keys[0]];
    if (isObj(inner)) {
      repairs.push(`unwrapped "${keys[0]}"`);
      args = inner;
    }
  }
  const input = coerce(schema, args, repairs, "") as Json;
  const problem = validateArgs(schema, input);
  return { name: tool.name, input, repairs, problem: problem ? `${tool.name}: ${problem}. Fix the arguments and call it again.` : null };
}

/** Values the schema says are objects, arrays, numbers or booleans, given as strings, turned into what they say. */
function coerce(schema: unknown, v: unknown, repairs: string[], path: string): unknown {
  if (!isObj(schema)) return v;
  const types = typesOf(schema);
  if (typeof v === "string" && !types.includes("string") && types.length) {
    const t = v.trim();
    if ((types.includes("object") || types.includes("array")) && /^[{[]/.test(t)) {
      const parsed = parseLoose(t);
      if (parsed !== undefined && ((isObj(parsed) && types.includes("object")) || (Array.isArray(parsed) && types.includes("array")))) {
        repairs.push(`${path || "value"} parsed from a string`);
        return coerce(schema, parsed, repairs, path);
      }
    }
    if ((types.includes("number") || types.includes("integer")) && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) {
      const n = Number(t);
      if (types.includes("number") || Number.isInteger(n)) {
        repairs.push(`${path || "value"} "${t}" → ${n}`);
        return n;
      }
    }
    if (types.includes("boolean") && /^(true|false)$/i.test(t)) {
      repairs.push(`${path || "value"} "${t}" → ${t.toLowerCase()}`);
      return t.toLowerCase() === "true";
    }
    if (types.includes("null") && t === "null") return null;
    return v;
  }
  if (isObj(v) && isObj(schema.properties)) {
    const out: Json = { ...v };
    for (const [k, sub] of Object.entries(schema.properties)) if (k in out) out[k] = coerce(sub, out[k], repairs, path ? `${path}.${k}` : k);
    return out;
  }
  if (Array.isArray(v) && isObj(schema.items)) return v.map((x, i) => coerce(schema.items, x, repairs, `${path}[${i}]`));
  return v;
}
