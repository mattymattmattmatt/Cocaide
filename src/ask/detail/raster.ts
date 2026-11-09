// A composed sheet as a picture, without a browser (Phase Q wave Q3B): what
// the detailing agent's renderSheet tool and its critic look at, and what the
// MCP server and the tests render. It draws the sheet's display list (the
// same primitives the SVG and PDF are written from) with exact-area
// anti-aliasing: lines at their ISO weights (never thinner than a pixel),
// dashes, filled arrowheads, hatch and shaded areas, and text in the bundled
// Liberation Sans outlines (metric-compatible with the sheet's Helvetica).

import type { Vec2 } from "../../doc/types";
import type { ComposedSheet } from "../../drafting/compose";
import type { Prim } from "../../drafting/sheet";
import { FONT_DATA, type FontData } from "../../geom/text/fontData";
import { encodePNG } from "../../render/png";
import type { Image } from "../../render/raster";

export interface SheetRaster {
  png: Uint8Array;
  width: number;
  height: number;
  /** Pixels per sheet mm. */
  scale: number;
}

/** The longest side a render gets by default: about 150 dpi on A3, enough to read 2.5 mm text. */
export const RENDER_SIDE = 2400;

/** The sheet as RGBA pixels, `scale` pixels per mm (default: its longer side `side` pixels). */
export function rasterizeSheet(sheet: ComposedSheet, opts: { scale?: number; side?: number } = {}): Image {
  const k = opts.scale ?? (opts.side ?? RENDER_SIDE) / Math.max(sheet.width, sheet.height);
  const width = Math.max(1, Math.round(sheet.width * k));
  const height = Math.max(1, Math.round(sheet.height * k));
  const data = new Uint8Array(width * height * 4).fill(255);
  const canvas: Canvas = { width, height, data };
  const toPx = (p: Vec2): Vec2 => [p[0] * k, (sheet.height - p[1]) * k];
  for (const p of sheet.prims) drawPrim(canvas, p, toPx, k);
  return { width, height, data };
}

/** The sheet as a PNG (renderSheet). */
export async function sheetRaster(sheet: ComposedSheet, opts: { scale?: number; side?: number } = {}): Promise<SheetRaster> {
  const img = rasterizeSheet(sheet, opts);
  const scale = img.width / sheet.width;
  return { png: await encodePNG(img), width: img.width, height: img.height, scale };
}

// ------------------------------------------------------------ drawing

interface Canvas {
  width: number;
  height: number;
  data: Uint8Array;
}

type Poly = Vec2[];

function drawPrim(c: Canvas, p: Prim, toPx: (p: Vec2) => Vec2, k: number): void {
  if (p.k === "area") {
    fill(c, p.loops.map((l) => l.map(toPx)), colour(p.fill));
    return;
  }
  if (p.k === "text") {
    fill(c, textPolys(p, toPx, k), colour(p.color));
    return;
  }
  const rgb = colour(p.color);
  if (p.k === "circle") {
    const n = Math.max(24, Math.min(256, Math.round(p.r * k * 1.2)));
    const ring: Vec2[] = Array.from({ length: n + 1 }, (_, i) => [p.c[0] + p.r * Math.cos((2 * Math.PI * i) / n), p.c[1] + p.r * Math.sin((2 * Math.PI * i) / n)]);
    if (p.fill) fill(c, [ring.map(toPx)], rgb);
    stroke(c, ring.map(toPx), p.w * k, p.dash?.map((d) => d * k), rgb);
    return;
  }
  const pts = p.pts.map(toPx);
  if (p.fill) fill(c, [pts], rgb);
  stroke(c, p.closed || p.fill ? [...pts, pts[0]] : pts, p.w * k, p.dash?.map((d) => d * k), rgb);
}

/** A polyline stroked: each piece a quad, round joins as small polygons; dashed by the pattern (pixels). */
function stroke(c: Canvas, pts: Vec2[], w: number, dash: number[] | undefined, rgb: RGB): void {
  if (pts.length < 2) return;
  const half = Math.max(w, 0.9) / 2;
  const runs = dash && dash.length && dash.some((d) => d > 0) ? dashed(pts, dash) : [pts];
  const polys: Poly[] = [];
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      const [a, b] = [run[i - 1], run[i]];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nx = (-dy / len) * half;
      const ny = (dx / len) * half;
      polys.push(ccw([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]));
    }
    // Round joins and caps where the line is thick enough for them to show.
    if (half > 1) for (const q of run) polys.push(disc(q, half));
  }
  fill(c, polys, rgb, true);
}

