// The parameters manager's rules (Phase P), pure: every parameter and named
// dimension with its expression, value, unit and where it is used.

import type { RawDocument } from "../../doc/commands";
import { documentSymbols, readersOf } from "../../doc/dimensions";
import { namesIn } from "../../doc/expr";
import { rawParameters } from "../../doc/parameters";

export interface Usage {
  /** A feature that reads it, and the fields that do ("distance", "entities"). */
  feature: string;
  fields: string[];
}

export interface ParameterRow {
  name: string;
  kind: "parameter" | "dimension";
  /** As written: a number, or "=expression". */
  expression: number | string;
  /** Worked out (null: it cannot be: the reason is in `problem`). */
  value: number | null;
  problem?: string;
  unit: "mm" | "°" | "";
  /** The features that read it, with the fields. */
  features: Usage[];
  /** The parameters (and nodes) that read it: "parameter t2", "node n1". */
  others: string[];
  /** The sketch a dimension belongs to. */
  sketch?: string;
  driven?: boolean;
}

/** Fields that hold angles, and counts (no unit). */
const ANGLE = /angle|twist|taper|startAngle|endAngle|tangent/i;
const COUNT = /count|sides|skip/i;

/** The top-level fields of a feature whose expressions read `name`. */
function fieldsReading(f: Record<string, unknown>, name: string): string[] {
  const out: string[] = [];
  const reads = (v: unknown): boolean => {
    if (typeof v === "string") return v.startsWith("=") && namesIn(v).includes(name);
    if (Array.isArray(v)) return v.some(reads);
    if (v && typeof v === "object") return Object.values(v).some(reads);
    return false;
  };
  for (const [k, v] of Object.entries(f)) if (k !== "id" && reads(v)) out.push(k);
  return out;
}

/** Which key inside a value reads it: for the unit ("angle" → degrees). */
function keysReading(v: unknown, name: string, key = ""): string[] {
  if (typeof v === "string") return v.startsWith("=") && namesIn(v).includes(name) ? [key] : [];
  if (Array.isArray(v)) return v.flatMap((x) => keysReading(x, name, key));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => keysReading(x, name, k));
  return [];
}

/** Every parameter, then every named dimension, of the document. */
export function parameterRows(doc: RawDocument): ParameterRow[] {
  const symbols = documentSymbols(doc);
  const params = rawParameters(doc);
  const rows: ParameterRow[] = [];
  const usage = (name: string) => {
    const features: Usage[] = [];
    for (const f of doc.features) {
      const fields = fieldsReading(f, name);
      if (fields.length) features.push({ feature: String(f.id), fields });
    }
    const others = readersOf(doc, name).filter((r) => r.startsWith("parameter ") || r.startsWith("node "));
    return { features, others };
  };
  const unitOf = (name: string, keys: string[]): ParameterRow["unit"] => {
    if (keys.length && keys.every((k) => ANGLE.test(k))) return "°";
    if (keys.length && keys.every((k) => COUNT.test(k))) return "";
    void name;
    return "mm";
  };
  for (const [name, expression] of Object.entries(params)) {
    const u = usage(name);
    const keys = doc.features.flatMap((f) => keysReading(f, name));
    rows.push({ name, kind: "parameter", expression, value: symbols.values[name] ?? null, ...(symbols.problems[name] ? { problem: symbols.problems[name] } : {}), unit: unitOf(name, keys), ...u });
  }
  for (const [full, e] of symbols.entries) {
    if (e.kind !== "dimension") continue;
    const f = doc.features.find((x) => x.id === e.sketch) as { constraints?: { name?: unknown; type?: unknown }[] } | undefined;
    const k = f?.constraints?.[e.index!];
    if (typeof k?.name !== "string") continue;
    const u = usage(full);
    rows.push({
      name: full,
      kind: "dimension",
      expression: e.raw as number | string,
      value: symbols.values[full] ?? null,
      unit: k.type === "angle" ? "°" : "mm",
      sketch: e.sketch,
      ...(e.driven ? { driven: true } : {}),
      ...u,
    });
  }
  return rows;
}

/** Is it used anywhere? */
export const isUsed = (r: ParameterRow) => r.features.length > 0 || r.others.length > 0;

export type SortKey = "name" | "value" | "used";

/** The rows sorted (parameters before dimensions within equal keys) and filtered by name, expression or user. */
export function sortRows(rows: ParameterRow[], key: SortKey, query: string, descending = false): ParameterRow[] {
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => [r.name, String(r.expression), ...r.features.map((u) => u.feature)].some((s) => s.toLowerCase().includes(q)) || (q === "unused" && !isUsed(r))) : rows;
  const cmp = (a: ParameterRow, b: ParameterRow) => {
    const d = key === "value" ? (a.value ?? -Infinity) - (b.value ?? -Infinity) : key === "used" ? a.features.length + a.others.length - (b.features.length + b.others.length) : a.name.localeCompare(b.name);
    return d || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "parameter" ? -1 : 1);
  };
  const out = [...shown].sort(cmp);
  return descending ? out.reverse() : out;
}

/** A parameter name for a value typed in a field: from the field's label ("Depth" → "depth"), the first free one. */
export function suggestName(label: string | undefined, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = (label ?? "value").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "p_$1") || "value";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}
