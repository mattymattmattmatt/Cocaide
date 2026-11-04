// Dimensions (Phase Q; Phase L had linear ones between points): linear
// horizontal / vertical / aligned (two points, an edge's length, two
// parallel edges' distance, a point's from an edge), angular (two edges or
// three points, the reflex side on request), radius (jogged for a centre off
// the view) and diameter (a circle, or a cylinder's two sides seen from the
// side), ordinate, baseline and chain sets, arc length, chamfers ("C2",
// "2 × 45°") and path lengths. Every value is measured on the rebuild in the
// view (view mm are model mm in a view that looks square at the part); the
// text carries the prefix, count, symbol, tolerance (src/drafting/
// tolerance.ts), suffix, TYP, frames and dual units.
//
// Two passes: `measureDimension` works in the view's own mm before the views
// are placed (so the sheet knows how much room each view's dimensions need:
// `planDimensionRows` stacks them outward in rows, chain dimensions sharing
// one, shorter ones nearer the part), and `layoutDimension` draws it on the
// sheet once the view is placed.

import { parseGeoRef, pointRef } from "../../doc/drawing";
import type { DimensionAnnotation, Drawing, DrawingPoint, Vec2, Vec3 } from "../../doc/types";
import type { ProjectedEdge } from "../../kernel/drawingViews";
import type { ComposedView, PointContext } from "../compose";
import { viewToSheet } from "../compose";
import { geoInView } from "../georef";
import type { Box, Prim } from "../sheet";
import { parseRich } from "../symbols/richtext";
import { CAP } from "../text";
import { numberText, toleranceText } from "../tolerance";
import { toModel, type ViewFrame } from "../views";
import {
  add,
  arrowHead,
  deg,
  dist,
  dot,
  failed,
  fromCentre,
  labelPrims,
  len,
  measureLabel,
  mul,
  perp,
  readable,
  sub,
  unit,
  type AnnotationContext,
  type Label,
  type LabelPart,
  type LayoutResult,
} from "./common";
import { findSpot } from "./placement";
import type { DraftStyle } from "./style";

type Side = -1 | 1;

/** A view before it is placed: enough to measure in it. */
export interface ViewInfo {
  id: string;
  edges: ProjectedEdge[];
  frame: ViewFrame;
  outline: Box | null;
  square: boolean;
}

/** What a dimension measures, in its view's mm. */
export type Measure =
  | { kind: "linear"; p1: Vec2; p2: Vec2; dir: "h" | "v" | "a"; value: number; sides: [boolean, boolean]; near?: Side; symbol?: string }
  | { kind: "angular"; v: Vec2; d1: Vec2; d2: Vec2; r1: number; r2: number; value: number }
  | { kind: "radial"; c: Vec2; r: number; value: number; diameter: boolean; arc?: [number, number]; tip?: Vec2 }
  | { kind: "arc"; c: Vec2; r: number; a0: number; a1: number; value: number }
  | { kind: "note"; tip: Vec2; dir: Vec2; text: string; value: number }
  | { kind: "set"; mode: "ordinate" | "baseline" | "chain"; dir: "h" | "v"; origin: Vec2; pts: Vec2[]; values: number[]; sides: boolean[] };

// ------------------------------------------------------------ points in a view

/** A dimension point in the view (view mm). A side of the outline has only the coordinate it names (the other NaN). */
export function viewPoint(v: ViewInfo, ref: DrawingPoint, points: PointContext | undefined): { p: Vec2; side?: "x" | "y" } | { problem: string } {
  const r = pointRef(ref);
  if (!r) return failed(`"${ref}" is not a point`);
  const o = v.outline;
  if (!o) return failed(`its view ${v.id} shows nothing`);
  if (r.kind === "side") {
    const s = r.side;
    return s === "@left" ? { p: [o.min[0], NaN], side: "x" } : s === "@right" ? { p: [o.max[0], NaN], side: "x" } : s === "@bottom" ? { p: [NaN, o.min[1]], side: "y" } : { p: [NaN, o.max[1]], side: "y" };
  }
  const parts = r.kind === "geo" ? parseGeoRef(r.ref) : parseGeoRef(`${v.id}:${ref}`);
  if (!parts) return failed(`"${ref}" is not a point`);
  const g = geoInView(v, parts, points);
  if (!g) {
    if (r.kind === "end") return failed(`no member "${r.member}" built`);
    if (r.kind === "name") return failed(`no node or hole "${r.name}" in the part`);
    return failed(`${ref} is not in its view (the edge it names is gone)`);
  }
  if (g.kind === "point") return { p: g.p };
  if (g.kind === "circle") return { p: g.c };
  return failed(`${ref} is an edge, not a point: use its end ("v…​.0"), its middle ("m…") or its centre ("c…")`);
}

/** A GeoRef in the view: an edge (a line's ends, an arc's circle), a circle, or a point. */
function geo(v: ViewInfo, ref: string, points: PointContext | undefined) {
  const parts = parseGeoRef(ref);
  if (!parts) return null;
  if (parts.view !== v.id) return null;
  return geoInView(v, parts, points);
}

// ------------------------------------------------------------ measuring