function dashed(pts: Vec2[], pattern: number[]): Vec2[][] {
  const out: Vec2[][] = [];
  let k = 0;
  let left = Math.max(pattern[0], 0.5);
  let on = true;
  let cur: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (len > 1e-9) {
      const step = Math.min(left, len);
      const t = step / len;
      const m: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (on) cur.push(m);
      left -= step;
      len -= step;
      a = m;
      if (left <= 1e-9) {
        if (on && cur.length > 1) out.push(cur);
        on = !on;
        k = (k + 1) % pattern.length;
        left = Math.max(pattern[k], on ? 0.5 : 0.8);
        cur = [m];
      }
    }
  }
  if (on && cur.length > 1) out.push(cur);
  return out;
}

function disc(c: Vec2, r: number): Poly {
  const n = Math.max(8, Math.min(32, Math.round(r * 3)));
  return ccw(Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)] as Vec2));
}

/** One winding for every stroke piece, so overlapping pieces add up instead of cancelling. */
function ccw(p: Poly): Poly {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a < 0 ? [...p].reverse() : p;
}

// ------------------------------------------------------------ text

const fontCache = new Map<string, { font: FontData; glyphs: Map<string, { adv: number; loops: Vec2[][] }> }>();

function fontFor(bold: boolean) {
  const key = bold ? "sans-bold" : "sans";
  let f = fontCache.get(key);
  if (!f) fontCache.set(key, (f = { font: FONT_DATA[key] ?? FONT_DATA.sans, glyphs: new Map() }));
  return f;
}

/** A glyph's outlines, flattened (font units, y up). */
function glyphOf(bold: boolean, ch: string): { adv: number; loops: Vec2[][] } | null {
  const f = fontFor(bold);
  const hit = f.glyphs.get(ch);
  if (hit) return hit;
  const g = f.font.glyphs[ch];
  if (!g) return null;
  const loops = g[1].map((contour) => flatten(contour));
  const out = { adv: g[0], loops };
  f.glyphs.set(ch, out);
  return out;
}

/** A TrueType contour ("x,y" on the curve, "~x,y" a control point) as a polygon. */
function flatten(contour: string): Vec2[] {
  const pts = contour.split(" ").map((s) => {
    const on = !s.startsWith("~");
    const [x, y] = s.replace("~", "").split(",").map(Number);
    return { p: [x, y] as Vec2, on };
  });
  if (pts.length < 2) return pts.map((q) => q.p);
  let start = pts.findIndex((q) => q.on);
  if (start < 0) {
    pts.splice(1, 0, { p: [(pts[0].p[0] + pts[1].p[0]) / 2, (pts[0].p[1] + pts[1].p[1]) / 2], on: true });
    start = 1;
  }
  const ring = [...pts.slice(start), ...pts.slice(0, start)];
  const out: Vec2[] = [ring[0].p];
  let at = ring[0].p;
  let ctrl: Vec2 | null = null;
  const quad = (a: Vec2, cp: Vec2, b: Vec2) => {
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      const u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * cp[0] + t * t * b[0], u * u * a[1] + 2 * u * t * cp[1] + t * t * b[1]]);
    }
  };
  for (let i = 1; i <= ring.length; i++) {
    const q = ring[i % ring.length];
    if (q.on) {
      if (ctrl) quad(at, ctrl, q.p);
      else out.push(q.p);
      at = q.p;
      ctrl = null;
    } else if (ctrl) {
      const m: Vec2 = [(ctrl[0] + q.p[0]) / 2, (ctrl[1] + q.p[1]) / 2];
      quad(at, ctrl, m);
      at = m;
      ctrl = q.p;
    } else ctrl = q.p;
  }
  return out;
}

