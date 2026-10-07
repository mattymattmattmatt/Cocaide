// apply(doc, command): every edit to a document goes through here. The UI
// uses it now; the agent tools use the same function in Phase C.
//
// Commands work on the raw JSON so a document can be edited while some of its
// features are invalid. A command is rejected, leaving the document as it
// was, if it would introduce a validation error that was not there before
// (a bad field, a broken reference, a duplicate id).

import { checkConstraints } from "../geom/constraints";
import { solveSketch, wouldOverDefine } from "../geom/solver";
import { documentParameters, isExpression, PARAMETER_NAME, parameterRefs, resolveExpressions, type Parameters } from "./parameters";
import { scopeProblem, type WriteScope } from "./scope";
import { ENTITY_PREFIX, nextEntityId, removeEntities } from "./sketch";
import type { Constraint, Feature, SketchEntity } from "./types";
import { allErrors, isObject, validateDocument } from "./validate";

/** A document as plain JSON: what a .cocaide.json parses to. */
export type RawDocument = Record<string, unknown> & { features: Record<string, unknown>[] };

export type Command =
  | { type: "addFeature"; feature: Record<string, unknown> | Feature; index?: number }
  /** Shallow merge into the feature; a value of null removes that field. */
  | { type: "updateFeature"; id: string; patch: Record<string, unknown> }
  | { type: "replaceFeature"; id: string; feature: Record<string, unknown> | Feature }
  | { type: "deleteFeature"; id: string }
  | { type: "reorderFeature"; id: string; index: number }
  | { type: "suppressFeature"; id: string; suppressed: boolean }
  | { type: "setName"; name: string }
  /** Sets a document parameter; sketches whose dimensions use it are re-solved. */
  | { type: "setParameter"; name: string; value: number }
  /** Removes a parameter nothing uses. */
  | { type: "deleteParameter"; name: string }
  /** Changes one dimension of a sketch (a constraint's value, or "=expr") and re-solves the sketch. */
  | { type: "setDimension"; sketch: string; index: number; value: number | string }
  // Inside one sketch. Each re-solves the sketch so its constraints still hold.
  | { type: "addEntity"; sketch: string; entity: Record<string, unknown> }
  /** Merges into the entity (null removes a field); the fields it sets are held while the sketch re-solves. */
  | { type: "updateEntity"; sketch: string; id: string; patch: Record<string, unknown> }
  /** Removes the entity and every constraint on it. */
  | { type: "deleteEntity"; sketch: string; id: string }
  | { type: "addConstraint"; sketch: string; constraint: Record<string, unknown> }
  | { type: "deleteConstraint"; sketch: string; index: number };

export type ApplyResult = { ok: true; doc: RawDocument } | { ok: false; error: string };

export interface ApplyOptions {
  /** When given, the command must fall inside it (see scope.ts). */
  writeScope?: WriteScope;
}

