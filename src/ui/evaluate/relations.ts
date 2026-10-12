// Parents and children of a feature, for the tree's hover highlight: what a
// feature is built on (the sketch it extrudes, the feature it patterns, the
// planes it stands on, the sketch dimensions its expressions read) and what
// is built on it. Pure.

import { references } from "../../doc/commands";
import { parameterRefs } from "../../doc/parameters";
import type { Raw } from "../model/ToolContext";

/** The features this one uses, in document order. */
export function parentsOf(features: Raw[], id: string): string[] {
  const f = features.find((g) => g.id === id);
  if (!f) return [];
  const ids = new Set(features.map((g) => String(g.id)));
  const out = new Set<string>(references(f).filter((r) => ids.has(r) && r !== id));
  // An expression reading "sketch_1.width" uses sketch_1.
  for (const name of parameterRefs(f)) {
    const owner = name.includes(".") ? name.slice(0, name.indexOf(".")) : null;
    if (owner && ids.has(owner) && owner !== id) out.add(owner);
  }
  return features.map((g) => String(g.id)).filter((g) => out.has(g));
}

/** The features that use this one. */
export function childrenOf(features: Raw[], id: string): string[] {
  return features.map((g) => String(g.id)).filter((g) => g !== id && parentsOf(features, g).includes(id));
}
