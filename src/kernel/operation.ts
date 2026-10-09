// The kernel side of the operation fields (DESIGN §2.5, src/features/operation.ts):
// a shape-making registry op builds its tool, then applyOperation puts it in
// the part as a new body, added to a body, cut from bodies, or intersected
// with a body, commits the change and leaves the tool for patterns and
// mirrors of the feature.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { RebuildCtx } from "../features/kernelDefs";
import { resolveOperation, type OperationFields, type ResolvedOperation } from "../features/operation";
import type { Scope } from "./oc";
import { commonWith, fuseInto, OpError, removeFrom } from "./ops";

/**
 * Applies the feature's tool by its operation and commits it, all or none.
 * `what` names the feature in messages ("revolve"). `tool` belongs to `s`.
 * Returns what the operation did.
 */
export function applyOperation(ctx: RebuildCtx, s: Scope, f: OperationFields & { id: string }, tool: TopoDS_Shape, what: string): ResolvedOperation {
  const { oc } = ctx;
  const r = resolveOperation(f, [...ctx.bodies.keys()]);
  if ("error" in r) throw new OpError(r.error);
  switch (r.kind) {
    case "new":
      if (ctx.bodies.has(r.name)) throw new OpError(`a body "${r.name}" already exists; name the new body with "newBody", or add to it with "operation": "add"`);
      ctx.commit(new Map([[r.name, fuseInto(oc, s, null, tool, what)]]));
      ctx.setSeed(f.id, { tool, kind: "fuse", newBody: r.name });
      break;
    case "add":
      ctx.commit(new Map([[r.body, fuseInto(oc, s, ctx.need(r.body), tool, what)]]));
      ctx.setSeed(f.id, { tool, kind: "fuse", into: r.body });
      break;
    case "remove":
      ctx.commit(removeFrom(oc, s, ctx.targets(r.bodies), tool, { listed: !!r.bodies, what, missed: `the ${what} does not reach ${r.bodies ? "the bodies it lists" : "the part"}` }));
      ctx.setSeed(f.id, { tool, kind: "cut", bodies: r.bodies });
      break;
    case "intersect":
      ctx.commit(new Map([[r.body, commonWith(oc, s, r.body, ctx.need(r.body), tool, what)]]));
      break;
  }
  return r;
}
