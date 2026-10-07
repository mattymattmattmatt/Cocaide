// Document parameters: `"parameters": { "plate_t": 6 }` and any numeric field
// of any feature written as an expression, `"distance": "=plate_t"` or
// `"=plate_t * 2 + 1"`. Expressions are numbers, parameter names, + - * /
// and parentheses; nothing else is evaluated.
//
// Expressions are resolved before validation, so everything downstream (the
// rebuild, the solver, the checks) sees plain numbers.

export type Parameters = Record<string, number>;

export const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isExpression(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("=");
}

export type Evaluation = { ok: true; value: number } | { ok: false; error: string };

/** Evaluates "=a * 2 + 1" against the parameters. */
export function evaluate(expression: string, params: Parameters): Evaluation {
  const src = expression.startsWith("=") ? expression.slice(1) : expression;
  let i = 0;
  const fail = (message: string): never => {
    throw new ExpressionError(`${message} in "${expression}"`);
  };
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      ws();
      if (src[i] === "+") (i++, (v += term()));
      else if (src[i] === "-") (i++, (v -= term()));
      else return v;
    }
  };
  const term = (): number => {
    let v = factor();
    for (;;) {
      ws();
      if (src[i] === "*") (i++, (v *= factor()));
      else if (src[i] === "/") {
        i++;
        const d = factor();
        if (d === 0) fail("division by zero");
        v /= d;
      } else return v;
    }
  };
  const factor = (): number => {
    ws();
    const ch = src[i];
    if (ch === "-") return i++, -factor();
    if (ch === "+") return i++, factor();
    if (ch === "(") {
      i++;
      const v = expr();
      ws();
      if (src[i] !== ")") fail("missing )");
      i++;
      return v;
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) {
      i += name[0].length;
      if (!(name[0] in params)) fail(`unknown parameter "${name[0]}"`);
      return params[name[0]];
    }
    return fail(i >= src.length ? "unexpected end" : `unexpected "${ch}"`);
  };
  try {
    const value = expr();
    ws();
    if (i < src.length) fail(`unexpected "${src[i]}"`);
    if (!Number.isFinite(value)) fail("result is not a finite number");
    return { ok: true, value };
  } catch (e) {
    if (e instanceof ExpressionError) return { ok: false, error: e.message };
    throw e;
  }
}

class ExpressionError extends Error {}

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

/** Parameter names an object's expressions refer to. */
export function parameterRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (isExpression(value)) {
    for (const m of value.slice(1).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      // Skip the exponent letter of numbers such as 1e3.
      const before = value.slice(1)[m.index! - 1];
      if (before !== undefined && /[0-9.]/.test(before)) continue;
      out.add(m[0]);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) parameterRefs(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) parameterRefs(v, out);
  }
  return out;
}

/** The document's parameters when they are well formed, else an empty set. */
export function documentParameters(doc: unknown): Parameters {
  const p = (doc as { parameters?: unknown })?.parameters;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return {};
  const out: Parameters = {};
  for (const [k, v] of Object.entries(p)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
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