/** A text primitive's glyphs as polygons, in pixels: anchored, rotated, slanted when italic. */
function textPolys(p: Extract<Prim, { k: "text" }>, toPx: (p: Vec2) => Vec2, k: number): Poly[] {
  const bold = !!p.bold;
  const font = fontFor(bold).font;
  const s = p.size / font.unitsPerEm;
  const chars = [...p.text];
  const width = chars.reduce((t, ch) => t + (glyphOf(bold, ch)?.adv ?? font.unitsPerEm * 0.5), 0) * s;
  const x0 = p.anchor === "middle" ? -width / 2 : p.anchor === "end" ? -width : 0;
  const a = ((p.angle ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const slant = p.italic ? Math.tan((12 * Math.PI) / 180) : 0;
  const polys: Poly[] = [];
  let x = x0;
  void k;
  for (const ch of chars) {
    const g = glyphOf(bold, ch);
    if (g) {
      for (const loop of g.loops) {
        polys.push(
          loop.map(([gx, gy]) => {
            const lx = x + (gx + slant * gy) * s;
            const ly = gy * s;
            return toPx([p.at[0] + lx * cos - ly * sin, p.at[1] + lx * sin + ly * cos]);
          }),
        );
      }
    }
    x += (g?.adv ?? font.unitsPerEm * 0.5) * s;
  }
  return polys;
}

// ------------------------------------------------------------ fill (exact-area coverage, non-zero by magnitude)

type RGB = [number, number, number];

const NAMED: Record<string, RGB> = { black: [0, 0, 0], white: [255, 255, 255], red: [192, 57, 43], gray: [128, 128, 128], grey: [128, 128, 128] };

function colour(c: string | undefined): RGB {
  if (!c || c === "currentColor") return [0, 0, 0];
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return NAMED[c.trim().toLowerCase()] ?? [0, 0, 0];
}

/**
 * Fills polygons into the canvas with exact-area anti-aliasing (signed-area
 * accumulation, one pass per scanline). Coverage is the magnitude of the
 * winding, clamped to one: outlines with holes (glyphs) and overlapping
 * same-turning pieces (a stroke's) both come out right.
 */
function fill(c: Canvas, polys: Poly[], rgb: RGB, _stroke = false): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys)
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  if (!Number.isFinite(minX)) return;
  const x0 = Math.max(0, Math.floor(minX) - 1);
  const y0 = Math.max(0, Math.floor(minY) - 1);
  const x1 = Math.min(c.width, Math.ceil(maxX) + 2);
  const y1 = Math.min(c.height, Math.ceil(maxY) + 2);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const acc = new Float32Array(w * h + 2);
  const W = w;
  const line = (ax: number, ay: number, bx: number, by: number) => {
    ax -= x0;
    bx -= x0;
    ay -= y0;
    by -= y0;
    if (Math.abs(ay - by) < 1e-9) return;
    let dir = 1;
    if (ay > by) {
      [ax, ay, bx, by] = [bx, by, ax, ay];
      dir = -1;
    }
    const dxdy = (bx - ax) / (by - ay);
    let x = ax;
    if (ay < 0) x -= ay * dxdy;
    const ys = Math.max(0, Math.floor(ay));
    const ye = Math.min(h, Math.ceil(by));
    const clampX = (v: number) => Math.min(Math.max(v, 0), W - 1.0001);
    for (let y = ys; y < ye; y++) {
      const row = y * W;
      const dy = Math.min(y + 1, by) - Math.max(y, ay);
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      const xa = clampX(Math.min(x, xnext));
      const xb = clampX(Math.max(x, xnext));
      const xaf = Math.floor(xa);
      const xai = xaf;
      const xbc = Math.ceil(xb);
      const xbi = xbc;
      if (xbi <= xai + 1) {
        const xmf = 0.5 * (clampX(x) + clampX(xnext)) - xaf;
        acc[row + xai] += d - d * xmf;
        acc[row + xai + 1] += d * xmf;
      } else {
        const s = 1 / (xb - xa);
        const f0 = xa - xaf;
        const a0 = 0.5 * s * (1 - f0) * (1 - f0);
        const f1 = xb - xbc + 1;
        const am = 0.5 * s * f1 * f1;
        acc[row + xai] += d * a0;
        if (xbi === xai + 2) acc[row + xai + 1] += d * (1 - a0 - am);
        else {
          const a1 = s * (1.5 - f0);
          acc[row + xai + 1] += d * (a1 - a0);
          for (let xi = xai + 2; xi < xbi - 1; xi++) acc[row + xi] += d * s;
          const a2 = a1 + (xbi - xai - 3) * s;
          acc[row + xbi - 1] += d * (1 - a2 - am);
        }
        acc[row + xbi] += d * am;
      }
      x = xnext;
    }
  };
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      line(a[0], a[1], b[0], b[1]);
    }
  }
  const [r, g, b] = rgb;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    const py = y + y0;
    for (let x = 0; x < w; x++) {
      sum += acc[y * W + x];
      const cov = Math.min(1, Math.abs(sum));
      if (cov < 1 / 512) continue;
      const i = (py * c.width + x + x0) * 4;
      c.data[i] = Math.round(c.data[i] + (r - c.data[i]) * cov);
      c.data[i + 1] = Math.round(c.data[i + 1] + (g - c.data[i + 1]) * cov);
      c.data[i + 2] = Math.round(c.data[i + 2] + (b - c.data[i + 2]) * cov);
    }
  }
}
