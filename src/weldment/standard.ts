// The standard section library: catalogue steel and timber sections every
// user has out of the box, beside the profiles they draw. Each family is one
// parametric profile (its sketch written in its size parameters) with many
// sizes. Pure data and geometry; nothing here touches storage.
//
// Sources (dimensions as published; nothing is made up):
// - AS/NZS 3679.1 hot-rolled UB, UC, PFC and angles: the Australian
//   manufacturers' section property tables (d, bf, tf, tw, r1; angles with
//   their actual thickness, root radius r1 and toe radius r2). Angle radii are
//   the catalogue's per-leg-size values. TFB is left out: its tapered flanges
//   are not in this data set.
// - AS/NZS 1163 cold-formed hollow sections: outside dimensions and wall
//   thickness as catalogued (C350L0 / C450L0 light gauges, C250/C350 CHS), with
//   the tables' outside corner radius ro = 2.0t for t <= 3 mm and 2.5t above.
// - Purlins: the common Australian C and Z purlin dimensions (depth, flange
//   widths, lip) by size code; bends are drawn sharp, so areas are within
//   about 2% of the catalogue's. Check the roll-former's table for design.
// - Timber: actual dressed (MGP, LVL) and sawn (F-grade hardwood, posts) sizes
//   used with AS 1684, with typical densities for mass.
// Bar and flat sizes are their designations.

import type { ProfileDef, SketchEntity } from "../doc/types";
import { evaluate } from "../doc/parameters";
import type { LibraryEntry } from "./library";

/** Densities, kg/m³. */
export const DENSITY = { steel: 7850, mgp: 550, hardwood: 1000, lvl: 620, treatedPine: 550 } as const;

/** Timber materials for the material picker. */
export const TIMBER_MATERIALS = [
  { name: "MGP pine (seasoned)", densityKgPerM3: DENSITY.mgp },
  { name: "F-grade hardwood (unseasoned)", densityKgPerM3: DENSITY.hardwood },
  { name: "LVL", densityKgPerM3: DENSITY.lvl },
];

export const STANDARD_GROUPS = ["AS/NZS 3679.1", "AS/NZS 1163", "Purlins", "Timber"] as const;

// ------------------------------------------------------------ geometry

/** A loop corner: coordinates as expressions in the size parameters, and an optional fillet radius. */
type Corner = [x: string, y: string, r?: string];

/**
 * A closed loop of lines through the corners, each corner with a radius
 * rounded by an arc. Corners are square, so the arc's ends lie along the two
 * sides; which way each side runs is read at the first size (the shape is the
 * same at every size).
 */
function loop(prefix: string, corners: Corner[], params: Record<string, number>): SketchEntity[] {
  const num = (e: string) => {
    const v = evaluate(`=${e}`, params);
    if (!v.ok) throw new Error(`${prefix}: ${e}: ${v.error}`);
    return v.value;
  };
  const at = corners.map(([x, y]) => [num(x), num(y)]);
  const n = corners.length;
  const dir = (i: number, j: number) => {
    const dx = at[j][0] - at[i][0];
    const dy = at[j][1] - at[i][1];
    const l = Math.hypot(dx, dy);
    return [Math.round(dx / l), Math.round(dy / l)];
  };
  const off = (base: string, r: string, k: number) => (k === 0 ? base : `(${base}) ${k > 0 ? "+" : "-"} (${r})`);
  // Each corner's point(s): where the side arrives and where it leaves.
  const ends = corners.map(([x, y, r], i) => {
    if (!r) return { in: [x, y], out: [x, y], arc: null };
    const din = dir((i + n - 1) % n, i);
    const dout = dir(i, (i + 1) % n);
    const start = [off(x, r, -din[0]), off(y, r, -din[1])];
    const end = [off(x, r, dout[0]), off(y, r, dout[1])];
    const center = [off(start[0], r, dout[0]), off(start[1], r, dout[1])];
    const turn = din[0] * dout[1] - din[1] * dout[0];
    return { in: start, out: end, arc: { center, clockwise: turn < 0 } };
  });
  const p = (v: string[]) => v.map((s) => `=${s}`) as unknown as [number, number];
  const out: SketchEntity[] = [];
  ends.forEach((e, i) => {
    if (e.arc) out.push({ id: `${prefix}a${i}`, type: "arc", center: p(e.arc.center), start: p(e.in), end: p(e.out), ...(e.arc.clockwise ? { clockwise: true } : {}) } as SketchEntity);
    const next = ends[(i + 1) % n];
    out.push({ id: `${prefix}l${i}`, type: "line", start: p(e.out), end: p(next.in) } as SketchEntity);
  });
  return out;
}