/** What a dimension measures in its view (view mm), or why it can't. */
export function measureDimension(a: DimensionAnnotation, v: ViewInfo, points: PointContext | undefined, members: { id: string; body: string; ends: [Vec3, Vec3]; length: number }[]): Measure | { problem: string } {
  if (!v.outline) return failed(`its view ${v.id} shows nothing`);
  if (!v.square) return failed(`${v.id} is a view at an angle to the part, which shortens every length`);
  const kind = a.kind ?? "linear";
  const refs = a.refs ?? [];
  const lineOf = (ref: string) => {
    const g = geo(v, ref, points);
    if (!g) return null;
    if (g.kind === "edge" && g.shape === "line" && g.a && g.b) return { a: g.a, b: g.b, g };
    return null;
  };
  switch (kind) {
    case "linear": {
      if (a.member !== undefined) {
        const m = members.find((x) => x.id === a.member) ?? members.find((x) => x.body === a.member);
        if (!m) return failed(`no member "${a.member}" built`);
        const p1 = inViewOf(m.ends[0], v.frame);
        const p2 = inViewOf(m.ends[1], v.frame);
        const along = dist(p1, p2);
        if (along < m.length * 0.999) return failed(`${a.member} doesn't lie flat in ${v.id} (it runs ${along < 1e-6 ? "straight at the viewer" : "at an angle to it"}): dimension it in a view it lies flat in`);
        const dir = Math.abs(p2[1] - p1[1]) < 1e-6 ? "h" : Math.abs(p2[0] - p1[0]) < 1e-6 ? "v" : "a";
        const c: Vec2 = [(v.outline.min[0] + v.outline.max[0]) / 2, (v.outline.min[1] + v.outline.max[1]) / 2];
        const mid = mul(add(p1, p2), 0.5);
        const near: Side = dir === "h" ? (mid[1] >= c[1] ? 1 : -1) : mid[0] >= c[0] ? 1 : -1;
        return { kind: "linear", p1, p2, dir, value: m.length, sides: [false, false], ...(dir === "a" ? {} : { near }) };
      }
      if (refs.length) return linearFromRefs(a, v, points, refs, lineOf);
      if (a.from === undefined || a.to === undefined) return failed("a linear dimension runs between two points (from, to), along a member, or over GeoRefs (refs)");
      return linearBetween(a, v, points, a.from, a.to);
    }
    case "diameter":
    case "radius": {
      if (kind === "diameter" && refs.length === 2) {
        // A cylinder seen from the side: the distance between its two outlines, written Ø.
        const m = linearFromRefs(a, v, points, refs, lineOf);
        if ("problem" in m) return m;
        return m.kind === "linear" ? { ...m, symbol: "Ø" } : failed("a diameter between two edges needs two parallel lines");
      }
      if (refs.length !== 1) return failed(`a ${kind} dimension is on one circle or arc (refs: ["<view>:e<edge>"])`);
      const g = geo(v, refs[0], points);
      if (!g) return failed(`${refs[0]} is not in ${v.id} any more`);
      if (g.kind === "circle") return { kind: "radial", c: g.c, r: g.r, value: kind === "diameter" ? 2 * g.radius : g.radius, diameter: kind === "diameter" };
      if (g.kind === "edge" && g.arc) return { kind: "radial", c: g.arc.c, r: g.arc.r, value: kind === "diameter" ? 2 * (g.model?.radius ?? g.arc.r) : (g.model?.radius ?? g.arc.r), diameter: kind === "diameter", arc: [g.arc.a0, g.arc.a1] };
      return failed(`${refs[0]} is not a circle or an arc seen end on in ${v.id}`);
    }
    case "angular":
      return angularFromRefs(v, points, refs, a.major === true);
    case "arcLength": {
      if (refs.length !== 1) return failed('an arc length is on one arc (refs: ["<view>:e<edge>"])');
      const g = geo(v, refs[0], points);
      if (!g || g.kind !== "edge" || !g.arc) return failed(`${refs[0]} is not an arc seen end on in ${v.id}`);
      let span = g.arc.a1 - g.arc.a0;
      if (span < 0) span += 2 * Math.PI;
      const r = g.model?.radius ?? g.arc.r;
      return { kind: "arc", c: g.arc.c, r: g.arc.r, a0: g.arc.a0, a1: g.arc.a0 + span, value: r * span };
    }
    case "chamfer": {
      if (refs.length !== 1) return failed('a chamfer dimension is on the chamfer\'s edge, seen from the side (refs: ["<view>:e<edge>"])');
      const l = lineOf(refs[0]);
      if (!l) return failed(`${refs[0]} is not a straight edge in ${v.id}`);
      const dx = Math.abs(l.b[0] - l.a[0]);
      const dy = Math.abs(l.b[1] - l.a[1]);
      if (dx < 1e-6 || dy < 1e-6) return failed(`${refs[0]} runs square to the view: a chamfer is seen as a slanted edge`);
      const leg = Math.min(dx, dy);
      const angle = deg(Math.atan2(Math.min(dx, dy), Math.max(dx, dy)));
      const tip = mul(add(l.a, l.b), 0.5);
      const d = unit(perp(sub(l.b, l.a)));
      const equal = Math.abs(dx - dy) < 1e-3;
      return { kind: "note", tip, dir: d, text: equal ? "chamfer45" : `chamfer:${numberText(Math.max(dx, dy) === dx ? dy : dx)}:${numberText(90 - angle)}`, value: equal ? leg : Math.max(dx, dy) === dx ? dy : dx };
    }
    case "pathLength": {
      if (!refs.length) return failed('a path length runs along edges (refs: ["<view>:e<edge>", ...])');
      let total = 0;
      let tip: Vec2 | null = null;
      for (const ref of refs) {
        const g = geo(v, ref, points);
        if (!g || g.kind !== "edge") return failed(`${ref} is not an edge in ${v.id}`);
        total += g.model?.length ?? g.pts.reduce((t, l) => t + l.reduce((u, q, i) => (i ? u + dist(q, l[i - 1]) : u), 0), 0);
        tip ??= g.pts[0][Math.floor(g.pts[0].length / 2)];
      }
      return { kind: "note", tip: tip!, dir: [Math.SQRT1_2, Math.SQRT1_2], text: "path", value: total };
    }
    case "ordinate":
    case "baseline":
    case "chain": {
      const pts = a.points ?? [];
      const first = kind === "chain" ? (a.origin ?? pts[0]) : a.origin;
      if (first === undefined) return failed(`a ${kind} set measures from an origin: give origin (a point or side of the view)`);
      const rest = kind === "chain" && a.origin === undefined ? pts.slice(1) : pts;
      if (!rest.length) return failed(`a ${kind} set needs points to measure`);
      const o = viewPoint(v, first, points);
      if ("problem" in o) return o;
      const qs = rest.map((p) => viewPoint(v, p, points));
      const bad = qs.find((q) => "problem" in q);
      if (bad && "problem" in bad) return bad;
      const ps = qs as { p: Vec2; side?: "x" | "y" }[];
      const sides = [o, ...ps].map((q) => q.side);
      let dir: "h" | "v";
      if (a.direction === "horizontal" || a.direction === "vertical") dir = a.direction === "horizontal" ? "h" : "v";
      else if (sides.some((s) => s)) dir = sides.find((s) => s) === "x" ? "h" : "v";
      else {
        const spreadX = Math.max(...ps.map((q) => Math.abs(q.p[0] - o.p[0])));
        const spreadY = Math.max(...ps.map((q) => Math.abs(q.p[1] - o.p[1])));
        dir = spreadX >= spreadY ? "h" : "v";
      }
      const axis = dir === "h" ? 0 : 1;
      for (const [q, ref] of [[o, first], ...ps.map((q, i) => [q, rest[i]] as const)] as const) {
        if (q.side && (q.side === "x") !== (dir === "h")) return failed(`${ref} is a side of the view across the set's direction`);
      }
      const fill = (p: Vec2): Vec2 => [Number.isNaN(p[0]) ? v.outline!.min[0] : p[0], Number.isNaN(p[1]) ? v.outline!.min[1] : p[1]];
      const origin = fill(o.p);
      const pts2 = ps.map((q) => fill(q.p));
      // A chain runs point to point in order along its direction.
      const order = pts2.map((p, i) => i).sort((i, j) => pts2[i][axis] - pts2[j][axis]);
      const sorted = kind === "chain" ? order.map((i) => pts2[i]) : pts2;
      const sortedSides = kind === "chain" ? order.map((i) => !!ps[i].side) : ps.map((q) => !!q.side);
      const values = kind === "chain" ? sorted.map((p, i) => Math.abs(p[axis] - (i ? sorted[i - 1][axis] : origin[axis]))) : sorted.map((p) => Math.abs(p[axis] - origin[axis]));
      return { kind: "set", mode: kind, dir, origin, pts: sorted, values, sides: [!!o.side, ...sortedSides] };
    }
  }
}

function inViewOf(p: Vec3, f: ViewFrame): Vec2 {
  return [p[0] * f.right[0] + p[1] * f.right[1] + p[2] * f.right[2], p[0] * f.up[0] + p[1] * f.up[1] + p[2] * f.up[2]];
}

