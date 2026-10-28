// Sketch text laid out as profile loops: each glyph's contours from the
// bundled font (fontData.ts, read from the TrueType outlines at build time)
// scaled so `height` is the capital letters' height, set along the baseline
// from the text's anchor point (left, centre or right of it), turned by its
// angle, slanted for italic, the bold face for bold, several lines a line
// height apart downwards. A contour's straight pieces become line segments
// and each run of its curved pieces one exact spline segment of cubic pieces
// (a TrueType quadratic raised to a cubic is the same curve), so areas are
// exact and the kernel builds the very curves. The loops are closed; letters'
// holes (O, A, B) are found by nesting like any other profile's.
//
// Pure: the document validation, the profile and the sketcher all use it.

import type { Vec2 } from "../../doc/types";
import type { Seg } from "../profile";
import type { Bezier, SplineCurve } from "../spline";
import { FONT_DATA, type FontData } from "./fontData";

export const TEXT_FONTS = ["sans"] as const;
export type TextFont = (typeof TEXT_FONTS)[number];
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

/** What laying out text needs of a text entity. */
export interface TextSpec {
  id: string;
  at: Vec2;
  text: string;
  height: number;
  font?: TextFont;
  angle?: number;
  align?: TextAlign;
  bold?: boolean;
  italic?: boolean;
}

/** Italic slants each glyph this much (degrees). */
export const ITALIC_SLANT = 12;
/** Lines are this many heights apart. */
export const LINE_SPACING = 1.6;
/** The most characters a text may have. */
export const MAX_TEXT = 400;

export function fontOf(spec: Pick<TextSpec, "font" | "bold">): FontData {
  return FONT_DATA[spec.bold ? `${spec.font ?? "sans"}-bold` : (spec.font ?? "sans")] ?? FONT_DATA.sans;
}

/** A font's capital height, font units: the top of "H". */
function capHeight(font: FontData): number {
  const g = font.glyphs.H;
  if (!g) return font.ascender * 0.7;
  return Math.max(...g[1].flatMap((c) => c.split(" ").map((p) => Number(p.replace("~", "").split(",")[1]))));
}

const capCache = new WeakMap<FontData, number>();
function cap(font: FontData): number {
  let c = capCache.get(font);
  if (c === undefined) capCache.set(font, (c = capHeight(font)));
  return c;
}

/** The characters the font has no glyph for (they are left out, as a space). */
export function missingGlyphs(text: string, spec: Pick<TextSpec, "font" | "bold"> = {}): string[] {
  const font = fontOf(spec);
  return [...new Set([...text].filter((ch) => ch !== "\n" && !font.glyphs[ch]))];
}

interface Piece {
  a: Vec2;
  /** A quadratic's control point; none for a line. */
  c?: Vec2;
  b: Vec2;
}

/** A TrueType contour's pieces (the points between two off-curve ones are implied midway). */
function pieces(points: { p: Vec2; on: boolean }[]): Piece[] {
  const n = points.length;
  if (n < 2) return [];
  // Start at an on-curve point (or the midpoint of the first two off ones).
  let k = points.findIndex((q) => q.on);
  const pts = [...points];
  if (k < 0) {
    const m: Vec2 = [(pts[0].p[0] + pts[1].p[0]) / 2, (pts[0].p[1] + pts[1].p[1]) / 2];
    pts.splice(1, 0, { p: m, on: true });
    k = 1;
  }
  const ring = [...pts.slice(k), ...pts.slice(0, k)];
  const out: Piece[] = [];
  let at = ring[0].p;
  let ctrl: Vec2 | null = null;
  for (let i = 1; i <= ring.length; i++) {
    const q = ring[i % ring.length];
    if (q.on) {
      out.push(ctrl ? { a: at, c: ctrl, b: q.p } : { a: at, b: q.p });
      at = q.p;
      ctrl = null;
    } else if (ctrl) {
      const m: Vec2 = [(ctrl[0] + q.p[0]) / 2, (ctrl[1] + q.p[1]) / 2];
      out.push({ a: at, c: ctrl, b: m });
      at = m;
      ctrl = q.p;
    } else ctrl = q.p;
  }
  return out.filter((pc) => Math.hypot(pc.b[0] - pc.a[0], pc.b[1] - pc.a[1]) > 1e-9);
}

/** A run of quadratics as one exact spline (each raised to a cubic). */
function splineOfRun(run: Piece[]): SplineCurve {
  const spans: Bezier[] = run.map(({ a, c, b }) => [a, [a[0] + (2 / 3) * (c![0] - a[0]), a[1] + (2 / 3) * (c![1] - a[1])], [b[0] + (2 / 3) * (c![0] - b[0]), b[1] + (2 / 3) * (c![1] - b[1])], b]);
  const points = [spans[0][0], ...spans.map((s) => s[3])];
  const knots = [0];
  for (const s of spans) knots.push(knots[knots.length - 1] + Math.max(1e-9, Math.hypot(s[3][0] - s[0][0], s[3][1] - s[0][1])));
  const derivs: Vec2[] = spans.map((s, i) => {
    const h = knots[i + 1] - knots[i];
    return [(3 * (s[1][0] - s[0][0])) / h, (3 * (s[1][1] - s[0][1])) / h] as Vec2;
  });
  const last = spans[spans.length - 1];
  const hl = knots[knots.length - 1] - knots[knots.length - 2];
  derivs.push([(3 * (last[3][0] - last[2][0])) / hl, (3 * (last[3][1] - last[2][1])) / hl]);
  // A control point on its end (a degenerate tangent) still has a direction: towards the far control point.
  for (const [i, s] of spans.entries()) {
    if (Math.hypot(...derivs[i]) < 1e-12) derivs[i] = [s[2][0] - s[0][0], s[2][1] - s[0][1]];
  }
  return { points, closed: false, knots, derivs, spans, exact: true };
}