interface Family {
  id: string;
  name: string;
  group: (typeof STANDARD_GROUPS)[number];
  /** Parameter names, in the order each size's values are listed. */
  keys: string[];
  entities: (params: Record<string, number>) => SketchEntity[];
  sizes: [designation: string, ...values: number[]][];
  tags: string[];
  material: string;
  density: number;
}

const iSection = (p: Record<string, number>) =>
  loop(
    "o",
    [
      ["-b/2", "-d/2"],
      ["b/2", "-d/2"],
      ["b/2", "-d/2 + tf"],
      ["tw/2", "-d/2 + tf", "r1"],
      ["tw/2", "d/2 - tf", "r1"],
      ["b/2", "d/2 - tf"],
      ["b/2", "d/2"],
      ["-b/2", "d/2"],
      ["-b/2", "d/2 - tf"],
      ["-tw/2", "d/2 - tf", "r1"],
      ["-tw/2", "-d/2 + tf", "r1"],
      ["-b/2", "-d/2 + tf"],
    ],
    p,
  );

const channel = (p: Record<string, number>) =>
  loop(
    "o",
    [
      ["0", "-d/2"],
      ["b", "-d/2"],
      ["b", "-d/2 + tf"],
      ["tw", "-d/2 + tf", "r1"],
      ["tw", "d/2 - tf", "r1"],
      ["b", "d/2 - tf"],
      ["b", "d/2"],
      ["0", "d/2"],
    ],
    p,
  );

const angle = (p: Record<string, number>) =>
  loop(
    "o",
    [
      ["0", "0"],
      ["b1", "0"],
      ["b1", "t", "r2"],
      ["t", "t", "r1"],
      ["t", "b2", "r2"],
      ["0", "b2"],
    ],
    p,
  );

const rhs = (p: Record<string, number>) => [
  ...loop("o", [["-b/2", "-d/2", "r"], ["b/2", "-d/2", "r"], ["b/2", "d/2", "r"], ["-b/2", "d/2", "r"]], p),
  ...loop("i", [["-b/2 + t", "-d/2 + t", "r - t"], ["b/2 - t", "-d/2 + t", "r - t"], ["b/2 - t", "d/2 - t", "r - t"], ["-b/2 + t", "d/2 - t", "r - t"]], p),
];

const shs = (p: Record<string, number>) => [
  ...loop("o", [["-b/2", "-b/2", "r"], ["b/2", "-b/2", "r"], ["b/2", "b/2", "r"], ["-b/2", "b/2", "r"]], p),
  ...loop("i", [["-b/2 + t", "-b/2 + t", "r - t"], ["b/2 - t", "-b/2 + t", "r - t"], ["b/2 - t", "b/2 - t", "r - t"], ["-b/2 + t", "b/2 - t", "r - t"]], p),
];

const chs = (): SketchEntity[] => [
  { id: "o", type: "circle", center: [0, 0], radius: "=D/2" as unknown as number },
  { id: "i", type: "circle", center: [0, 0], radius: "=D/2 - t" as unknown as number },
];

const rect = (): SketchEntity[] => [{ id: "r", type: "rect", center: [0, 0], w: "=b" as unknown as number, h: "=d" as unknown as number }];
const roundBar = (): SketchEntity[] => [{ id: "c", type: "circle", center: [0, 0], radius: "=D/2" as unknown as number }];

