// Geometry references (Phase Q, the contract of DRAWINGS.md Q.1): what a
// GeoRef ("front:eextrude_1/l3", "front:chole_1/c0", "front:A") is on the
// composed drawing. Every later wave attaches annotations through these two:
//
//   resolveGeoRef(drawing, ref) → the edge, point or circle, on the sheet and
//     in the model, or null when the view or the edge is not there (the
//     annotation is then "dangling": drawn in the warning colour where it
//     was, listed by the checks, never deleted);
//   listGeoRefs(drawing, view) → what a view offers: each edge (line, arc,
//     circle, curve), each end of one, each circle's centre, with the feature
//     that made it.
//
// Edge keys come from the model's provenance (src/kernel/drawingViews.ts), so
// a reference survives a rebuild that leaves that feature's edges alone. The
// Phase L points (nodes, member ends, holes, @sides) resolve too.

import { parseGeoRef, type GeoRefParts, type PointRef } from "../doc/drawing";
import type { GeoRef, Vec2, Vec3 } from "../doc/types";
import type { ProjectedEdge } from "../kernel/drawingViews";
import type { ComposedDrawing, ComposedSheet, ComposedView } from "./compose";
import { viewToSheet } from "./compose";
import type { Box } from "./sheet";
import { inView, type ViewFrame } from "./views";

/** What a GeoRef is. Sheet mm unless said; `inView` is the same in view mm (the view's own frame, breaks not taken out). */
export type ResolvedGeoRef = ResolvedEdge | ResolvedPoint | ResolvedCircle;

interface ResolvedBase {
  ref: GeoRef;
  view: string;
  sheet: string;
  /** Seen in the view: drawn (not hidden, inside a detail's circle). */
  visible: boolean;
  /** The model edge's key, the feature that made it and its body (for edge forms). */
  key?: string;
  feature?: string;
  body?: string;
}

export interface ResolvedEdge extends ResolvedBase {
  kind: "edge";
  /** What it looks like in the view. */
  shape: "line" | "arc" | "curve";
  /** Its pieces on the sheet (hidden parts included). */
  pts: Vec2[][];
  /** A line's ends on the sheet. */
  a?: Vec2;
  b?: Vec2;
  /** An arc seen end on: centre and radius on the sheet, angles (radians, counter-clockwise from +x). */
  arc?: { c: Vec2; r: number; a0: number; a1: number };
  inView: { pts: Vec2[][]; a?: Vec2; b?: Vec2 };
  /** The model edge: true length, ends, a circle's centre and radius (mm). */
  model?: { kind: "line" | "circle" | "other"; start: Vec3; end: Vec3; length: number; center?: Vec3; radius?: number };
}

export interface ResolvedPoint extends ResolvedBase {
  kind: "point";
  at: Vec2;
  inView: Vec2;
  /** Where it is in the model, when known. */
  model?: Vec3;
  /** What the point is. */
  of: "vertex" | "centre" | "midpoint" | "quadrant" | "node" | "memberEnd" | "hole";
}

export interface ResolvedCircle extends ResolvedBase {
  kind: "circle";
  c: Vec2;
  /** Radius on the sheet. */
  r: number;
  inView: { c: Vec2; r: number };
  /** True radius (mm) and centre in the model. */
  radius: number;
  model?: Vec3;
}

type Model = ComposedDrawing | ComposedSheet | ComposedSheet[];

function sheetsOf(m: Model): ComposedSheet[] {
  if (Array.isArray(m)) return m;
  if ("sheets" in m) return m.sheets;
  return [m];
}

/** The view and its sheet, by id. */
export function findComposedView(m: Model, id: string): { sheet: ComposedSheet; cv: ComposedView } | null {
  for (const sheet of sheetsOf(m)) {
    const cv = sheet.views.find((v) => v.id === id);
    if (cv) return { sheet, cv };
  }
  return null;
}

