// Test-only registry ops, document side, put in the registry by vi.mock in
// tests/registry-ops.test.ts (they are not part of the app). Like a real
// op's doc.ts, this imports only types (and the pure operation helpers):
// the mock loads it while src/doc/types.ts is still loading.
// - block: a box, with the operation fields (new / add / remove / intersect);
//   patternable, so patterns and mirrors repeat it.
// - probe: reads a sketch the way a sweep or rib would (ctx.sketch,
//   ctx.profiles, ctx.profile), and records what it saw.
// - ghost: a doc def with no kernel.

import type { FeatureBase, Vec3 } from "../src/doc/types";
import type { FeatureDef } from "../src/features/defs";
import { OPERATION_KEYS, operationBodies, operationBodyFromId, operationOnlyBodies, validateOperation, type OperationFields } from "../src/features/operation";

export interface BlockFeature extends FeatureBase, OperationFields {
  op: "block";
  at: Vec3;
  size: Vec3;
}

export const blockDef: FeatureDef<BlockFeature> = {
  op: "block",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "at", "size", ...OPERATION_KEYS]);
    const at = c.vec3(raw, "at", "");
    const size = c.vec3(raw, "size", "");
    if (size && !size.every((s) => s > 0)) c.fail("size", "must be three lengths over 0");
    const operation = validateOperation(raw, c, x);
    if (c.errors.length || !at || !size || !operation) return null;
    return { id: raw.id as string, op: "block", at, size, ...operation };
  },
  bodies: operationBodies<BlockFeature>(),
  onlyBodies: (raw, inScope) => operationOnlyBodies(raw, inScope),
  bodyFromId: operationBodyFromId,
  patternable: true,
  measurementKeys: ["size"],
  reference: '## block\n{ "id": "block_1", "op": "block", "at": [0,0,0], "size": [10,10,10] } (test only)\n',
};

export interface ProbeFeature extends FeatureBase {
  op: "probe";
  sketch: string;
}

export const probeDef: FeatureDef<ProbeFeature> = {
  op: "probe",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "sketch"]);
    const sketch = x.sketch(raw.sketch, "sketch");
    return sketch && !c.errors.length ? { id: raw.id as string, op: "probe", sketch } : null;
  },
  references: (raw) => (typeof raw.sketch === "string" ? [raw.sketch] : []),
  reference: "## probe\n(test only)\n",
};

export const ghostDef: FeatureDef<FeatureBase & { op: "ghost" }> = {
  op: "ghost",
  validate(raw, c) {
    c.keys(raw, "", ["id", "op"]);
    return { id: raw.id as string, op: "ghost" };
  },
  reference: "## ghost\n(test only)\n",
};
