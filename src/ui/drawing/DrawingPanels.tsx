// Drawing ids (Phase L): the sheet editor itself is src/ui/drawing/Workspace.tsx (wave Q2B).

import type { Drawing } from "../../doc/types";

/** The next free id with this prefix: views and annotations of every sheet share their ids (and `taken`, ids about to be used). */
export function nextDrawingId(d: Drawing, prefix: string, taken: Set<string> = new Set()): string {
  const used = new Set([...taken, ...d.sheets.flatMap((s) => [...s.views.map((v) => v.id), ...s.annotations.map((a) => a.id), ...(s.tables ?? []).map((t) => t.id)])]);
  let n = 1;
  for (const id of used) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
