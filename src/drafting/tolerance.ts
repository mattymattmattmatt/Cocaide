// Tolerances on a drawing (Phase Q): general tolerances — ISO 2768-1
// (linear and angular, classes f, m, c, v), ISO 2768-2 (geometric, H, K, L),
// ISO 13920 (welded constructions: linear and angular A–D, geometric E–H),
// and an ASME title-block tolerance block ("X.X ±0.5, X.XX ±0.1, ANG ±0.5°")
// — and a dimension's own tolerance (± symmetric, +a/−b bilateral, limits,
// an ISO 286 fit with or without its values, basic, reference, min, max): how
// each is written, and the tolerance a dimension effectively has
// (`toleranceOf`), which the drawing's critic reads.
//
// Numbers are mm and degrees. Worked examples: ISO 2768-m on 50 mm is ±0.3,
// on an angle whose shorter side is 30 mm ±0°30'; ISO 2768-K flatness of a
// 200 mm face is 0.4; ISO 13920-B on 1500 mm is ±4.

import { classDeviations, fitDeviations, fitText, parseFit, type Deviations } from "./fits";

// ------------------------------------------------------------ the tolerance on a dimension

export const TOLERANCE_KINDS = ["symmetric", "bilateral", "limit", "fit", "fitWithTol", "fitLimits", "basic", "reference", "min", "max"] as const;
export type ToleranceKind = (typeof TOLERANCE_KINDS)[number];

/**
 * A dimension's tolerance. `plus` is how far over the size it may be and
 * `minus` how far under (both mm; a negative one crosses: g6 on Ø25 is
 * plus −0.007, minus 0.020). symmetric: ±plus. bilateral: +plus/−minus.
 * limit: the two limits stacked (max over min). fit: "H7", "g6" or "H7/g6"
 * (ISO 286), the class alone; fitWithTol: the class and its deviations in
 * brackets; fitLimits: the class and its limits. basic: the theoretically
 * exact size, boxed. reference: in brackets, for information. min, max: the
 * size is a limit ("25 MIN").
 */
export interface Tolerance {
  kind: ToleranceKind;
  plus?: number;
  minus?: number;
  fit?: string;
  /** Decimal places of the deviations (default: as many as they need, at least the size's). */
  precision?: number;
}
export const TOLERANCE_KEYS = ["kind", "plus", "minus", "fit", "precision"] as const;

/** What is wrong with a tolerance, for validation; null when it is good. */
export function toleranceProblem(t: unknown): string | null {
  if (typeof t !== "object" || t === null || Array.isArray(t)) return `must be a tolerance { kind, plus?, minus?, fit?, precision? } (got ${JSON.stringify(t)})`;
  const o = t as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(TOLERANCE_KEYS as readonly string[]).includes(k)) return `unknown field "${k}" (a tolerance has ${TOLERANCE_KEYS.join(", ")})`;
  if (!(TOLERANCE_KINDS as readonly string[]).includes(o.kind as string)) return `kind must be ${TOLERANCE_KINDS.map((k) => `"${k}"`).join(", ")} (got ${JSON.stringify(o.kind)})`;
  const num = (k: string) => o[k] === undefined || (typeof o[k] === "number" && Number.isFinite(o[k] as number));
  for (const k of ["plus", "minus", "precision"]) if (!num(k)) return `${k} must be a number (got ${JSON.stringify(o[k])})`;
  if (o.precision !== undefined && (!Number.isInteger(o.precision) || (o.precision as number) < 0 || (o.precision as number) > 6)) return `precision is decimal places, 0 to 6 (got ${o.precision})`;
  const kind = o.kind as ToleranceKind;
  if (kind === "symmetric") {
    if (typeof o.plus !== "number" || o.plus <= 0) return `a symmetric tolerance is ±plus: give plus, more than 0 (got ${JSON.stringify(o.plus)})`;
    if (o.minus !== undefined) return "a symmetric tolerance has plus only (±plus); for different amounts use bilateral";
  }
  if (kind === "bilateral" || kind === "limit") {
    if (typeof o.plus !== "number" || typeof o.minus !== "number") return `a ${kind} tolerance has plus (over the size) and minus (under it), both mm (got plus ${JSON.stringify(o.plus)}, minus ${JSON.stringify(o.minus)})`;
    if ((o.plus as number) + (o.minus as number) <= 0) return `plus ${o.plus} and minus ${o.minus} leave no room: the upper limit (size + plus) must be above the lower (size − minus)`;
  }
  if (kind === "fit" || kind === "fitWithTol" || kind === "fitLimits") {
    if (typeof o.fit !== "string" || !parseFit(o.fit)) return `fit must be an ISO 286 class or pair like "H7", "g6" or "H7/g6" (got ${JSON.stringify(o.fit)})`;
    if (o.plus !== undefined || o.minus !== undefined) return "a fit's deviations come from ISO 286: leave plus and minus out";
  } else if (o.fit !== undefined) return `fit is for the fit kinds (fit, fitWithTol, fitLimits), not ${kind}`;
  if ((kind === "basic" || kind === "reference" || kind === "min" || kind === "max") && (o.plus !== undefined || o.minus !== undefined)) return `a ${kind} dimension has no deviations: leave plus and minus out`;
  return null;
}