function linearBetween(a: DimensionAnnotation, v: ViewInfo, points: PointContext | undefined, from: string, to: string): Measure | { problem: string } {
  const q1 = viewPoint(v, from, points);
  const q2 = viewPoint(v, to, points);
  if ("problem" in q1) return q1;
  if ("problem" in q2) return q2;
  const sides = [q1.side, q2.side].filter(Boolean);
  let dir: "h" | "v" | "a";
  if (a.direction) dir = a.direction === "horizontal" ? "h" : a.direction === "vertical" ? "v" : "a";
  else if (sides.length) dir = sides[0] === "x" ? "h" : "v";
  else dir = Math.abs(q2.p[0] - q1.p[0]) >= Math.abs(q2.p[1] - q1.p[1]) ? "h" : "v";
  for (const [q, ref] of [
    [q1, from],
    [q2, to],
  ] as const) {
    if (q.side === "x" && dir !== "h") return failed(`${ref} is a side of the view: use it in a horizontal dimension`);
    if (q.side === "y" && dir !== "v") return failed(`${ref} is the top or bottom of the view: use it in a vertical dimension`);
  }
  // A side has only its own coordinate: the other is the view's edge nearest the dimension (filled in on the sheet).
  const fill = (p: Vec2): Vec2 => [Number.isNaN(p[0]) ? v.outline!.min[0] : p[0], Number.isNaN(p[1]) ? v.outline!.min[1] : p[1]];
  const p1 = fill(q1.p);
  const p2 = fill(q2.p);
  const value = dir === "h" ? Math.abs(p2[0] - p1[0]) : dir === "v" ? Math.abs(p2[1] - p1[1]) : dist(p1, p2);
  if (value < 1e-6) return failed(`${from} and ${to} are at the same place ${dir === "h" ? "across" : dir === "v" ? "up" : "in"} ${v.id}`);
  return { kind: "linear", p1, p2, dir, value, sides: [!!q1.side, !!q2.side] };
}

/** Linear from GeoRefs: an edge's length, two parallel edges' distance, a point's distance from an edge, two points. */
function linearFromRefs(
  a: DimensionAnnotation,
  v: ViewInfo,
  points: PointContext | undefined,
  refs: string[],
  lineOf: (ref: string) => { a: Vec2; b: Vec2 } | null,
): Measure | { problem: string } {
  if (refs.length === 1) {
    const l = lineOf(refs[0]);
    if (!l) return failed(`${refs[0]} is not a straight edge in ${v.id} (a linear dimension on one GeoRef measures its length)`);
    const along = sub(l.b, l.a);
    const dir: "h" | "v" | "a" = a.direction === "horizontal" ? "h" : a.direction === "vertical" ? "v" : Math.abs(along[1]) < 1e-6 ? "h" : Math.abs(along[0]) < 1e-6 ? "v" : "a";
    const value = dir === "h" ? Math.abs(along[0]) : dir === "v" ? Math.abs(along[1]) : len(along);
    if (value < 1e-6) return failed(`${refs[0]} has no length ${dir === "h" ? "across" : "up"} ${v.id}`);
    return { kind: "linear", p1: l.a, p2: l.b, dir, value, sides: [false, false] };
  }
  if (refs.length !== 2) return failed("a linear dimension is on one edge or between two GeoRefs");
  const l1 = lineOf(refs[0]);
  const l2 = lineOf(refs[1]);
  if (l1 && l2) {
    const d1 = unit(sub(l1.b, l1.a));
    const d2 = unit(sub(l2.b, l2.a));
    if (Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) > 1e-4) return failed(`${refs[0]} and ${refs[1]} aren't parallel: dimension the angle between them (kind "angular")`);
    // Where both run: the middle of their overlap along them, then square across.
    const t = (p: Vec2) => dot(sub(p, l1.a), d1);
    const lo = Math.max(Math.min(t(l1.a), t(l1.b)), Math.min(t(l2.a), t(l2.b)));
    const hi = Math.min(Math.max(t(l1.a), t(l1.b)), Math.max(t(l2.a), t(l2.b)));
    const at = lo <= hi ? (lo + hi) / 2 : (t(l1.a) + t(l1.b)) / 2;
    const p1 = add(l1.a, mul(d1, at));
    const n = perp(d1);
    const gap = dot(sub(l2.a, p1), n);
    const p2 = add(p1, mul(n, gap));
    if (Math.abs(gap) < 1e-6) return failed(`${refs[0]} and ${refs[1]} are on one line`);
    const dir: "h" | "v" | "a" = Math.abs(n[0]) < 1e-6 ? "v" : Math.abs(n[1]) < 1e-6 ? "h" : "a";
    return { kind: "linear", p1, p2, dir, value: Math.abs(gap), sides: [false, false] };
  }
  // A point and an edge: square from the edge to the point.
  const lineRef = l1 ? 0 : l2 ? 1 : -1;
  if (lineRef >= 0) {
    const l = (lineRef === 0 ? l1 : l2)!;
    const q = viewPoint(v, refs[1 - lineRef], points);
    if ("problem" in q) return q;
    if (q.side) return failed("a side of the view and an edge: dimension between two points or two edges");
    const d = unit(sub(l.b, l.a));
    const n = perp(d);
    const gap = dot(sub(q.p, l.a), n);
    if (Math.abs(gap) < 1e-6) return failed(`${refs[1 - lineRef]} is on ${refs[lineRef]}`);
    const foot = sub(q.p, mul(n, gap));
    const dir: "h" | "v" | "a" = Math.abs(n[0]) < 1e-6 ? "v" : Math.abs(n[1]) < 1e-6 ? "h" : "a";
    return { kind: "linear", p1: foot, p2: q.p, dir, value: Math.abs(gap), sides: [false, false] };
  }
  return linearBetween(a, v, points, refs[0], refs[1]);
}

/** An angle: between two straight edges (where their lines meet), or at the middle of three points. */
function angularFromRefs(v: ViewInfo, points: PointContext | undefined, refs: string[], major: boolean): Measure | { problem: string } {
  let vertex: Vec2;
  let e1: Vec2;
  let e2: Vec2;
  if (refs.length === 2) {
    const ls = refs.map((r) => {
      const g = geo(v, r, points);
      return g && g.kind === "edge" && g.a && g.b ? { a: g.a, b: g.b } : null;
    });
    if (!ls[0] || !ls[1]) return failed("an angle is between two straight edges, or at the middle of three points");
    const [A, B] = ls as { a: Vec2; b: Vec2 }[];
    const d1 = sub(A.b, A.a);
    const d2 = sub(B.b, B.a);
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(cross) < 1e-9 * len(d1) * len(d2)) return failed(`${refs[0]} and ${refs[1]} are parallel: there is no angle between them (dimension their distance)`);
    const t = ((B.a[0] - A.a[0]) * d2[1] - (B.a[1] - A.a[1]) * d2[0]) / cross;
    vertex = add(A.a, mul(d1, t));
    // Each ray toward the edge's far end from where they meet.
    const far = (l: { a: Vec2; b: Vec2 }) => (dist(l.a, vertex) > dist(l.b, vertex) ? l.a : l.b);
    e1 = far(A);
    e2 = far(B);
  } else if (refs.length === 3) {
    const qs = refs.map((r) => viewPoint(v, r, points));
    const bad = qs.find((q) => "problem" in q);
    if (bad && "problem" in bad) return bad;
    const [p, c, q] = qs.map((x) => (x as { p: Vec2 }).p);
    vertex = c;
    e1 = p;
    e2 = q;
  } else return failed("an angle is between two edges (refs: [edge, edge]) or at the middle of three points (refs: [point, vertex, point])");
  const d1 = unit(sub(e1, vertex));
  const d2 = unit(sub(e2, vertex));
  let value = deg(Math.acos(Math.max(-1, Math.min(1, dot(d1, d2)))));
  if (major) value = 360 - value;
  return { kind: "angular", v: vertex, d1, d2, r1: dist(e1, vertex), r2: dist(e2, vertex), value };
}

// ------------------------------------------------------------ the text

/** How many decimals a dimension is written to: its own, else the drawing's, else as few as it needs (up to one). */
export function placesOf(a: Pick<DimensionAnnotation, "precision">, drawing: Pick<Drawing, "precision" | "units">): number | undefined {
  return a.precision ?? drawing.precision ?? (drawing.units === "in" ? 2 : undefined);
}