const cPurlin = (p: Record<string, number>) =>
  loop(
    "o",
    [
      ["0", "-d/2"],
      ["b", "-d/2"],
      ["b", "-d/2 + L"],
      ["b - t", "-d/2 + L"],
      ["b - t", "-d/2 + t"],
      ["t", "-d/2 + t"],
      ["t", "d/2 - t"],
      ["b - t", "d/2 - t"],
      ["b - t", "d/2 - L"],
      ["b", "d/2 - L"],
      ["b", "d/2"],
      ["0", "d/2"],
    ],
    p,
  );

const zPurlin = (p: Record<string, number>) =>
  loop(
    "o",
    [
      ["t - F", "-d/2"],
      ["t", "-d/2"],
      ["t", "d/2 - t"],
      ["E - t", "d/2 - t"],
      ["E - t", "d/2 - L"],
      ["E", "d/2 - L"],
      ["E", "d/2"],
      ["0", "d/2"],
      ["0", "-d/2 + t"],
      ["2*t - F", "-d/2 + t"],
      ["2*t - F", "-d/2 + L"],
      ["t - F", "-d/2 + L"],
    ],
    p,
  );

// ------------------------------------------------------------ data

// UB and UC: designation, d, bf, tf, tw, r1 (mm).
const UB: [string, number, number, number, number, number][] = [
  ["610UB125", 612, 229, 19.6, 11.9, 14],
  ["610UB113", 607, 228, 17.3, 11.2, 14],
  ["610UB101", 602, 228, 14.8, 10.6, 14],
  ["530UB92.4", 533, 209, 15.6, 10.2, 14],
  ["530UB82.0", 528, 209, 13.2, 9.6, 14],
  ["460UB82.1", 460, 191, 16.0, 9.9, 11.4],
  ["460UB74.6", 457, 190, 14.5, 9.1, 11.4],
  ["460UB67.1", 454, 190, 12.7, 8.5, 11.4],
  ["410UB59.7", 406, 178, 12.8, 7.8, 11.4],
  ["410UB53.7", 403, 178, 10.9, 7.6, 11.4],
  ["360UB56.7", 359, 172, 13.0, 8.0, 11.4],
  ["360UB50.7", 356, 171, 11.5, 7.3, 11.4],
  ["360UB44.7", 352, 171, 9.7, 6.9, 11.4],
  ["310UB46.2", 307, 166, 11.8, 6.7, 11.4],
  ["310UB40.4", 304, 165, 10.2, 6.1, 11.4],
  ["310UB32.0", 298, 149, 8.0, 5.5, 13],
  ["250UB37.3", 256, 146, 10.9, 6.4, 8.9],
  ["250UB31.4", 252, 146, 8.6, 6.1, 8.9],
  ["250UB25.7", 248, 124, 8.0, 5.0, 12],
  ["200UB29.8", 207, 134, 9.6, 6.3, 8.9],
  ["200UB25.4", 203, 133, 7.8, 5.8, 8.9],
  ["200UB22.3", 202, 133, 7.0, 5.0, 8.9],
  ["200UB18.2", 198, 99, 7.0, 4.5, 11],
  ["180UB22.2", 179, 90, 10.0, 6.0, 8.9],
  ["180UB18.1", 175, 90, 8.0, 5.0, 8.9],
  ["180UB16.1", 173, 90, 7.0, 4.5, 8.9],
  ["150UB18.0", 155, 75, 9.5, 6.0, 8],
  ["150UB14.0", 150, 75, 7.0, 5.0, 8],
];

const UC: [string, number, number, number, number, number][] = [
  ["310UC158", 327, 310, 25.0, 15.7, 16.5],
  ["310UC137", 321, 309, 21.7, 13.8, 16.5],
  ["310UC118", 315, 307, 18.7, 11.9, 16.5],
  ["310UC96.8", 308, 305, 15.4, 9.9, 16.5],
  ["250UC89.5", 260, 256, 17.3, 10.5, 14],
  ["250UC72.9", 254, 254, 14.2, 8.6, 14],
  ["200UC59.5", 210, 205, 14.2, 9.3, 11.4],
  ["200UC52.2", 206, 204, 12.5, 8.0, 11.4],
  ["200UC46.2", 203, 203, 11.0, 7.3, 11.4],
  ["150UC37.2", 162, 154, 11.5, 8.1, 8.9],
  ["150UC30.0", 158, 153, 9.4, 6.6, 8.9],
  ["150UC23.4", 152, 152, 6.8, 6.1, 8.9],
  ["100UC14.8", 97, 99, 7.0, 5.0, 10],
];

