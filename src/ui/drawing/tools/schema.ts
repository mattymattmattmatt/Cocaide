// Property schemas (Phase Q wave Q2B): what the property panel shows for an
// annotation (or a view's, a table's options), as data. Each field names its
// key in the stored object (a path: "between.0"), how it is edited, and what
// it may be; the panel (SchemaForm.tsx) is the same for every kind, so a new
// kind of annotation gets its panel by listing its fields. Reading a field
// and turning what was typed into a patch are pure, and tested.

import type { RawDocument } from "../../../doc/commands";
import type { Drawing, DrawingSheet } from "../../../doc/types";
import type { ComposedSheet } from "../../../drafting/compose";
import type { Measurements } from "../../../kernel/measure";
import type { SnapKind } from "../snap";

export type FieldKind = "text" | "textarea" | "number" | "select" | "bool" | "ref" | "vec2";

/** What a field's choices and checks may read. */
export interface SchemaEnv {
  doc: RawDocument;
  drawing: Drawing;
  sheetDoc: DrawingSheet;
  sheet: ComposedSheet | null;
  measurements: Measurements | null;
}

export interface Choice {
  value: string;
  label: string;
}

export interface PropField {
  /** The key in the object, or a path into it ("between.0", "style.textSize"). */
  key: string;
  label: string;
  kind: FieldKind;
  /** select: the choices (an empty value is "automatic" when the field is optional). */
  options?: readonly string[] | Choice[] | ((env: SchemaEnv, value: Record<string, unknown>) => Choice[]);
  /** May be left empty: then the key is removed (the default applies). */
  optional?: boolean;
  /** What empty means, shown greyed in the box ("automatic"). */
  placeholder?: string;
  help?: string;
  /** number: the least and most allowed, and whether it must be above zero. */
  min?: number;
  max?: number;
  positive?: boolean;
  integer?: boolean;
  /** ref: what a pick on the sheet fills it with (a GeoRef of these kinds). */
  picks?: SnapKind[];
  /** Shown only when this holds. */
  when?(value: Record<string, unknown>): boolean;
  /** Its test id; default `prop-<kind>-<key>` with dots as dashes. */
  testId?: string;
}

export interface PropSchema {
  fields: PropField[];
}

/** The value at a path ("between.0") of an object; undefined when any step is missing. */
export function getPath(obj: unknown, path: string): unknown {
  let v: unknown = obj;
  for (const step of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[step];
  }
  return v;
}

/**
 * A patch for the object's top-level key that sets the path to `value`
 * (undefined removes it): "between.0" = x gives { between: [x, <old second>] }.
 * A top-level key set to null in the patch is removed by the caller.
 */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const steps = path.split(".");
  if (steps.length === 1) return { [path]: value === undefined ? null : value };
  const root = steps[0];
  const clone = (x: unknown): unknown => (Array.isArray(x) ? [...x] : x && typeof x === "object" ? { ...(x as object) } : undefined);
  const top = clone(obj[root]) ?? (/^\d+$/.test(steps[1]) ? [] : {});
  let cur = top as Record<string, unknown>;
  for (let i = 1; i < steps.length - 1; i++) {
    const s = steps[i];
    const next = clone(cur[s]) ?? (/^\d+$/.test(steps[i + 1]) ? [] : {});
    cur[s] = next;
    cur = next as Record<string, unknown>;
  }
  const last = steps[steps.length - 1];
  if (value === undefined) {
    if (Array.isArray(cur)) cur[Number(last)] = undefined as never;
    else delete cur[last];
  } else cur[last] = value;
  const empty = !Array.isArray(top) && Object.keys(top as object).length === 0;
  return { [root]: empty ? null : top };
}

/** What a field shows: a string for a box, a boolean for a tick. */
export function readField(value: Record<string, unknown>, f: PropField): string | boolean {
  const v = getPath(value, f.key);
  if (f.kind === "bool") return v === true;
  if (v === undefined || v === null) return "";
  if (f.kind === "vec2" && Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  return String(v);
}

/**
 * What was typed, as a patch for the object, or why it can't be: a number is
 * read (and held to its limits), an empty optional field removes its key, an
 * empty required one is refused, a choice must be one of the choices.
 */
export function writeField(value: Record<string, unknown>, f: PropField, input: string | boolean, choices?: Choice[]): { patch: Record<string, unknown> } | { error: string } {
  if (f.kind === "bool") return { patch: setPath(value, f.key, input === true ? true : undefined) };
  const text = String(input).trim();
  if (text === "") {
    if (!f.optional) return { error: `${f.label} can't be empty` };
    return { patch: setPath(value, f.key, undefined) };
  }
  if (f.kind === "number") {
    const n = Number(text.replace(",", "."));
    if (!Number.isFinite(n)) return { error: `${f.label} must be a number (got "${text}")` };
    if (f.integer && !Number.isInteger(n)) return { error: `${f.label} must be a whole number (got ${n})` };
    if (f.positive && n <= 0) return { error: `${f.label} must be more than 0 (got ${n})` };
    if (f.min !== undefined && n < f.min) return { error: `${f.label} must be at least ${f.min} (got ${n})` };
    if (f.max !== undefined && n > f.max) return { error: `${f.label} must be at most ${f.max} (got ${n})` };
    return { patch: setPath(value, f.key, n) };
  }
  if (f.kind === "vec2") {
    const parts = text.split(/[\s,;]+/).filter(Boolean).map((x) => Number(x));
    if (parts.length !== 2 || !parts.every(Number.isFinite)) return { error: `${f.label} must be two numbers, x and y in mm (got "${text}")` };
    return { patch: setPath(value, f.key, parts) };
  }
  if (f.kind === "select" && choices && !choices.some((c) => c.value === text)) return { error: `${f.label} must be one of ${choices.map((c) => c.value).join(", ")} (got "${text}")` };
  return { patch: setPath(value, f.key, text) };
}

/** A field's choices, as value and label. */
export function choicesOf(f: PropField, env: SchemaEnv, value: Record<string, unknown>): Choice[] {
  const o = f.options;
  if (!o) return [];
  if (typeof o === "function") return o(env, value);
  return (o as readonly (string | Choice)[]).map((c) => (typeof c === "string" ? { value: c, label: c } : c));
}

/** The fields shown for a value: those whose `when` holds. */
export function shownFields(schema: PropSchema, value: Record<string, unknown>): PropField[] {
  return schema.fields.filter((f) => !f.when || f.when(value));
}

/** The object with a patch merged: a key set to null is removed. */
export function applyPatch(value: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...value, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
  return next;
}