/** Resolves a GeoRef on the composed drawing; null when its view or edge isn't there. */
export function resolveGeoRef(m: Model, ref: GeoRef): ResolvedGeoRef | null {
  const parts = parseGeoRef(ref);
  if (!parts) return null;
  const found = findComposedView(m, parts.view);
  if (!found) return null;
  const { sheet, cv } = found;
  const r = geoInView(cv, parts, sheet.points);
  if (!r) return null;
  const toSheet = (p: Vec2) => viewToSheet(cv, p);
  const inside = (p: Vec2) => {
    const c = cv.clip;
    if (c?.circle) return Math.hypot(p[0] - c.circle.c[0], p[1] - c.circle.c[1]) <= c.circle.r + 1e-9;
    return true;
  };
  const base = { ref, view: cv.id, sheet: sheet.id };
  if (r.kind === "point") return { ...base, kind: "point", at: toSheet(r.p), inView: r.p, visible: r.visible && inside(r.p), of: r.of, ...(r.model ? { model: r.model } : {}), ...r.meta };
  if (r.kind === "circle") return { ...base, kind: "circle", c: toSheet(r.c), r: r.r * cv.scale, inView: { c: r.c, r: r.r }, radius: r.radius, visible: r.visible && inside(r.c), ...(r.model ? { model: r.model } : {}), ...r.meta };
  const pts = r.pts.map((l) => l.map(toSheet));
  return {
    ...base,
    kind: "edge",
    shape: r.shape,
    pts,
    ...(r.a && r.b ? { a: toSheet(r.a), b: toSheet(r.b) } : {}),
    ...(r.arc ? { arc: { c: toSheet(r.arc.c), r: r.arc.r * cv.scale, a0: r.arc.a0, a1: r.arc.a1 } } : {}),
    inView: { pts: r.pts, ...(r.a && r.b ? { a: r.a, b: r.b } : {}) },
    visible: r.visible && r.pts.some((l) => l.some(inside)),
    ...(r.model ? { model: r.model } : {}),
    ...r.meta,
  };
}

type Meta = { key?: string; feature?: string; body?: string };
type InView =
  | { kind: "point"; p: Vec2; visible: boolean; of: ResolvedPoint["of"]; model?: Vec3; meta: Meta }
  | { kind: "circle"; c: Vec2; r: number; radius: number; visible: boolean; model?: Vec3; meta: Meta }
  | { kind: "edge"; shape: ResolvedEdge["shape"]; pts: Vec2[][]; a?: Vec2; b?: Vec2; arc?: { c: Vec2; r: number; a0: number; a1: number }; visible: boolean; model?: ResolvedEdge["model"]; meta: Meta };

/** The pieces of one edge in a view (a circle half hidden comes as two). */
function piecesOf(edges: ProjectedEdge[], key: string): ProjectedEdge[] {
  return edges.filter((e) => e.key === key);
}

