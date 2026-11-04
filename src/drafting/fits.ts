// ISO 286 limits and fits (Phase Q): the standard tolerance grades IT01–IT18
// and the fundamental deviations of holes (A–ZC) and shafts (a–zc), for
// nominal sizes up to 3150 mm, as ISO 286-1:2010 tabulates them. A tolerance
// class ("H7", "g6") gives a size's two limit deviations; a fit ("H7/g6")
// pairs a hole and a shaft and says whether it is a clearance, transition or
// interference fit, with its largest and smallest clearance.
//
// Values are µm in the tables and mm out of every function. Worked numbers
// (tests/annotations.test.ts): Ø25 H7 = +0.021/0, Ø25 g6 = −0.007/−0.020,
// Ø40 m6 = +0.025/+0.009, Ø25 K7 = +0.006/−0.015 (the Δ rule).

/** The upper limits of the main size ranges, mm (each range is above the previous limit up to and including this one). */
const MAIN = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150];

export const IT_GRADES = ["01", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18"] as const;
export type ItGrade = (typeof IT_GRADES)[number];

/**
 * Standard tolerance grades (ISO 286-1 Table 1), µm, per main range: IT01,
 * IT0, IT1 … IT18. IT01 and IT0 are not defined above 500 mm (null).
 */
const IT: (number | null)[][] = [
  [0.3, 0.5, 0.8, 1.2, 2, 3, 4, 6, 10, 14, 25, 40, 60, 100, 140, 250, 400, 600, 1000, 1400],
  [0.4, 0.6, 1, 1.5, 2.5, 4, 5, 8, 12, 18, 30, 48, 75, 120, 180, 300, 480, 750, 1200, 1800],
  [0.4, 0.6, 1, 1.5, 2.5, 4, 6, 9, 15, 22, 36, 58, 90, 150, 220, 360, 580, 900, 1500, 2200],
  [0.5, 0.8, 1.2, 2, 3, 5, 8, 11, 18, 27, 43, 70, 110, 180, 270, 430, 700, 1100, 1800, 2700],
  [0.6, 1, 1.5, 2.5, 4, 6, 9, 13, 21, 33, 52, 84, 130, 210, 330, 520, 840, 1300, 2100, 3300],
  [0.6, 1, 1.5, 2.5, 4, 7, 11, 16, 25, 39, 62, 100, 160, 250, 390, 620, 1000, 1600, 2500, 3900],
  [0.8, 1.2, 2, 3, 5, 8, 13, 19, 30, 46, 74, 120, 190, 300, 460, 740, 1200, 1900, 3000, 4600],
  [1, 1.5, 2.5, 4, 6, 10, 15, 22, 35, 54, 87, 140, 220, 350, 540, 870, 1400, 2200, 3500, 5400],
  [1.2, 2, 3.5, 5, 8, 12, 18, 25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300],
  [2, 3, 4.5, 7, 10, 14, 20, 29, 46, 72, 115, 185, 290, 460, 720, 1150, 1850, 2900, 4600, 7200],
  [2.5, 4, 6, 8, 12, 16, 23, 32, 52, 81, 130, 210, 320, 520, 810, 1300, 2100, 3200, 5200, 8100],
  [3, 5, 7, 9, 13, 18, 25, 36, 57, 89, 140, 230, 360, 570, 890, 1400, 2300, 3600, 5700, 8900],
  [4, 6, 8, 10, 15, 20, 27, 40, 63, 97, 155, 250, 400, 630, 970, 1550, 2500, 4000, 6300, 9700],
  [null, null, 9, 11, 16, 22, 32, 44, 70, 110, 175, 280, 440, 700, 1100, 1750, 2800, 4400, 7000, 11000],
  [null, null, 10, 13, 18, 25, 36, 50, 80, 125, 200, 320, 500, 800, 1250, 2000, 3200, 5000, 8000, 12500],
  [null, null, 11, 15, 21, 28, 40, 56, 90, 140, 230, 360, 560, 900, 1400, 2300, 3600, 5600, 9000, 14000],
  [null, null, 13, 18, 24, 33, 47, 66, 105, 165, 260, 420, 660, 1050, 1650, 2600, 4200, 6600, 10500, 16500],
  [null, null, 15, 21, 29, 39, 55, 78, 125, 195, 310, 500, 780, 1250, 1950, 3100, 5000, 7800, 12500, 19500],
  [null, null, 18, 25, 35, 46, 65, 92, 150, 230, 370, 600, 920, 1500, 2300, 3700, 6000, 9200, 15000, 23000],
  [null, null, 22, 30, 41, 55, 78, 110, 175, 280, 440, 700, 1100, 1750, 2800, 4400, 7000, 11000, 17500, 28000],
  [null, null, 26, 36, 50, 68, 96, 135, 210, 330, 540, 860, 1350, 2100, 3300, 5400, 8600, 13500, 21000, 33000],
];

/** The intermediate ranges some deviations are tabulated by (a, b, c and r–zc), upper limits, mm. */
const SUB = [3, 6, 10, 14, 18, 24, 30, 40, 50, 65, 80, 100, 120, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500];
const SUB_BIG = [560, 630, 710, 800, 900, 1000, 1120, 1250, 1400, 1600, 1800, 2000, 2240, 2500, 2800, 3150];

/** A shaft's upper deviation es, µm (negative), for a–h, by main range to 500 (a, b, c by SUB). */
const ES_SUB: Record<string, (number | null)[]> = {
  a: [-270, -270, -280, -290, -290, -300, -300, -310, -320, -340, -360, -380, -410, -460, -520, -580, -660, -740, -820, -920, -1050, -1200, -1350, -1500, -1650],
  b: [-140, -140, -150, -150, -150, -160, -160, -170, -180, -190, -200, -220, -240, -260, -280, -310, -340, -380, -420, -480, -540, -600, -680, -760, -840],
  c: [-60, -70, -80, -95, -95, -110, -110, -120, -130, -140, -150, -170, -180, -200, -210, -230, -240, -260, -280, -300, -330, -360, -400, -440, -480],
};
const ES_MAIN: Record<string, (number | null)[]> = {
  cd: [-34, -46, -56, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  d: [-20, -30, -40, -50, -65, -80, -100, -120, -145, -170, -190, -210, -230, -260, -290, -320, -350, -390, -430, -480, -520],
  e: [-14, -20, -25, -32, -40, -50, -60, -72, -85, -100, -110, -125, -135, -145, -160, -170, -195, -220, -240, -260, -290],
  ef: [-10, -14, -18, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50, -56, -62, -68, -76, -80, -86, -98, -110, -120, -130, -145],
  fg: [-4, -6, -8, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20, -22, -24, -26, -28, -30, -32, -34, -38],
  h: Array(21).fill(0),
};
/** A shaft's lower deviation ei, µm, for k–p by main range (k for grades 4–7; k is 0 for the others). */
const EI_MAIN: Record<string, (number | null)[]> = {
  k: [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  m: [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23, 26, 30, 34, 40, 48, 58, 68, 76],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40, 44, 50, 56, 66, 78, 92, 110, 135],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68, 78, 88, 100, 120, 140, 170, 195, 240],
};
/** ei, µm, for r–zc by SUB (to 500) then SUB_BIG (r, s, t, u only); null where the standard has none. */
const EI_SUB: Record<string, (number | null)[]> = {
  r: [10, 15, 19, 23, 23, 28, 28, 34, 34, 41, 43, 51, 54, 63, 65, 68, 77, 80, 84, 94, 98, 108, 114, 126, 132, 150, 155, 175, 185, 210, 220, 250, 260, 300, 330, 370, 400, 440, 460, 550, 580],
  s: [14, 19, 23, 28, 28, 35, 35, 43, 43, 53, 59, 71, 79, 92, 100, 108, 122, 130, 140, 158, 170, 190, 208, 232, 252, 280, 310, 340, 380, 430, 470, 520, 580, 640, 720, 820, 920, 1000, 1100, 1250, 1400],
  t: [null, null, null, null, null, null, 41, 48, 54, 66, 75, 91, 104, 122, 134, 146, 166, 180, 196, 218, 240, 268, 294, 330, 360, 400, 450, 500, 560, 620, 680, 780, 840, 960, 1050, 1200, 1350, 1500, 1650, 1900, 2100],
  u: [18, 23, 28, 33, 33, 41, 48, 60, 70, 87, 102, 124, 144, 170, 190, 210, 236, 258, 284, 315, 350, 390, 435, 490, 540, 600, 660, 740, 840, 940, 1050, 1150, 1300, 1450, 1600, 1850, 2000, 2300, 2500, 2900, 3200],
  v: [null, null, null, null, 39, 47, 55, 68, 81, 102, 120, 146, 172, 202, 228, 252, 284, 310, 340, 385, 425, 475, 530, 595, 660],
  x: [20, 28, 34, 40, 45, 54, 64, 80, 97, 122, 146, 178, 210, 248, 280, 310, 350, 385, 425, 475, 525, 590, 660, 740, 820],
  y: [null, null, null, null, null, 63, 75, 94, 114, 144, 174, 214, 254, 300, 340, 380, 425, 470, 520, 580, 650, 730, 820, 920, 1000],
  z: [26, 35, 42, 50, 60, 73, 88, 112, 136, 172, 210, 258, 310, 365, 415, 465, 520, 575, 640, 710, 790, 900, 1000, 1100, 1250],
  za: [32, 42, 52, 64, 77, 98, 118, 148, 180, 226, 274, 335, 400, 470, 535, 600, 670, 740, 820, 920, 1000, 1150, 1300, 1450, 1600],
  zb: [40, 50, 67, 90, 108, 136, 160, 200, 242, 300, 360, 445, 525, 620, 700, 780, 880, 960, 1050, 1200, 1300, 1500, 1650, 1850, 2100],
  zc: [60, 80, 97, 130, 150, 188, 218, 274, 325, 405, 480, 585, 690, 800, 900, 1000, 1150, 1250, 1350, 1550, 1700, 1900, 2100, 2400, 2600],
};
/** j shafts: ei for j5 and j6, j7, j8 (j8 to 3 mm only), µm, by main range to 500. */
const J_SHAFT: [number, number, number | null][] = [
  [-2, -4, -6], [-2, -4, null], [-2, -5, null], [-3, -6, null], [-4, -8, null], [-5, -10, null], [-7, -12, null],
  [-9, -15, null], [-11, -18, null], [-13, -21, null], [-16, -26, null], [-18, -28, null], [-20, -32, null],
];
/** J holes: ES for J6, J7, J8, µm, by main range to 500. */
const J_HOLE: [number, number, number][] = [
  [2, 4, 6], [5, 6, 10], [5, 8, 12], [6, 10, 15], [8, 12, 20], [10, 14, 24], [13, 18, 28],
  [16, 22, 34], [18, 26, 41], [22, 30, 47], [25, 36, 55], [29, 39, 60], [33, 43, 66],
];

export const HOLE_LETTERS = ["A", "B", "C", "CD", "D", "E", "EF", "F", "FG", "G", "H", "JS", "J", "K", "M", "N", "P", "R", "S", "T", "U", "V", "X", "Y", "Z", "ZA", "ZB", "ZC"] as const;
export const SHAFT_LETTERS = HOLE_LETTERS.map((l) => l.toLowerCase());

function rangeIndex(limits: number[], size: number): number {
  // A size on a limit belongs to the range below it ("over 18 up to and including 30").
  for (let i = 0; i < limits.length; i++) if (size <= limits[i] + 1e-9) return i;
  return -1;
}

/** The standard tolerance IT<grade> for a nominal size, mm; null outside 0–3150 mm or where the standard has none. */
export function itTolerance(size: number, grade: ItGrade | string | number): number | null {
  const g = IT_GRADES.indexOf(String(grade) as ItGrade);
  const i = rangeIndex(MAIN, size);
  if (g < 0 || i < 0 || !(size > 0)) return null;
  const v = IT[i][g];
  return v === null ? null : v / 1000;
}

/** µm, as tabulated (for the Δ rule and the js rounding). */
function itMicrons(i: number, grade: number): number | null {
  const g = IT_GRADES.indexOf(String(grade) as ItGrade);
  return g < 0 ? null : IT[i][g];
}

/** A tolerance class as written: "H7", "g6", "JS9", "zc11". */
export interface ToleranceClass {
  /** "H", "g", "js". */
  letter: string;
  grade: ItGrade;
  hole: boolean;
}

/** Reads "H7", "g6", "js11", "ZC8"; null when it isn't a class. */
export function parseToleranceClass(s: string): ToleranceClass | null {
  const m = /^\s*([A-Za-z]{1,2})(01|0|1[0-8]|[1-9])\s*$/.exec(s);
  if (!m) return null;
  const letter = m[1];
  const upper = letter.toUpperCase();
  const isHole = letter === upper;
  if (!isHole && letter !== letter.toLowerCase()) return null; // "Js" is neither
  if (!(HOLE_LETTERS as readonly string[]).includes(upper)) return null;
  return { letter, grade: m[2] as ItGrade, hole: isHole };
}

/** A fit as written: "H7/g6", "H7-g6", "H7 g6", or one class ("H7", "g6"). */
export interface FitCode {
  hole?: ToleranceClass;
  shaft?: ToleranceClass;
}

export function parseFit(s: string): FitCode | null {
  if (typeof s !== "string") return null;
  const parts = s.trim().split(/\s*[/\- ]\s*/).filter(Boolean);
  if (parts.length === 1) {
    const c = parseToleranceClass(parts[0]);
    return c ? (c.hole ? { hole: c } : { shaft: c }) : null;
  }
  if (parts.length !== 2) return null;
  const h = parseToleranceClass(parts[0]);
  const sh = parseToleranceClass(parts[1]);
  if (!h || !sh || !h.hole || sh.hole) return null;
  return { hole: h, shaft: sh };
}

/** Limit deviations of a size, mm: upper and lower, the size's limits are size + lower … size + upper. */
export interface Deviations {
  upper: number;
  lower: number;
}

/** "Ø25 H7" → { upper: 0.021, lower: 0 }. Null outside 0–3150 mm or for a class the standard does not have at that size. */
export function classDeviations(size: number, c: ToleranceClass | string): Deviations | null {
  const cls = typeof c === "string" ? parseToleranceClass(c) : c;
  if (!cls || !(size > 0) || size > 3150 + 1e-9) return null;
  const main = rangeIndex(MAIN, size);
  // IT01 counts as grade −1 in the rules below (only its value is read).
  const grade = cls.grade === "01" ? -1 : Number(cls.grade);
  const itv = IT[main][IT_GRADES.indexOf(cls.grade)];
  if (itv === null || itv === undefined) return null;
  const um = cls.hole ? holeMicrons(size, cls.letter.toUpperCase(), grade, itv, main) : shaftMicrons(size, cls.letter.toLowerCase(), grade, itv, main);
  if (!um) return null;
  return { upper: round6(um[0] / 1000), lower: round6(um[1] / 1000) };
}

/** [es, ei] of a shaft, µm. */
function shaftMicrons(size: number, l: string, grade: number, it: number, main: number): [number, number] | null {
  if (l === "js") {
    const half = jsHalf(it);
    return [half, -half];
  }
  if (l === "j") {
    if (main >= J_SHAFT.length) return null;
    const row = J_SHAFT[main];
    const ei = grade === 5 || grade === 6 ? row[0] : grade === 7 ? row[1] : grade === 8 ? row[2] : null;
    return ei === null ? null : [ei + it, ei];
  }
  const es = upperShaft(size, l, main);
  if (es !== undefined) return es === null ? null : [es, es - it];
  const ei = lowerShaft(size, l, grade, main);
  return ei === null ? null : [ei + it, ei];
}

/** es, µm, for a–h; undefined for the letters it is not (their ei is tabulated). */
function upperShaft(size: number, l: string, main: number): number | null | undefined {
  if (l in ES_SUB) {
    const i = rangeIndex(SUB, size);
    return i < 0 ? null : ES_SUB[l][i];
  }
  if (l in ES_MAIN) return ES_MAIN[l][main] ?? null;
  return undefined;
}

/** ei, µm, for k–zc. */
function lowerShaft(size: number, l: string, grade: number, main: number): number | null {
  // k: +0.6∛D for grades 4 to 7 (tabulated); 0 for the others, at 3 mm and under, and over 500 mm.
  if (l === "k") return grade >= 4 && grade <= 7 ? (EI_MAIN.k[main] ?? null) : 0;
  if (l in EI_MAIN) return EI_MAIN[l][main] ?? null;
  if (l in EI_SUB) {
    const row = EI_SUB[l];
    const i = size <= 500 ? rangeIndex(SUB, size) : SUB.length + rangeIndex(SUB_BIG, size);
    return i < 0 || i >= row.length ? null : row[i];
  }
  return null;
}

/** ±IT/2, µm; an odd IT in whole µm is taken down to the even number below (ISO 286-1 4.2.3). */
function jsHalf(it: number): number {
  if (Number.isInteger(it) && it >= 7 && it % 2 === 1) return (it - 1) / 2;
  return it / 2;
}

/** [ES, EI] of a hole, µm. */
function holeMicrons(size: number, L: string, grade: number, it: number, main: number): [number, number] | null {
  if (L === "JS") {
    const half = jsHalf(it);
    return [half, -half];
  }
  if (L === "J") {
    if (main >= J_HOLE.length) return null;
    const row = J_HOLE[main];
    const es = grade === 6 ? row[0] : grade === 7 ? row[1] : grade === 8 ? row[2] : null;
    return es === null ? null : [es, es - it];
  }
  const l = L.toLowerCase();
  const es = upperShaft(size, l, main);
  if (es !== undefined) {
    // A–H: EI = −es (the shaft's mirror).
    if (es === null) return null;
    return [-es + it, -es];
  }
  // K–ZC: ES = −ei, with Δ = IT(n) − IT(n−1) added for K, M, N to grade 8 and P–ZC to grade 7, over 3 mm and to 500 mm.
  const ei = lowerShaft(size, l, l === "k" ? Math.min(grade, 7) : grade, main);
  if (ei === null) return null;
  let ES = -ei;
  const deltaApplies = size > 3 && size <= 500 && ((["k", "m", "n"].includes(l) && grade <= 8) || (!["k", "m", "n"].includes(l) && grade <= 7)) && grade >= 3;
  if (l === "k" && grade > 8) ES = 0;
  else if (l === "n" && grade > 8) ES = size <= 3 ? -4 : 0;
  else if (deltaApplies) {
    const a = itMicrons(main, grade);
    const b = itMicrons(main, grade - 1);
    if (a !== null && b !== null) ES += a - b;
  }
  // K over 3 mm to grade 8 is −k(ei of grades 4–7) + Δ; at 3 mm and under, 0.
  if (l === "k" && size <= 3) ES = 0;
  return [ES, ES - it];
}

export type FitType = "clearance" | "transition" | "interference";

/** A hole and shaft pair: each one's deviations, the largest and smallest clearance (negative: interference), mm, and the kind of fit. */
export interface FitResult {
  hole: Deviations;
  shaft: Deviations;
  maxClearance: number;
  minClearance: number;
  type: FitType;
}

/** "Ø25 H7/g6": the hole +0.021/0, the shaft −0.007/−0.020, clearance 0.007 to 0.041. Null when either class is not tabulated at that size. */
export function fitOf(size: number, code: string | FitCode): FitResult | null {
  const f = typeof code === "string" ? parseFit(code) : code;
  if (!f?.hole || !f.shaft) return null;
  const hole = classDeviations(size, f.hole);
  const shaft = classDeviations(size, f.shaft);
  if (!hole || !shaft) return null;
  const maxClearance = round6(hole.upper - shaft.lower);
  const minClearance = round6(hole.lower - shaft.upper);
  const type: FitType = minClearance >= 0 ? "clearance" : maxClearance <= 0 ? "interference" : "transition";
  return { hole, shaft, maxClearance, minClearance, type };
}

/** The deviations a fit code puts on one size: a hole class's, a shaft class's, or for a pair the side named (default the hole). */
export function fitDeviations(size: number, code: string, side: "hole" | "shaft" = "hole"): Deviations | null {
  const f = parseFit(code);
  if (!f) return null;
  const c = f.hole && f.shaft ? f[side] : (f.hole ?? f.shaft);
  return c ? classDeviations(size, c) : null;
}

/** "H7/g6" written as the standards do: "H7/g6"; a single class as given. */
export function fitText(code: string): string {
  const f = parseFit(code);
  if (!f) return code;
  if (f.hole && f.shaft) return `${f.hole.letter}${f.hole.grade}/${f.shaft.letter}${f.shaft.grade}`;
  const c = (f.hole ?? f.shaft)!;
  return `${c.letter}${c.grade}`;
}

/** Common fits by purpose (ISO 286-2's preferred hole-basis fits), for the AI and the property panel. */
export const PREFERRED_FITS: { fit: string; type: FitType; use: string }[] = [
  { fit: "H11/c11", type: "clearance", use: "loose running: wide commercial tolerances" },
  { fit: "H9/d9", type: "clearance", use: "free running: large temperature changes, high speeds" },
  { fit: "H8/f7", type: "clearance", use: "close running: accurate location at moderate speeds" },
  { fit: "H7/g6", type: "clearance", use: "sliding: free to move and turn, located accurately" },
  { fit: "H7/h6", type: "clearance", use: "locational clearance: snug, assembled by hand" },
  { fit: "H7/k6", type: "transition", use: "locational transition: accurate location, light press or tap" },
  { fit: "H7/n6", type: "transition", use: "locational transition: more accurate, light press" },
  { fit: "H7/p6", type: "interference", use: "locational interference: rigid alignment, pressed" },
  { fit: "H7/s6", type: "interference", use: "medium drive: ordinary steel parts, shrink fits on light sections" },
  { fit: "H7/u6", type: "interference", use: "force: permanent, heavy press or shrink" },
  { fit: "H7/m6", type: "transition", use: "dowel pins in a reamed hole" },
];

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6 + 0;
}
