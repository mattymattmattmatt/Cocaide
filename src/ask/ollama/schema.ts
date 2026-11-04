// JSON schemas between the ask's tools and Ollama.
//
// toOllamaTool: an Anthropic tool (name, description, input_schema) as an
// Ollama function definition. Ollama renders tool definitions into the
// model's chat template; its Go types take one "type" per property and no
// anyOf/oneOf/additionalProperties, so unions become one type with the others
// named in the description, and unsupported keywords are dropped. Enums,
// required, items and nested properties are kept.
//
// formatSchema: a structured-output schema for Ollama's "format" (turned into
// a llama.cpp grammar). It keeps type unions, anyOf, enums, required and
// additionalProperties: false, and drops the keywords the grammar converter
// does not take (bounds, patterns, formats, $schema).
//
// validateArgs: checks a call's arguments against the tool's original schema
// and says exactly what is wrong, so a small model gets a precise error back
// instead of a call that fails somewhere deeper.

import type { OllamaSchema, OllamaTool } from "./wire";

type Json = Record<string, unknown>;

interface ToolLike {
  name: string;
  description?: string;
  input_schema: unknown;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** The types a schema allows: its "type" (one or several) and those of its anyOf/oneOf branches. */
export function typesOf(s: unknown): string[] {
  if (!isObj(s)) return [];
  const own = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === "string" ? [s.type] : [];
  const branches = [...(Array.isArray(s.anyOf) ? s.anyOf : []), ...(Array.isArray(s.oneOf) ? s.oneOf : [])].flatMap(typesOf);
  return [...new Set([...own, ...branches])];
}

export function toOllamaTool(t: ToolLike): OllamaTool {
  const p = toolSchema(t.input_schema);
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: { ...p, type: "object", properties: p.properties ?? {}, required: p.required ?? [] },
    },
  };
}

function toolSchema(s: unknown): OllamaSchema {
  if (!isObj(s)) return {};
  const out: OllamaSchema = {};
  const types = typesOf(s);
  const nonNull = types.filter((t) => t !== "null");
  if (nonNull.length)
    out.type = nonNull.includes("object") && nonNull.length > 1 && !nonNull.includes("array") ? nonNull.find((t) => t !== "object")! : nonNull[0];
  const notes: string[] = [];
  if (nonNull.length > 1) notes.push(`${nonNull.join(" or ")}`);
  if (types.includes("null")) notes.push("or null");
  const desc = typeof s.description === "string" ? s.description : "";
  const typeNote = notes.length ? `(${notes.join(", ")})` : "";
  if (desc || typeNote) out.description = [typeNote, desc].filter(Boolean).join(" ");
  if (Array.isArray(s.enum)) out.enum = s.enum.filter((v) => v !== null);
  if (isObj(s.properties)) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toolSchema(v)]));
    if (Array.isArray(s.required)) out.required = s.required as string[];
  }
  const items = s.items ?? (Array.isArray(s.anyOf) ? (s.anyOf as Json[]).find((b) => isObj(b) && b.type === "array")?.items : undefined);
  if (isObj(items) && (out.type === "array" || nonNull.includes("array"))) out.items = toolSchema(items);
  return out;
}

const FORMAT_KEEP = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "anyOf",
  "additionalProperties",
  "minItems",
  "maxItems",
  "description",
  "$defs",
  "$ref",
  "definitions",
]);

/** A schema Ollama's "format" takes (a llama.cpp grammar is made from it). */
export function formatSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(formatSchema);
  if (!isObj(s)) return s;
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "oneOf") {
      out.anyOf = formatSchema(v);
      continue;
    }
    if (!FORMAT_KEEP.has(k)) continue;
    if (k === "additionalProperties") {
      // Only "no other keys" is a grammar rule; a schema for the extra keys is dropped (they stay allowed).
      if (v === false) out[k] = false;
      continue;
    }
    if (k === "properties" || k === "$defs" || k === "definitions")
      out[k] = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, formatSchema(pv)]));
    else out[k] = formatSchema(v);
  }
  return out;
}

const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

function fits(type: string, v: unknown): boolean {
  switch (type) {
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return isObj(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    default:
      return true;
  }
}

/**
 * The first thing wrong with a value against a schema (the subset the tools use: type and type unions, anyOf/oneOf,
 * enum, properties, required, additionalProperties: false, items, minItems/maxItems), as "path: what is wrong", or
 * null when it fits.
 */
export function validateArgs(schema: unknown, value: unknown, path = "arguments"): string | null {
  if (!isObj(schema)) return null;
  const branches = [...(Array.isArray(schema.anyOf) ? schema.anyOf : []), ...(Array.isArray(schema.oneOf) ? schema.oneOf : [])];
  if (branches.length) {
    const errors = branches.map((b) => validateArgs(b, value, path));
    if (errors.every((e) => e !== null)) {
      // The branch of the value's own type says best what is wrong with it.
      const own = branches.findIndex((b) => typesOf(b).some((t) => fits(t, value)));
      if (own >= 0) return errors[own];
      return `${path}: expected ${typesOf(schema).join(" or ") || "one of the allowed shapes"}, got ${describe(value)}`;
    }
  }
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : typeof schema.type === "string" ? [schema.type] : [];
  if (types.length && !types.some((t) => fits(t, value))) return `${path}: expected ${types.join(" or ")}, got ${describe(value)}`;
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value))
    return `${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}, got ${JSON.stringify(value)}`;
  if (isObj(value)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const r of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(r in value) || value[r] === undefined) return `${path === "arguments" ? "" : `${path}: `}"${r}" is required`;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter((k) => !(k in props));
      if (extra.length)
        return `${path}: unknown argument${extra.length > 1 ? "s" : ""} ${extra.map((k) => `"${k}"`).join(", ")} (allowed: ${Object.keys(props).join(", ") || "none"})`;
    }
    for (const [k, sub] of Object.entries(props)) {
      if (!(k in value) || value[k] === undefined) continue;
      const e = validateArgs(sub, value[k], path === "arguments" ? k : `${path}.${k}`);
      if (e) return e;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path}: needs at least ${schema.minItems} items, got ${value.length}`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path}: takes at most ${schema.maxItems} items, got ${value.length}`;
    if (isObj(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const e = validateArgs(schema.items, value[i], `${path}[${i}]`);
        if (e) return e;
      }
    }
  }
  return null;
}

function describe(v: unknown): string {
  const t = typeName(v);
  if (t === "string") {
    const s = v as string;
    return `a string (${JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s)})`;
  }
  return t === "integer" ? "a number" : t === "object" ? "an object" : t === "array" ? "an array" : t;
}
