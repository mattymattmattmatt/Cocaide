// Rich text on a sheet (Phase Q): what a note, a callout or a dimension says,
// with **bold**, *italic* and __underlined__ runs, the symbols palette's
// tokens (<MOD-DIAM>, <HOLE-DEPTH> ...) and the drafting characters (↧ ⌴ ⌵
// □ Ⓜ ⌖ ...) drawn as glyphs among the letters. Measured with the sheet
// font's metrics, so a box drawn round it fits in the app, the SVG and the
// PDF alike.

import type { Vec2 } from "../../doc/types";
import type { Prim } from "../sheet";
import { CAP, textWidth } from "../text";
import { expandTokens, glyph, GLYPH_CHARS, glyphWidth, type GlyphName } from "./glyphs";

export type Span = { kind: "text"; text: string; bold?: boolean; italic?: boolean; underline?: boolean } | { kind: "glyph"; name: GlyphName; underline?: boolean };

/** Reads text into runs: markup toggles bold (**), italic (*) and underline (__); tokens and drafting characters become glyphs. */
export function parseRich(text: string): Span[] {
  const s = expandTokens(text);
  const out: Span[] = [];
  let bold = false;
  let italic = false;
  let underline = false;
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}), ...(underline ? { underline } : {}) });
    buf = "";
  };
  for (let i = 0; i < s.length; ) {
    if (s.startsWith("**", i)) {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (s.startsWith("__", i)) {
      flush();
      underline = !underline;
      i += 2;
      continue;
    }
    if (s[i] === "*" && s[i + 1] !== " " && (italic || /\S/.test(s[i + 1] ?? ""))) {
      // A lone * that opens before a word or closes a run is italic; "2 * 3" stays.
      if (italic || s.indexOf("*", i + 1) > i) {
        flush();
        italic = !italic;
        i += 1;
        continue;
      }
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (GLYPH_CHARS[ch]) {
      flush();
      out.push({ kind: "glyph", name: GLYPH_CHARS[ch], ...(underline ? { underline } : {}) });
    } else buf += ch;
    i += ch.length;
  }
  flush();
  return out;
}

/** Plain text of runs (glyphs as their characters): what a reader of the sheet's text layer sees. */
export function plainText(text: string): string {
  return expandTokens(text).replace(/\*\*|__/g, "").replace(/(^|\s)\*(\S)/g, "$1$2").replace(/(\S)\*(\s|$)/g, "$1$2");
}

/** Width of runs at font size `size`, mm. */
export function richWidth(spans: Span[], size: number): number {
  let w = 0;
  for (const s of spans) w += s.kind === "text" ? textWidth(s.text, size, s.bold) : glyphWidth(s.name, size * CAP);
  return w;
}

export interface RichStyle {
  size: number;
  anchor?: "start" | "middle" | "end";
  /** Degrees, counter-clockwise. */
  angle?: number;
  bold?: boolean;
  color?: string;
  owner?: string;
  layer?: string;
  /** Glyph strokes, mm (default the capital height / 10). */
  stroke?: number;
}

/** Runs set on a baseline at `at`, as primitives; the anchor is the run's start, middle or end. */
export function richPrims(spans: Span[], at: Vec2, style: RichStyle): Prim[] {
  const size = style.size;
  const width = richWidth(spans, size);
  const x0 = style.anchor === "middle" ? -width / 2 : style.anchor === "end" ? -width : 0;
  const out: Prim[] = [];
  const extra = { ...(style.color ? { color: style.color } : {}), ...(style.owner ? { owner: style.owner } : {}), ...(style.layer ? { layer: style.layer } : {}) };
  let x = x0;
  const h = size * CAP;
  for (const s of spans) {
    const w = s.kind === "text" ? textWidth(s.text, size, s.bold) : glyphWidth(s.name, h);
    if (s.kind === "text") {
      out.push({ k: "text", at: [x, 0], text: s.text, size, anchor: "start", ...(s.bold || style.bold ? { bold: true } : {}), ...(s.italic ? { italic: true } : {}), ...extra });
    } else out.push(...glyph(s.name, x, 0, h, { w: style.stroke ?? h / 10, ...(style.color ? { color: style.color } : {}) }).map((p) => ({ ...p, ...extra })));
    if (s.underline) out.push({ k: "line", pts: [[x, -0.18 * size], [x + w, -0.18 * size]], w: h / 12, ...extra });
    x += w;
  }
  return place(out, at, style.angle ?? 0);
}

/** Primitives drawn about the origin, turned by `angle` degrees and moved to `at`. */
export function place(prims: Prim[], at: Vec2, angle = 0): Prim[] {
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = (p: Vec2): Vec2 => [at[0] + p[0] * c - p[1] * s, at[1] + p[0] * s + p[1] * c];
  return prims.map((p) => {
    if (p.k === "line") return { ...p, pts: p.pts.map(t) };
    if (p.k === "circle") return { ...p, c: t(p.c) };
    if (p.k === "area") return { ...p, loops: p.loops.map((l) => l.map(t)) };
    const angleSum = (p.angle ?? 0) + angle;
    return { ...p, at: t(p.at), ...(Math.abs(angleSum) > 1e-9 ? { angle: Math.round(angleSum * 1000) / 1000 + 0 } : {}) };
  });
}

/** Lines of rich text, the first line's baseline at `at`, `gap` font sizes apart (default 1.5). */
export function richBlock(text: string, at: Vec2, style: RichStyle & { gap?: number }): { prims: Prim[]; width: number; lines: number } {
  const lines = text.split("\n");
  const gap = (style.gap ?? 1.5) * style.size;
  const a = ((style.angle ?? 0) * Math.PI) / 180;
  const down: Vec2 = [Math.sin(a), -Math.cos(a)];
  const prims: Prim[] = [];
  let width = 0;
  lines.forEach((l, i) => {
    const spans = parseRich(l);
    width = Math.max(width, richWidth(spans, style.size));
    prims.push(...richPrims(spans, [at[0] + down[0] * gap * i, at[1] + down[1] * gap * i], style));
  });
  return { prims, width, lines: lines.length };
}
