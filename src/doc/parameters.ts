// Document parameters: `"parameters": { "plate_t": 6 }` and any numeric field
// of any feature written as an expression, `"distance": "=plate_t"` or
// `"=plate_t * 2 + 1"`. The language (functions, units, comparisons) is in
// expr.ts; the names an expression may read, parameters and sketch
// dimensions by name ("=sketch_1.width"), are in dimensions.ts. A parameter
// may itself be an expression ("=sketch_1.d1 / 2").
//
// Expressions are resolved before validation, so everything downstream (the
// rebuild, the solver, the checks) sees plain numbers.

import { documentSymbols } from "./dimensions";
import { evaluateWith, namesIn, recordLookup, type Evaluation, type Lookup } from "./expr";

export type { Evaluation } from "./expr";

/** Names and their numbers: the parameters, and every sketch dimension by its full name ("sketch_1.d2"). */
export type Parameters = Record<string, number>;

export const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isExpression(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("=");
}

/** Why a name of a set of parameters can't be worked out (a cycle), kept beside the set it belongs to. */
const problemsOf = new WeakMap<Parameters, Record<string, string>>();

/** The lookup over a set of parameters, saying why a name of it doesn't resolve when it can. */
export function lookupOf(params: Parameters): Lookup {
  const own = recordLookup(params);
  const problems = problemsOf.get(params);
  return (name) => own(name) ?? (problems?.[name] ? { error: `${name} can't be worked out: ${problems[name]}` } : undefined);
}

/** Evaluates "=a * 2 + 1" (or "=sqrt(2) * 10", "=1in", "=sketch_1.d1 / 2") against the parameters. */
export function evaluate(expression: string, params: Parameters): Evaluation {
  return evaluateWith(expression, lookupOf(params));
}

/**
 * A deep copy of `value` with every "=expr" string replaced by its number.
 * Problems are appended to `errors` as "<path>: <message>".
 */
export function resolveExpressions(value: unknown, params: Parameters, errors: string[], path = ""): unknown {
  if (isExpression(value)) {
    const r = evaluate(value, params);
    if (r.ok) return r.value;
    errors.push(`${path || "value"}: ${r.error}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveExpressions(v, params, errors, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveExpressions(v, params, errors, path ? `${path}.${k}` : k);
    return out;
  }
  return value;
}

/** Names (parameters, dimensions) an object's expressions refer to. */
export function parameterRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (isExpression(value)) {
    for (const n of namesIn(value)) out.add(n);
  } else if (Array.isArray(value)) {
    for (const v of value) parameterRefs(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) parameterRefs(v, out);
  }
  return out;
}

/**
 * Every name an expression in the document may read, to its number: the
 * parameters (an expression one worked out) and each sketch dimension by its
 * full name. A name that can't be worked out (a cycle) is left out, and an
 * expression reading it says why.
 */
export function documentParameters(doc: unknown): Parameters {
  const table = documentSymbols(doc);
  const values = { ...table.values };
  problemsOf.set(values, table.problems);
  return values;
}

/** The document's own parameters (not the dimensions), worked out. */
export function parameterValues(doc: unknown): Parameters {
  const table = documentSymbols(doc);
  const out: Parameters = {};
  for (const [name, e] of table.entries) if (e.kind === "parameter" && name in table.values) out[name] = table.values[name];
  return out;
}

/** The parameters as written: numbers and "=expressions". */
export function rawParameters(doc: unknown): Record<string, number | string> {
  const p = (doc as { parameters?: unknown })?.parameters;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return {};
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(p)) if ((typeof v === "number" && Number.isFinite(v)) || isExpression(v)) out[k] = v;
  return out;
}

/** The whole document with expressions replaced where they resolve (for display and tools). */
export function resolvedDocument<T>(doc: T): T {
  const params = documentParameters(doc);
  return resolveExpressions(doc, params, []) as T;
}

/**
 * After an editor that works on numbers (the sketcher) has changed a resolved
 * copy, put back every expression whose value it did not change. Objects in
 * arrays are matched by id, or by everything but their value (constraints).
 */
export function restoreExpressions(original: unknown, edited: unknown, params: Parameters): unknown {
  if (isExpression(original)) {
    const r = evaluate(original, params);
    return r.ok && typeof edited === "number" && Math.abs(r.value - edited) <= 1e-9 * Math.max(1, Math.abs(edited)) ? original : edited;
  }
  if (Array.isArray(edited)) {
    if (!Array.isArray(original)) return edited;
    return edited.map((item, i) => restoreExpressions(counterpart(original, item, i), item, params));
  }
  if (isPlainObject(edited) && isPlainObject(original)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(edited)) out[k] = restoreExpressions(original[k], v, params);
    return out;
  }
  return edited;
}

function counterpart(original: unknown[], item: unknown, i: number): unknown {
  if (!isPlainObject(item)) return original[i];
  if (typeof item.id === "string") return original.find((o) => isPlainObject(o) && o.id === item.id);
  const { value: _, ...key } = item;
  const k = JSON.stringify(key);
  return original.find((o) => {
    if (!isPlainObject(o)) return false;
    const { value: __, ...ok } = o;
    return JSON.stringify(ok) === k;
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
