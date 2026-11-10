// New drawing (Phase L; Phase Q makes it smarter): code plans the first
// sheet, not the model. A front view, the top and right views projected from
// it (so they stay lined up), and an iso. A part with hidden insides has its
// front view drawn as a full section, cut along the top view through the most
// holes; small, crowded features
// get a detail at a larger scale. The overall size dimensioned; every hole
// called out and placed; centre marks on the circles and centre lines on the
// round faces seen from the side; a balloon for every cut list item, on the
// member of it the iso shows best; the cut list and weld tables; an ISO title
// block with the general tolerance (ISO 2768-mK for a part, ISO 13920-BF for
// a weldment). The sheet is A3, the scale whatever fits — stored on the sheet
// (Phase Q wave Q4), so that moving views never changes it.

import type { DrawingGeometry } from "../ask/kernel";
import { parseScale, STANDARD_SCALES } from "../doc/drawing";
import type { Annotation, Drawing, DrawingView, Vec2, ViewLook } from "../doc/types";
import { validateDocument } from "../doc/validate";
import type { Measurements } from "../kernel/measure";
import type { ViewSpec } from "../kernel/drawingViews";
import { cutList } from "../weldment/cutlist";
import { autoDimension } from "./autodim";
import { composeSheet } from "./compose";
import { withShownScales } from "./fit";
import { inView, viewFrame } from "./views";