export function apply(input: unknown, cmd: Command, opts: ApplyOptions = {}): ApplyResult {
  if (!isObject(input) || !Array.isArray(input.features)) {
    return { ok: false, error: "document: not a document (needs a features array)" };
  }
  const outside = scopeProblem(input as RawDocument, cmd, opts.writeScope);
  if (outside) return { ok: false, error: outside };
  const doc = structuredClone(input) as RawDocument;
  const features = doc.features;
  const indexOf = (id: string) => features.findIndex((f) => isObject(f) && f.id === id);
  const need = (id: string): number | string => {
    const i = indexOf(id);
    return i < 0 ? `${cmd.type}: no feature "${id}"` : i;
  };

  switch (cmd.type) {
    case "addFeature": {
      const f = structuredClone(cmd.feature) as Record<string, unknown>;
      if (typeof f.id === "string" && indexOf(f.id) >= 0) {
        return { ok: false, error: `addFeature: a feature "${f.id}" already exists` };
      }
      const at = cmd.index ?? features.length;
      if (!Number.isInteger(at) || at < 0 || at > features.length) {
        return { ok: false, error: `addFeature: index ${at} is outside 0..${features.length}` };
      }
      features.splice(at, 0, f);
      break;
    }
    case "updateFeature":
    case "replaceFeature": {
      const i = need(cmd.id);
      if (typeof i === "string") return { ok: false, error: i };
      const next =
        cmd.type === "replaceFeature"
          ? (structuredClone(cmd.feature) as Record<string, unknown>)
          : { ...features[i], ...structuredClone(cmd.patch) };
      for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
      if (next.id !== cmd.id) {
        const renamed = String(next.id);
        if (indexOf(renamed) >= 0) return { ok: false, error: `${cmd.type}: a feature "${renamed}" already exists` };
        const users = dependants(features, cmd.id);
        if (users.length) {
          return { ok: false, error: `${cmd.type}: cannot rename ${cmd.id}; ${users.join(", ")} ${users.length === 1 ? "uses" : "use"} it` };
        }
      }
      features[i] = next;
      break;
    }
    case "deleteFeature": {
      const i = need(cmd.id);
      if (typeof i === "string") return { ok: false, error: i };
      const users = dependants(features, cmd.id);
      if (users.length) {
        return {
          ok: false,
          error: `deleteFeature: ${cmd.id} is used by ${users.join(", ")}; delete or change ${users.length === 1 ? "it" : "them"} first`,
        };
      }
      features.splice(i, 1);
      break;
    }
    case "reorderFeature": {
      const i = need(cmd.id);
      if (typeof i === "string") return { ok: false, error: i };
      if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= features.length) {
        return { ok: false, error: `reorderFeature: index ${cmd.index} is outside 0..${features.length - 1}` };
      }
      const [moved] = features.splice(i, 1);
      features.splice(cmd.index, 0, moved);
      const problem = orderProblem(features);
      if (problem) return { ok: false, error: `reorderFeature: ${problem}` };
      break;
    }
    case "suppressFeature": {
      const i = need(cmd.id);
      if (typeof i === "string") return { ok: false, error: i };
      const next = { ...features[i] };
      if (cmd.suppressed) next.suppressed = true;
      else delete next.suppressed;
      features[i] = next;
      break;
    }
    case "setName":
      doc.name = cmd.name;
      break;
    case "setParameter": {
      if (typeof cmd.name !== "string" || !PARAMETER_NAME.test(cmd.name)) {
        return { ok: false, error: `setParameter: "${String(cmd.name)}" is not a parameter name (letters, digits, _)` };
      }
      if (typeof cmd.value !== "number" || !Number.isFinite(cmd.value)) {
        return { ok: false, error: `setParameter: value must be a number (got ${JSON.stringify(cmd.value)})` };
      }
      doc.parameters = { ...documentParameters(doc), [cmd.name]: cmd.value };
      const params = documentParameters(doc);
      for (let i = 0; i < features.length; i++) {
        const f = features[i];
        if (!isObject(f) || f.op !== "sketch" || !parameterRefs(f).has(cmd.name)) continue;
        const r = resolveSketch(f, params);
        if (!r.ok) return { ok: false, error: `setParameter: ${cmd.name} = ${cmd.value}: ${r.error}` };
        features[i] = r.feature;
      }
      break;
    }
    case "deleteParameter": {
      const params = documentParameters(doc);
      if (!(cmd.name in params)) return { ok: false, error: `deleteParameter: no parameter "${cmd.name}"` };
      const users = features.filter((f) => isObject(f) && parameterRefs(f).has(cmd.name)).map((f) => String(f.id));
      if (users.length) return { ok: false, error: `deleteParameter: ${cmd.name} is used by ${users.join(", ")}` };
      delete params[cmd.name];
      if (Object.keys(params).length) doc.parameters = params;
      else delete doc.parameters;
      break;
    }
    case "setDimension": {
      const i = need(cmd.sketch);
      if (typeof i === "string") return { ok: false, error: i };
      const f = structuredClone(features[i]);
      if (f.op !== "sketch") return { ok: false, error: `setDimension: "${cmd.sketch}" is a ${String(f.op)}, not a sketch` };
      const constraints = Array.isArray(f.constraints) ? (f.constraints as Record<string, unknown>[]) : [];
      const k = constraints[cmd.index];
      if (!isObject(k) || !("value" in k)) {
        return { ok: false, error: `setDimension: ${cmd.sketch} has no dimension at index ${cmd.index} (it has ${constraints.length} constraints)` };
      }
      if (!(typeof cmd.value === "number" && Number.isFinite(cmd.value)) && !isExpression(cmd.value)) {
        return { ok: false, error: `setDimension: value must be a number or "=expression" (got ${JSON.stringify(cmd.value)})` };
      }
      k.value = cmd.value;
      const r = resolveSketch(f, documentParameters(doc));
      if (!r.ok) return { ok: false, error: `setDimension: ${r.error}` };
      features[i] = r.feature;
      break;
    }
    case "addEntity":
    case "updateEntity":
    case "deleteEntity":
    case "addConstraint":
    case "deleteConstraint": {
      const i = need(cmd.sketch);
      if (typeof i === "string") return { ok: false, error: i };
      const r = editSketch(features[i], cmd, documentParameters(doc));
      if (typeof r === "string") return { ok: false, error: `${cmd.type}: ${r}` };
      features[i] = r;
      break;
    }
    default:
      return { ok: false, error: `unknown command ${JSON.stringify((cmd as { type?: unknown }).type)}` };
  }

  const before = new Set(allErrors(validateDocument(input)));
  const introduced = allErrors(validateDocument(doc)).filter((e) => !before.has(e));
  if (introduced.length > 0) {
    return { ok: false, error: `${cmd.type} rejected: ${introduced.join("; ")}` };
  }
  return { ok: true, doc };
}

