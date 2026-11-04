// Drafting glyphs (Phase Q): the ISO 1101 / ASME Y14.5 geometric
// characteristics, their circled modifiers, and the dimensioning symbols of
// ISO 129-1 / ASME Y14.5 (depth ↧, counterbore ⌴, countersink ⌵, square □,
// arc length ⌒, conical taper, slope, centre line ℄, all around). They are
// drawn as lines and circles, not set as text: the PDF's font (WinAnsi) has
// none of them, and a drawing must print the same from the app, the SVG, the
// PDF and the DXF.
//
// Every glyph is drawn on a baseline at (x, y) for lettering of capital
// height h (3.5 mm on a dimension), and says how wide it is. Its strokes are
// h/10 wide, as ISO 3098 letters are.

import type { Vec2 } from "../../doc/types";
import type { Prim } from "../sheet";

/** The GD&T characteristics (ISO 1101 / ASME Y14.5), in the standard's order. */
export const GDT_CHARACTERISTICS = [
  "straightness",
  "flatness",
  "circularity",
  "cylindricity",
  "profileLine",
  "profileSurface",
  "angularity",
  "perpendicularity",
  "parallelism",
  "position",
  "concentricity",
  "symmetry",
  "circularRunout",
  "totalRunout",
] as const;
export type GdtCharacteristic = (typeof GDT_CHARACTERISTICS)[number];

/** The circled modifiers: maximum and least material, projected zone, free state, tangent plane, regardless of feature size (ASME's legacy Ⓢ), unequally disposed. */
export const CIRCLED = ["M", "L", "P", "F", "T", "S", "U", "E", "I"] as const;
export type CircledLetter = (typeof CIRCLED)[number];

export type GlyphName =
  | GdtCharacteristic
  | `circled${CircledLetter}`
  | "depth"
  | "counterbore"
  | "countersink"
  | "square"
  | "arc"
  | "taper"
  | "slope"
  | "centreline"
  | "spotface"
  | "between";

/** Unicode characters and <TOKENS> that stand for glyphs in text (rich text, dimension prefixes, notes). */
export const GLYPH_CHARS: Record<string, GlyphName> = {
  "↧": "depth",
  "⌴": "counterbore",
  "⌵": "countersink",
  "□": "square",
  "⌒": "arc",
  "⌲": "taper",
  "⌳": "slope",
  "℄": "centreline",
  "Ⓜ": "circledM",
  "Ⓛ": "circledL",
  "Ⓟ": "circledP",
  "Ⓕ": "circledF",
  "Ⓣ": "circledT",
  "Ⓢ": "circledS",
  "Ⓤ": "circledU",
  "Ⓔ": "circledE",
  "Ⓘ": "circledI",
  "⏤": "straightness",
  "⏥": "flatness",
  "○": "circularity",
  "⌭": "cylindricity",
  "⌓": "profileSurface",
  "∠": "angularity",
  "⊥": "perpendicularity",
  "∥": "parallelism",
  "⌖": "position",
  "◎": "concentricity",
  "⌯": "symmetry",
  "↗": "circularRunout",
  "⌰": "totalRunout",
  "⟷": "between",
};

/** Text tokens for the symbols palette: "<MOD-DIAM>8 <HOLE-DEPTH>12". Tokens that are plain characters map to them. */
export const SYMBOL_TOKENS: Record<string, string> = {
  "<MOD-DIAM>": "Ø",
  "<MOD-DEG>": "°",
  "<MOD-PM>": "±",
  "<MOD-SPHDIAM>": "SØ",
  "<MOD-SPHR>": "SR",
  "<MOD-SQUARE>": "□",
  "<MOD-CL>": "℄",
  "<MOD-MMC>": "Ⓜ",
  "<MOD-LMC>": "Ⓛ",
  "<MOD-PROJ>": "Ⓟ",
  "<MOD-FREE>": "Ⓕ",
  "<MOD-TANG>": "Ⓣ",
  "<MOD-RFS>": "Ⓢ",
  "<MOD-UNEQ>": "Ⓤ",
  "<MOD-ENV>": "Ⓔ",
  "<MOD-ARC>": "⌒",
  "<MOD-TAPER>": "⌲",
  "<MOD-SLOPE>": "⌳",
  "<MOD-BETWEEN>": "⟷",
  "<MOD-TIMES>": "×",
  "<HOLE-DEPTH>": "↧",
  "<HOLE-CBORE>": "⌴",
  "<HOLE-CSK>": "⌵",
  "<HOLE-SPOT>": "⌴SF",
  "<GDT-STRAIGHT>": "⏤",
  "<GDT-FLAT>": "⏥",
  "<GDT-CIRC>": "○",
  "<GDT-CYL>": "⌭",
  "<GDT-PLINE>": "⌒",
  "<GDT-PSURF>": "⌓",
  "<GDT-ANG>": "∠",
  "<GDT-PERP>": "⊥",
  "<GDT-PARA>": "∥",
  "<GDT-POS>": "⌖",
  "<GDT-CONC>": "◎",
  "<GDT-SYM>": "⌯",
  "<GDT-RUNOUT>": "↗",
  "<GDT-TRUNOUT>": "⌰",
};

