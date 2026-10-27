// Smart defaults that read the part (Phase P wave 2): a new feature starts
// with numbers that suit what it is made on, rounded to values a person would
// type. A fillet's radius is about a tenth of the narrowest face beside the
// edges picked (a chamfer's distance likewise), a shell's wall a tenth of the
// part's thinnest extent, a hole the largest M3–M12 size that sits on its face
// with a margin, a pattern's spacing half as much again as the seed is wide.
// The last value used for a tool in this browser wins when it still suits the
// part (src/ui/model/toolMemory.ts). Pure: Vitest checks the rules on known parts.

import type { Vec3 } from "../../doc/types";
import { ISO_METRIC } from "../../features/hole/standards";
import { cross3, dot3, len3, normalize3, sub3 } from "../../geom/vec";
import { normalAt, tangentAt, type PartTopology } from "./smartSelect";

/** The round numbers a default is taken from, per decade: 1, 2, 3, 5. */
const NICE = [1, 2, 3, 5];

/** The largest round value (…, 0.5, 1, 2, 3, 5, 10, 20 …) not over `x` (and not under 0.1). */
export function niceValue(x: number): number {
  if (!Number.isFinite(x) || x <= 0.1) return 0.1;
  const decade = 10 ** Math.floor(Math.log10(x));
  let best = 0.1;
  for (const d of [decade / 10, decade, decade * 10]) for (const n of NICE) if (n * d <= x * (1 + 1e-9)) best = Math.max(best, n * d);
  return Math.round(best * 1e6) / 1e6;
}

/** The points of a face: its mesh's vertices (empty without a mesh). */
function facePoints(t: PartTopology, face: number): Vec3[] {
  const range = t.mesh?.faceRanges[face];
  if (!t.mesh || !range) return [];
  const { positions, indices } = t.mesh;
  const out: Vec3[] = [];
  for (let k = range.start; k < range.start + range.count; k++) {
    const v = indices[k];
    out.push([positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
  }
  return out;
}

/**
 * How wide a face is across an edge of it: from the edge, square to it, in
 * the face, as far as the face goes (the most a fillet there could take).
 * Without a mesh, the side of a square of the face's area.
 */
export function widthAcross(t: PartTopology, face: number, edge: number): number {
  const e = t.edges[edge];
  const f = t.faces[face];
  if (!e || !f) return Infinity;
  const along = tangentAt(t, edge, e.mid);
  const n = normalAt(t, face, e.mid);
  const pts = facePoints(t, face);
  if (!along || !n || !pts.length) return Math.sqrt(f.area);
  const u = cross3(n, along);
  if (len3(u) < 1e-12) return Math.sqrt(f.area);
  const dir = normalize3(u);
  const s = pts.map((p) => dot3(sub3(p, e.mid), dir));
  return Math.max(...s) - Math.min(...s);
}

/** The narrowest face beside these edges (across each edge), mm; Infinity when none is known. */
export function narrowestBeside(t: PartTopology, edges: readonly number[]): number {
  let least = Infinity;
  for (const i of edges) for (const f of t.edges[i]?.faces ?? []) least = Math.min(least, widthAcross(t, f, i));
  return least;
}

/** A new fillet's radius on these edges: about a tenth of the narrowest face beside them, rounded down to a round value. */
export function filletRadiusFor(t: PartTopology, edges: readonly number[], fallback = 1): number {
  const w = narrowestBeside(t, edges);
  return Number.isFinite(w) && w > 0 ? niceValue(w / 10) : fallback;
}

/** The most a remembered radius or distance may be on these edges and still suit them: four tenths of the narrowest face. */
export function edgeLimit(t: PartTopology, edges: readonly number[]): number {
  const w = narrowestBeside(t, edges);
  return Number.isFinite(w) ? 0.4 * w : Infinity;
}

/** A new chamfer's distance: as a fillet's radius. */
export const chamferDistanceFor = filletRadiusFor;

/** A part's box, as the rebuild measures it. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

/** A new shell's wall: about a tenth of the part's thinnest extent, rounded down to a round value. */
export function shellThicknessFor(box: Box | null | undefined, fallback = 2): number {
  if (!box) return fallback;
  const least = Math.min(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  return least > 0 ? niceValue(least / 10) : fallback;
}

/** The most a remembered wall may be on this part: a third of its thinnest extent. */
export function shellLimit(box: Box | null | undefined): number {
  if (!box) return Infinity;
  return Math.min(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 3;
}

/** The sizes a new hole is chosen from. */
export const HOLE_DEFAULT_SIZES = ["M3", "M4", "M5", "M6", "M8", "M10", "M12"];

/**
 * A new hole's size on a face this wide (its narrowest width, mm): the
 * largest of M3–M12 whose counterbore fits with half a counterbore of margin
 * each side (twice its diameter); M3 when none does.
 */
export function holeSizeFor(width: number): string {
  let best = "M3";
  for (const s of ISO_METRIC) if (HOLE_DEFAULT_SIZES.includes(s.size) && 2 * s.counterbore.diameter <= width) best = s.size;
  return best;
}

/** The narrowest width of a flat face (its smaller in-plane extent), from its mesh; the side of a square of its area without one. */
export function faceWidth(t: PartTopology, face: number): number {
  const f = t.faces[face];
  if (!f) return 0;
  const pts = facePoints(t, face);
  if (!pts.length || f.type !== "plane" || !f.normal) return Math.sqrt(f.area);
  const n = f.normal;
  const a = normalize3(Math.abs(n[2]) < 0.9 ? cross3(n, [0, 0, 1]) : cross3(n, [1, 0, 0]));
  const b = cross3(n, a);
  // The narrowest of a few directions round the face (its box, turned in steps of 15°).
  let least = Infinity;
  for (let k = 0; k < 12; k++) {
    const t0 = (k * Math.PI) / 12;
    const d: Vec3 = [a[0] * Math.cos(t0) + b[0] * Math.sin(t0), a[1] * Math.cos(t0) + b[1] * Math.sin(t0), a[2] * Math.cos(t0) + b[2] * Math.sin(t0)];
    const s = pts.map((p) => dot3(p, d));
    least = Math.min(least, Math.max(...s) - Math.min(...s));
  }
  return least;
}

/** A new pattern's spacing for a seed this wide along the pattern (mm): half as much again, rounded up to a whole millimetre. */
export function patternSpacingFor(seedWidth: number, fallback = 10): number {
  if (!Number.isFinite(seedWidth) || seedWidth <= 0) return fallback;
  return Math.max(1, Math.ceil(seedWidth * 1.5 - 1e-9));
}

/** How wide a set of points is along a direction (mm). */
export function widthAlong(points: readonly Vec3[], dir: Vec3): number {
  if (!points.length) return 0;
  const d = normalize3(dir);
  const s = points.map((p) => dot3(p, d));
  return Math.max(...s) - Math.min(...s);
}

/** A draft feature's angle, and an extrude's draft when it is ticked on (degrees). */
export const DRAFT_ANGLE = 1;
export const EXTRUDE_DRAFT_ANGLE = 2;

/** Does a remembered value suit the part: a number over 0 and not over the limit? */
export function suits(value: unknown, limit = Infinity): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= limit;
}
