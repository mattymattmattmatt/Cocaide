// The model tools, in toolbar order within each tab's groups. To add tools:
// one import line and one array line per module, appended at the end of each
// block. Never reorder or rewrite lines here: this file merges by union
// (.gitattributes), so parallel branches each keep their own lines.

import type { ToolDef } from "../ToolContext";
import { tools as sketch } from "./sketch";
import { tools as extrude } from "./extrude";
import { tools as hole } from "./hole";
import { tools as edges } from "./edges";
import { tools as pattern } from "./pattern";
import { tools as mirror } from "./mirror";
import { tools as bodies } from "./bodies";
import { tools as member } from "./member";

const LISTS: ToolDef[][] = [
  sketch,
  extrude,
  hole,
  edges,
  pattern,
  mirror,
  bodies,
  member,
];

export const MODEL_TOOLS: ToolDef[] = LISTS.flat();