/** A GeoRef in a view, view mm. `points` resolves the Phase L forms. */
export function geoInView(cv: Pick<ComposedView, "edges" | "frame" | "outline">, parts: GeoRefParts, points?: ComposedSheet["points"]): InView | null {
  if (parts.form === "point") return phaseL(cv, parts.point, points);
  const pieces = piecesOf(cv.edges, parts.key);
  if (!pieces.length) return null;
  const e = pieces.find((x) => x.visible) ?? pieces[0];
  const meta: Meta = { key: e.key, ...(e.feature ? { feature: e.feature } : {}), body: e.body };
  const visible = pieces.some((x) => x.visible);
  const f = cv.frame;
  const circle = pieces.find((x) => x.circle)?.circle;
  const model = e.model;
  const line = lineEnds(pieces);
  switch (parts.form) {
    case "e": {
      if (circle && e.look === "circle") return { kind: "circle", c: circle.c, r: circle.r, radius: model?.radius ?? circle.r, visible, ...(model?.center ? { model: model.center } : {}), meta };
      const shape: ResolvedEdge["shape"] = e.look === "line" ? "line" : e.look === "arc" ? "arc" : "curve";
      return {
        kind: "edge",
        shape,
        pts: pieces.map((x) => x.pts),
        ...(shape === "line" && line ? { a: line[0], b: line[1] } : {}),
        ...(shape === "arc" && circle && circle.a0 !== undefined && circle.a1 !== undefined ? { arc: { c: circle.c, r: circle.r, a0: circle.a0, a1: circle.a1 } } : {}),
        visible,
        ...(model ? { model: { kind: model.kind, start: model.start, end: model.end, length: model.length, ...(model.center ? { center: model.center, radius: model.radius } : {}) } } : {}),
        meta,
      };
    }
    case "c": {
      if (!circle) return null;
      return { kind: "point", p: circle.c, visible, of: "centre", ...(model?.center ? { model: model.center } : {}), meta };
    }
    case "v": {
      if (model && model.kind !== "circle") {
        const p3 = parts.end === 0 ? model.start : model.end;
        return { kind: "point", p: inView(p3, f), visible, of: "vertex", model: p3, meta };
      }
      if (model && model.kind === "circle" && circle && e.look === "arc") {
        const p3 = parts.end === 0 ? model.start : model.end;
        return { kind: "point", p: inView(p3, f), visible, of: "vertex", model: p3, meta };
      }
      if (!line) return null;
      return { kind: "point", p: line[parts.end], visible, of: "vertex", meta };
    }
    case "m": {
      if (circle && circle.a0 !== undefined && circle.a1 !== undefined) {
        let span = circle.a1 - circle.a0;
        if (span < 0) span += 2 * Math.PI;
        const a = circle.a0 + span / 2;
        return { kind: "point", p: [circle.c[0] + circle.r * Math.cos(a), circle.c[1] + circle.r * Math.sin(a)], visible, of: "midpoint", meta };
      }
      if (line && e.look === "line") return { kind: "point", p: [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2], visible, of: "midpoint", ...(model ? { model: mid3(model.start, model.end) } : {}), meta };
      const all = pieces.flatMap((x) => x.pts);
      return all.length ? { kind: "point", p: halfway(all), visible, of: "midpoint", meta } : null;
    }
    case "q": {
      if (!circle) return null;
      const a = (parts.quadrant * Math.PI) / 2;
      const p: Vec2 = [circle.c[0] + circle.r * Math.cos(a), circle.c[1] + circle.r * Math.sin(a)];
      const m3 = model?.center ? quadrant3(model.center, model.radius ?? circle.r, f, a) : undefined;
      return { kind: "point", p, visible, of: "quadrant", ...(m3 ? { model: m3 } : {}), meta };
    }
  }
}

/** A straight edge's two ends over all its pieces (the furthest apart along it). */
function lineEnds(pieces: ProjectedEdge[]): [Vec2, Vec2] | null {
  const pts = pieces.flatMap((p) => p.pts);
  if (pts.length < 2) return null;
  let best: [Vec2, Vec2] = [pts[0], pts[1]];
  let far = -1;
  // Few points (a line is two per piece): all pairs.
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (d > far) {
        far = d;
        best = [pts[i], pts[j]];
      }
    }
  // In a fixed order: left to right, then bottom to top.
  const [a, b] = best;
  return a[0] < b[0] - 1e-9 || (Math.abs(a[0] - b[0]) <= 1e-9 && a[1] <= b[1]) ? [a, b] : [b, a];
}

function halfway(pts: Vec2[]): Vec2 {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (l >= left && l > 0) return [pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * left) / l, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * left) / l];
    left -= l;
  }
  return pts[pts.length - 1];
}