/** A size as written: in the drawing's units, to its decimals ("12.5", "0.98"). */
export function sizeText(value: number, places: number | undefined, units: "mm" | "in" = "mm", angle = false): string {
  const v = angle || units === "mm" ? value : value / 25.4;
  if (places === undefined) {
    const r = Math.round(v * 10) / 10 + 0;
    return numberText(r, Number.isInteger(r) ? 0 : 1);
  }
  return numberText(v, places);
}

/**
 * A dimension's text: "2× Ø25 H7 (+0.021/0) THRU TYP", as a label the sheet
 * lays out (with its stacked deviations and its frame) and as one line.
 */
export function dimensionLabel(a: DimensionAnnotation, value: number, symbol: string, style: DraftStyle, drawing: Drawing, opts: { angle?: boolean; side?: "hole" | "shaft"; size?: number } = {}): { label: Label; text: string } {
  const places = placesOf(a, drawing);
  const units = drawing.units ?? "mm";
  const num = opts.angle ? `${sizeText(value, places ?? (Number.isInteger(Math.round(value * 10) / 10) ? 0 : 1), "mm", true)}°` : sizeText(value, places, units);
  const head = `${a.count && a.count > 1 ? `${a.count}× ` : ""}${a.prefix ? `${a.prefix}` : ""}${symbol}`;
  const size = opts.size ?? style.font;
  const t = toleranceText(value, `${head}${num}`, a.tolerance, { ...(opts.side ? { side: opts.side } : {}), ...(places !== undefined ? { places } : {}) });
  const parts: LabelPart[] = [];
  if (t.size !== null) parts.push({ kind: "rich", spans: parseRich(t.size), size });
  if (t.stack) {
    if (t.size === null) parts.push({ kind: "stack", upper: parseRich(t.stack[0]), lower: parseRich(t.stack[1]), size });
    else parts.push({ kind: "gap", w: 0.6 }, { kind: "stack", upper: parseRich(t.stack[0]), lower: parseRich(t.stack[1]), size: style.small });
  }
  if (t.inline) parts.push({ kind: "rich", spans: parseRich(t.inline.startsWith("±") ? t.inline : ` ${t.inline}`), size });
  if (t.bracket) parts.push({ kind: "gap", w: 0.6 }, { kind: "stack", upper: parseRich(t.bracket[0]), lower: parseRich(t.bracket[1]), size: style.small, brackets: true });
  const tail = [a.suffix, a.typ ? "TYP" : ""].filter(Boolean).join(" ");
  if (tail) parts.push({ kind: "rich", spans: parseRich(` ${tail}`), size });
  const dual = a.dual ?? drawing.dualUnits ?? false;
  const other = dual && !opts.angle ? (units === "mm" ? `[${numberText(value / 25.4, 3)}]` : `[${numberText(value, 1)}]`) : null;
  const label: Label = {
    parts,
    size,
    ...(a.tolerance?.kind === "basic" ? { frame: "box" as const } : a.tolerance?.kind === "reference" ? { frame: "brackets" as const } : a.inspection ? { frame: "oval" as const } : {}),
    ...(other ? { below: parseRich(other) } : {}),
  };
  let text = t.size ?? `${t.stack![1]}–${t.stack![0]}`;
  if (t.size !== null && t.stack) text += ` ${t.stack[0]}/${t.stack[1]}`;
  if (t.inline) text += t.inline.startsWith("±") ? t.inline : ` ${t.inline}`;
  if (t.bracket) text += ` (${t.bracket.join("/")})`;
  if (tail) text += ` ${tail}`;
  if (t.frame === "brackets") text = `(${text})`;
  if (t.frame === "box") text = `[${text}]`;
  if (other) text += ` ${other}`;
  return { label, text };
}

// ------------------------------------------------------------ planning rows

/** A dimension's interval along its view's side, sheet mm from the view's centre, for stacking. */
interface RowItem {
  id: string;
  dir: "h" | "v";
  side: Side;
  lo: number;
  hi: number;
  /** A set's members share a row (chain, ordinate) or take one each (baseline). */
  group?: number;
  rows: number;
  fixed: boolean;
}

/**
 * Each linear dimension's side and row outside its view, at scale k:
 * dimensions on a side are packed into rows, shortest nearest, a row holding
 * any that don't overlap (with room for text set outside a short one), so
 * chained dimensions share a line and an overall size goes outside them and
 * no extension line crosses a dimension line where that can be avoided.
 */
export function planDimensionRows(items: { id: string; m: Measure; side: Side; fixed: boolean }[], k: number, style: DraftStyle): Map<string, { side: Side; row: number; dir: "h" | "v" | "a" }> {
  const out = new Map<string, { side: Side; row: number; dir: "h" | "v" | "a" }>();
  const rows: RowItem[] = [];
  const textW = 2.2 * style.font * CAP + 4;
  for (const { id, m, side, fixed } of items) {
    if (m.kind === "linear") {
      if (m.dir === "a") {
        out.set(id, { side, row: 0, dir: "a" });
        continue;
      }
      const axis = m.dir === "h" ? 0 : 1;
      let lo = Math.min(m.p1[axis], m.p2[axis]) * k;
      let hi = Math.max(m.p1[axis], m.p2[axis]) * k;
      // Too short for its text between the arrows: the text goes outside, past its end.
      if (hi - lo < textW + 2 * style.arrow.length) hi += textW + 2 * style.arrow.length;
      if (m.sides[0] && m.sides[1]) {
        lo -= 0.01;
        hi += 0.01;
      }
      rows.push({ id, dir: m.dir, side, lo, hi, rows: 1, fixed });
    } else if (m.kind === "set") {
      const axis = m.dir === "h" ? 0 : 1;
      const all = [m.origin[axis], ...m.pts.map((p) => p[axis])].map((x) => x * k);
      const lo = Math.min(...all);
      const hi = Math.max(...all);
      if (m.mode === "baseline") {
        // Each its own dimension from the origin, nested outward.
        m.pts.forEach((p, i) => rows.push({ id: `${id}#${i}`, dir: m.dir, side, lo: Math.min(m.origin[axis], p[axis]) * k, hi: Math.max(m.origin[axis], p[axis]) * k, rows: 1, fixed, group: undefined }));
      } else rows.push({ id, dir: m.dir, side, lo, hi: hi + (m.mode === "chain" ? textW * 0.4 : 0), rows: 1, fixed });
    }
  }
  for (const dir of ["h", "v"] as const) {
    for (const side of [-1, 1] as const) {
      const here = rows.filter((r) => r.dir === dir && r.side === side && !r.fixed).sort((x, y) => x.hi - x.lo - (y.hi - y.lo) || x.lo - y.lo);
      const placed: RowItem[][] = [];
      for (const r of here) {
        let row = 0;
        for (; ; row++) {
          const there = placed[row] ?? [];
          // Clear of everything in the row (2 mm apart), and nothing nearer the part may have this one's ends strictly inside it.
          const clash = there.some((o) => r.lo < o.hi + 2 && o.lo < r.hi + 2);
          if (!clash) break;
        }
        (placed[row] ??= []).push(r);
        out.set(r.id, { side, row, dir });
      }
      for (const r of rows.filter((x) => x.dir === dir && x.side === side && x.fixed)) out.set(r.id, { side, row: 0, dir });
    }
  }
  return out;
}

/** How far out from its view a dimension's row is, sheet mm. */
export function rowDistance(row: number, style: DraftStyle): number {
  return style.first + style.step * row;
}

// ------------------------------------------------------------ drawing

