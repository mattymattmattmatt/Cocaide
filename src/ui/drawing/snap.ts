// What the pointer is over on the sheet (Phase Q wave Q2B): the edges,
// vertices, circle centres, quadrants and midpoints of the views' geometry,
// each as the GeoRef an annotation attaches to (src/drafting/georef.ts), with
// a glyph and words for the tooltip: "Edge of hole_1 (circle Ø6.6)". Points
// win over edges near them, as in the 3D view a vertex wins over its edges;
// a hidden edge is offered only where the view draws hidden lines.

import type { GeoRef, Vec2 } from "../../doc/types";
import type { ComposedSheet } from "../../drafting/compose";
import { fmt } from "../../drafting/compose";
import { listGeoRefs, resolveGeoRef, type GeoRefInfo } from "../../drafting/georef";

export type SnapKind = "vertex" | "centre" | "quadrant" | "midpoint" | "edge" | "circle" | "arc";

/** One thing on the sheet the pointer can snap to. Sheet mm (y up). */
export interface SnapTarget {
  ref: GeoRef;
  view: string;
  kind: SnapKind;
  /** The snap point: the point itself, or the nearest point on an edge. */
  at: Vec2;
  /** An edge's pieces on the sheet (to highlight), or a circle. */
  pts?: Vec2[][];
  circle?: { c: Vec2; r: number };
  visible: boolean;
  feature?: string;
  /** The body it is an edge of (a weldment's member's body). */
  body?: string;
  /** What it is in words, for the tooltip and the status bar. */
  label: string;
}

/** Every snap target of a sheet, per view, worked out once per composed sheet. */
export interface SnapIndex {
  sheet: string;
  targets: SnapTarget[];
}

const POINT_KINDS: SnapKind[] = ["vertex", "centre", "quadrant", "midpoint"];

/** The feature an edge key names ("hole_1/c0" → hole_1), for edges the kernel didn't attribute. */
function featureOf(info: { feature?: string; ref: string }): string {
  if (info.feature) return info.feature;
  const key = info.ref.slice(info.ref.indexOf(":") + 2);
  const maker = key.split("/")[0];
  return maker && maker !== "?" ? maker : "the part";
}

/** "Edge of hole_1 (circle Ø6.6)", "Centre of hole_1 (Ø6.6)", "Vertex of ext_1", "Edge of ext_1 (line 80)". */
export function snapLabel(kind: SnapKind, feature: string, extra: { radius?: number; length?: number; visible?: boolean } = {}): string {
  const hidden = extra.visible === false ? ", hidden" : "";
  const d = extra.radius !== undefined ? `Ø${fmt(2 * extra.radius)}` : "";
  switch (kind) {
    case "circle":
      return `Edge of ${feature} (circle ${d})${hidden}`.replace(" ()", "");
    case "arc":
      return `Edge of ${feature} (arc R${fmt(extra.radius ?? 0)})${hidden}`;
    case "edge":
      return `Edge of ${feature}${extra.length !== undefined ? ` (line ${fmt(extra.length)})` : ""}${hidden}`;
    case "centre":
      return `Centre of ${feature}${d ? ` (${d})` : ""}${hidden}`;
    case "quadrant":
      return `Quadrant of ${feature}${d ? ` (${d})` : ""}${hidden}`;
    case "midpoint":
      return `Midpoint of an edge of ${feature}${extra.length !== undefined ? ` (line ${fmt(extra.length)})` : ""}${hidden}`;
    case "vertex":
      return `Vertex of ${feature}${hidden}`;
  }
}

/** Every edge, vertex, centre, quadrant and line midpoint of every view on the sheet. */
export function snapIndex(sheet: ComposedSheet): SnapIndex {
  const targets: SnapTarget[] = [];
  for (const cv of sheet.views) {
    const infos = listGeoRefs(sheet, cv.id);
    const radius = new Map<string, number>();
    for (const i of infos) if (i.radius !== undefined) radius.set(keyOf(i.ref), i.radius);
    for (const info of infos) {
      const feature = featureOf(info);
      const body = info.body;
      const r = resolveGeoRef(sheet, info.ref);
      if (!r) continue;
      if (info.what === "vertex" || info.what === "centre") {
        if (r.kind !== "point") continue;
        const kind: SnapKind = info.what === "vertex" ? "vertex" : "centre";
        targets.push({ ref: info.ref, view: cv.id, kind, at: r.at, visible: r.visible, feature, body, label: snapLabel(kind, feature, { radius: radius.get(keyOf(info.ref)), visible: r.visible }) });
        continue;
      }
      if (info.what === "circle" && r.kind === "circle") {
        targets.push({ ref: info.ref, view: cv.id, kind: "circle", at: r.c, circle: { c: r.c, r: r.r }, visible: r.visible, feature, body, label: snapLabel("circle", feature, { radius: r.radius, visible: r.visible }) });
        for (let q = 0; q < 4; q++) addPoint(targets, sheet, `${info.ref.replace(":e", ":q")}.${q}`, cv.id, "quadrant", feature, info);
        continue;
      }
      if (r.kind !== "edge") continue;
      const kind: SnapKind = info.what === "arc" ? "arc" : "edge";
      targets.push({ ref: info.ref, view: cv.id, kind, at: info.at, pts: r.pts, visible: r.visible, feature, body, label: snapLabel(kind, feature, { radius: info.radius, length: info.length, visible: r.visible }) });
      if (info.what === "line") addPoint(targets, sheet, info.ref.replace(":e", ":m"), cv.id, "midpoint", feature, info);
    }
  }
  return { sheet: sheet.id, targets };
}

