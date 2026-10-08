// Text on a sheet is Helvetica, the font every PDF reader has built in (and
// Arial, its metric twin, in the browser). These are its widths, per 1000
// units of the font size, so a table cell or a balloon is sized the same in
// the app, the SVG and the PDF.

const FIRST = 32;
// Characters 32–126. Read from Liberation Sans, which shares Helvetica's metrics.
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];
/** The few others a drawing uses: Ø ° × ² ± µ – —. */
const EXTRA: Record<string, number> = { "Ø": 778, "°": 400, "×": 584, "²": 333, "±": 584, "µ": 556, "–": 556, "—": 1000 };

/** Width of `text` set at font size `size` (mm), mm. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? BOLD : REGULAR;
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    units += c >= FIRST && c < FIRST + table.length ? table[c - FIRST] : (EXTRA[ch] ?? 556);
  }
  return (units / 1000) * size;
}

/**
 * Font sizes, mm. Helvetica's capitals are 0.72 of its size, so a dimension's
 * 5 mm font is the 3.5 mm lettering of ISO 3098.
 */
export const TEXT = { dimension: 5, label: 2.6, cell: 3.8, title: 7, balloon: 5, note: 4.2 } as const;
/** Capital height as a fraction of the font size. */
export const CAP = 0.72;
/** Line weights, mm (ISO 128). */
export const LINE = { visible: 0.5, thin: 0.25, border: 0.7 } as const;
/** Hidden edges: 3 mm dashes with 1.5 mm gaps. */
export const HIDDEN_DASH = [3, 1.5];