// PFC: designation, d, bf, tf, tw, r1.
const PFC: [string, number, number, number, number, number][] = [
  ["380PFC", 380, 100, 17.5, 10.0, 14],
  ["300PFC", 300, 90, 16.0, 8.0, 14],
  ["250PFC", 250, 90, 15.0, 8.0, 12],
  ["230PFC", 230, 75, 12.0, 6.5, 12],
  ["200PFC", 200, 75, 12.0, 6.0, 12],
  ["180PFC", 180, 75, 11.0, 6.0, 12],
  ["150PFC", 150, 75, 9.5, 6.0, 10],
  ["125PFC", 125, 65, 7.5, 4.7, 8],
  ["100PFC", 100, 50, 6.7, 4.2, 8],
  ["75PFC", 75, 40, 6.1, 3.8, 8],
];

// Equal angles: leg, nominal t, actual t, r1, r2.
const EA: [number, number, number, number, number][] = [
  [150, 16, 15.8, 13, 5], [150, 12, 11.8, 13, 5], [150, 10, 9.5, 13, 5],
  [125, 12, 11.8, 10, 5], [125, 10, 9.5, 10, 5], [125, 8, 7.8, 10, 5],
  [100, 12, 11.8, 8, 5], [100, 10, 9.5, 8, 5], [100, 8, 7.8, 8, 5], [100, 6, 6.0, 8, 5],
  [90, 10, 9.5, 8, 5], [90, 8, 7.8, 8, 5], [90, 6, 6.0, 8, 5],
  [75, 10, 9.5, 8, 5], [75, 8, 7.8, 8, 5], [75, 6, 6.0, 8, 5], [75, 5, 4.6, 8, 3],
  [65, 10, 9.5, 6, 3], [65, 8, 7.8, 6, 3], [65, 6, 6.0, 6, 3], [65, 5, 4.6, 6, 3],
  [50, 8, 7.8, 6, 3], [50, 6, 6.0, 6, 3], [50, 5, 4.6, 6, 3],
];

// Unequal angles: long leg, short leg, nominal t, actual t, r1, r2.
const UA: [number, number, number, number, number, number][] = [
  [150, 100, 12, 11.8, 10, 5], [150, 100, 10, 9.5, 10, 5],
  [150, 90, 16, 15.8, 10, 5], [150, 90, 12, 11.8, 10, 5], [150, 90, 10, 9.5, 10, 5], [150, 90, 8, 7.8, 10, 5],
  [125, 75, 12, 11.8, 8, 5], [125, 75, 10, 9.5, 8, 5], [125, 75, 8, 7.8, 8, 5], [125, 75, 6, 6.0, 8, 5],
  [100, 75, 10, 9.5, 8, 5], [100, 75, 8, 7.8, 8, 5], [100, 75, 6, 6.0, 8, 5],
  [75, 50, 8, 7.8, 6, 3], [75, 50, 6, 6.0, 6, 3], [75, 50, 5, 4.6, 6, 3],
];

const FLATS: [number, number][] = [
  [25, 3], [25, 5], [25, 6], [32, 5], [32, 6], [40, 5], [40, 6], [40, 8], [40, 10], [50, 5], [50, 6], [50, 8], [50, 10], [50, 12],
  [65, 6], [65, 10], [75, 6], [75, 8], [75, 10], [75, 12], [100, 6], [100, 8], [100, 10], [100, 12], [100, 16], [100, 20],
  [125, 10], [150, 10], [150, 12], [150, 16], [150, 20], [200, 10], [200, 12], [200, 16], [200, 20],
];
const SQUARES = [10, 12, 16, 20, 25, 32, 40, 50];
const ROUNDS = [10, 12, 16, 20, 24, 25, 30, 32, 36, 40, 50];

