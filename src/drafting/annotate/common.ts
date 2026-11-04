// What every annotation module shares (Phase Q): the layout an annotation
// makes (its primitives, its box, the grips a drag moves, what it says), the
// context it is laid out in (the sheet's views, its data, the standard's
// style, what is already placed), and the drawing pieces they are built
// from: arrowheads, leaders, labels with stacked tolerances and frames.

import type { Annotation, AnnotationPlace, ArrowStyle, Drawing, GeoRef, Vec2, Vec3, Weld } from "../../doc/types";
import type { HoleRecord } from "../../kernel/rebuild";
import type { BodyMeasurement, MemberMeasurement } from "../../kernel/measure";
import type { CutListItem } from "../../weldment/cutlist";
import type { ComposedView, PointContext } from "../compose";
import type { ResolvedGeoRef } from "../georef";
import type { PropContext } from "../props";
import { boxOf, type Box, type Prim } from "../sheet";
import { CAP } from "../text";
import { parseRich, place, richPrims, richWidth, type Span } from "../symbols/richtext";
import type { DraftStyle } from "./style";
import type { Occupancy } from "./placement";

// ------------------------------------------------------------ layouts

/**
 * A handle a drag moves: the text, a dimension's line, a leader's knee, a
 * symbol. `field` is what dragging it sets (see dragGrip in ./picks).
 */
export interface Grip {
  name: "text" | "line" | "knee" | "symbol" | "frame" | "end" | "vertex";
  /** On the sheet. */
  at: Vec2;
  field: "at" | "offset" | "pts" | "via";
  /** For pts / via: which point. */
  index?: number;
}

/** An annotation laid out on the sheet. */
export interface AnnotationLayout {
  id: string;
  type: Annotation["type"];
  view?: string;
  prims: Prim[];
  box: Box | null;
  /** Where its text is (a dimension's, a callout's): for hit tests, collisions and attachments. */
  textBox?: Box;
  /** What it says. */
  text: string;
  /** A dimension's value (mm or degrees) and the model direction it measures along. */
  value?: number;
  along?: Vec3;
  /** A balloon's item. */
  item?: number;
  /** Where it is held (a balloon's centre, a callout's knee, a frame's corner): what a drag moves. */
  at?: Vec2;
  grips: Grip[];
  /** Why it isn't drawn (or is drawn dangling, in the warning colour, at its last place). */
  problem?: string;
  dangling?: boolean;
  /** Where it is now, from its view's centre: kept as the annotation's `last`. */
  place?: AnnotationPlace;
  /** A dimension's line, ends on the sheet (frames and datums attach to it); a leader's landing. */
  line?: [Vec2, Vec2];
  /** A dimension's extension lines, each from the part to past the line. */
  extensions?: [Vec2, Vec2][];
  /** The point text attaches at below a dimension (a frame under it). */
  under?: Vec2;
}

/** What the sheet's annotations read: its holes, welds, members, items, properties. */
export interface AnnotationData {
  /** Each hole feature's first hole, and how many holes it makes with its copies. */
  holes: Map<string, HoleRecord>;
  holeCounts: Map<string, number>;
  /** The pattern that copies a hole feature, when one does: its kind and count. */
  patterns: Map<string, { op: string; id: string; count: number }>;
  welds: Weld[];
  members: MemberMeasurement[];
  bodies: BodyMeasurement[];
  cutList: CutListItem[];
  /** A body's or member's item number (the cut list v2's, kept numbering included), when known. */
  itemOf?: (bodyOrMember: string) => number | null;
  /** How many of an item. */
  quantityOf?: (item: number) => number;
  props: PropContext;
}

/** The sheet as far as annotations need it. */
export interface SheetGeometry {
  id: string;
  views: ComposedView[];
  points: PointContext;
  frame: Box;
  titleBlock: Box;
}