type SketchCommand = Extract<Command, { type: "addEntity" | "updateEntity" | "deleteEntity" | "addConstraint" | "deleteConstraint" }>;

/** One edit inside a sketch, then a re-solve. Returns the new feature or why not. */
function editSketch(raw: Record<string, unknown>, cmd: SketchCommand, params: Parameters): Record<string, unknown> | string {
  if (raw.op !== "sketch") return `"${cmd.sketch}" is a ${String(raw.op)}, not a sketch`;
  const f = structuredClone(raw);
  const entities = (Array.isArray(f.entities) ? f.entities : []) as Record<string, unknown>[];
  const constraints = (Array.isArray(f.constraints) ? f.constraints : []) as Record<string, unknown>[];
  const findEntity = (id: string) => entities.findIndex((e) => isObject(e) && e.id === id);
  const fixed: string[] = [];
  switch (cmd.type) {
    case "addEntity": {
      if (!isObject(cmd.entity)) return "entity must be an object";
      const e = { ...cmd.entity };
      if (e.id === undefined) e.id = nextEntityId(entities, ENTITY_PREFIX[e.type as keyof typeof ENTITY_PREFIX] ?? "e");
      if (findEntity(String(e.id)) >= 0) return `${cmd.sketch} already has an entity "${String(e.id)}"`;
      entities.push(e);
      break;
    }
    case "updateEntity": {
      const k = findEntity(cmd.id);
      if (k < 0) return `${cmd.sketch} has no entity "${cmd.id}"`;
      if (!isObject(cmd.patch)) return "patch must be an object";
      if ("id" in cmd.patch && cmd.patch.id !== cmd.id) return "an entity's id cannot change";
      const next: Record<string, unknown> = { ...entities[k], ...cmd.patch };
      for (const [key, v] of Object.entries(next)) if (v === null) delete next[key];
      entities[k] = next;
      // What the edit set stays put; the rest of the sketch moves to keep its constraints.
      for (const [key, v] of Object.entries(cmd.patch)) if (typeof v === "number" || Array.isArray(v)) fixed.push(`${cmd.id}.${key}`);
      break;
    }
    case "deleteEntity": {
      if (findEntity(cmd.id) < 0) return `${cmd.sketch} has no entity "${cmd.id}"`;
      const left = removeEntities(entities as never, constraints as never, [cmd.id]);
      f.entities = left.entities;
      f.constraints = left.constraints;
      break;
    }
    case "addConstraint": {
      if (!isObject(cmd.constraint)) return "constraint must be an object";
      const resolved = resolveExpressions(f, params, []) as { entities: SketchEntity[]; constraints?: Constraint[] };
      const extra = resolveExpressions(cmd.constraint, params, []) as Constraint;
      try {
        if (wouldOverDefine(resolved.entities, resolved.constraints ?? [], extra)) {
          return `${cmd.sketch}: that constraint repeats or contradicts what the sketch already fixes`;
        }
      } catch (e) {
        return `${cmd.sketch}: constraint: ${(e as Error).message}`;
      }
      constraints.push({ ...cmd.constraint });
      break;
    }
    case "deleteConstraint": {
      if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= constraints.length) {
        return `${cmd.sketch} has no constraint at index ${cmd.index} (it has ${constraints.length})`;
      }
      constraints.splice(cmd.index, 1);
      break;
    }
  }
  if (cmd.type !== "deleteEntity") {
    f.entities = entities;
    if (constraints.length || f.constraints !== undefined) f.constraints = constraints;
  }
  const r = resolveSketch(f, params, fixed);
  if (!r.ok) return fixed.length ? `${r.error} (with ${fixed.join(", ")} held where you set them)` : r.error;
  return r.feature;
}