interface LinearDraw {
  /** The two feature points on the sheet. */
  a: Vec2;
  b: Vec2;
  /** Along the measurement, and the way out to the dimension line. */
  u: Vec2;
  n: Vec2;
  /** The dimension line is {x : x·n = level}. */
  level: number;
  label: Label;
  /** Where the text goes along the line (dragged there), a sheet point; else centred. */
  textPoint?: Vec2;
  arrows: "auto" | "inside" | "outside";
  /** Which end the text goes past when it doesn't fit between (default the second). */
  outsideEnd?: 0 | 1;
  /** Extension lines left out (a side already on the outline; an ordinate's own). */
  noExtension?: [boolean, boolean];
  owner: string;
}

/**
 * A linear dimension: extension lines from a and b (1 mm clear of the part,
 * 2 mm past the line), the line with its arrows (inside when they fit,
 * else outside with the line run on), and the text above the line (ISO,
 * along it) or upright in a break of it (ASME).
 */
export function drawLinear(d: LinearDraw, style: DraftStyle): { prims: Prim[]; textBox: Box; line: [Vec2, Vec2]; extensions: [Vec2, Vec2][]; under: Vec2; textAt: Vec2 } {
  const prims: Prim[] = [];
  const foot = (p: Vec2): Vec2 => {
    const t = d.level - dot(p, d.n);
    return add(p, mul(d.n, t));
  };
  const fa = foot(d.a);
  const fb = foot(d.b);
  const extensions: [Vec2, Vec2][] = [];
  [
    [d.a, fa],
    [d.b, fb],
  ].forEach(([p, q], i) => {
    if (d.noExtension?.[i]) return;
    const l = dist(p, q);
    if (l < style.gap + 0.5) return;
    const dir = unit(sub(q, p));
    const from = add(p, mul(dir, style.gap));
    const to = add(q, mul(dir, style.over));
    prims.push({ k: "line", pts: [from, to], w: style.thin });
    extensions.push([from, to]);
  });
  const span = dot(sub(fb, fa), d.u);
  const along: Vec2 = span >= 0 ? d.u : mul(d.u, -1);
  const length = Math.abs(span);
  const m = measureLabel(d.label);
  const fits = length >= m.w + 2 * style.arrow.length + 2.5;
  const inside = d.arrows === "inside" || (d.arrows === "auto" && length >= 2 * style.arrow.length + 2.5);
  // Text: centred, or past an end when there is no room, or where it was dragged.
  const tA = dot(fa, along);
  const tB = dot(fb, along);
  let tText = (tA + tB) / 2;
  if (d.textPoint) tText = dot(d.textPoint, along);
  else if (!fits) {
    const lo = Math.min(tA, tB);
    const hi = Math.max(tA, tB);
    tText = d.outsideEnd === 0 ? lo - style.arrow.length * 2 - m.w / 2 - 1 : hi + style.arrow.length * 2 + m.w / 2 + 1;
  }
  const base = sub(fa, mul(along, tA));
  const centre = add(base, mul(along, tText));
  // The line: between the arrows; run on under text outside it.
  let lineA = fa;
  let lineB = fb;
  const textLo = tText - m.w / 2 - 1;
  const textHi = tText + m.w / 2 + 1;
  if (!inside) {
    lineA = sub(fa, mul(along, style.arrow.length + 3));
    lineB = add(fb, mul(along, style.arrow.length + 3));
  }
  if (textLo < Math.min(dot(lineA, along), dot(lineB, along))) lineA = add(base, mul(along, textLo));
  if (textHi > Math.max(dot(lineA, along), dot(lineB, along))) lineB = add(base, mul(along, textHi));
  const asme = style.unidirectional;
  const { u: tu, angle } = asme ? { u: [1, 0] as Vec2, angle: 0 } : readable(along);
  const up = perp(tu);
  let textAt: Vec2;
  let prof: ReturnType<typeof labelPrims>;
  if (asme) {
    // Upright, centred on the line, the line broken round it.
    textAt = [centre[0], centre[1] - (m.up - m.down) / 2];
    prof = labelPrims(d.label, textAt, "middle", 0, style);
    const t0 = Math.min(dot(lineA, along), dot(lineB, along));
    const t1 = Math.max(dot(lineA, along), dot(lineB, along));
    // The break: the text's extent along the line (its width on a horizontal line, its height on a vertical one).
    const e0 = dot(prof.box.min, along);
    const e1 = dot(prof.box.max, along);
    const lo = Math.min(e0, e1) - 0.8;
    const hi = Math.max(e0, e1) + 0.8;
    const square = Math.abs(along[0]) < 1e-9 || Math.abs(along[1]) < 1e-9;
    const segs: [number, number][] = square && hi > t0 && lo < t1 ? [[t0, lo], [hi, t1]] : [[t0, t1]];
    for (const [s0, s1] of segs) if (s1 - s0 > 0.2) prims.push({ k: "line", pts: [add(base, mul(along, s0)), add(base, mul(along, s1))], w: style.thin });
  } else {
    prims.push({ k: "line", pts: [lineA, lineB], w: style.thin });
    // ISO: above the line (to the left of it, read from the bottom or the right), clear of it.
    textAt = add(centre, mul(up, style.lift + Math.max(0, m.down - 0.22 * d.label.size)));
    prof = labelPrims(d.label, textAt, "middle", angle, style);
  }
  if (inside) {
    prims.push(...arrowHead(fa, mul(along, -1), style), ...arrowHead(fb, along, style));
  } else {
    prims.push(...arrowHead(fa, along, style), ...arrowHead(fb, mul(along, -1), style));
  }
  prims.push(...prof.prims);
  // Under the text (a frame hangs there): on the far side of the line from the text.
  const under = asme ? [prof.box.min[0] + (prof.box.max[0] - prof.box.min[0]) / 2, prof.box.min[1] - 0.6] as Vec2 : add(centre, mul(up, -0.8));
  return { prims, textBox: prof.box, line: [fa, fb], extensions, under, textAt };
}