function mid3(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function quadrant3(c: Vec3, r: number, f: ViewFrame, a: number): Vec3 {
  return [0, 1, 2].map((k) => c[k] + r * (Math.cos(a) * f.right[k] + Math.sin(a) * f.up[k])) as Vec3;
}

/** A Phase L point in a view: a node, a member's end, a hole's entry, a side of the outline (an edge). */
function phaseL(cv: Pick<ComposedView, "frame" | "outline">, p: PointRef, points?: ComposedSheet["points"]): InView | null {
  const f = cv.frame;
  if (p.kind === "side") {
    const o: Box | null = cv.outline;
    if (!o) return null;
    const pts: Vec2[] =
      p.side === "@left" ? [[o.min[0], o.min[1]], [o.min[0], o.max[1]]] : p.side === "@right" ? [[o.max[0], o.min[1]], [o.max[0], o.max[1]]] : p.side === "@bottom" ? [[o.min[0], o.min[1]], [o.max[0], o.min[1]]] : [[o.min[0], o.max[1]], [o.max[0], o.max[1]]];
    return { kind: "edge", shape: "line", pts: [pts], a: pts[0], b: pts[1], visible: true, meta: {} };
  }
  if (!points) return null;
  if (p.kind === "end") {
    const m = points.members.find((x) => x.id === p.member) ?? points.members.find((x) => x.body === p.member);
    if (!m) return null;
    const p3 = m.ends[p.end === "start" ? 0 : 1];
    return { kind: "point", p: inView(p3, f), visible: true, of: "memberEnd", model: p3, meta: { body: m.body } };
  }
  if (p.kind === "name") {
    const node = points.nodes[p.name];
    if (node) return { kind: "point", p: inView(node, f), visible: true, of: "node", model: node, meta: {} };
    const hole = points.holes.get(p.name);
    if (hole) return { kind: "point", p: inView(hole.entry, f), visible: true, of: "hole", model: hole.entry, meta: { feature: hole.feature } };
  }
  return null;
}

/** One thing a view offers to attach to. */
export interface GeoRefInfo {
  ref: GeoRef;
  kind: "edge" | "point" | "circle";
  /** What it is: "line" (with its true length), "arc", "circle" (with its radius), "curve", "vertex", "centre". */
  what: "line" | "arc" | "circle" | "curve" | "vertex" | "centre";
  visible: boolean;
  /** Where it is on the sheet (an edge's middle, a circle's centre). */
  at: Vec2;
  feature?: string;
  body?: string;
  /** A line's true length or a circle's or arc's radius, model mm. */
  length?: number;
  radius?: number;
}

/**
 * What a view offers, in a fixed order: its edges (each once, by key), the
 * ends of its straight edges and arcs (each place once, a visible edge's
 * first), and the centres of its circles and arcs.
 */
export function listGeoRefs(m: Model, view: string): GeoRefInfo[] {
  const found = findComposedView(m, view);
  if (!found) return [];
  const { cv } = found;
  const out: GeoRefInfo[] = [];
  const byKey = new Map<string, ProjectedEdge[]>();
  for (const e of cv.edges) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  const keys = [...byKey.keys()].sort();
  const toSheet = (p: Vec2) => viewToSheet(cv, p);
  const vertices: { p: Vec2; info: GeoRefInfo }[] = [];
  for (const key of keys) {
    const pieces = byKey.get(key)!;
    const e = pieces.find((x) => x.visible) ?? pieces[0];
    const visible = pieces.some((x) => x.visible);
    const meta = { ...(e.feature ? { feature: e.feature } : {}), body: e.body };
    if (e.circle && e.look === "circle") {
      out.push({ ref: `${view}:e${key}`, kind: "circle", what: "circle", visible, at: toSheet(e.circle.c), radius: e.model?.radius ?? e.circle.r, ...meta });
      out.push({ ref: `${view}:c${key}`, kind: "point", what: "centre", visible, at: toSheet(e.circle.c), ...meta });
      continue;
    }
    const all = pieces.flatMap((x) => x.pts);
    const what = e.look === "line" ? "line" : e.look === "arc" ? "arc" : "curve";
    out.push({ ref: `${view}:e${key}`, kind: "edge", what, visible, at: toSheet(halfway(all)), ...(what === "line" && e.model ? { length: e.model.length } : {}), ...(what === "arc" ? { radius: e.model?.radius ?? e.circle?.r } : {}), ...meta });
    if (e.circle && e.look === "arc") out.push({ ref: `${view}:c${key}`, kind: "point", what: "centre", visible, at: toSheet(e.circle.c), ...meta });
    if (what === "line" || what === "arc") {
      for (const end of [0, 1] as const) {
        const r = geoInView(cv, { view, form: "v", key, end });
        if (!r || r.kind !== "point") continue;
        vertices.push({ p: r.p, info: { ref: `${view}:v${key}.${end}`, kind: "point", what: "vertex", visible, at: toSheet(r.p), ...meta } });
      }
    }
  }
  // A corner is the end of several edges: listed once, by a visible edge if one ends there.
  vertices.sort((a, b) => Number(b.info.visible) - Number(a.info.visible));
  const kept: { p: Vec2; info: GeoRefInfo }[] = [];
  for (const v of vertices) if (!kept.some((k) => Math.hypot(k.p[0] - v.p[0], k.p[1] - v.p[1]) < 1e-6)) kept.push(v);
  kept.sort((a, b) => (a.info.ref < b.info.ref ? -1 : 1));
  return [...out, ...kept.map((k) => k.info)];
}
