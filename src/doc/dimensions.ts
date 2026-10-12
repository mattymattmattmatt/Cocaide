// Named dimensions and the document's symbol table (names like D1@Sketch1,
// done plainly). Every dimension of a sketch (a constraint with a value) has
// a name: the one it is given (`name`, renameable in the Modify box), else
// d<n>, n its place among the sketch's dimensions (d1, d2, …). Any expression
// anywhere reads it as <sketch id>.<name>: "=sketch_1.width * 2". A
// parameter may be an expression too ("=sketch_1.d1 / 2"), so parameters and
// dimensions are one set of equations; a cycle among them is refused, saying
// which names go round.
//
// A driven dimension (driven: true) is measured, never solved: its stored
// value is what the geometry measures, kept up to date by every solve, so an
// expression can read it like any other.
//
// When an expression names a dimension by its default name, the name is
// written into the dimension (`pinReferencedNames`), so deleting an earlier
// dimension can't shift it onto another one.

import { evaluateWith, namesIn, renameIn, type Lookup, type NameValue } from "./expr";

/** A dimension's own name: letters, digits and _, starting with a letter or _ (the sketch id goes before it, after a dot). */
export const DIMENSION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => v !== null && typeof v === "object" && !Array.isArray(v);
const isExpr = (v: unknown): v is string => typeof v === "string" && v.startsWith("=");

/** A dimension: a constraint with a value (a distance, radius, angle, arc length, offset …). */
export function isDimension(k: unknown): k is Raw & { value: unknown } {
  return isObject(k) && "value" in k;
}

/**
 * Each constraint's dimension name, null for a relation: its own name, or
 * d<n> by its place among the dimensions (the next free one when that is
 * taken by a name given to another).
 */
export function dimensionNames(constraints: unknown): (string | null)[] {
  const list = Array.isArray(constraints) ? constraints : [];
  const taken = new Set(list.flatMap((k) => (isDimension(k) && typeof k.name === "string" ? [k.name] : [])));
  let n = 0;
  return list.map((k) => {
    if (!isDimension(k)) return null;
    n++;
    if (typeof k.name === "string") return k.name;
    let m = n;
    while (taken.has(`d${m}`)) m++;
    taken.add(`d${m}`);
    return `d${m}`;
  });
}

/** The full name expressions use: "sketch_1.d3". */
export function qualified(sketch: string, name: string): string {
  return `${sketch}.${name}`;
}

export interface SymbolEntry {
  kind: "parameter" | "dimension";
  /** A number, or "=expression". */
  raw: unknown;
  sketch?: string;
  /** The constraint's index in its sketch. */
  index?: number;
  driven?: boolean;
}

export interface SymbolTable {
  /** Every name that resolves, to its number. */
  values: Record<string, number>;
  /** Names that don't, and why (a cycle, a bad expression, not a number). */
  problems: Record<string, string>;
  entries: Map<string, SymbolEntry>;
  lookup: Lookup;
}

/** The parameters and every sketch dimension of a raw document, by name. Parameters win over a dimension that would share their name. */
export function symbolEntries(doc: unknown): Map<string, SymbolEntry> {
  const entries = new Map<string, SymbolEntry>();
  if (!isObject(doc)) return entries;
  if (isObject(doc.parameters)) for (const [name, raw] of Object.entries(doc.parameters)) entries.set(name, { kind: "parameter", raw });
  const features = Array.isArray(doc.features) ? doc.features : [];
  for (const f of features) {
    if (!isObject(f) || f.op !== "sketch" || typeof f.id !== "string") continue;
    const names = dimensionNames(f.constraints);
    (f.constraints as unknown[] | undefined)?.forEach((k, index) => {
      const name = names[index];
      if (!name || !isDimension(k)) return;
      const full = qualified(f.id as string, name);
      if (!entries.has(full)) entries.set(full, { kind: "dimension", raw: k.value, sketch: f.id as string, index, ...(k.driven === true ? { driven: true } : {}) });
    });
  }
  return entries;
}