/** Lays a dimension out on the sheet. */
export function layoutDimension(a: DimensionAnnotation, ctx: AnnotationContext, cv: ComposedView, m: Measure): LayoutResult | { problem: string } {
  const style = ctx.style;
  const toSheet = (p: Vec2) => viewToSheet(cv, p);
  const box = cv.box!;
  const plan = ctx.row(a.id);
  const at = a.at ? add(cv.centre, a.at) : undefined;
  const sym = (m.kind === "linear" && m.symbol) || (a.kind === "diameter" ? "Ø" : a.kind === "radius" ? "R" : a.kind === "arcLength" ? "⌒" : "");
  const owner = a.id;
  if (m.kind === "linear") {
    const s1 = toSheet(m.p1);
    const s2 = toSheet(m.p2);
    const side = plan?.side ?? -1;
    const dist0 = a.offset !== undefined ? Math.abs(a.offset) : rowDistance(plan?.row ?? 0, style);
    // A side of the outline stands on the view's edge nearest the dimension.
    const onEdge = (s: Vec2, isSide: boolean): Vec2 => {
      if (!isSide) return s;
      if (m.dir === "h") return [s[0], side > 0 ? box.max[1] : box.min[1]];
      return [side > 0 ? box.max[0] : box.min[0], s[1]];
    };
    const a1 = onEdge(s1, m.sides[0]);
    const a2 = onEdge(s2, m.sides[1]);
    let u: Vec2;
    let n: Vec2;
    let level: number;
    if (m.dir === "h") {
      u = [1, 0];
      n = [0, side];
      level = side > 0 ? box.max[1] + dist0 : -(box.min[1] - dist0);
    } else if (m.dir === "v") {
      u = [0, 1];
      n = [side, 0];
      level = side > 0 ? box.max[0] + dist0 : -(box.min[0] - dist0);
    } else {
      u = unit(sub(a2, a1));
      n = perp(u);
      const mid = mul(add(a1, a2), 0.5);
      if (dot(sub(mid, cv.centre), n) < 0) n = mul(n, -1);
      if (a.flip) n = mul(n, -1);
      level = Math.max(dot(a1, n), dot(a2, n)) + (a.offset !== undefined ? Math.abs(a.offset) : style.first);
    }
    if (at) {
      // Dragged: the line goes through the text's place; flipping side if dragged across the part.
      const lv = dot(at, n);
      const nearest = Math.max(dot(a1, n), dot(a2, n));
      if (m.dir !== "a" && lv < Math.min(dot(a1, n), dot(a2, n))) {
        n = mul(n, -1);
        level = dot(at, n);
      } else level = Math.max(lv, nearest + 2);
    }
    const { label, text } = dimensionLabel(a, m.value, sym, style, ctx.drawing, { side: a.kind === "diameter" ? "shaft" : "hole" });
    const d = drawLinear({ a: a1, b: a2, u, n, level, label, ...(at ? { textPoint: at } : {}), arrows: a.arrows ?? "auto", outsideEnd: a.flip ? 0 : 1, owner }, style);
    const f = cv.frame;
    const alongModel: Vec3 = m.dir === "h" ? f.right : m.dir === "v" ? f.up : normalize3(toModel(sub(m.p2, m.p1), f));
    return {
      prims: d.prims,
      textBox: d.textBox,
      text,
      value: m.value,
      along: alongModel,
      at: d.textAt,
      line: d.line,
      extensions: d.extensions,
      under: d.under,
      grips: [
        { name: "text", at: d.textAt, field: "at" },
        { name: "line", at: mul(add(d.line[0], d.line[1]), 0.5), field: "offset" },
      ],
      place: { pts: [fromCentre(cv, a1), fromCentre(cv, a2), fromCentre(cv, d.line[0]), fromCentre(cv, d.line[1])], text },
    };
  }
  if (m.kind === "radial") return radial(a, ctx, cv, m, sym, toSheet, at);
  if (m.kind === "angular") return angular(a, ctx, cv, m, toSheet, at);
  if (m.kind === "arc") return arcLength(a, ctx, cv, m, toSheet, at);
  if (m.kind === "note") return noteDim(a, ctx, cv, m, toSheet, at);
  return setDims(a, ctx, cv, m, toSheet, plan);
}