/** The pieces of one contour as segments: lines, and each run of curves one spline. */
function contourSegs(entity: string, list: Piece[]): Seg[] {
  const out: Seg[] = [];
  let run: Piece[] = [];
  const flush = () => {
    if (!run.length) return;
    const curve = splineOfRun(run);
    out.push({ kind: "spline", entity, a: run[0].a, b: run[run.length - 1].b, curve });
    run = [];
  };
  for (const pc of list) {
    if (pc.c) run.push(pc);
    else {
      flush();
      out.push({ kind: "line", entity, a: pc.a, b: pc.b });
    }
  }
  flush();
  return out;
}

export interface TextLayout {
  /** Closed loops of segments, in sketch coordinates. */
  loops: Seg[][];
  /** The box round the text as set (before turning), relative to the anchor: [minX, minY, maxX, maxY] along the baseline. */
  box: [number, number, number, number];
  /** Where each line's baseline starts and ends, in sketch coordinates. */
  baselines: [Vec2, Vec2][];
}

const layoutCache = new Map<string, TextLayout>();

/** The text set as profile loops. Laid out once per spec (kept for the last few hundred). */
export function layoutText(spec: TextSpec): TextLayout {
  const key = JSON.stringify([spec.id, spec.at, spec.text, spec.height, spec.font, spec.angle, spec.align, spec.bold, spec.italic]);
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const font = fontOf(spec);
  const k = spec.height / cap(font);
  const slant = spec.italic ? Math.tan((ITALIC_SLANT * Math.PI) / 180) : 0;
  const ang = ((spec.angle ?? 0) * Math.PI) / 180;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const place = (x: number, y: number): Vec2 => [spec.at[0] + x * cos - y * sin, spec.at[1] + x * sin + y * cos];
  const loops: Seg[][] = [];
  const baselines: [Vec2, Vec2][] = [];
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  spec.text.split("\n").forEach((line, row) => {
    const width = [...line].reduce((w, ch) => w + (font.glyphs[ch]?.[0] ?? font.glyphs[" "]?.[0] ?? 0), 0) * k;
    const x0 = spec.align === "center" ? -width / 2 : spec.align === "right" ? -width : 0;
    const y0 = -row * LINE_SPACING * spec.height;
    baselines.push([place(x0, y0), place(x0 + width, y0)]);
    box = [Math.min(box[0], x0), Math.min(box[1], y0), Math.max(box[2], x0 + width), Math.max(box[3], y0 + spec.height)];
    let pen = x0;
    for (const ch of line) {
      const g = font.glyphs[ch];
      if (!g) {
        pen += (font.glyphs[" "]?.[0] ?? 0) * k;
        continue;
      }
      for (const contour of g[1]) {
        const pts = contour.split(" ").map((t) => {
          const on = !t.startsWith("~");
          const [x, y] = t.replace("~", "").split(",").map(Number);
          const gx = x * k;
          const gy = y * k;
          return { p: place(pen + gx + gy * slant, y0 + gy), on };
        });
        const segs = contourSegs(spec.id, pieces(pts));
        if (segs.length) loops.push(segs);
        for (const q of pts) {
          const lx = (q.p[0] - spec.at[0]) * cos + (q.p[1] - spec.at[1]) * sin;
          const ly = -(q.p[0] - spec.at[0]) * sin + (q.p[1] - spec.at[1]) * cos;
          box = [Math.min(box[0], lx), Math.min(box[1], ly), Math.max(box[2], lx), Math.max(box[3], ly)];
        }
      }
      pen += g[0] * k;
    }
  });
  if (!Number.isFinite(box[0])) box = [0, 0, 0, spec.height];
  const out = { loops, box, baselines };
  if (layoutCache.size > 400) layoutCache.clear();
  layoutCache.set(key, out);
  return out;
}

/** The text's box corners (turned with it), in sketch coordinates: for drawing, picking and fitting. */
export function textCorners(spec: TextSpec): [Vec2, Vec2, Vec2, Vec2] {
  const { box } = layoutText(spec);
  const ang = ((spec.angle ?? 0) * Math.PI) / 180;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const p = (x: number, y: number): Vec2 => [spec.at[0] + x * c - y * s, spec.at[1] + x * s + y * c];
  return [p(box[0], box[1]), p(box[2], box[1]), p(box[2], box[3]), p(box[0], box[3])];
}
