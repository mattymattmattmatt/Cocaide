// The registry's ops, kernel side: one import line and one array line per
// op. Git merges this file by union (.gitattributes), so only ever append
// whole lines (an import above the array, an entry inside it); never reorder
// or rewrite existing ones. See kernelDefs.ts for what an op's kernel.ts exports.

import { kernel as scale } from "./scale/kernel";
import { kernel as plane } from "./plane/kernel";
import { kernel as axis } from "./axis/kernel";
import { kernel as point } from "./point/kernel";

export const KERNEL_DEFS = [
  scale,
  plane,
  axis,
  point,
];
