// The sketch tools, in toolbar order (tools sharing a flyout sit together;
// the first of a flyout is its default). To add tools: one import line and
// one array line per module, appended at the end of each block. Never
// reorder or rewrite lines here: this file merges by union (.gitattributes),
// so parallel branches each keep their own lines.

import type { SketchToolDef } from "./types";
import { tools as lines } from "./lines";
import { tools as rectangles } from "./rectangles";
import { tools as circles } from "./circles";
import { tools as arcs } from "./arcs";
import { tools as slots } from "./slots";
import { tools as polygon } from "./polygon";
import { tools as point } from "./point";

const LISTS: SketchToolDef[][] = [
  lines,
  rectangles,
  circles,
  arcs,
  slots,
  polygon,
  point,
];

export const SKETCH_TOOLS: SketchToolDef[] = LISTS.flat();
