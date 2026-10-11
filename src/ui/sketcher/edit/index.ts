// The sketch edit tools, in toolbar order (tools sharing a flyout sit
// together; the first of a flyout is its default). To add tools: one import
// line and one array line per module, appended at the end of each block
// (append only, as in ../tools/index.ts).

import type { EditToolDef } from "./types";
import { tools as trim } from "./trim";
import { tools as corner } from "./corner";
import { tools as offset } from "./offset";
import { tools as mirror } from "./mirror";
import { tools as pattern } from "./pattern";
import { tools as move } from "./move";

const LISTS: EditToolDef[][] = [
  trim,
  corner,
  offset,
  mirror,
  pattern,
  move,
];

export const EDIT_TOOLS: EditToolDef[] = LISTS.flat();

export function editByName(name: string): EditToolDef | undefined {
  return EDIT_TOOLS.find((t) => t.name === name);
}
