// apply(doc, command): every edit to a document goes through here. The UI
// uses it now; the agent tools use the same function in Phase C.
//
// Commands work on the raw JSON so a document can be edited while some of its
// features are invalid. A command is rejected, leaving the document as it
// was, if it would introduce a validation error that was not there before
// (a bad field, a broken reference, a duplicate id).

import type { Feature } from "./types";
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
  | { type: "setName"; name: string };

export type ApplyResult = { ok: true; doc: RawDocument } | { ok: false; error: string };

export function apply(input: unknown, cmd: Command): ApplyResult {
  if (!isObject(input) || !Array.isArray(input.features)) {
    return { ok: false, error: "document: not a document (needs a features array)" };
  }
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