/** The characteristics' glyphs in text, the same way round. */
export const CHARACTERISTIC_CHAR: Record<GdtCharacteristic, string> = {
  straightness: "⏤",
  flatness: "⏥",
  circularity: "○",
  cylindricity: "⌭",
  profileLine: "⌒",
  profileSurface: "⌓",
  angularity: "∠",
  perpendicularity: "⊥",
  parallelism: "∥",
  position: "⌖",
  concentricity: "◎",
  symmetry: "⌯",
  circularRunout: "↗",
  totalRunout: "⌰",
};

/** Replaces the palette's tokens by their characters. */
export function expandTokens(text: string): string {
  return text.replace(/<[A-Z]+-[A-Z]+>/g, (t) => SYMBOL_TOKENS[t] ?? t);
}

/** How wide a glyph is for lettering of capital height h. */
export function glyphWidth(name: GlyphName, h: number): number {
  if (name.startsWith("circled")) return 1.3 * h;
  switch (name) {
    case "depth":
      return 0.7 * h;
    case "counterbore":
    case "spotface":
      return 0.85 * h;
    case "countersink":
      return 1.05 * h;
    case "square":
      return 0.95 * h;
    case "arc":
      return 1.05 * h;
    case "taper":
    case "slope":
      return 1.25 * h;
    case "centreline":
      return 1.1 * h;
    case "between":
      return 1.6 * h;
    default:
      return 1.25 * h;
  }
}

interface Pen {
  w: number;
  owner?: string;
  color?: string;
}

/**
 * A glyph on the baseline at (x, y), lettering of capital height h, its
 * strokes `w` wide (default h/10). Its width is glyphWidth(name, h).
 */