/** Works out every name: each expression against the others, refusing cycles. */
export function documentSymbols(doc: unknown): SymbolTable {
  const entries = symbolEntries(doc);
  const done = new Map<string, NameValue>();
  const stack: string[] = [];
  const resolve = (name: string): NameValue => {
    if (done.has(name)) return done.get(name);
    const e = entries.get(name);
    if (!e) return undefined;
    if (stack.includes(name)) return { error: `cycle: ${[...stack.slice(stack.indexOf(name)), name].join(" → ")}` };
    let out: NameValue;
    if (typeof e.raw === "number") out = Number.isFinite(e.raw) ? e.raw : { error: `${name} is not a finite number` };
    else if (isExpr(e.raw)) {
      stack.push(name);
      const r = evaluateWith(e.raw, resolve);
      stack.pop();
      // A cycle says so once, plainly, wherever it is read from.
      out = r.ok ? r.value : { error: r.error.includes("cycle: ") ? r.error.slice(r.error.indexOf("cycle: ")).replace(/ in "=.*$/, "") : r.error };
    } else out = { error: `${name} must be a number or "=expression" (got ${JSON.stringify(e.raw)})` };
    // While a cycle is being unwound, the names inside it are not settled yet.
    if (!(typeof out === "object" && stack.length)) done.set(name, out);
    return out;
  };
  const values: Record<string, number> = {};
  const problems: Record<string, string> = {};
  for (const name of entries.keys()) {
    const v = resolve(name);
    if (typeof v === "number") values[name] = v;
    else if (v) problems[name] = v.error;
  }
  const lookup: Lookup = (name) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : problems[name] ? { error: `${name} can't be worked out: ${problems[name]}` } : undefined);
  return { values, problems, entries, lookup };
}

/** Every "=expression" string in a value, with a setter to rewrite it. */
function visitExpressions(value: unknown, visit: (expr: string) => string): unknown {
  if (isExpr(value)) return visit(value);
  if (Array.isArray(value)) return value.map((v) => visitExpressions(v, visit));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visitExpressions(v, visit)]));
  return value;
}

/** Where a document keeps expressions: its parameters, nodes and features. */
const EXPRESSION_HOMES = ["parameters", "nodes", "features"] as const;

/** Every name the document's expressions read. */
export function referencedNames(doc: Raw): Set<string> {
  const out = new Set<string>();
  for (const home of EXPRESSION_HOMES) visitExpressions(doc[home], (e) => (namesIn(e).forEach((n) => out.add(n)), e));
  return out;
}

/** Rewrites every expression in the document (in place): each name `rename` maps. */
export function renameInDocument(doc: Raw, rename: (name: string) => string | undefined): void {
  const visit = (v: unknown) => visitExpressions(v, (e) => renameIn(e, rename));
  for (const home of EXPRESSION_HOMES) {
    const v = doc[home];
    // The features array itself stays the same array (callers hold it).
    if (Array.isArray(v)) v.forEach((x, i) => (v[i] = visit(x)));
    else if (v !== undefined) doc[home] = visit(v);
  }
}

/**
 * Writes the default name into each dimension an expression reads by it (in
 * place), so the name stays with that dimension whatever is deleted before it.
 * True when anything was written.
 */
export function pinReferencedNames(doc: Raw): boolean {
  if (!Array.isArray(doc.features)) return false;
  const used = [...referencedNames(doc)].filter((n) => n.includes("."));
  if (!used.length) return false;
  let changed = false;
  doc.features.forEach((f, i) => {
    if (!isObject(f) || f.op !== "sketch" || typeof f.id !== "string" || !Array.isArray(f.constraints)) return;
    const names = dimensionNames(f.constraints);
    const pin = new Set(used.filter((n) => n.startsWith(`${f.id}.`)).map((n) => n.slice((f.id as string).length + 1)));
    if (![...pin].some((n) => names.includes(n))) return;
    const constraints = (f.constraints as unknown[]).map((k, j) => (isDimension(k) && k.name === undefined && pin.has(names[j]!) ? ((changed = true), { ...k, name: names[j] }) : k));
    (doc.features as unknown[])[i] = { ...f, constraints };
  });
  return changed;
}

/** The dimensions (full names) whose value is an expression reading any of `names`, and theirs in turn, with the names themselves. */
export function dependentNames(entries: Map<string, SymbolEntry>, names: Iterable<string>): Set<string> {
  const out = new Set(names);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, e] of entries) {
      if (out.has(name) || !isExpr(e.raw)) continue;
      if (namesIn(e.raw).some((n) => out.has(n))) {
        out.add(name);
        grew = true;
      }
    }
  }
  return out;
}

/** The dimensions (full names) that carry a name of their own: what a pinned reference reads. */
export function namedDimensions(doc: Raw): Set<string> {
  const out = new Set<string>();
  for (const f of Array.isArray(doc.features) ? doc.features : []) {
    if (!isObject(f) || f.op !== "sketch" || typeof f.id !== "string" || !Array.isArray(f.constraints)) continue;
    for (const k of f.constraints) if (isDimension(k) && typeof k.name === "string") out.add(qualified(f.id, k.name));
  }
  return out;
}

/** What reads a name: the features, parameters and nodes whose expressions use it. */
export function readersOf(doc: Raw, name: string): string[] {
  const out: string[] = [];
  for (const f of Array.isArray(doc.features) ? doc.features : []) {
    let reads = false;
    visitExpressions(f, (e) => ((reads ||= namesIn(e).includes(name)), e));
    if (reads && isObject(f)) out.push(String(f.id));
  }
  for (const home of ["parameters", "nodes"] as const) {
    const v = doc[home];
    if (!isObject(v)) continue;
    for (const [k, x] of Object.entries(v)) {
      let reads = false;
      visitExpressions(x, (e) => ((reads ||= namesIn(e).includes(name)), e));
      if (reads) out.push(home === "parameters" ? `parameter ${k}` : `node ${k}`);
    }
  }
  return out;
}
