// loft: a solid that passes through sketch profiles in order (DESIGN §2.6),
// joining each to the next smoothly, or with straight lines ("ruled"), and
// back to the first ("closed", a ring). A sketch holding just one point may
// be the first or last section (a pointed loft: a pyramid, a cone). The
// operation fields make it a new body, add to one, cut (a lofted cut) or
// intersect.

import type { FeatureBase } from "../../doc/types";
import type { FeatureDef } from "../defs";
import { OPERATION_KEYS, operationBodies, operationBodyFromId, operationOnlyBodies, validateOperation, type OperationFields } from "../operation";

export interface LoftFeature extends FeatureBase, OperationFields {
  op: "loft";
  /** The sketches it passes through, in order (2 or more): each a closed profile of one region, or one point at either end. */
  profiles: string[];
  /** Straight between sections, not a smooth blend. */
  ruled?: boolean;
  /** Back from the last section to the first (3 or more sections): a ring. */
  closed?: boolean;
}

export const def: FeatureDef<LoftFeature> = {
  op: "loft",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "profiles", "ruled", "closed", ...OPERATION_KEYS]);
    let profiles: string[] | undefined;
    if (!Array.isArray(raw.profiles)) c.fail("profiles", `must be a list of 2 or more sketch ids, in the order the loft passes through them (got ${x.describe(raw.profiles)})`);
    else if (raw.profiles.length < 2) c.fail("profiles", `a loft passes through 2 or more sketches (got ${raw.profiles.length})`);
    else {
      const ids = raw.profiles.map((p, i) => x.sketch(p, `profiles[${i}]`));
      raw.profiles.forEach((p, i) => {
        if (raw.profiles && (raw.profiles as unknown[]).indexOf(p) < i) c.fail(`profiles[${i}]`, `"${String(p)}" is listed twice: each sketch is one section`);
      });
      if (ids.every((id): id is string => id !== undefined)) profiles = ids;
    }
    const ruled = x.bool(raw, "ruled", "");
    const closed = x.bool(raw, "closed", "");
    if (closed && Array.isArray(raw.profiles) && raw.profiles.length < 3) c.fail("closed", "a closed loft goes round through 3 or more sections and back to the first");
    const operation = validateOperation(raw, c, x);
    if (c.errors.length || !profiles || !operation) return null;
    return { id: raw.id as string, op: "loft", profiles, ...(ruled ? { ruled } : {}), ...(closed ? { closed } : {}), ...operation };
  },
  references: (raw) => (Array.isArray(raw.profiles) ? raw.profiles.filter((p): p is string => typeof p === "string") : []),
  bodies: operationBodies<LoftFeature>(),
  onlyBodies: (raw, inScope) => operationOnlyBodies(raw, inScope),
  bodyFromId: operationBodyFromId,
  patternable: true,
  reference: `## loft
{ "id": "loft_1", "op": "loft", "profiles": ["sketch_1", "sketch_2"], "ruled": false (optional), "closed": false (optional) }
A solid through the sketches in "profiles", in that order (2 or more, each a closed profile of ONE region, usually on
parallel planes: Top and a plane feature offset from it; any planes work). Holes are lofted too when every section has
the same number. A sketch holding just one point (no curves) may be the first or last section: a pointed loft (a pyramid,
a cone). Each section's loop is lined up with the one before (the same way round, starting at the corner nearest the
previous start), so drawing order does not twist it. "ruled": true joins sections with straight lines (a frustum between
two parallel squares: volume h/3 x (A1 + A2 + sqrt(A1 x A2)); a pyramid to a point: A x h/3); otherwise a smooth blend
through all of them. "closed": true goes on from the last section back to the first (3 or more sections, around a ring).
Operation fields: "operation": "new" | "add" | "remove" (a lofted cut) | "intersect" (default: add to the part's body if
there is one, else a new body); "body", "bodies", "newBody" as for revolve. A pattern or mirror can repeat it.
`,
};
