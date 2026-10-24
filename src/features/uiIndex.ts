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
import { ui as revolve } from "./revolve/ui";
import { ui as shell } from "./shell/ui";
import { ui as draft } from "./draft/ui";
import { ui as scale } from "./scale/ui";
import { ui as sweep } from "./sweep/ui";
import { ui as loft } from "./loft/ui";
import { ui as rib } from "./rib/ui";
import { ui as sketchPattern } from "./sketchPattern/ui";
import { ui as hole } from "./hole/ui";
import { ui as importOp } from "./import/ui";

export const UI_OP_LIST: UiOp[] = [
  fillet,
  chamfer,
  linearPattern,
  circularPattern,
  plane,
  axis,
  point,
  revolve,
  shell,
  draft,
  scale,
  sweep,
  loft,
  rib,
  sketchPattern,
  hole,
  importOp,
];