function normalize3(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** A radius or diameter of a circle or arc seen end on. */
function radial(a: DimensionAnnotation, ctx: AnnotationContext, cv: ComposedView, m: Extract<Measure, { kind: "radial" }>, sym: string, toSheet: (p: Vec2) => Vec2, at: Vec2 | undefined): LayoutResult {
  const style = ctx.style;
  const c = toSheet(m.c);
  const r = m.r * cv.scale;
  const { label, text } = dimensionLabel(a, m.value, sym, style, ctx.drawing, { side: "hole" });
  const lm = measureLabel(label);
  // The leader's way out: toward the drag, else a free direction (up and right first), on the arc when it is one.
  let u: Vec2;
  if (at && dist(at, c) > 1e-6) u = unit(sub(at, c));
  else {
    u = chooseRadialDirection(ctx, cv, c, r, m.arc, lm.w, a.id);
  }
  const prims: Prim[] = [];
  const edge = add(c, mul(u, r));
  const knee = at ?? add(c, mul(u, r + Math.max(7, r * 0.25 + 5)));
  const right = knee[0] >= c[0];
  const landing = add(knee, [right ? lm.w + 1.5 : -lm.w - 1.5, 0]);
  if (m.diameter && r * 2 > lm.w + 12 && !at) {
    // Across the circle through its centre, arrows inside at both sides, run on to the text outside.
    const other = sub(c, mul(u, r));
    prims.push({ k: "line", pts: [other, edge, knee, landing], w: style.thin });
    prims.push(...arrowHead(edge, u, style), ...arrowHead(other, mul(u, -1), style));
  } else if (!m.diameter && a.jog) {
    // A large radius whose centre is off the view: from a false centre, jogged.
    const fc = add(edge, mul(u, -Math.min(r * 0.7, 30)));
    const mid = mul(add(fc, edge), 0.5);
    const j = mul(perp(u), 2.5);
    const j1 = add(sub(mid, mul(u, 2)), j);
    const j2 = sub(add(mid, mul(u, 2)), j);
    prims.push({ k: "line", pts: [fc, sub(mid, mul(u, 2)), j1, j2, add(mid, mul(u, 2)), edge, knee, landing], w: style.thin });
    prims.push(...arrowHead(edge, u, style));
    prims.push({ k: "line", pts: [add(fc, [-1, 0]), add(fc, [1, 0])], w: style.thin }, { k: "line", pts: [add(fc, [0, -1]), add(fc, [0, 1])], w: style.thin });
  } else if (!m.diameter && r > 8) {
    // From the centre to the arc, the arrow on the arc, run on outside to the text.
    prims.push({ k: "line", pts: [c, edge, knee, landing], w: style.thin });
    prims.push(...arrowHead(edge, u, style));
  } else {
    // Small: the arrow from outside onto the circle, pointing at the centre.
    prims.push({ k: "line", pts: [edge, knee, landing], w: style.thin });
    prims.push(...arrowHead(edge, mul(u, -1), style));
  }
  const textAt: Vec2 = [right ? knee[0] + 0.75 : knee[0] - 0.75, knee[1] + style.lift + Math.max(0, lm.down - 0.22 * label.size)];
  const lp = labelPrims(label, textAt, right ? "start" : "end", 0, style);
  prims.push(...lp.prims);
  return {
    prims,
    textBox: lp.box,
    text,
    value: m.value,
    at: knee,
    line: [knee, landing],
    under: [right ? knee[0] : landing[0], knee[1] - 0.8],
    grips: [{ name: "knee", at: knee, field: "at" }],
    place: { pts: [fromCentre(cv, edge), fromCentre(cv, knee), fromCentre(cv, landing)], text },
  };
}

/** A free way out of a circle for its leader: up and right if nothing is there, else the clearest of 16 directions. */
function chooseRadialDirection(ctx: AnnotationContext, cv: ComposedView, c: Vec2, r: number, arc: [number, number] | undefined, w: number, owner: string): Vec2 {
  let best: { u: Vec2; cost: number } | null = null;
  for (let k = 0; k < 16; k++) {
    const t = Math.PI / 4 + (k * Math.PI) / 8;
    if (arc) {
      // On the arc itself.
      let s = arc[1] - arc[0];
      if (s < 0) s += 2 * Math.PI;
      let x = t - arc[0];
      x = ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (x > s) continue;
    }
    const u: Vec2 = [Math.cos(t), Math.sin(t)];
    const knee = add(c, mul(u, r + Math.max(7, r * 0.25 + 5)));
    const right = knee[0] >= c[0];
    const tb: Box = { min: [right ? knee[0] : knee[0] - w - 1.5, knee[1] - 1], max: [right ? knee[0] + w + 1.5 : knee[0], knee[1] + 6] };
    let cost = ctx.occ.overlap(tb, { ignore: [owner], kinds: ["text", "symbol", "balloon", "label", "table", "title"] }) * 5;
    cost += ctx.occ.overlap(tb, { ignore: [owner], views: true, kinds: ["view"] }) * 0.4;
    cost += ctx.occ.crossings(add(c, mul(u, r)), knee, [owner]) * 30;
    if (!ctx.occ.inFrame(tb)) cost += 1000;
    cost += Math.abs(Math.sin(2 * t)) < 0.3 ? 8 : 0;
    cost += k * 0.5;
    if (!best || cost < best.cost) best = { u, cost };
  }
  return best?.u ?? [Math.SQRT1_2, Math.SQRT1_2];
}

/** An angle: an arc between the two rays, arrows on it, extension lines out to it when it is beyond the edges. */
function angular(a: DimensionAnnotation, ctx: AnnotationContext, cv: ComposedView, m: Extract<Measure, { kind: "angular" }>, toSheet: (p: Vec2) => Vec2, at: Vec2 | undefined): LayoutResult {
  const style = ctx.style;
  const v = toSheet(m.v);
  // Sheet directions of the rays (a square view keeps its directions; breaks aside).
  const e1 = toSheet(add(m.v, mul(m.d1, m.r1)));
  const e2 = toSheet(add(m.v, mul(m.d2, m.r2)));
  const d1 = unit(sub(e1, v));
  const d2 = unit(sub(e2, v));
  let a1 = Math.atan2(d1[1], d1[0]);
  let a2 = Math.atan2(d2[1], d2[0]);
  // Counter-clockwise from a1 to a2 over the minor angle, or the major one.
  let span = a2 - a1;
  while (span < 0) span += 2 * Math.PI;
  if ((span > Math.PI) !== !!a.major) {
    [a1, a2] = [a2, a1];
    span = 2 * Math.PI - span;
  }
  const minLen = Math.min(dist(e1, v), dist(e2, v));
  const R = at ? Math.max(4, dist(at, v)) : Math.max(12, Math.min(28, minLen * 0.75));
  const { label, text } = dimensionLabel(a, m.value, "", style, ctx.drawing, { angle: true });
  const prims: Prim[] = [];
  const arcPts: Vec2[] = [];
  const n = 32;
  for (let i = 0; i <= n; i++) {
    const t = a1 + (span * i) / n;
    arcPts.push([v[0] + R * Math.cos(t), v[1] + R * Math.sin(t)]);
  }
  prims.push({ k: "line", pts: arcPts, w: style.thin });
  const p1 = arcPts[0];
  const p2 = arcPts[n];
  const t1: Vec2 = [-Math.sin(a1), Math.cos(a1)];
  const t2: Vec2 = [-Math.sin(a2), Math.cos(a2)];
  prims.push(...arrowHead(p1, mul(t1, -1), style), ...arrowHead(p2, t2, style));
  // Extension lines along the rays when the arc is past an edge's end.
  for (const [e, d, p] of [
    [e1, d1, p1],
    [e2, d2, p2],
  ] as const) {
    const reach = dist(e, v);
    const dd = Math.abs(dot(sub(p, v), d));
    if (dd > reach + style.gap) prims.push({ k: "line", pts: [add(e, mul(d, style.gap)), add(p, mul(d, style.over))], w: style.thin });
  }
  const mid = a1 + span / 2;
  const mu: Vec2 = [Math.cos(mid), Math.sin(mid)];
  const lm = measureLabel(label);
  const textAt = add(v, mul(mu, R + style.lift + lm.up * 0.5));
  // Horizontal text centred outside the arc's middle (ISO 129 allows it; it reads at any angle).
  const lp = labelPrims(label, [textAt[0], textAt[1] - (lm.up - lm.down) / 2 + (mu[1] < 0 ? -lm.up * 0.4 : 0)], "middle", 0, style);
  prims.push(...lp.prims);
  return { prims, textBox: lp.box, text, value: m.value, at: textAt, grips: [{ name: "text", at: textAt, field: "at" }], place: { pts: [fromCentre(cv, p1), fromCentre(cv, p2), fromCentre(cv, arcPts[n >> 1])], text } };
}

/** An arc's length: an arc concentric with it, extension lines out to it, "⌒" before the value. */
function arcLength(a: DimensionAnnotation, ctx: AnnotationContext, cv: ComposedView, m: Extract<Measure, { kind: "arc" }>, toSheet: (p: Vec2) => Vec2, at: Vec2 | undefined): LayoutResult {
  const style = ctx.style;
  const c = toSheet(m.c);
  const r = m.r * cv.scale;
  const R = at ? Math.max(r + 2, dist(at, c)) : r + style.first;
  const { label, text } = dimensionLabel(a, m.value, "⌒", style, ctx.drawing);
  const prims: Prim[] = [];
  const n = 32;
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = m.a0 + ((m.a1 - m.a0) * i) / n;
    pts.push([c[0] + R * Math.cos(t), c[1] + R * Math.sin(t)]);
  }
  prims.push({ k: "line", pts, w: style.thin });
  // Extension lines: radial, from the arc's ends (ISO 129-1 for arcs up to 90° allows parallel ones; radial reads for any).
  for (const t of [m.a0, m.a1]) {
    const d: Vec2 = [Math.cos(t), Math.sin(t)];
    prims.push({ k: "line", pts: [add(c, mul(d, r + style.gap)), add(c, mul(d, R + style.over))], w: style.thin });
  }
  prims.push(...arrowHead(pts[0], [Math.sin(m.a0), -Math.cos(m.a0)], style), ...arrowHead(pts[n], [-Math.sin(m.a1), Math.cos(m.a1)], style));
  const mid = (m.a0 + m.a1) / 2;
  const mu: Vec2 = [Math.cos(mid), Math.sin(mid)];
  const { u, angle } = readable(perp(mu));
  void u;
  const lm = measureLabel(label);
  const textAt = add(c, mul(mu, R + style.lift + (mu[1] >= 0 ? 0 : lm.up)));
  const lp = labelPrims(label, textAt, "middle", angle, style);
  prims.push(...lp.prims);
  return { prims, textBox: lp.box, text, value: m.value, at: textAt, grips: [{ name: "text", at: textAt, field: "at" }], place: { pts: [fromCentre(cv, pts[0]), fromCentre(cv, pts[n])], text } };
}

/** A chamfer or a path length: a leader to the edge, the text on its landing. */
function noteDim(a: DimensionAnnotation, ctx: AnnotationContext, cv: ComposedView, m: Extract<Measure, { kind: "note" }>, toSheet: (p: Vec2) => Vec2, at: Vec2 | undefined): LayoutResult {
  const style = ctx.style;
  const tip = toSheet(m.tip);
  const asme = ctx.drawing.standard === "ASME";
  let body: string;
  const places = placesOf(a, ctx.drawing);
  if (m.text === "chamfer45") body = asme ? `${sizeText(m.value, places, ctx.drawing.units)} × 45°` : `C${sizeText(m.value, places, ctx.drawing.units)}`;
  else if (m.text.startsWith("chamfer:")) {
    const [, leg, ang] = m.text.split(":");
    body = `${leg} × ${ang}°`;
  } else body = `${sizeText(m.value, places, ctx.drawing.units)}`;
  const label: Label = { size: style.font, parts: [] };
  label.parts = [{ kind: "rich", spans: parseRich(`${a.count && a.count > 1 ? `${a.count}× ` : ""}${a.prefix ?? ""}${body}${m.text === "path" ? " PATH" : ""}${a.typ ? " TYP" : ""}${a.suffix ? ` ${a.suffix}` : ""}`), size: style.font }];
  const lm = measureLabel(label);
  const shape = (knee: Vec2, dir: 1 | -1): Box => ({ min: [dir > 0 ? knee[0] : knee[0] - lm.w - 1.5, knee[1] - 0.6], max: [dir > 0 ? knee[0] + lm.w + 1.5 : knee[0], knee[1] + lm.up + 1.2] });
  let knee: Vec2;
  let dir: 1 | -1;
  if (at) {
    knee = at;
    dir = at[0] >= tip[0] ? 1 : -1;
  } else {
    const s = cv.box ? findSpotLite(ctx, cv, tip, shape, a.id, m.dir) : null;
    knee = s?.knee ?? add(tip, [8, 8]);
    dir = s?.dir ?? 1;
  }
  const landing = add(knee, [dir * (lm.w + 1.5), 0]);
  const prims: Prim[] = [{ k: "line", pts: [landing, knee, tip], w: style.thin }, ...arrowHead(tip, sub(tip, knee), style)];
  const textAt: Vec2 = [dir > 0 ? knee[0] + 0.75 : knee[0] - 0.75, knee[1] + style.lift];
  const lp = labelPrims(label, textAt, dir > 0 ? "start" : "end", 0, style);
  prims.push(...lp.prims);
  const said = label.parts.map((p) => (p.kind === "rich" ? p.spans.map((s) => (s.kind === "text" ? s.text : "")).join("") : "")).join("");
  return { prims, textBox: lp.box, text: said, value: m.value, at: knee, line: [knee, landing], grips: [{ name: "knee", at: knee, field: "at" }], place: { pts: [fromCentre(cv, tip), fromCentre(cv, knee)], text: said } };
}

