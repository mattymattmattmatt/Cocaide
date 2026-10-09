// The typed features of the registry's ops, for the document's Feature union
// (src/doc/types.ts). Derived from docIndex.ts, so a new op adds nothing here.

import type { FeatureDef } from "./defs";
import { DOC_DEFS } from "./docIndex";

/** The feature type a def validates to. */
type FeatureOf<D> = D extends FeatureDef<infer F> ? F : never;

/** Every registry op's typed feature, as a union (its `op` strings are disjoint from the built-in ops'). */
export type PluginFeature = FeatureOf<(typeof DOC_DEFS)[number]>;

/** The registry's ops, in index order. */
export const PLUGIN_OPS: readonly PluginFeature["op"][] = DOC_DEFS.map((d) => d.op);
