// How annotations are drawn, per drafting standard (Phase Q): ISO 129-1 /
// ISO 128 / ISO 3098 and ASME Y14.5 / Y14.2. Arrowheads 3 mm long, closed
// and filled with a 15° half angle; lettering 3.5 mm high (2.5 mm for
// tolerances and notes); dimension and leader lines 0.25 mm, symbols and
// lettering strokes 0.35 mm, visible edges 0.5 mm; extension lines start
// 1 mm from the part and run 2 mm past the dimension line; the first
// dimension line 10 mm from the part, the next ones 7 mm apart. ISO writes a
// dimension's text along its line, above it; ASME writes it upright,
// breaking the line. The classic template (Phase L drawings) keeps its own
// numbers so an old drawing looks as it did.

import { CAP } from "../text";

export interface DraftStyle {
  standard: "ISO" | "ASME";
  /** Phase L's look. */
  classic: boolean;
  /** Lettering: capital height and the font size that gives it, mm. */
  h: number;
  font: number;
  /** Tolerances, dual units: a size smaller. */
  small: number;
  /** Notes and callouts' second lines. */
  note: number;
  arrow: { length: number; half: number };
  /** Extension lines: gap from the part, overshoot past the dimension line. */
  gap: number;
  over: number;
  /** First dimension line from the part, then between lines. */
  first: number;
  step: number;
  /** Line weights. */
  thin: number;
  symbol: number;
  /** The text's clearance above its dimension line. */
  lift: number;
  /** ASME: text upright, in a break of the dimension line. */
  unidirectional: boolean;
  /** Datum triangles filled. */
  filledDatum: boolean;
}

/** The style a sheet's annotations are drawn in. */
export function draftStyle(standard: "ISO" | "ASME" = "ISO", template: string = "iso"): DraftStyle {
  if (template === "classic") {
    // Phase L: a 5 mm font (3.6 mm capitals), arrows 3 × 1.2, 10 mm then 8 mm apart.
    return { standard, classic: true, h: 5 * CAP, font: 5, small: 3.8, note: 4.2, arrow: { length: 3, half: 0.6 }, gap: 1.5, over: 2, first: 10, step: 8, thin: 0.25, symbol: 0.25, lift: 1.2, unidirectional: false, filledDatum: true };
  }
  const h = 3.5;
  const half = 3 * Math.tan((15 * Math.PI) / 180);
  return {
    standard,
    classic: false,
    h,
    font: h / CAP,
    small: 2.5 / CAP,
    note: 2.5 / CAP,
    arrow: { length: 3, half },
    gap: 1,
    over: 2,
    first: 10,
    step: 7,
    thin: 0.25,
    symbol: 0.35,
    lift: 1,
    unidirectional: standard === "ASME",
    filledDatum: true,
  };
}

/** The DXF layers annotations go on. */
export const LAYERS = { dimension: "DIMENSION", annotation: "ANNOTATION", center: "CENTER", text: "TEXT", table: "TABLE" } as const;