function keyOf(ref: string): string {
  return ref.slice(ref.indexOf(":") + 2).replace(/\.\d$/, "");
}

function addPoint(out: SnapTarget[], sheet: ComposedSheet, ref: GeoRef, view: string, kind: SnapKind, feature: string, info: GeoRefInfo): void {
  const r = resolveGeoRef(sheet, ref);
  if (!r || r.kind !== "point") return;
  out.push({ ref, view, kind, at: r.at, visible: r.visible, feature, ...(info.body ? { body: info.body } : {}), label: snapLabel(kind, feature, { radius: info.radius, length: info.length, visible: r.visible }) });
}

/** The nearest point of a polyline to p, and how far. */
export function nearestOnPolyline(pts: Vec2[], p: Vec2): { at: Vec2; d: number } {
  let best = { at: pts[0], d: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const ab: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1];
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2)) : 0;
    const q: Vec2 = [a[0] + ab[0] * t, a[1] + ab[1] * t];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best.d) best = { at: q, d };
  }
  if (pts.length === 1) best = { at: pts[0], d: Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) };
  return best;
}

export interface SnapOptions {
  /** Only this view's geometry. */
  view?: string;
  /** Hidden edges too (a view drawn with hidden lines). */
  hidden?: boolean | ((view: string) => boolean);
  /** Only these kinds. */
  kinds?: SnapKind[];
}

/**
 * What the pointer at `p` (sheet mm) is over, within `tol` mm: the nearest
 * point (vertex, centre, quadrant, midpoint) within 1.5 × tol, else the
 * nearest edge within tol, the point on it under the pointer. Null when
 * nothing is near.
 */
export function snapAt(index: SnapIndex, p: Vec2, tol: number, opts: SnapOptions = {}): SnapTarget | null {
  const hiddenOk = (view: string) => (typeof opts.hidden === "function" ? opts.hidden(view) : !!opts.hidden);
  const usable = index.targets.filter((t) => (!opts.view || t.view === opts.view) && (t.visible || hiddenOk(t.view)) && (!opts.kinds || opts.kinds.includes(t.kind)));
  let point: { t: SnapTarget; d: number } | null = null;
  for (const t of usable) {
    if (!POINT_KINDS.includes(t.kind)) continue;
    const d = Math.hypot(t.at[0] - p[0], t.at[1] - p[1]);
    // A visible point wins over a hidden one at the same place.
    if (d <= tol * 1.5 && (!point || d < point.d - 1e-6 || (Math.abs(d - point.d) < 1e-6 && t.visible && !point.t.visible))) point = { t, d };
  }
  if (point) return point.t;
  let edge: { t: SnapTarget; d: number; at: Vec2 } | null = null;
  for (const t of usable) {
    if (t.kind === "circle" && t.circle) {
      const dc = Math.hypot(p[0] - t.circle.c[0], p[1] - t.circle.c[1]);
      const d = Math.abs(dc - t.circle.r);
      const at: Vec2 = dc > 1e-9 ? [t.circle.c[0] + ((p[0] - t.circle.c[0]) / dc) * t.circle.r, t.circle.c[1] + ((p[1] - t.circle.c[1]) / dc) * t.circle.r] : [t.circle.c[0] + t.circle.r, t.circle.c[1]];
      if (d <= tol && (!edge || d < edge.d)) edge = { t, d, at };
      continue;
    }
    if (!t.pts) continue;
    for (const line of t.pts) {
      if (!line.length) continue;
      const n = nearestOnPolyline(line, p);
      if (n.d <= tol && (!edge || n.d < edge.d - 1e-9 || (Math.abs(n.d - edge.d) < 1e-9 && t.visible && !edge.t.visible))) edge = { t, d: n.d, at: n.at };
    }
  }
  return edge ? { ...edge.t, at: edge.at } : null;
}

/** The snap targets of a kind whose points fall in a box (sheet mm): box selection of geometry. */
export function targetsIn(index: SnapIndex, min: Vec2, max: Vec2, kinds: SnapKind[] = ["circle", "edge", "arc"]): SnapTarget[] {
  const inside = (q: Vec2) => q[0] >= min[0] && q[0] <= max[0] && q[1] >= min[1] && q[1] <= max[1];
  return index.targets.filter((t) => t.visible && kinds.includes(t.kind) && (t.circle ? inside([t.circle.c[0] - t.circle.r, t.circle.c[1] - t.circle.r]) && inside([t.circle.c[0] + t.circle.r, t.circle.c[1] + t.circle.r]) : (t.pts ?? []).every((l) => l.every(inside))));
}
