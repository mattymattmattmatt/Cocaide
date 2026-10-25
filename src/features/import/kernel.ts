// import, kernel side: the STEP text read into solids (src/kernel/step.ts
// readStepSolids: units to mm, repaired, surfaces sewn), placed (turned about
// X, then Y, then Z, about the file's origin, then moved by `at`) and each
// committed as a body. Reading a big file takes a while, so the solids of the
// last few files are kept between rebuilds (per kernel instance): editing a
// later feature does not read the file again.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../../doc/types";
import type { OC } from "../../kernel/oc";
import { scoped } from "../../kernel/oc";
import { identity, OpError, pnt, dir, transformed, vec } from "../../kernel/ops";
import { readStepSolids, StepImportError } from "../../kernel/step";
import type { KernelOp } from "../kernelDefs";
import { importBodies, type ImportFeature } from "./doc";

/** The solids read from each recent file, by its text, per kernel instance (a recycled kernel starts afresh). */
const cache = new WeakMap<OC, Map<string, TopoDS_Shape[]>>();
const KEEP = 3;

/** The file's solids, unplaced: read once, then from the cache. Owned by the cache: never delete them. */
export function stepSolids(oc: OC, data: string): TopoDS_Shape[] {
  let files = cache.get(oc);
  if (!files) cache.set(oc, (files = new Map()));
  const hit = files.get(data);
  if (hit) {
    // Most recently used last.
    files.delete(data);
    files.set(data, hit);
    return hit;
  }
  let solids: TopoDS_Shape[];
  try {
    solids = readStepSolids(oc, data).solids;
  } catch (e) {
    if (e instanceof StepImportError) throw new OpError(e.message);
    throw e;
  }
  files.set(data, solids);
  while (files.size > KEEP) {
    const [oldest, shapes] = files.entries().next().value!;
    files.delete(oldest);
    for (const sh of shapes) sh.delete();
  }
  return solids;
}

const DEG = Math.PI / 180;

export const kernel: KernelOp<ImportFeature> = {
  op: "import",
  run(ctx, f) {
    const { oc } = ctx;
    const solids = stepSolids(oc, f.data);
    const names = importBodies(f, solids.length);
    const taken = names.filter((n) => ctx.bodies.has(n));
    if (taken.length) {
      throw new OpError(
        `body ${taken.map((n) => `"${n}"`).join(", ")} already exist${taken.length === 1 ? "s" : ""}; name the imported bod${solids.length === 1 ? "y" : "ies"} with newBody`,
      );
    }
    scoped((s) => {
      // The solids were checked when the file was read; turning and moving them keeps them whole.
      const still = !(f.rotate ?? [0, 0, 0]).some((x) => x % 360 !== 0) && !(f.at ?? [0, 0, 0]).some((x) => x !== 0);
      const t = still ? null : placementTrsf(ctx.oc, s, f.rotate ?? [0, 0, 0], f.at ?? [0, 0, 0]);
      const changed = new Map<string, TopoDS_Shape>();
      solids.forEach((solid, i) => changed.set(names[i], t ? transformed(oc, s, solid, t) : solid));
      ctx.commit(changed);
    });
  },
};

/** Turn about X, then Y, then Z (degrees, about the origin), then move by `at`. */
export function placementTrsf(oc: OC, s: Parameters<typeof identity>[1], rotate: Vec3, at: Vec3) {
  const t = identity(oc, s);
  const axes: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  axes.forEach((axis, k) => {
    if (!rotate[k]) return;
    const r = identity(oc, s);
    r.SetRotation(s.track(new oc.gp_Ax1(pnt(oc, s, [0, 0, 0]), dir(oc, s, axis))), rotate[k] * DEG);
    // PreMultiply: this turn comes after the ones before it.
    t.PreMultiply(r);
  });
  if (at[0] || at[1] || at[2]) {
    const m = identity(oc, s);
    m.SetTranslation(vec(oc, s, at));
    t.PreMultiply(m);
  }
  return t;
}
