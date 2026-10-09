// The operation fields every shape-making registry op shares (DESIGN §2.5):
//   "operation": "new" | "add" | "remove" | "intersect"
//   "body":      add / intersect: the body to change (default: the only body)
//   "bodies":    remove: the bodies to cut (default: every body it reaches)
//   "newBody":   new: its name (default: the feature's id)
// Without "operation": "newBody" means new, "body" means add; with neither,
// the feature adds to the part's body if it has one, and starts one if not.
// Document side, pure: validation, the body-name hooks, write scopes. The
// kernel side is applyOperation (src/kernel/operation.ts).

import type { Checker } from "../doc/validate";
import type { BodyHooks, ValidateKit } from "./defs";

export const OPERATIONS = ["new", "add", "remove", "intersect"] as const;
export type Operation = (typeof OPERATIONS)[number];

/** The fields, as a feature type includes them: interface RevolveFeature extends FeatureBase, OperationFields { ... }. */
export interface OperationFields {
  operation?: Operation;
  body?: string;
  bodies?: string[];
  newBody?: string;
}

/** Their keys, for c.keys(raw, "", ["id", "op", ..., ...OPERATION_KEYS]). */
export const OPERATION_KEYS = ["operation", "body", "bodies", "newBody"] as const;

/** What an operation does, once the bodies before it are known. */
export type ResolvedOperation =
  | { kind: "new"; name: string }
  | { kind: "add" | "intersect"; body: string }
  /** bodies: null cuts every body it reaches. */
  | { kind: "remove"; bodies: string[] | null };

/**
 * Checks the operation fields of a raw feature and returns them (only those
 * given), or null with the errors reported. Which fields go with which
 * operation is checked here; whether the bodies exist, when the names are.
 */
export function validateOperation(raw: Record<string, unknown>, c: Checker, x: ValidateKit): OperationFields | null {
  const before = c.errors.length;
  const operation = raw.operation === undefined ? undefined : x.oneOf(raw, "operation", "", OPERATIONS);
  const body = raw.body === undefined ? undefined : x.bodyName(raw.body, "body");
  const bodies = raw.bodies === undefined ? undefined : x.bodyList(raw.bodies, "bodies");
  const newBody = x.newBody(raw);
  const op = operation ?? (newBody !== undefined ? "new" : body !== undefined ? "add" : undefined);
  if (body !== undefined && op !== "add" && op !== "intersect") c.fail("body", `names the body to add to or intersect; with "operation": "${op}" leave it out`);
  if (bodies !== undefined && op !== "remove") c.fail("bodies", `lists the bodies to cut: it goes with "operation": "remove"`);
  if (newBody !== undefined && op !== "new") c.fail("newBody", `names the new body: it goes with "operation": "new"`);
  if (body !== undefined && newBody !== undefined) c.fail("", 'give "body" (add to it) or "newBody" (start one), not both');
  if (c.errors.length > before) return null;
  return {
    ...(operation ? { operation } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(bodies ? { bodies } : {}),
    ...(newBody !== undefined ? { newBody } : {}),
  };
}

/**
 * What the operation does, given the bodies before the feature: or why it
 * cannot ("the part has 2 bodies (a, b); name the one to add to with body").
 */
export function resolveOperation(f: OperationFields & { id: string }, bodies: readonly string[]): ResolvedOperation | { error: string; path: string } {
  const op: Operation = f.operation ?? (f.newBody !== undefined ? "new" : f.body !== undefined || bodies.length > 0 ? "add" : "new");
  switch (op) {
    case "new":
      return { kind: "new", name: f.newBody ?? f.id };
    case "remove":
      if (bodies.length === 0) return { error: "there is no body to cut: nothing is built before this feature", path: "operation" };
      return { kind: "remove", bodies: f.bodies ?? null };
    case "add":
    case "intersect": {
      if (f.body !== undefined) return { kind: op, body: f.body };
      if (bodies.length === 1) return { kind: op, body: bodies[0] };
      const verb = op === "add" ? "add to" : "intersect";
      if (bodies.length === 0) return { error: `there is no body to ${verb}: nothing is built before this feature (use "operation": "new")`, path: "operation" };
      return { error: `the part has ${bodies.length} bodies (${bodies.join(", ")}); name the one to ${verb} with "body"`, path: "body" };
    }
  }
}

/** The body-name hooks of an op with operation fields (its def's `bodies`). */
export function operationBodies<F extends OperationFields & { id: string }>(): BodyHooks<F> {
  return {
    needs: (f) => [...(f.body !== undefined ? [["body", f.body] as [string, string]] : []), ...(f.bodies ?? []).map((b, i) => [`bodies[${i}]`, b] as [string, string])],
    makes(f, { names }) {
      const r = resolveOperation(f, [...names]);
      return "kind" in r && r.kind === "new" ? { names: [r.name], path: f.newBody !== undefined ? "newBody" : "id" } : null;
    },
    problems(f, { names }) {
      const r = resolveOperation(f, [...names]);
      return "error" in r ? [[r.path, r.error]] : [];
    },
    seedBody: (f) => (typeof f.newBody === "string" ? f.newBody : f.operation === "new" && typeof f.id === "string" ? f.id : undefined),
  };
}

/** For a def's onlyBodies: the feature names its bodies, and every one is in the scope. */
export function operationOnlyBodies(raw: Record<string, unknown>, inScope: (name: unknown) => boolean): boolean {
  if (raw.operation === "remove") return Array.isArray(raw.bodies) && raw.bodies.length > 0 && raw.bodies.every(inScope);
  if (raw.newBody !== undefined || raw.operation === "new") return inScope(raw.newBody ?? raw.id);
  return raw.body !== undefined && inScope(raw.body);
}

/** For a def's bodyFromId: a new body named after the feature. */
export function operationBodyFromId(raw: Record<string, unknown>): boolean {
  return raw.operation === "new" && raw.newBody === undefined;
}