/** What New drawing projects first: the planned views' looks. */
export const DEFAULT_VIEWS: (ViewSpec & { look: ViewLook })[] = [
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
  const hidden = !weldment ? { display: "hidden" as const } : {};
  const look: Record<string, ViewLook> = { front: "front", top: "top", right: "right", iso: "iso" };
  const views: DrawingView[] = [
    { id: "front", look: "front", ...hidden },
    { id: "top", kind: "projected", parent: "front", direction: "up", ...hidden },
    { id: "right", kind: "projected", parent: "front", direction: "right", ...hidden },
    { id: "iso", look: "iso" },
  ];
  const annotations: Annotation[] = [];
  let n = 0;
  const id = (prefix: string) => `${prefix}${++n}`;

  // Hidden insides: the front view becomes a full section, cut along the top view through the most holes (or the middle).
  const top = geometry?.views.find((x) => x.id === "top");
  const topOutline = outlineOf(geometry, "top");
  const insides = visibleLength(geometry, "front", null, true) + visibleLength(geometry, "right", null, true);
  if (!weldment && top && topOutline && insides > 1e-6) {
    const mid = (topOutline.min[1] + topOutline.max[1]) / 2;
    // Each line across the top view through a circle's centre, scored by the circles on it.
    const score = new Map<number, number>();
    for (const e of top.edges) {
      if (!e.circle || e.look !== "circle") continue;
      const y = Math.round(e.circle.c[1] * 1000) / 1000;
      if (y <= topOutline.min[1] + 1e-6 || y >= topOutline.max[1] - 1e-6) continue;
      score.set(y, (score.get(y) ?? 0) + 1);
    }
    const best = [...score].sort((p, q) => q[1] - p[1] || Math.abs(p[0] - mid) - Math.abs(q[0] - mid))[0];
    const y = best ? best[0] : mid;
    const w = topOutline.max[0] - topOutline.min[0];
    const h = topOutline.max[1] - topOutline.min[1];
    const margin = Math.max(2, 0.08 * Math.max(w, h));
    // Drawn right to left, the viewer stands at the front: the section is the front view.
    views[0] = { id: "top", look: "top", ...hidden };
    views[1] = { id: "front", kind: "section", parent: "top", line: [r2([topOutline.max[0] + margin, y]), r2([topOutline.min[0] - margin, y])], label: "A" };
  }
  const generalTolerance = weldment ? "ISO 13920-BF" : "ISO 2768-mK";
  let planned = views;
  if (!weldment) {
    // The auto-dimension engine v2 (src/drafting/autodim.ts): sizes and places from the features' intent.
    const r = autoDimension({ v, m, geometry, views, looks: look, id, generalTolerance });
    planned = views.filter((x) => !r.unneeded.includes(x.id));
    annotations.push(...r.annotations);
  }
  /** A weldment's member lengths: after its balloons and welds (they keep the ids they had). */
  const lengths: Annotation[] = [];
  if (weldment) {
    // The overall size: length and height on the front, width on the side.
    annotations.push({ id: id("d"), type: "dimension", view: "front", from: "@left", to: "@right" });
    annotations.push({ id: id("d"), type: "dimension", view: "front", from: "@bottom", to: "@top" });
    annotations.push({ id: id("d"), type: "dimension", view: "right", from: "@left", to: "@right" });
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
  if (weldment) {
    // Each cut list item's length once, where a member of it lies flat in the front and its length is not an overall size.
    const bb = m?.boundingBox?.size;
    const f = viewFrame("front");
    for (const item of cutList(members)) {
      const mem = item.members.map((mid) => members.find((x) => x.id === mid)!).find((x) => {
        const d = inView(x.ends[1], f).map((c, i) => c - inView(x.ends[0], f)[i]);
        return Math.abs(Math.hypot(d[0], d[1]) - x.length) < 1e-3 && (Math.abs(d[0]) < 1e-6 || Math.abs(d[1]) < 1e-6);
      });
      if (!mem || (bb && bb.some((s) => Math.abs(s - mem.length) < 0.05))) continue;
      lengths.push({ id: id("d"), type: "dimension", view: "front", member: mem.id });
    }
    annotations.push(...lengths);
  }
  if (weldment) {
    const lines = [`GENERAL TOLERANCES ${generalTolerance}.`, "WELDS TO ISO 2553; REMOVE SPATTER AND SLAG.", "BREAK ALL SHARP EDGES.", "DIMENSIONS IN MILLIMETRES. DO NOT SCALE."];
    annotations.push({ id: "general_notes", type: "note", text: lines.join("\n"), at: [0, 0], numbered: true, title: "NOTES:" });
  }
  if (items.length) annotations.push({ id: "cut_list", type: "table", table: "cutList" });
  if (v.welds.length) annotations.push({ id: "weld_table", type: "table", table: "welds" });

  const drawing: Drawing = {
    sheets: [{ id: "sheet1", format: { size: "A3", template: "iso", ...(opts.date ? { date: opts.date } : {}) }, projection: "third", views: planned, annotations }],
    standard: "ISO",
    generalTolerance,
  };
  placeNotes(doc, drawing, m, geometry);
  addDetail(doc, drawing, m, geometry);
  keepPlannedScale(doc, drawing, m, geometry);
  return drawing;
}

/** The scale the sheet came out at, stored (Phase Q wave Q4): from now on only the user changes it. */
function keepPlannedScale(doc: unknown, drawing: Drawing, m: Measurements | null, geometry: DrawingGeometry | null): void {
  if (!geometry) return;
  const sheet = composeSheet({ ...(doc as object), drawing }, { measurements: m, geometry });
  if (sheet) drawing.sheets[0] = withShownScales(drawing.sheets[0], sheet);
}

/** The general notes block: in the sheet's lower left corner, inside its border. */
function placeNotes(doc: unknown, drawing: Drawing, m: Measurements | null, geometry: DrawingGeometry | null): void {
  const s = drawing.sheets[0];
  const note = s.annotations.find((a) => a.id === "general_notes");
  if (!note || note.type !== "note") return;
  const sheet = composeSheet({ ...(doc as object), drawing: { ...drawing, sheets: [{ ...s, annotations: s.annotations.filter((a) => a !== note) }] } }, { measurements: m, geometry });
  if (!sheet) return;
  const lines = note.text.split("\n").length;
  // In the lower left corner, above any table along the bottom border there.
  const h = lines * 4.9 + 7;
  const x0 = sheet.frame.min[0] + 6;
  let y0 = sheet.frame.min[1] + 4;
  for (const b of [...sheet.blocks.map((x) => x.box), sheet.titleBlock]) if (b.min[0] < x0 + 120 && b.max[0] > x0 && b.min[1] < y0 + h) y0 = Math.max(y0, b.max[1] + 4);
  note.at = [Math.round(x0), Math.round(y0 + 3 + lines * 4.9)];
}

/**
 * A detail for small, crowded features: circles the sheet's scale draws under
 * 3 mm across, in the front or top view, gathered in one circle and drawn at
 * a scale that makes the smallest at least 6 mm.
 */
function addDetail(doc: unknown, drawing: Drawing, m: Measurements | null, geometry: DrawingGeometry | null): void {
  if (!geometry || !m || (m.members?.length ?? 0) > 0) return;
  const sheet = composeSheet({ ...(doc as object), drawing }, { measurements: m, geometry });
  if (!sheet) return;
  const scale = sheet.scale;
  let best: { view: string; small: { c: Vec2; r: number }[] } | null = null;
  for (const id of ["front", "top"]) {
    const pv = geometry.views.find((x) => x.id === id);
    if (!pv) continue;
    const small: { c: Vec2; r: number }[] = [];
    for (const e of pv.edges) {
      if (!e.visible || e.look !== "circle" || !e.circle) continue;
      if (2 * e.circle.r * scale >= 3) continue;
      if (small.some((s) => Math.hypot(s.c[0] - e.circle!.c[0], s.c[1] - e.circle!.c[1]) < 1e-6)) continue;
      small.push({ c: e.circle.c, r: e.circle.r });
    }
    if (small.length && (!best || small.length > best.small.length)) best = { view: id, small };
  }
  if (!best) return;
  // Around the first, the ones within 12 mm of paper.
  const first = best.small[0];
  const group = best.small.filter((s) => Math.hypot(s.c[0] - first.c[0], s.c[1] - first.c[1]) * scale < 12);
  const c: Vec2 = [group.reduce((a, s) => a + s.c[0], 0) / group.length, group.reduce((a, s) => a + s.c[1], 0) / group.length];
  const r = Math.max(...group.map((s) => Math.hypot(s.c[0] - c[0], s.c[1] - c[1]) + s.r)) * 1.8 + 2 / scale;
  const rmin = Math.min(...group.map((s) => s.r));
  const want = Math.max(scale * 2, 6 / (2 * rmin));
  const scales = STANDARD_SCALES.map((x) => parseScale(x)!).sort((a, b) => a - b);
  const k = scales.find((x) => x >= want - 1e-9) ?? scales[scales.length - 1];
  const s = drawing.sheets[0];
  const label = s.views.some((x) => x.label === "A") ? "B" : "A";
  s.views.push({ id: `detail_${label}`, kind: "detail", parent: best.view, circle: { at: r2(c), r: Math.round(r * 10) / 10 }, label, scale: k >= 1 ? `${k}:1` : `1:${Math.round(1 / k)}` });
}

function r2(p: Vec2): Vec2 {
  return [Math.round(p[0] * 100) / 100 + 0, Math.round(p[1] * 100) / 100 + 0];
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

/** How much of a body's outline (or every body's, `body` null) a view shows, mm; its hidden lines with `hidden`. */
export function visibleLength(g: DrawingGeometry | null, view: string, body: string | null, hidden = false): number {
  const pv = g?.views.find((x) => x.id === view);
  let total = 0;
  for (const b of pv?.bodies ?? []) {
    if (body !== null && b.name !== body) continue;
    for (const line of hidden ? b.hidden : b.visible) for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  }
  return total;
}