export interface AnnotationContext {
  sheet: SheetGeometry;
  style: DraftStyle;
  drawing: Drawing;
  data: AnnotationData;
  occ: Occupancy;
  /** Annotations laid out so far, by id (a frame finds its dimension here). */
  layouts: Map<string, AnnotationLayout>;
  /** Every annotation on the sheet, by id. */
  all: Map<string, Annotation>;
  resolve(ref: GeoRef): ResolvedGeoRef | null;
  view(id: string): ComposedView | undefined;
  /** A linear dimension's planned line: its side and its row outside the view (see ./dimension planDimensionRows). */
  row(id: string): { side: -1 | 1; row: number; dir: "h" | "v" | "a" } | undefined;
}

export type LayoutResult = Omit<AnnotationLayout, "id" | "type" | "view" | "box" | "grips"> & { grips?: Grip[]; box?: Box | null };

export function failed(problem: string): { problem: string } {
  return { problem };
}

// ------------------------------------------------------------ vectors

export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
export const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const unit = (a: Vec2): Vec2 => {
  const l = Math.hypot(a[0], a[1]);
  return l < 1e-12 ? [1, 0] : [a[0] / l, a[1] / l];
};
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const round1 = (p: Vec2): Vec2 => [Math.round(p[0] * 10) / 10 + 0, Math.round(p[1] * 10) / 10 + 0];
export const deg = (rad: number) => (rad * 180) / Math.PI;

/** A view's point (sheet mm) as `at` is held: from the view's centre. */
export function fromCentre(cv: Pick<ComposedView, "centre">, p: Vec2): Vec2 {
  return round1([p[0] - cv.centre[0], p[1] - cv.centre[1]]);
}

export function toSheetAt(cv: Pick<ComposedView, "centre"> | undefined, at: Vec2): Vec2 {
  return cv ? [cv.centre[0] + at[0], cv.centre[1] + at[1]] : at;
}

/** The angle text reads at along direction d: from the bottom or the right of the sheet (ISO 129-1 method 1). */
export function readable(d: Vec2): { u: Vec2; angle: number } {
  let u = unit(d);
  let a = deg(Math.atan2(u[1], u[0]));
  if (a <= -90 + 1e-6 || a > 90 + 1e-6) {
    u = [-u[0], -u[1]];
    a = deg(Math.atan2(u[1], u[0]));
  }
  return { u, angle: Math.abs(a) < 1e-6 ? 0 : Math.round(a * 1000) / 1000 + 0 };
}

// ------------------------------------------------------------ arrowheads and leaders

/** An arrowhead (or dot, or slash) at `tip`, pointing along `dir`. */
export function arrowHead(tip: Vec2, dir: Vec2, style: DraftStyle, kind: ArrowStyle = "closed", scale = 1): Prim[] {
  const d = unit(dir);
  const l = style.arrow.length * scale;
  const hw = style.arrow.half * scale;
  const back = sub(tip, mul(d, l));
  const side = mul(perp(d), hw);
  switch (kind) {
    case "none":
      return [];
    case "dot":
      return [{ k: "circle", c: tip, r: 0.5 * scale + 0.25, w: style.thin, fill: true }];
    case "open":
      return [{ k: "line", pts: [add(back, side), tip, sub(back, side)], w: style.thin }];
    case "slash": {
      // An oblique stroke (architectural ticks, ASME's alternative): 45° across the line.
      const t = mul(unit(add(d, perp(d))), 1.6 * scale);
      return [{ k: "line", pts: [sub(tip, t), add(tip, t)], w: style.symbol }];
    }
    default:
      return [{ k: "line", pts: [tip, add(back, side), sub(back, side)], closed: true, fill: true, w: style.thin }];
  }
}