// Cold-formed hollow: outside size(s), wall thicknesses.
const SHS: [number, number[]][] = [
  [20, [1.6, 2.0]], [25, [1.6, 2.0, 2.5, 3.0]], [30, [1.6, 2.0]], [35, [1.6, 2.0, 2.5, 3.0]], [40, [1.6, 2.0, 2.5, 3.0, 4.0]],
  [50, [1.6, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0]], [65, [1.6, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0]], [75, [2.5, 3.0, 3.5, 4.0, 5.0, 6.0]],
  [89, [3.5, 5.0, 6.0]], [100, [3.0, 4.0, 5.0, 6.0, 9.0]], [125, [4.0, 5.0, 6.0, 9.0]], [150, [5.0, 6.0, 9.0]], [200, [5.0, 6.0, 9.0]], [250, [6.0, 9.0]],
];
const RHS: [number, number, number[]][] = [
  [50, 20, [1.6, 2.0, 2.5, 3.0]], [50, 25, [1.6, 2.0, 2.5, 3.0]], [65, 35, [2.0, 2.5, 3.0, 4.0]], [75, 25, [1.6, 2.0, 2.5]],
  [75, 50, [1.6, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0]], [100, 50, [1.6, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0]], [125, 75, [2.0, 2.5, 3.0, 4.0, 5.0, 6.0]],
  [150, 50, [2.0, 2.5, 3.0, 4.0, 5.0]], [150, 100, [4.0, 5.0, 6.0, 9.0]], [200, 100, [4.0, 5.0, 6.0, 9.0]], [250, 150, [5.0, 6.0, 9.0]],
];
const CHS: [number, number[]][] = [
  [26.9, [2.3, 2.6, 3.2]], [33.7, [2.6, 3.2, 4.0]], [42.4, [2.6, 3.2, 4.0]], [48.3, [2.9, 3.2, 4.0]], [60.3, [2.9, 3.6, 4.5]],
  [76.1, [3.2, 3.6, 4.5]], [88.9, [3.2, 4.0, 5.0, 5.5]], [101.6, [3.2, 4.0, 5.0]], [114.3, [3.6, 4.5, 5.4, 6.0]], [139.7, [5.0, 5.4]], [165.1, [5.0, 5.4]],
];
/** AS/NZS 1163 tables' outside corner radius. */
export const cornerRadius = (t: number) => (t <= 3 ? 2 * t : 2.5 * t);

// Purlins: code depth, d, flange(s), lip; thicknesses by the code's last digits.
const C_PURLIN: [number, number, number, number, number[]][] = [
  [100, 102, 51, 12.5, [10, 12, 15, 19]], [150, 152, 64, 14.5, [12, 15, 19, 24]], [200, 203, 76, 15.5, [15, 19, 24]], [250, 254, 76, 18.5, [19, 24]], [300, 300, 96, 27.5, [24, 30]],
];
const Z_PURLIN: [number, number, number, number, number, number[]][] = [
  [100, 102, 53, 49, 12.5, [10, 12, 15, 19]], [150, 152, 65, 61, 16.5, [12, 15, 19, 24]], [200, 203, 79, 74, 15.5, [15, 19, 24]], [250, 254, 79, 74, 18.5, [19, 24]], [300, 300, 100, 93, 27.5, [24, 30]],
];
const code = (d: number, t: number) => `${d / 100}${String(d % 100).padStart(2, "0")}${String(t).padStart(2, "0")}`;

const MGP: [number, number][] = [[70, 35], [70, 45], [90, 35], [90, 45], [120, 35], [120, 45], [140, 35], [140, 45], [190, 35], [190, 45], [240, 35], [240, 45], [290, 45]];
const HARDWOOD: [number, number][] = [[75, 50], [100, 50], [100, 75], [100, 100], [125, 75], [150, 50], [150, 75], [200, 50], [200, 75], [250, 50], [300, 50]];
const LVL: [number, number][] = [[95, 45], [130, 45], [150, 45], [170, 45], [200, 45], [240, 45], [300, 45], [360, 45], [400, 45], [240, 63], [300, 63], [360, 63], [400, 63]];
const POSTS = [90, 100, 125, 150];