/** The deviations a tolerance puts on a size (mm), or null when it puts none (basic, reference) or can't (a fit outside ISO 286's sizes). */
export function deviationsOf(t: Tolerance, size: number, side: "hole" | "shaft" = "hole"): Deviations | null {
  switch (t.kind) {
    case "symmetric":
      return { upper: t.plus ?? 0, lower: -(t.plus ?? 0) };
    case "bilateral":
    case "limit":
      return { upper: t.plus ?? 0, lower: -(t.minus ?? 0) };
    case "fit":
    case "fitWithTol":
    case "fitLimits":
      return t.fit ? fitDeviations(size, t.fit, side) : null;
    case "min":
      return { upper: Infinity, lower: 0 };
    case "max":
      return { upper: 0, lower: -Infinity };
    default:
      return null;
  }
}

// ------------------------------------------------------------ writing numbers

/** A number to `places` decimals ("12.50"), or as few as it needs up to 3 when places is undefined ("12.5"). A minus sign is a true minus. */
export function numberText(x: number, places?: number, opts: { trimZeros?: boolean; leadingZero?: boolean } = {}): string {
  const p = places ?? autoPlaces(x);
  let s = (Math.round(x * 10 ** p) / 10 ** p + 0).toFixed(p);
  if (opts.trimZeros && s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (opts.leadingZero === false) s = s.replace(/^(-?)0\./, "$1.");
  return s.replace(/^-/, "−");
}

function autoPlaces(x: number): number {
  for (let p = 0; p <= 3; p++) if (Math.abs(Math.round(x * 10 ** p) - x * 10 ** p) < 1e-6) return p;
  return 3;
}

/** A deviation with its sign: "+0.021", "−0.007", "0" (no sign on zero). */
export function deviationText(x: number, places?: number): string {
  if (Math.abs(x) < 1e-9) return "0";
  const t = numberText(Math.abs(x), places ?? Math.max(autoPlaces(x), 1));
  return `${x > 0 ? "+" : "−"}${t}`;
}

/**
 * What a tolerance adds to a size, as parts the composer lays out: `inline`
 * after the size ("±0.1", "H7", "MIN"), a `stack` of two lines (upper over
 * lower deviations, or the limits instead of the size), `frame` around it
 * (basic: a box, reference: brackets), and a bracketed tail ("(+0.021/0)").
 */
export interface ToleranceText {
  /** The size as written, or null when the limits replace it (a limit dimension). */
  size: string | null;
  inline?: string;
  stack?: [string, string];
  /** After a fit: its deviations or limits, stacked in brackets. */
  bracket?: [string, string];
  frame?: "box" | "brackets";
}

/**
 * How a size with this tolerance is written. ISO writes deviations to the
 * same decimals as each other ("+0.1/−0.05" becomes "+0.10/−0.05"); a zero
 * deviation is "0".
 */
export function toleranceText(size: number, sizeText: string, t: Tolerance | undefined, opts: { side?: "hole" | "shaft"; places?: number } = {}): ToleranceText {
  if (!t) return { size: sizeText };
  const p = t.precision;
  const pair = (u: number, l: number): [string, string] => {
    const places = p ?? Math.max(autoPlaces(u), autoPlaces(l), 1);
    return [deviationText(u, places), deviationText(l, places)];
  };
  switch (t.kind) {
    case "symmetric":
      return { size: sizeText, inline: `±${numberText(t.plus ?? 0, p)}` };
    case "bilateral": {
      const u = t.plus ?? 0;
      const l = -(t.minus ?? 0);
      // Equal and opposite is ±.
      if (Math.abs(u + l) < 1e-12) return { size: sizeText, inline: `±${numberText(u, p)}` };
      return { size: sizeText, stack: pair(u, l) };
    }
    case "limit": {
      const places = p ?? Math.max(autoPlaces(size + (t.plus ?? 0)), autoPlaces(size - (t.minus ?? 0)), opts.places ?? 0);
      const prefix = sizeText.replace(/[\d.,−-]+.*$/, "");
      return { size: null, stack: [`${prefix}${numberText(size + (t.plus ?? 0), places)}`, `${prefix}${numberText(size - (t.minus ?? 0), places)}`] };
    }
    case "fit":
    case "fitWithTol":
    case "fitLimits": {
      const fit = fitText(t.fit ?? "");
      const out: ToleranceText = { size: sizeText, inline: fit };
      const f = parseFit(t.fit ?? "");
      if (t.kind !== "fit" && f) {
        if (f.hole && f.shaft) {
          // A pair on one size (an assembly drawing): the hole's over the shaft's.
          const h = classDeviations(size, f.hole);
          const s = classDeviations(size, f.shaft);
          if (h && s) out.bracket = t.kind === "fitLimits" ? [numberText(size + h.upper, 3), numberText(size + s.lower, 3)] : [`${pair(h.upper, h.lower).join("/")}`, `${pair(s.upper, s.lower).join("/")}`];
        } else {
          const d = deviationsOf(t, size, opts.side);
          if (d) out.bracket = t.kind === "fitLimits" ? [numberText(size + d.upper, 3), numberText(size + d.lower, 3)] : pair(d.upper, d.lower);
        }
      }
      return out;
    }
    case "basic":
      return { size: sizeText, frame: "box" };
    case "reference":
      return { size: sizeText, frame: "brackets" };
    case "min":
      return { size: sizeText, inline: "MIN" };
    case "max":
      return { size: sizeText, inline: "MAX" };
  }
}

/** The tolerance as one line of plain text: "25 H7 (+0.021/0)", "25 +0.1/−0.05", "(25)". */
export function toleranceLine(size: number, sizeText: string, t: Tolerance | undefined): string {
  const x = toleranceText(size, sizeText, t);
  let s = x.size ?? "";
  if (x.stack) s = x.size === null ? `${x.stack[1]}–${x.stack[0]}` : `${s} ${x.stack[0]}/${x.stack[1]}`;
  if (x.inline) s = `${s} ${x.inline}`;
  if (x.bracket) s = `${s} (${x.bracket.join("/")})`;
  if (x.frame === "brackets") s = `(${s})`;
  if (x.frame === "box") s = `[${s}]`;
  return s.trim();
}

// ------------------------------------------------------------ ISO 2768

export const ISO2768_LINEAR_CLASSES = ["f", "m", "c", "v"] as const;
export type Iso2768Class = (typeof ISO2768_LINEAR_CLASSES)[number];
export const ISO2768_GEOMETRIC_CLASSES = ["H", "K", "L"] as const;
export type Iso2768Geometric = (typeof ISO2768_GEOMETRIC_CLASSES)[number];

/** ISO 2768-1 Table 1, linear sizes (except broken edges): over 0.5 up to the limit, ± mm. */
const LINEAR_RANGES = [3, 6, 30, 120, 400, 1000, 2000, 4000];
const LINEAR: Record<Iso2768Class, (number | null)[]> = {
  f: [0.05, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, null],
  m: [0.1, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2],
  c: [0.2, 0.3, 0.5, 0.8, 1.2, 2, 3, 4],
  v: [null, 0.5, 1, 1.5, 2.5, 4, 6, 8],
};
/** Table 2, broken edges (radii and chamfer heights): to 3, to 6, over 6. */
const EDGE_RANGES = [3, 6, Infinity];
const EDGES: Record<Iso2768Class, number[]> = { f: [0.2, 0.5, 1], m: [0.2, 0.5, 1], c: [0.4, 1, 2], v: [0.4, 1, 2] };
/** Table 3, angles by the shorter side's length: to 10, 50, 120, 400, over 400; ± degrees. */
const ANGLE_RANGES = [10, 50, 120, 400, Infinity];
const ANGLES: Record<Iso2768Class, number[]> = {
  f: [1, 0.5, 20 / 60, 10 / 60, 5 / 60],
  m: [1, 0.5, 20 / 60, 10 / 60, 5 / 60],
  c: [1.5, 1, 0.5, 15 / 60, 10 / 60],
  v: [3, 2, 1, 0.5, 20 / 60],
};
/** ISO 2768-2 Table 1, straightness and flatness by length: to 10, 30, 100, 300, 1000, 3000. */
const FLAT_RANGES = [10, 30, 100, 300, 1000, 3000];
const FLAT: Record<Iso2768Geometric, number[]> = {
  H: [0.02, 0.05, 0.1, 0.2, 0.3, 0.4],
  K: [0.05, 0.1, 0.2, 0.4, 0.6, 0.8],
  L: [0.1, 0.2, 0.4, 0.8, 1.2, 1.6],
};
/** Table 2, perpendicularity by the shorter side: to 100, 300, 1000, 3000. Table 3, symmetry, the same ranges. Table 4, circular run-out. */
const PERP_RANGES = [100, 300, 1000, 3000];
const PERP: Record<Iso2768Geometric, number[]> = { H: [0.2, 0.3, 0.4, 0.5], K: [0.4, 0.6, 0.8, 1], L: [0.6, 1, 1.5, 2] };
const SYMMETRY: Record<Iso2768Geometric, number[]> = { H: [0.5, 0.5, 0.5, 0.5], K: [0.6, 0.6, 0.8, 1], L: [0.6, 1, 1.5, 2] };
const RUNOUT: Record<Iso2768Geometric, number> = { H: 0.1, K: 0.2, L: 0.5 };

function pick<T>(ranges: number[], x: number, row: T[]): T | null {
  for (let i = 0; i < ranges.length; i++) if (x <= ranges[i] + 1e-9) return row[i];
  return null;
}

/** ISO 2768-1 linear: ± mm for a size; null under 0.5 mm, over 4000, or where the class has none (f over 2000, v to 3). */
export function iso2768Linear(size: number, cls: Iso2768Class): number | null {
  if (!(size >= 0.5 - 1e-9)) return null;
  return pick(LINEAR_RANGES, size, LINEAR[cls]);
}

/** ISO 2768-1 broken edges (an outside radius, a chamfer height): ± mm. */
export function iso2768Edge(size: number, cls: Iso2768Class): number | null {
  if (!(size >= 0.5 - 1e-9)) return null;
  return pick(EDGE_RANGES, size, EDGES[cls]);
}

/** ISO 2768-1 angular: ± degrees, by the length of the angle's shorter side (mm). */
export function iso2768Angle(shorterSide: number, cls: Iso2768Class): number {
  return pick(ANGLE_RANGES, shorterSide, ANGLES[cls])!;
}

export type GeometricCharacteristic = "straightness" | "flatness" | "perpendicularity" | "symmetry" | "circularRunout";

/** ISO 2768-2: the general geometric tolerance, mm, for a length (the shorter side for perpendicularity). */
export function iso2768Geometric(kind: GeometricCharacteristic, length: number, cls: Iso2768Geometric): number | null {
  if (kind === "straightness" || kind === "flatness") return pick(FLAT_RANGES, length, FLAT[cls]);
  if (kind === "perpendicularity") return pick(PERP_RANGES, length, PERP[cls]);
  if (kind === "symmetry") return pick(PERP_RANGES, length, SYMMETRY[cls]);
  return RUNOUT[cls];
}

// ------------------------------------------------------------ ISO 13920 (welded constructions)

export const ISO13920_LINEAR_CLASSES = ["A", "B", "C", "D"] as const;
export const ISO13920_GEOMETRIC_CLASSES = ["E", "F", "G", "H"] as const;
export type Iso13920Class = (typeof ISO13920_LINEAR_CLASSES)[number];
export type Iso13920Geometric = (typeof ISO13920_GEOMETRIC_CLASSES)[number];

/** Table 1, linear: 2–30, 30–120, 120–400, 400–1000, 1000–2000, 2000–4000, 4000–8000, 8000–12000, 12000–16000, 16000–20000, over 20000. */
const W_LINEAR_RANGES = [30, 120, 400, 1000, 2000, 4000, 8000, 12000, 16000, 20000, Infinity];
const W_LINEAR: Record<Iso13920Class, number[]> = {
  A: [1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  B: [1, 2, 2, 3, 4, 6, 8, 10, 12, 14, 16],
  C: [1, 3, 4, 6, 8, 11, 14, 18, 21, 24, 27],
  D: [1, 4, 7, 9, 12, 16, 21, 27, 32, 36, 40],
};
/** Table 2, angles by the shorter leg: to 400, 1000, over 1000; ± degrees. */
const W_ANGLE_RANGES = [400, 1000, Infinity];
const W_ANGLES: Record<Iso13920Class, number[]> = {
  A: [20 / 60, 15 / 60, 10 / 60],
  B: [45 / 60, 30 / 60, 20 / 60],
  C: [1, 45 / 60, 30 / 60],
  D: [1.5, 1.25, 1],
};
/** Table 3, straightness, flatness and parallelism: over 30 to 120, 400, 1000, 2000, 4000, 8000, 12000, 16000, 20000, over 20000. */
const W_FLAT_RANGES = [120, 400, 1000, 2000, 4000, 8000, 12000, 16000, 20000, Infinity];
const W_FLAT: Record<Iso13920Geometric, number[]> = {
  E: [0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8],
  F: [1, 1.5, 3, 4.5, 6, 8, 10, 12, 14, 16],
  G: [1.5, 3, 5.5, 9, 11, 16, 20, 22, 25, 25],
  H: [2.5, 5, 9, 14, 18, 26, 32, 36, 40, 40],
};

/** ISO 13920 linear: ± mm (null under 2 mm). */
export function iso13920Linear(size: number, cls: Iso13920Class): number | null {
  if (!(size >= 2 - 1e-9)) return null;
  return pick(W_LINEAR_RANGES, size, W_LINEAR[cls]);
}

/** ISO 13920 angular: ± degrees by the shorter leg (mm). */
export function iso13920Angle(shorterLeg: number, cls: Iso13920Class): number {
  return pick(W_ANGLE_RANGES, shorterLeg, W_ANGLES[cls])!;
}

/** ISO 13920 straightness, flatness and parallelism: mm, for lengths over 30 mm. */
export function iso13920Geometric(length: number, cls: Iso13920Geometric): number | null {
  if (!(length > 30 - 1e-9)) return null;
  return pick(W_FLAT_RANGES, length, W_FLAT[cls]);
}

// ------------------------------------------------------------ the drawing's general tolerance

/** A general tolerance as written in the title block, read. */
export type GeneralTolerance =
  | { standard: "ISO 2768"; linear?: Iso2768Class; geometric?: Iso2768Geometric; text: string }
  | { standard: "ISO 13920"; linear?: Iso13920Class; geometric?: Iso13920Geometric; text: string }
  /** ASME: by the decimals a size is written to ("X.X ±0.5"), angles alike. */
  | { standard: "block"; places: Record<number, number>; angle?: number; text: string };

/**
 * Reads "ISO 2768-mK", "ISO 2768-m", "2768-fH", "ISO 13920-BF", "EN ISO
 * 13920-B", or a block "X ±1, X.X ±0.5, X.XX ±0.1, X.XXX ±0.05, ANG ±0.5°"
 * (also "0.X", ".XX", "±1°"). Null when it is none of these.
 */
export function parseGeneralTolerance(text: string | undefined): GeneralTolerance | null {
  if (!text) return null;
  const t = text.trim();
  const iso = /2768\s*-?\s*([fmcv])?\s*([HKL])?\b/i.exec(t);
  if (iso && (iso[1] || iso[2])) {
    const linear = iso[1]?.toLowerCase() as Iso2768Class | undefined;
    const geometric = iso[2]?.toUpperCase() as Iso2768Geometric | undefined;
    return { standard: "ISO 2768", ...(linear ? { linear } : {}), ...(geometric ? { geometric } : {}), text: t };
  }
  const weld = /13920\s*-?\s*([ABCD])?\s*([EFGH])?\b/i.exec(t);
  if (weld && (weld[1] || weld[2])) {
    const linear = weld[1]?.toUpperCase() as Iso13920Class | undefined;
    const geometric = weld[2]?.toUpperCase() as Iso13920Geometric | undefined;
    return { standard: "ISO 13920", ...(linear ? { linear } : {}), ...(geometric ? { geometric } : {}), text: t };
  }
  const places: Record<number, number> = {};
  let angle: number | undefined;
  for (const m of t.matchAll(/(ANG(?:LES?|ULAR)?|[0X]?\.?X*)\s*[:=]?\s*±\s*([\d.]+)\s*(°)?/gi)) {
    const key = m[1].toUpperCase();
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    if (key.startsWith("ANG") || m[3]) angle = value;
    else if (/^[0X]?\.?X*$/.test(key)) places[(key.split(".")[1] ?? "").length] = value;
  }
  if (Object.keys(places).length || angle !== undefined) return { standard: "block", places, ...(angle !== undefined ? { angle } : {}), text: t };
  return null;
}

/** What a general tolerance allows on a size written to `places` decimals: ± mm, or null when it says nothing for it. */
export function generalLinear(g: GeneralTolerance | null, size: number, places = 0, opts: { edge?: boolean } = {}): number | null {
  if (!g) return null;
  if (g.standard === "ISO 2768") return g.linear ? (opts.edge ? iso2768Edge(size, g.linear) : iso2768Linear(size, g.linear)) : null;
  if (g.standard === "ISO 13920") return g.linear ? iso13920Linear(size, g.linear) : null;
  const known = Object.keys(g.places).map(Number).sort((a, b) => a - b);
  if (!known.length) return null;
  // The block's row for this many decimals, else the nearest coarser one.
  const row = known.filter((k) => k <= places).pop() ?? known[0];
  return g.places[row];
}

/** What a general tolerance allows on an angle: ± degrees (by the shorter side, mm, for the ISO ones). */
export function generalAngle(g: GeneralTolerance | null, shorterSide: number): number | null {
  if (!g) return null;
  if (g.standard === "ISO 2768") return g.linear ? iso2768Angle(shorterSide, g.linear) : null;
  if (g.standard === "ISO 13920") return g.linear ? iso13920Angle(shorterSide, g.linear) : null;
  return g.angle ?? null;
}

/** ± degrees written as the standards do: "±0°30'", "±1°", "±0.5°" (a block's own). */
export function angleTolText(deg: number, decimal = false): string {
  if (decimal) return `±${numberText(deg)}°`;
  const d = Math.floor(deg + 1e-9);
  const m = Math.round((deg - d) * 60);
  return m ? `±${d}°${m}'` : `±${d}°`;
}

/**
 * The general-tolerance block the title area carries: a few lines naming
 * the standard and what it means for this drawing's sizes. ISO 2768 lists
 * its linear ranges; a block lists its rows.
 */
export function generalToleranceLines(g: GeneralTolerance | null): string[] {
  if (!g) return [];
  if (g.standard === "ISO 2768") {
    const lines = [`GENERAL TOLERANCES ${g.text.toUpperCase().startsWith("ISO") ? g.text : `ISO ${g.text}`}`];
    if (g.linear) {
      const row = LINEAR[g.linear];
      const labels = ["0.5–3", "3–6", "6–30", "30–120", "120–400", "400–1000", "1000–2000", "2000–4000"];
      lines.push(labels.map((l, i) => (row[i] === null ? null : `${l}: ±${numberText(row[i]!)}`)).filter(Boolean).join("  "));
    }
    return lines;
  }
  if (g.standard === "ISO 13920") return [`GENERAL TOLERANCES ${g.text.toUpperCase().startsWith("ISO") || g.text.toUpperCase().startsWith("EN") ? g.text : `ISO ${g.text}`}`];
  const rows = Object.keys(g.places)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => `${k === 0 ? "X" : `X.${"X".repeat(k)}`} ±${numberText(g.places[k])}`);
  if (g.angle !== undefined) rows.push(`ANGLES ±${numberText(g.angle)}°`);
  return ["UNLESS OTHERWISE SPECIFIED:", ...rows];
}

// ------------------------------------------------------------ the effective tolerance

/** What a dimension may vary by, and where that comes from. */
export interface EffectiveTolerance {
  /** mm (degrees for an angle) over and under the size; Infinity for a MIN's upper. */
  upper: number;
  lower: number;
  source: "dimension" | "fit" | "general" | "basic" | "reference" | "none";
  /** "±0.2 (ISO 2768-m)", "H7 +0.021/0", "basic: by its feature control frame". */
  text: string;
}

/** What `toleranceOf` reads off a dimension: its measured value, its kind, its tolerance and precision. */
export interface ToleranceInput {
  value: number;
  /** "angular" reads angle tolerances; "radius"/"chamfer" are broken edges in ISO 2768. */
  kind?: string;
  tolerance?: Tolerance;
  /** Decimals the size is written to (ASME blocks go by it). */
  places?: number;
  /** For an angle: its shorter side, mm. */
  side?: number;
  /** Which part of a fit this size is (a hole's or a shaft's) when the fit is a pair. Default: by the fit's letter. */
  fitSide?: "hole" | "shaft";
}

/**
 * The tolerance a dimension effectively has: its own (± bilateral, limits, a
 * fit's ISO 286 deviations), else the drawing's general tolerance for its
 * size (or angle), else none. A basic dimension's tolerance is its frame's;
 * a reference dimension has none.
 */
export function toleranceOf(dim: ToleranceInput, drawing: { generalTolerance?: string } | null | undefined): EffectiveTolerance {
  const t = dim.tolerance;
  if (t) {
    if (t.kind === "basic") return { upper: 0, lower: 0, source: "basic", text: "basic: toleranced by its feature control frame" };
    if (t.kind === "reference") return { upper: 0, lower: 0, source: "reference", text: "reference: for information, not toleranced" };
    const d = deviationsOf(t, dim.value, dim.fitSide);
    if (d) {
      const fit = t.kind === "fit" || t.kind === "fitWithTol" || t.kind === "fitLimits";
      return { upper: d.upper, lower: d.lower, source: fit ? "fit" : "dimension", text: `${fit ? `${fitText(t.fit!)} ` : ""}${t.kind === "min" ? "MIN" : t.kind === "max" ? "MAX" : `${deviationText(d.upper)}/${deviationText(d.lower)}`}` };
    }
  }
  const g = parseGeneralTolerance(drawing?.generalTolerance);
  if (dim.kind === "angular") {
    const a = generalAngle(g, dim.side ?? 0);
    if (a !== null) return { upper: a, lower: -a, source: "general", text: `${angleTolText(a, g?.standard === "block")} (${g!.text})` };
  } else {
    const edge = dim.kind === "radius" || dim.kind === "chamfer";
    const v = generalLinear(g, Math.abs(dim.value), dim.places ?? 0, { edge });
    if (v !== null) return { upper: v, lower: -v, source: "general", text: `±${numberText(v)} (${g!.text})` };
  }
  return { upper: 0, lower: 0, source: "none", text: "no tolerance: give it one or a general tolerance on the drawing" };
}
