// Section hatching (Phase Q): the patterns of ISO 128-50 and the ANSI set a
// drawing office uses for materials, which pattern a body's material gets,
// and the lines of a pattern inside a cut face's loops (even-odd, so holes
// stay clear). Lines are anchored to the sheet's origin, so two faces of one
// body hatch as one.

import type { HatchPattern, Material, Vec2 } from "../doc/types";

/** One set of parallel lines of a pattern: turned `turn` degrees from the pattern's angle, repeating every `period` spacings. */
interface Family {
  turn: number;
  period: number;
  /** Lines in each period: where (a fraction of it) and their dash (sheet mm), if dashed. */
  lines: { at: number; dash?: number[] }[];
}

export const PATTERNS: Record<HatchPattern, Family[]> = {
  // ANSI31 / ISO 128-50: thin lines at 45°.
  general: [{ turn: 0, period: 1, lines: [{ at: 0 }] }],
  // ANSI32: pairs of lines.
  steel: [{ turn: 0, period: 2, lines: [{ at: 0 }, { at: 0.3 }] }],
  // ANSI38: lines, crossed by dashes.
  aluminium: [
    { turn: 0, period: 1.4, lines: [{ at: 0 }] },
    { turn: 90, period: 1.4, lines: [{ at: 0.5, dash: [1.4, 2.2] }] },
  ],
  // ANSI33: lines, every other one dashed.
  copper: [{ turn: 0, period: 2, lines: [{ at: 0 }, { at: 0.5, dash: [2.4, 1.2] }] }],
  // ANSI37: cross-hatch.
  plastic: [
    { turn: 0, period: 1, lines: [{ at: 0 }] },
    { turn: 90, period: 1, lines: [{ at: 0 }] },
  ],
  rubber: [
    { turn: 0, period: 0.6, lines: [{ at: 0 }] },
    { turn: 90, period: 0.6, lines: [{ at: 0 }] },
  ],
  wood: [{ turn: -45, period: 1.6, lines: [{ at: 0, dash: [7, 1.4] }, { at: 0.5, dash: [2.5, 1.2, 0.6, 1.2] }] }],
  concrete: [
    { turn: 0, period: 2, lines: [{ at: 0, dash: [0.4, 1.4] }] },
    { turn: 90, period: 2.5, lines: [{ at: 0.3, dash: [0.4, 2.1] }] },
  ],
  solid: [],
  none: [],
};

/**
 * The pattern a material gets: by its name, else by its density (steel and
 * iron about 7850, aluminium about 2700, copper alloys 8400–8960, plastics
 * below 1500).
 */
export function materialPattern(m: Material | undefined): HatchPattern {
  if (!m) return "steel";
  const n = (m.name ?? "").toLowerCase();
  if (/alu|6061|6082|7075|5083/.test(n)) return "aluminium";
  if (/brass|bronze|copper|cuzn|cusn/.test(n)) return "copper";
  if (/rubber|epdm|nbr|neoprene|silicone/.test(n)) return "rubber";
  if (/wood|timber|oak|pine|spruce|ply|mdf|lumber/.test(n)) return "wood";
  if (/concrete|stone|masonry/.test(n)) return "concrete";
  if (/plastic|nylon|pa6|pa66|pom|delrin|acetal|abs|pla|petg|ptfe|hdpe|uhmw|pvc|acrylic|pmma|polycarbonate|peek/.test(n)) return "plastic";
  if (/iron|cast/.test(n)) return "general";
  if (/steel|s235|s275|s355|304|316|stainless|mild/.test(n)) return "steel";
  const d = m.densityKgPerM3;
  if (d > 8300 && d < 9000) return "copper";
  if (d > 6800 && d < 8300) return "steel";
  if (d > 2400 && d < 3000) return "aluminium";
  if (d < 1500) return d < 1000 && d > 300 ? "wood" : "plastic";
  return "general";
}

/** Angles for the bodies of a section, in turn: each member of a weldment hatched its own way. */
export const BODY_ANGLES = [45, 135, 60, 120, 30, 150, 75, 105];

export interface HatchLine {
  pts: Vec2[];
  dash?: number[];
}

/**
 * The lines of a pattern inside loops (even-odd), in the loops' units.
 * `spacing` is between lines in those units; `dashScale` turns a dash's sheet
 * mm into them.
 */
export function hatchLines(loops: Vec2[][], pattern: HatchPattern, angle: number, spacing: number, dashScale = 1): HatchLine[] {
  const out: HatchLine[] = [];
  const edges: [Vec2, Vec2][] = [];
  for (const l of loops) for (let i = 0; i < l.length; i++) edges.push([l[i], l[(i + 1) % l.length]]);
  if (!edges.length || spacing <= 0) return out;
  for (const fam of PATTERNS[pattern]) {
    const t = ((angle + fam.turn) * Math.PI) / 180;
    const u: Vec2 = [Math.cos(t), Math.sin(t)];
    const v: Vec2 = [-u[1], u[0]];
    let lo = Infinity;
    let hi = -Infinity;
    for (const [p] of edges) {
      const c = p[0] * v[0] + p[1] * v[1];
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
    }
    const period = fam.period * spacing;
    // Never more than a few thousand lines in a face: a hatch finer than that is grey, not lines.
    if ((hi - lo) / period > 4000) continue;
    for (let k = Math.floor(lo / period) - 1; k * period <= hi + period; k++) {
      for (const line of fam.lines) {
        const c = (k + line.at) * period;
        if (c < lo || c > hi) continue;
        const ts: number[] = [];
        for (const [p, q] of edges) {
          const cp = p[0] * v[0] + p[1] * v[1] - c;
          const cq = q[0] * v[0] + q[1] * v[1] - c;
          if (cp > 0 === cq > 0) continue;
          const f = cp / (cp - cq);
          const x: Vec2 = [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
          ts.push(x[0] * u[0] + x[1] * u[1]);
        }
        ts.sort((a, b) => a - b);
        for (let i = 0; i + 1 < ts.length; i += 2) {
          if (ts[i + 1] - ts[i] < 1e-9) continue;
          const at = (s: number): Vec2 => [u[0] * s + v[0] * c, u[1] * s + v[1] * c];
          out.push({ pts: [at(ts[i]), at(ts[i + 1])], ...(line.dash ? { dash: line.dash.map((d) => d * dashScale) } : {}) });
        }
      }
    }
  }
  return out;
}