export function glyph(name: GlyphName, x: number, y: number, h: number, pen: Partial<Pen> = {}): Prim[] {
  const w = pen.w ?? h / 10;
  const extra = { ...(pen.owner ? { owner: pen.owner } : {}), ...(pen.color ? { color: pen.color } : {}) };
  const out: Prim[] = [];
  const line = (...pts: Vec2[]) => out.push({ k: "line", pts: pts.map(([a, b]) => [x + a * h, y + b * h] as Vec2), w, ...extra });
  const closed = (fill: boolean, ...pts: Vec2[]) => out.push({ k: "line", pts: pts.map(([a, b]) => [x + a * h, y + b * h] as Vec2), w, closed: true, ...(fill ? { fill: true } : {}), ...extra });
  const circle = (cx: number, cy: number, r: number) => out.push({ k: "circle", c: [x + cx * h, y + cy * h], r: r * h, w, ...extra });
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 16): Vec2[] => {
    const pts: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  };
  if (name.startsWith("circled")) {
    const letter = name.slice(7);
    circle(0.65, 0.5, 0.6);
    const size = (0.78 * h) / 0.72;
    out.push({ k: "text", at: [x + 0.65 * h, y + 0.5 * h - 0.39 * h], text: letter, size, anchor: "middle", ...extra });
    return out;
  }
  switch (name) {
    // --- GD&T characteristics, in a box about 1.25h wide.
    case "straightness":
      line([0.1, 0.5], [1.15, 0.5]);
      break;
    case "flatness":
      closed(false, [0.1, 0.2], [0.85, 0.2], [1.15, 0.8], [0.4, 0.8]);
      break;
    case "circularity":
      circle(0.625, 0.5, 0.45);
      break;
    case "cylindricity":
      circle(0.625, 0.5, 0.36);
      line([0.1, 0.02], [0.62, 0.98]);
      line([0.63, 0.02], [1.15, 0.98]);
      break;
    case "profileLine":
      line(...arc(0.625, 0.18, 0.48, 0, 180));
      break;
    case "profileSurface":
      line(...arc(0.625, 0.18, 0.48, 0, 180), [0.145, 0.18]);
      break;
    case "angularity":
      line([1.15, 0.82], [0.1, 0.18], [1.15, 0.18]);
      break;
    case "perpendicularity":
      line([0.625, 0.95], [0.625, 0.12]);
      line([0.1, 0.12], [1.15, 0.12]);
      break;
    case "parallelism":
      line([0.15, 0.1], [0.65, 0.9]);
      line([0.6, 0.1], [1.1, 0.9]);
      break;
    case "position":
      circle(0.625, 0.5, 0.33);
      line([0.07, 0.5], [1.18, 0.5]);
      line([0.625, -0.05], [0.625, 1.05]);
      break;
    case "concentricity":
      circle(0.625, 0.5, 0.46);
      circle(0.625, 0.5, 0.24);
      break;
    case "symmetry":
      line([0.1, 0.5], [1.15, 0.5]);
      line([0.3, 0.8], [0.95, 0.8]);
      line([0.3, 0.2], [0.95, 0.2]);
      break;
    case "circularRunout":
      line([0.2, 0.08], [1.0, 0.88]);
      closed(true, [1.05, 0.93], [0.77, 0.86], [0.98, 0.65]);
      break;
    case "totalRunout":
      line([0.1, 0.1], [1.15, 0.1]);
      line([0.1, 0.1], [0.55, 0.88]);
      line([0.55, 0.1], [1.0, 0.88]);
      closed(true, [0.58, 0.94], [0.4, 0.75], [0.6, 0.7]);
      closed(true, [1.03, 0.94], [0.85, 0.75], [1.05, 0.7]);
      break;
    // --- Dimensioning symbols (ISO 129-1).
    case "depth":
      line([0.35, 0.95], [0.35, 0.02]);
      line([0.12, 0.3], [0.35, 0.02], [0.58, 0.3]);
      line([0.05, 0.02], [0.65, 0.02]);
      break;
    case "counterbore":
      line([0.1, 0.85], [0.1, 0.05], [0.75, 0.05], [0.75, 0.85]);
      break;
    case "spotface":
      line([0.1, 0.85], [0.1, 0.05], [0.75, 0.05], [0.75, 0.85]);
      break;
    case "countersink":
      line([0.05, 0.85], [0.525, 0.05], [1.0, 0.85]);
      break;
    case "square":
      closed(false, [0.1, 0], [0.85, 0], [0.85, 0.75], [0.1, 0.75]);
      break;
    case "arc":
      line(...arc(0.525, 0.35, 0.45, 20, 160));
      break;
    case "taper":
      // ISO 3040: a triangle pointing the way it narrows, on its axis.
      closed(false, [0.1, 0.2], [1.1, 0.5], [0.1, 0.8]);
      line([0, 0.5], [1.2, 0.5]);
      break;
    case "slope":
      line([0.1, 0.1], [1.15, 0.1]);
      line([0.1, 0.1], [1.15, 0.6]);
      break;
    case "centreline":
      line(...arc(0.5, 0.45, 0.42, 45, 315));
      line([0.55, 1.0], [0.55, -0.05], [1.05, -0.05]);
      break;
    case "between":
      line([0.05, 0.4], [1.55, 0.4]);
      closed(true, [0.05, 0.4], [0.35, 0.55], [0.35, 0.25]);
      closed(true, [1.55, 0.4], [1.25, 0.55], [1.25, 0.25]);
      break;
  }
  return out;
}

/** True when a character of text is drawn as a glyph. */
export function isGlyphChar(ch: string): boolean {
  return ch in GLYPH_CHARS;
}
