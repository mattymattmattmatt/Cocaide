// Where the standard views look from, in this part's axes (Z up; Front looks
// along +Y, from −Y), and the view cube's and the triad's targets: the 26
// orientations of a cube (6 faces, 12 edges, 8 corners) and "look along this
// axis". Pure, so Vitest covers the directions.

import type { Vec3 } from "../../doc/types";

export type ViewName = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso" | "dimetric" | "trimetric";

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Trimetric: from 30° round from the front toward the right, 24° above (three axes all shortened differently). */
const TRI_AZ = (30 * Math.PI) / 180;
const TRI_EL = (24 * Math.PI) / 180;

/**
 * Where each view looks from (unit, toward the camera) and which way is up on
 * the screen. Isometric is the true one: equal angles to X, Y and Z, from the
 * front, right and above. Dimetric is the drawing-office one (X and Z full
 * size, Y half): from mostly in front, a little to the right and above.
 */
export const VIEWS: Record<ViewName, { dir: Vec3; up: Vec3 }> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  // Third-angle: the top view's bottom edge is the front, and the bottom view's top edge is.
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { dir: unit([1, -1, 1]), up: [0, 0, 1] },
  dimetric: { dir: unit([1, -Math.sqrt(7), 1]), up: [0, 0, 1] },
  trimetric: { dir: [Math.cos(TRI_EL) * Math.sin(TRI_AZ), -Math.cos(TRI_EL) * Math.cos(TRI_AZ), Math.sin(TRI_EL)], up: [0, 0, 1] },
};

export const VIEW_ORDER: ViewName[] = ["front", "back", "left", "right", "top", "bottom", "iso", "dimetric", "trimetric"];
export const VIEW_LABEL: Record<ViewName, string> = {
  front: "Front",
  back: "Back",
  left: "Left",
  right: "Right",
  top: "Top",
  bottom: "Bottom",
  iso: "Isometric",
  dimetric: "Dimetric",
  trimetric: "Trimetric",
};

/** Screen up for a view from `dir`: +Z, unless looking straight down (+Y up) or up (−Y up), as the top and bottom views do. */
export function upFor(dir: Vec3): Vec3 {
  const d = unit(dir);
  if (Math.abs(d[2]) > 0.999) return d[2] > 0 ? [0, 1, 0] : [0, -1, 0];
  return [0, 0, 1];
}

// ------------------------------------------------------------------ the view cube

export type CubeFace = "front" | "back" | "left" | "right" | "top" | "bottom";
export const CUBE_FACES: CubeFace[] = ["front", "back", "left", "right", "top", "bottom"];

/**
 * Each face of the cube in world axes: its outward normal, and its own right
 * (x) and down (y) as they read when you look straight at it in that standard
 * view (so the label reads upright there).
 */
export const CUBE_FACE_AXES: Record<CubeFace, { n: Vec3; x: Vec3; y: Vec3 }> = {
  front: { n: [0, -1, 0], x: [1, 0, 0], y: [0, 0, -1] },
  back: { n: [0, 1, 0], x: [-1, 0, 0], y: [0, 0, -1] },
  left: { n: [-1, 0, 0], x: [0, -1, 0], y: [0, 0, -1] },
  right: { n: [1, 0, 0], x: [0, 1, 0], y: [0, 0, -1] },
  top: { n: [0, 0, 1], x: [1, 0, 0], y: [0, -1, 0] },
  bottom: { n: [0, 0, -1], x: [1, 0, 0], y: [0, 1, 0] },
};

export interface CubeTarget {
  /** The direction's signs, "1,-1,1": the same corner or edge from whichever face it is clicked. */
  key: string;
  kind: "face" | "edge" | "corner";
  /** Unit, toward the camera. */
  dir: Vec3;
  up: Vec3;
  /** "Front", "Front Right", "Front Right Top". */
  label: string;
}

const SIDE_WORDS: [number, string, string][] = [
  [1, "Front", "Back"], // y: −1 is Front
  [0, "Right", "Left"], // x: +1 is Right
  [2, "Top", "Bottom"], // z: +1 is Top
];

/** The target a direction of signs (each −1, 0 or 1, not all 0) stands for. */
export function cubeTarget(signs: Vec3): CubeTarget {
  const words: string[] = [];
  for (const [axis, plus, minus] of SIDE_WORDS) {
    const s = signs[axis];
    if (s === 0) continue;
    // Front is −Y: its word is the "plus" word when y is negative.
    const positive = axis === 1 ? s < 0 : s > 0;
    words.push(positive ? plus : minus);
  }
  const count = signs.filter((s) => s !== 0).length;
  const dir = unit(signs);
  return { key: signs.join(","), kind: count === 1 ? "face" : count === 2 ? "edge" : "corner", dir, up: upFor(dir), label: words.join(" ") };
}

/**
 * The target of a cell of the 3 × 3 grid on a face (col 0–2 left to right,
 * row 0–2 top to bottom as the face reads): the middle is the face, the
 * sides its edges, the corners its corners.
 */
export function cubeCell(face: CubeFace, col: number, row: number): CubeTarget {
  const { n, x, y } = CUBE_FACE_AXES[face];
  const signs = [0, 1, 2].map((i) => Math.round(n[i] + (col - 1) * x[i] + (row - 1) * y[i])) as Vec3;
  return cubeTarget(signs);
}

/** All 26 orientations of the cube, once each. */
export function cubeTargets(): CubeTarget[] {
  const out = new Map<string, CubeTarget>();
  for (const f of CUBE_FACES) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.set(cubeCell(f, c, r).key, cubeCell(f, c, r));
  return [...out.values()];
}

// ------------------------------------------------------------------ the triad

export type Axis = "x" | "y" | "z";
const AXIS_DIR: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * A click on a triad axis: look along it with the axis pointing at you (X:
 * the right view, Y: the back, Z: the top); clicked again while already
 * looking that way, from the other side.
 */
export function triadView(axis: Axis, lookingFrom: Vec3): { dir: Vec3; up: Vec3 } {
  const a = AXIS_DIR[axis];
  const from = unit(lookingFrom);
  const already = from[0] * a[0] + from[1] * a[1] + from[2] * a[2] > 0.999;
  const dir: Vec3 = already ? [0 - a[0], 0 - a[1], 0 - a[2]] : a;
  return { dir, up: upFor(dir) };
}

/** Is `from` (unit, toward the camera) one of the standard views, to a hair? Which one. */
export function standardViewOf(from: Vec3): ViewName | null {
  const f = unit(from);
  for (const name of VIEW_ORDER) {
    const d = VIEWS[name].dir;
    if (f[0] * d[0] + f[1] * d[1] + f[2] * d[2] > 0.99999) return name;
  }
  return null;
}