/**
 * Brings a sketch's geometry back in line with its constraints after a
 * dimension or parameter changed: solve, with fields that are themselves
 * expressions held fixed, and write the solved numbers back. A sketch whose
 * constraints already hold, or that does not validate, is returned as is.
 */
export function resolveSketch(
  raw: Record<string, unknown>,
  params: Parameters,
  hold: string[] = [],
): { ok: true; feature: Record<string, unknown> } | { ok: false; error: string } {
  const errors: string[] = [];
  const resolved = resolveExpressions(raw, params, errors) as { entities?: SketchEntity[]; constraints?: Constraint[] };
  if (errors.length || !Array.isArray(resolved.entities)) return { ok: true, feature: raw };
  const constraints = resolved.constraints ?? [];
  try {
    if (checkConstraints(resolved.entities, constraints).length === 0) return { ok: true, feature: raw };
  } catch {
    return { ok: true, feature: raw }; // malformed: validation will say why
  }
  const rawEntities = raw.entities as Record<string, unknown>[];
  const fixed: string[] = [...hold];
  for (const e of rawEntities) {
    for (const [field, v] of Object.entries(e)) {
      if (isExpression(v)) fixed.push(`${String(e.id)}.${field}`);
      else if (Array.isArray(v)) v.forEach((c, k) => isExpression(c) && fixed.push(`${String(e.id)}.${field}.${k}`));
    }
  }
  const r = solveSketch(resolved.entities, constraints, { fixed });
  if (!r.ok) return { ok: false, error: `${String(raw.id)}: ${r.error}` };
  const out = structuredClone(raw);
  (out.entities as Record<string, unknown>[]).forEach((e, n) => {
    const solved = r.entities[n] as unknown as Record<string, unknown>;
    for (const [field, v] of Object.entries(e)) {
      if (typeof v === "number") e[field] = clean(solved[field] as number);
      else if (Array.isArray(v)) e[field] = v.map((c, k) => (isExpression(c) ? c : clean((solved[field] as number[])[k])));
    }
  });
  return { ok: true, feature: out };
}

/** Solver output for the document: a value within 1e-8 of a 6-decimal number is that number. */
function clean(x: number): number {
  const r6 = Math.round(x * 1e6) / 1e6;
  return (Math.abs(x - r6) < 1e-8 ? r6 : Math.round(x * 1e9) / 1e9) + 0;
}

/** Ids of features that reference `id` (an extrude's sketch, a pattern's feature). */
export function dependants(features: unknown[], id: string): string[] {
  return features.filter((f) => isObject(f) && references(f).includes(id)).map((f) => String((f as { id: unknown }).id));
}

export function references(f: Record<string, unknown>): string[] {
  const refs: string[] = [];
  if ((f.op === "extrude" || f.op === "cut") && typeof f.sketch === "string") refs.push(f.sketch);
  if ((f.op === "linearPattern" || f.op === "circularPattern") && typeof f.feature === "string") refs.push(f.feature);
  return refs;
}

function orderProblem(features: unknown[]): string | null {
  const seen = new Set<string>();
  for (const f of features) {
    if (!isObject(f)) continue;
    for (const ref of references(f)) {
      if (!seen.has(ref)) return `${String(f.id)} uses ${ref}, which would come after it`;
    }
    if (typeof f.id === "string") seen.add(f.id);
  }
  return null;
}

/** The first free id of the form prefix_1, prefix_2, ... */
export function nextId(doc: unknown, prefix: string): string {
  const used = new Set(
    isObject(doc) && Array.isArray(doc.features) ? doc.features.map((f) => (isObject(f) ? f.id : undefined)) : [],
  );
  for (let n = 1; ; n++) if (!used.has(`${prefix}_${n}`)) return `${prefix}_${n}`;
}