/** A smooth curve through points (Catmull-Rom), for spline leaders. */
export function spline(pts: Vec2[], steps = 10): Vec2[] {
  if (pts.length < 3) return pts;
  const out: Vec2[] = [pts[0]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  return out;
}

/**
 * A leader from `from` (the text's side) through `via` to `tip`, ending in
 * an arrowhead (ISO 128-22: a filled arrow on an outline, a dot on a
 * surface, none on a dimension line).
 */
export function leaderPrims(from: Vec2, via: Vec2[], tip: Vec2, style: DraftStyle, arrow: ArrowStyle = "closed", smooth = false): Prim[] {
  const pts = [from, ...via, tip];
  const line = smooth ? spline(pts) : pts;
  const last = line[line.length - 2];
  const d = sub(tip, last);
  // The line stops at the arrowhead's back so its end doesn't show past the tip.
  const back = arrow === "closed" && len(d) > style.arrow.length ? sub(tip, mul(unit(d), style.arrow.length * 0.6)) : tip;
  return [{ k: "line", pts: [...line.slice(0, -1), back], w: style.thin }, ...arrowHead(tip, d, style, arrow)];
}

// ------------------------------------------------------------ labels

/** A piece of a label: rich text, a stack of two lines (deviations, limits), or a gap. */
export type LabelPart = { kind: "rich"; spans: Span[]; size: number } | { kind: "stack"; upper: Span[]; lower: Span[]; size: number; brackets?: boolean } | { kind: "gap"; w: number };

/** Text that may hold stacked tolerances, in a frame: a box (basic), brackets (reference), an oval (inspection). */
export interface Label {
  parts: LabelPart[];
  /** The main size, mm: the label's capitals are size × CAP. */
  size: number;
  frame?: "box" | "brackets" | "oval";
  /** A second line under it (dual units, a "2×" note). */
  below?: Span[];
}

export function rich(text: string, size: number): LabelPart {
  return { kind: "rich", spans: parseRich(text), size };
}

/** A label's width, and how far it reaches above and below its baseline, mm. */
export function measureLabel(l: Label): { w: number; up: number; down: number } {
  const h = l.size * CAP;
  let w = 0;
  let up = h;
  let down = 0.22 * l.size;
  for (const p of l.parts) {
    if (p.kind === "gap") w += p.w;
    else if (p.kind === "rich") w += richWidth(p.spans, p.size);
    else {
      const sw = Math.max(richWidth(p.upper, p.size), richWidth(p.lower, p.size));
      const b = p.brackets ? 2 * 0.333 * l.size : 0;
      w += sw + b;
      const st = stackLines(l.size, p.size);
      up = Math.max(up, st.upper + p.size * CAP);
      down = Math.max(down, -st.lower + 0.22 * p.size);
    }
  }
  if (l.frame === "brackets") w += 2 * 0.333 * l.size;
  const pad = l.frame === "box" ? 0.9 : l.frame === "oval" ? h * 0.8 : 0;
  if (l.below) down += 1.5 * l.size;
  return { w: w + 2 * pad, up: up + (l.frame ? 0.9 : 0), down: down + (l.frame ? 0.9 : 0) };
}

/** Where a stack's two baselines sit, from the label's: the lower a little under, the upper above it. */
function stackLines(size: number, small: number): { upper: number; lower: number } {
  const h = size * CAP;
  const lower = -0.12 * h;
  return { lower, upper: lower + small * CAP * 1.45 };
}

/**
 * A label's primitives, its baseline's start, middle or end at `at`, turned
 * by `angle` degrees; and its box on the sheet (the turned rectangle's
 * bounds) and that rectangle's corners.
 */
export function labelPrims(l: Label, at: Vec2, anchor: "start" | "middle" | "end", angle: number, style: DraftStyle): { prims: Prim[]; box: Box; corners: Vec2[]; width: number } {
  const m = measureLabel(l);
  const h = l.size * CAP;
  const pad = l.frame === "box" ? 0.9 : l.frame === "oval" ? h * 0.8 : 0;
  const x0 = anchor === "start" ? 0 : anchor === "middle" ? -m.w / 2 : -m.w;
  const local: Prim[] = [];
  let x = x0 + pad;
  const stroke = Math.min(style.symbol, h / 10);
  if (l.frame === "brackets") {
    local.push({ k: "text", at: [x, 0], text: "(", size: l.size, anchor: "start" });
    x += 0.333 * l.size;
  }
  for (const p of l.parts) {
    if (p.kind === "gap") {
      x += p.w;
      continue;
    }
    if (p.kind === "rich") {
      local.push(...richPrims(p.spans, [x, 0], { size: p.size, stroke }));
      x += richWidth(p.spans, p.size);
      continue;
    }
    const st = stackLines(l.size, p.size);
    if (p.brackets) {
      local.push({ k: "text", at: [x, -0.05 * h], text: "(", size: l.size * 1.25, anchor: "start" });
      x += 0.333 * l.size;
    }
    const sw = Math.max(richWidth(p.upper, p.size), richWidth(p.lower, p.size));
    // Deviations line up on their right (their decimal points, for equal decimals).
    local.push(...richPrims(p.upper, [x + sw, st.upper], { size: p.size, anchor: "end", stroke }));
    local.push(...richPrims(p.lower, [x + sw, st.lower], { size: p.size, anchor: "end", stroke }));
    x += sw;
    if (p.brackets) {
      local.push({ k: "text", at: [x, -0.05 * h], text: ")", size: l.size * 1.25, anchor: "start" });
      x += 0.333 * l.size;
    }
  }
  if (l.frame === "brackets") {
    local.push({ k: "text", at: [x, 0], text: ")", size: l.size, anchor: "start" });
    x += 0.333 * l.size;
  }
  const top = m.up - (l.frame ? 0.9 : 0) + (l.frame ? 0.9 : 0);
  const bottom = -(m.down - (l.below ? 1.5 * l.size : 0));
  if (l.frame === "box") local.push({ k: "line", pts: [[x0, bottom], [x0 + m.w, bottom], [x0 + m.w, top], [x0, top]], closed: true, w: style.thin });
  if (l.frame === "oval") {
    // A stadium: two half circles joined.
    const r = (top - bottom) / 2;
    const cy = (top + bottom) / 2;
    const pts: Vec2[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = Math.PI / 2 + (Math.PI * i) / 16;
      pts.push([x0 + r + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    for (let i = 0; i <= 16; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / 16;
      pts.push([x0 + m.w - r + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    local.push({ k: "line", pts, closed: true, w: style.thin });
  }
  if (l.below) local.push(...richPrims(l.below, [x0 + m.w / 2, bottom - 1.2 * l.size + 0.22 * l.size], { size: l.size, anchor: "middle", stroke }));
  const placed = place(local, at, angle);
  const cornersLocal: Vec2[] = [
    [x0, -m.down],
    [x0 + m.w, -m.down],
    [x0 + m.w, m.up],
    [x0, m.up],
  ];
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const corners = cornersLocal.map(([px, py]): Vec2 => [at[0] + px * c - py * s, at[1] + px * s + py * c]);
  return { prims: placed, box: boxOf(corners)!, corners, width: m.w };
}

/** A box's corners, for leaders that start at a label's side. */
export function boxMidSide(b: Box, side: "left" | "right" | "top" | "bottom"): Vec2 {
  const cy = (b.min[1] + b.max[1]) / 2;
  const cx = (b.min[0] + b.max[0]) / 2;
  return side === "left" ? [b.min[0], cy] : side === "right" ? [b.max[0], cy] : side === "top" ? [cx, b.max[1]] : [cx, b.min[1]];
}

/** Every primitive coloured (a dangling annotation's warning colour). */
export function coloured(prims: Prim[], color: string): Prim[] {
  return prims.map((p) => (p.k === "area" ? p : { ...p, color }));
}

/** A label's size for lettering of capital height h (mm). */
export function fontFor(h: number): number {
  return h / CAP;
}
