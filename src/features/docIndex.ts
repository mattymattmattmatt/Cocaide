// The registry's ops, document side: one import line and one array line per
// op. Git merges this file by union (.gitattributes), so only ever append
// whole lines (an import above the array, an entry inside it); never reorder
// or rewrite existing ones. See defs.ts for what an op's doc.ts exports.

import { def as scale } from "./scale/doc";
import { def as plane } from "./plane/doc";
import { def as axis } from "./axis/doc";
import { def as point } from "./point/doc";
import { def as revolve } from "./revolve/doc";
import { def as shell } from "./shell/doc";
import { def as draft } from "./draft/doc";

export const DOC_DEFS = [
  scale,
  plane,
  axis,
  point,
  revolve,
  shell,
  draft,
];