function findSpotLite(ctx: AnnotationContext, cv: ComposedView, tip: Vec2, shape: (k: Vec2, d: 1 | -1) => Box, owner: string, prefer: Vec2) {
  return findSpot(ctx.occ, { tip, viewBox: cv.box, shape, owner, prefer: unit(prefer), rings: [6, 10, 16, 24] });
}

/** Ordinate, baseline and chain sets. */
function setDims(a: DimensionAnnotation, ctx: AnnotationContext, cv: ComposedView, m: Extract<Measure, { kind: "set" }>, toSheet: (p: Vec2) => Vec2, plan: { side: Side; row: number } | undefined): LayoutResult {
  const style = ctx.style;
  const box = cv.box!;
  const side: Side = plan?.side ?? -1;
  const prims: Prim[] = [];
  const axis = m.dir === "h" ? 0 : 1;
  const other = 1 - axis;
  const u: Vec2 = m.dir === "h" ? [1, 0] : [0, 1];
  const n: Vec2 = m.dir === "h" ? [0, side] : [side, 0];
  const edgeLevel = side > 0 ? box.max[other] : -box.min[other];
  const fill = (p: Vec2, isSide: boolean): Vec2 => (isSide ? (other === 1 ? [p[0], side > 0 ? box.max[1] : box.min[1]] : [side > 0 ? box.max[0] : box.min[0], p[1]]) : p);
  const o = fill(toSheet(m.origin), m.sides[0]);
  const pts = m.pts.map((p, i) => fill(toSheet(p), m.sides[i + 1]));
  const texts: string[] = [];
  const places = placesOf(a, ctx.drawing);
  const owner = a.id;
  let textBox: Box | undefined;
  const grow = (b: Box | undefined, c: Box): Box => (b ? { min: [Math.min(b.min[0], c.min[0]), Math.min(b.min[1], c.min[1])], max: [Math.max(b.max[0], c.max[0]), Math.max(b.max[1], c.max[1])] } : c);
  if (m.mode === "ordinate") {
    // Each point's distance from the origin at the end of its own extension line, the values written along them; close ones jogged apart.
    const level = edgeLevel + rowDistance(plan?.row ?? 0, style) * 0.8;
    const all = [o, ...pts];
    const values = [0, ...m.values];
    const order = all.map((_, i) => i).sort((i, j) => all[i][axis] - all[j][axis]);
    const h = style.h;
    const minGap = h * 1.6;
    // Spread the text positions so neighbours are at least a letter height and a half apart.
    const want = order.map((i) => all[i][axis]);
    const placed = [...want];
    for (let i = 1; i < placed.length; i++) placed[i] = Math.max(placed[i], placed[i - 1] + minGap);
    // Centre the shift: move the run back so it sits about the points.
    const shift = (want.reduce((s, x) => s + x, 0) - placed.reduce((s, x) => s + x, 0)) / placed.length;
    for (let i = 0; i < placed.length; i++) placed[i] += shift;
    for (let i = 1; i < placed.length; i++) placed[i] = Math.max(placed[i], placed[i - 1] + minGap);
    order.forEach((idx, k) => {
      const p = all[idx];
      const pLevel = dot(p, n) * (1 as number);
      const foot = (t: number): Vec2 => (other === 1 ? [t, side * level] : [side * level, t]);
      const start = add(p, mul(n, style.gap));
      const jogAt = level - 4;
      const pts2: Vec2[] = [start];
      const fromLine = other === 1 ? [p[0], side * jogAt] : [side * jogAt, p[1]];
      if (Math.abs(placed[k] - want[k]) > 0.2) {
        pts2.push(fromLine as Vec2, other === 1 ? [placed[k], side * (jogAt + 2)] : [side * (jogAt + 2), placed[k]], foot(placed[k]));
      } else pts2.push(foot(p[axis]));
      void pLevel;
      prims.push({ k: "line", pts: pts2, w: style.thin });
      const label: Label = { parts: [{ kind: "rich", spans: parseRich(sizeText(values[idx], places, ctx.drawing.units)), size: style.font }], size: style.font };
      const tPos = add(foot(placed[k]), mul(n, 1));
      const angle = m.dir === "h" ? 90 : 0;
      const lp = labelPrims(label, [tPos[0] + (m.dir === "h" ? style.h / 2 : 0), tPos[1] - (m.dir === "h" ? 0 : style.h / 2)], side > 0 ? "start" : "end", angle, style);
      prims.push(...lp.prims);
      textBox = grow(textBox, lp.box);
      texts.push(sizeText(values[idx], places, ctx.drawing.units));
    });
    // The origin: a small circle at its point (ISO 129-1 ordinate origin).
    prims.push({ k: "circle", c: o, r: 1.2, w: style.thin });
  } else if (m.mode === "chain") {
    const level = edgeLevel + rowDistance(plan?.row ?? 0, style);
    const chain = [o, ...pts];
    for (let i = 1; i < chain.length; i++) {
      const { label, text } = dimensionLabel({ ...a, count: undefined, typ: false, suffix: undefined, prefix: undefined }, m.values[i - 1], "", style, ctx.drawing);
      const d = drawLinear({ a: chain[i - 1], b: chain[i], u, n, level, label, arrows: a.arrows ?? "auto", noExtension: [i > 1, false], owner }, style);
      prims.push(...d.prims);
      textBox = grow(textBox, d.textBox);
      texts.push(text);
    }
  } else {
    // Baseline: each from the origin, nested outward by its row.
    pts.forEach((p, i) => {
      const r = ctx.row(`${a.id}#${i}`)?.row ?? i;
      const level = edgeLevel + rowDistance(r, style);
      const { label, text } = dimensionLabel({ ...a, count: undefined, typ: false, suffix: undefined, prefix: undefined }, m.values[i], "", style, ctx.drawing);
      const d = drawLinear({ a: o, b: p, u, n, level, label, arrows: a.arrows ?? "auto", noExtension: [i > 0, false], owner }, style);
      prims.push(...d.prims);
      textBox = grow(textBox, d.textBox);
      texts.push(text);
    });
  }
  const text = texts.join(", ");
  return { prims, ...(textBox ? { textBox } : {}), text, value: m.values[m.values.length - 1], grips: [], place: { pts: [fromCentre(cv, o), ...pts.map((p) => fromCentre(cv, p))], text } };
}
