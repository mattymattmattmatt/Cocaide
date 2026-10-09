// The registry's ops, document side: one import line and one array line per
// op. Git merges this file by union (.gitattributes), so only ever append
// whole lines (an import above the array, an entry inside it); never reorder
// or rewrite existing ones. See defs.ts for what an op's doc.ts exports.

import { def as scale } from "./scale/doc";

export const DOC_DEFS = [
  scale,
];
