// The Evaluate tools' kernel queries, on a rebuild the worker already has
// (the document on screen): Measure's closest points and Mass Properties.
// Plain data in and out; shared with tests.

import { validateDocument } from "../doc/validate";
import { massProperties, minDistance } from "../kernel/evaluate";
import type { OC } from "../kernel/oc";
import type { RebuildResult } from "../kernel/rebuild";
import type { EvaluateQuery, EvaluateResult } from "./protocol";

export function evaluate(oc: OC, built: RebuildResult, doc: unknown, query: EvaluateQuery): EvaluateResult {
  if (query.kind === "distance") return { kind: "distance", closest: minDistance(oc, built.solid, query.a, query.b) };
  const v = validateDocument(doc);
  return { kind: "mass", mass: massProperties(oc, built.bodies, v.material, v.bodyMaterials) };
}
