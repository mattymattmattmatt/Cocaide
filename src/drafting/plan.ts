// New drawing (Phase L): code plans the first sheet, not the model. Front, top
// and right views and an iso; the overall size dimensioned; every hole called
// out and placed; a balloon for every cut list item, on the member of it the
// iso shows best; the cut list and weld tables; the title block. The sheet
// size is A3, the scale whatever fits.

import type { DrawingGeometry } from "../ask/kernel";
import type { Annotation, Drawing, DrawingView, Vec3, ViewLook } from "../doc/types";
import { validateDocument } from "../doc/validate";
import type { Measurements } from "../kernel/measure";
import { cutList } from "../weldment/cutlist";
import { inView, viewFrame } from "./views";

export const DEFAULT_VIEWS: { id: string; look: ViewLook }[] = [
  { id: "front", look: "front" },
  { id: "top", look: "top" },
  { id: "right", look: "right" },
  { id: "iso", look: "iso" },
];

export interface PlanOptions {
  /** The title block's date, "2026-10-08". */
  date?: string;
}

/** The default drawing of the part. `geometry` is the part projected for DEFAULT_VIEWS. */
export function planDrawing(doc: unknown, m: Measurements | null, geometry: DrawingGeometry | null, opts: PlanOptions = {}): Drawing {
  const v = validateDocument(doc);
  const members = m?.members ?? [];
  const weldment = members.length > 0;
  // Hollow sections fill a view with hidden lines; a plate's hidden holes are worth showing.
  const views: DrawingView[] = DEFAULT_VIEWS.map((d) => ({ ...d, ...(d.look !== "iso" && !weldment ? { hidden: true } : {}) }));
  const annotations: Annotation[] = [];
  let n = 0;
  const id = (prefix: string) => `${prefix}${++n}`;

  // The overall size: length and height on the front, width on the right.
  annotations.push({ id: id("d"), type: "dimension", view: "front", from: "@left", to: "@right" });
  annotations.push({ id: id("d"), type: "dimension", view: "front", from: "@bottom", to: "@top" });
  annotations.push({ id: id("d"), type: "dimension", view: "right", from: "@left", to: "@right" });

  // Each hole, called out and placed from the view's left and bottom where it shows as a circle.
  for (const h of geometry?.holes ?? []) {
    const view = views.find((x) => x.look !== "iso" && facing(h.axis, x.look));
    if (!view) continue;
    annotations.push({ id: id("h"), type: "hole", view: view.id, hole: h.feature });
    const at = inView(h.entry, viewFrame(view.look));
    const outline = outlineOf(geometry, view.id);
    if (outline && at[0] - outline.min[0] > 1e-6) annotations.push({ id: id("d"), type: "dimension", view: view.id, from: "@left", to: h.feature });
    if (outline && at[1] - outline.min[1] > 1e-6) annotations.push({ id: id("d"), type: "dimension", view: view.id, from: "@bottom", to: h.feature });
  }

  // A balloon per cut list item, on the member of it the iso shows most of.
  const items = cutList(members);
  for (const item of items) {
    const best = item.members
      .map((mid) => ({ mid, seen: visibleLength(geometry, "iso", members.find((x) => x.id === mid)!.body) }))
      .sort((a, b) => b.seen - a.seen)[0];
    annotations.push({ id: id("b"), type: "balloon", view: "iso", member: best.mid });
  }
  for (const w of v.welds) annotations.push({ id: id("w"), type: "weld", view: "front", weld: w.id });
  if (items.length) annotations.push({ id: "cut_list", type: "table", table: "cutList" });
  if (v.welds.length) annotations.push({ id: "weld_table", type: "table", table: "welds" });

  return {
    sheet: { size: "A3", projection: "third", title: v.name, ...(opts.date ? { date: opts.date } : {}) },
    views,
    annotations,
  };
}

function facing(axis: Vec3, look: ViewLook): boolean {
  const e = viewFrame(look).eye;
  return Math.abs(axis[0] * e[0] + axis[1] * e[1] + axis[2] * e[2]) > 0.999;
}

function outlineOf(g: DrawingGeometry | null, view: string): { min: [number, number]; max: [number, number] } | null {
  const pv = g?.views.find((x) => x.id === view);
  if (!pv) return null;
  let min: [number, number] = [Infinity, Infinity];
  let max: [number, number] = [-Infinity, -Infinity];
  for (const b of pv.bodies) for (const line of [...b.visible, ...b.hidden]) for (const p of line) {
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])];
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** How much of a body's outline a view shows, mm. */
export function visibleLength(g: DrawingGeometry | null, view: string, body: string): number {
  const b = g?.views.find((x) => x.id === view)?.bodies.find((x) => x.name === body);
  let total = 0;
  for (const line of b?.visible ?? []) for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return total;
}