const f1 = (x: number) => x.toFixed(1);

const FAMILIES: Family[] = [
  { id: "ub", name: "UB", group: "AS/NZS 3679.1", keys: ["d", "b", "tf", "tw", "r1"], entities: iSection, sizes: UB, tags: ["universal beam", "i-beam", "hot-rolled", "steel"], material: "steel AS/NZS 3679.1-300", density: DENSITY.steel },
  { id: "uc", name: "UC", group: "AS/NZS 3679.1", keys: ["d", "b", "tf", "tw", "r1"], entities: iSection, sizes: UC, tags: ["universal column", "h-section", "hot-rolled", "steel"], material: "steel AS/NZS 3679.1-300", density: DENSITY.steel },
  { id: "pfc", name: "PFC", group: "AS/NZS 3679.1", keys: ["d", "b", "tf", "tw", "r1"], entities: channel, sizes: PFC, tags: ["channel", "parallel flange", "hot-rolled", "steel"], material: "steel AS/NZS 3679.1-300", density: DENSITY.steel },
  {
    id: "ea", name: "EA", group: "AS/NZS 3679.1", keys: ["b1", "b2", "t", "r1", "r2"], entities: angle,
    sizes: EA.map(([b, n, t, r1, r2]) => [`${b}x${b}x${n} EA`, b, b, t, r1, r2]),
    tags: ["equal angle", "angle", "hot-rolled", "steel"], material: "steel AS/NZS 3679.1-300", density: DENSITY.steel,
  },
  {
    id: "ua", name: "UA", group: "AS/NZS 3679.1", keys: ["b1", "b2", "t", "r1", "r2"], entities: angle,
    sizes: UA.map(([b1, b2, n, t, r1, r2]) => [`${b1}x${b2}x${n} UA`, b1, b2, t, r1, r2]),
    tags: ["unequal angle", "angle", "hot-rolled", "steel"], material: "steel AS/NZS 3679.1-300", density: DENSITY.steel,
  },
  { id: "fb", name: "FB", group: "AS/NZS 3679.1", keys: ["b", "d"], entities: rect, sizes: FLATS.map(([b, t]) => [`${b}x${t} FB`, b, t]), tags: ["flat bar", "flat", "solid", "steel"], material: "steel AS/NZS 3679.1-300", density: DENSITY.steel },
  { id: "sq", name: "SQ", group: "AS/NZS 3679.1", keys: ["b", "d"], entities: rect, sizes: SQUARES.map((b) => [`${b} SQ`, b, b]), tags: ["square bar", "bar", "solid", "steel"], material: "steel AS/NZS 3679.1-300", density: DENSITY.steel },
  { id: "rnd", name: "RND", group: "AS/NZS 3679.1", keys: ["D"], entities: roundBar, sizes: ROUNDS.map((d) => [`${d} RND`, d]), tags: ["round bar", "bar", "solid", "steel"], material: "steel AS/NZS 3679.1-300", density: DENSITY.steel },
  {
    id: "shs", name: "SHS", group: "AS/NZS 1163", keys: ["b", "t", "r"], entities: shs,
    sizes: SHS.flatMap(([b, ts]) => ts.map((t): [string, ...number[]] => [`${b}x${b}x${f1(t)} SHS`, b, t, cornerRadius(t)])),
    tags: ["square hollow", "hollow", "tube", "cold-formed", "steel"], material: "steel AS/NZS 1163-C350L0", density: DENSITY.steel,
  },
  {
    id: "rhs", name: "RHS", group: "AS/NZS 1163", keys: ["d", "b", "t", "r"], entities: rhs,
    sizes: RHS.flatMap(([d, b, ts]) => ts.map((t): [string, ...number[]] => [`${d}x${b}x${f1(t)} RHS`, d, b, t, cornerRadius(t)])),
    tags: ["rectangular hollow", "hollow", "tube", "cold-formed", "steel"], material: "steel AS/NZS 1163-C350L0", density: DENSITY.steel,
  },
  {
    id: "chs", name: "CHS", group: "AS/NZS 1163", keys: ["D", "t"], entities: chs,
    sizes: CHS.flatMap(([d, ts]) => ts.map((t): [string, ...number[]] => [`${d}x${f1(t)} CHS`, d, t])),
    tags: ["circular hollow", "hollow", "pipe", "tube", "round", "cold-formed", "steel"], material: "steel AS/NZS 1163-C250L0", density: DENSITY.steel,
  },
  {
    id: "c-purlin", name: "C purlin", group: "Purlins", keys: ["d", "b", "L", "t"], entities: cPurlin,
    sizes: C_PURLIN.flatMap(([c, d, b, l, ts]) => ts.map((t): [string, ...number[]] => [`C${code(c, t)}`, d, b, l, t / 10])),
    tags: ["purlin", "girt", "lipped channel", "cold-formed", "galvanised", "steel"], material: "steel G450 Z350", density: DENSITY.steel,
  },
  {
    id: "z-purlin", name: "Z purlin", group: "Purlins", keys: ["d", "E", "F", "L", "t"], entities: zPurlin,
    sizes: Z_PURLIN.flatMap(([c, d, e, f, l, ts]) => ts.map((t): [string, ...number[]] => [`Z${code(c, t)}`, d, e, f, l, t / 10])),
    tags: ["purlin", "girt", "zed", "cold-formed", "galvanised", "steel"], material: "steel G450 Z350", density: DENSITY.steel,
  },
  { id: "mgp10", name: "MGP10", group: "Timber", keys: ["d", "b"], entities: rect, sizes: MGP.map(([d, b]) => [`${d}x${b} MGP10`, d, b]), tags: ["timber", "pine", "framing", "seasoned", "mgp10"], material: "MGP10 pine (seasoned)", density: DENSITY.mgp },
  { id: "mgp12", name: "MGP12", group: "Timber", keys: ["d", "b"], entities: rect, sizes: MGP.map(([d, b]) => [`${d}x${b} MGP12`, d, b]), tags: ["timber", "pine", "framing", "seasoned", "mgp12"], material: "MGP12 pine (seasoned)", density: DENSITY.mgp },
  { id: "f-hardwood", name: "F-grade hardwood", group: "Timber", keys: ["d", "b"], entities: rect, sizes: HARDWOOD.map(([d, b]) => [`${d}x${b} F8 HW`, d, b]), tags: ["timber", "hardwood", "sawn", "unseasoned", "f8", "f-grade"], material: "F8 hardwood (unseasoned)", density: DENSITY.hardwood },
  { id: "lvl", name: "LVL", group: "Timber", keys: ["d", "b"], entities: rect, sizes: LVL.map(([d, b]) => [`${d}x${b} LVL`, d, b]), tags: ["timber", "lvl", "engineered", "beam"], material: "LVL", density: DENSITY.lvl },
  { id: "post", name: "Treated pine post", group: "Timber", keys: ["d", "b"], entities: rect, sizes: POSTS.map((s) => [`${s}x${s} H4 post`, s, s]), tags: ["timber", "post", "treated", "h4", "pine"], material: "H4 treated pine", density: DENSITY.treatedPine },
];

const toEntry = (f: Family): LibraryEntry => {
  const sizes = f.sizes.map(([designation, ...v]) => ({ designation, values: Object.fromEntries(f.keys.map((k, i) => [k, v[i]])) }));
  const parameters = sizes[0].values;
  const def: ProfileDef = { name: `${f.name} (${f.group})`, entities: f.entities(parameters), parameters, sizes, anchor: "centroid", tags: f.tags, material: f.material, density: f.density };
  return { ...def, id: `std:${f.id}`, version: 1, favourite: false, uses: 0, updatedAt: "2026-10-18T00:00:00.000Z", group: f.group, builtin: true };
};

let cache: LibraryEntry[] | null = null;
/** Every standard family, as library entries. */
export function standardLibrary(): LibraryEntry[] {
  return (cache ??= FAMILIES.map(toEntry));
}
