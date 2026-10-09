// Every feature op's UI (src/features/<op>/ui.tsx). To add an op: one import
// line and one array line, appended at the end of each block. Never reorder or
// rewrite lines here: this file merges by union (.gitattributes), so parallel
// branches each keep their own lines.

import type { UiOp } from "./uiDefs";
import { ui as fillet } from "./fillet/ui";
import { ui as chamfer } from "./chamfer/ui";
import { ui as linearPattern } from "./linearPattern/ui";
import { ui as circularPattern } from "./circularPattern/ui";
import { ui as plane } from "./plane/ui";
import { ui as axis } from "./axis/ui";
import { ui as point } from "./point/ui";

export const UI_OP_LIST: UiOp[] = [
  fillet,
  chamfer,
  linearPattern,
  circularPattern,
  plane,
  axis,
  point,
];
