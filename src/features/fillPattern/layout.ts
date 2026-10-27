// Where a fill pattern's copies go, pure: a layout of places (a square grid,
// a staggered one, or rings) through the seed, in the plane of the region it
// fills, kept where the seed's footprint moved there lies wholly inside the
// region, at least `margin` from its boundary (its outer edge and any holes).
// The kernel and the editor both use it: the kernel with the face's exact
// edges, the editor with the view's, so they agree on the instance numbers.
//
// Instances are numbered 1 (the seed), then the kept places in order: a grid
// row by row (along its second direction, then along the first), rings from
// the seed outwards, each ring counter-clockwise from the layout's angle.

import type { Vec2, Vec3 } from "../../doc/types";

export const FILL_LAYOUTS = ["square", "staggered", "circular"] as const;
export type FillLayout = (typeof FILL_LAYOUTS)[number];

export interface FillSpec {
  layout: FillLayout;
  /** Between neighbours along a row (circular: along a ring, about). */
  spacing: number;
  /** Between rows (circular: between rings). Default `spacing` (staggered: spacing × √3/2, so neighbours are equally far). */
  spacing2?: number;
  /** The layout turned this many degrees about the seed, from the plane's x axis. */
  angle?: number;
  /** Copies keep at least this far (mm) from the region's boundary. Default 0. */
  margin?: number;
}

/** The most copies a fill pattern makes. */
export const MAX_FILL_COPIES = 2000;
/** The most places it looks at before keeping those inside. */
const MAX_CANDIDATES = 200_000;

/** The places to look at, in instance order, without the seed's own. */
function candidates(spec: FillSpec, seed: Vec2, reach: number): Vec2[] | string {
  const a = ((spec.angle ?? 0) * Math.PI) / 180;
  const u: Vec2 = [Math.cos(a), Math.sin(a)];
  const v: Vec2 = [-u[1], u[0]];
  const at = (x: number, y: number): Vec2 => [seed[0] + x * u[0] + y * v[0], seed[1] + x * u[1] + y * v[1]];
  const out: Vec2[] = [];
  if (spec.layout === "circular") {
    const ring = spec.spacing2 ?? spec.spacing;
    const rings = Math.ceil(reach / ring);
    for (let k = 1; k <= rings; k++) {
      const r = k * ring;
      const n = Math.max(1, Math.floor((2 * Math.PI * r) / spec.spacing + 1e-9));
      if (out.length + n > MAX_CANDIDATES) return `the rings are too close for the region (more than ${MAX_CANDIDATES} places to look at): make the spacing larger`;
      for (let m = 0; m < n; m++) {
        const t = (2 * Math.PI * m) / n;
        out.push(at(r * Math.cos(t), r * Math.sin(t)));
      }
    }
    return out;
  }
  const sx = spec.spacing;
  const sy = spec.spacing2 ?? (spec.layout === "staggered" ? (spec.spacing * Math.sqrt(3)) / 2 : spec.spacing);
  const I = Math.ceil(reach / sx) + 1;
  const J = Math.ceil(reach / sy);
  if ((2 * I + 1) * (2 * J + 1) > MAX_CANDIDATES) return `the spacing is too small for the region (more than ${MAX_CANDIDATES} places to look at): make it larger`;
  for (let j = -J; j <= J; j++) {
    const shift = spec.layout === "staggered" && Math.abs(j) % 2 === 1 ? sx / 2 : 0;
    for (let i = -I; i <= I; i++) {
      const x = i * sx + shift;
      if (j === 0 && Math.abs(x) < 1e-12) continue; // the seed's own place
      out.push(at(x, j * sy));
    }
  }
  return out;
}

/** Polylines' pieces, as segments [a, b]. */
function segmentsOf(lines: readonly Vec2[][]): [Vec2, Vec2][] {
  // Polylines' ends within a hair of each other are made one point, so the loops they make are closed exactly
  // (a mesh's single-precision polyline next to an exact line, a circle's end a rounding away from its start).
  const ends: Vec2[] = [];
  const snap = (p: Vec2): Vec2 => ends.find((q) => Math.abs(q[0] - p[0]) < 1e-4 && Math.abs(q[1] - p[1]) < 1e-4) ?? (ends.push(p), p);
  const out: [Vec2, Vec2][] = [];
  for (const raw of lines) {
    if (raw.length < 2) continue;
    const line = [snap(raw[0]), ...raw.slice(1, -1), snap(raw[raw.length - 1])];
    for (let i = 0; i + 1 < line.length; i++) out.push([line[i], line[i + 1]]);
  }
  return out;
}

/** Inside the boundary by the even-odd rule (a hole's inside is outside). */
function inside(p: Vec2, segs: readonly [Vec2, Vec2][]): boolean {
  let n = 0;
  for (const [a, b] of segs) {
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x > p[0]) n++;
    }
  }
  return n % 2 === 1;
}

function pointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Do segments ab and cd cross or touch? */
function crosses(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** The least distance between two segments (0 when they cross). */
function segmentSegment(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (crosses(a, b, c, d)) return 0;
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
}

/**
 * Does the footprint (a closed polygon about the origin) moved to `p` lie
 * inside the region, at least `margin` from every piece of its boundary?
 */
export function footprintFits(p: Vec2, footprint: readonly Vec2[], segs: readonly [Vec2, Vec2][], margin: number): boolean {
  const poly = footprint.map((q): Vec2 => [q[0] + p[0], q[1] + p[1]]);
  if (!inside(p, segs) || !poly.every((q) => inside(q, segs))) return false;
  const lo: Vec2 = [Math.min(...poly.map((q) => q[0])) - margin, Math.min(...poly.map((q) => q[1])) - margin];
  const hi: Vec2 = [Math.max(...poly.map((q) => q[0])) + margin, Math.max(...poly.map((q) => q[1])) + margin];
  const near = segs.filter(([a, b]) => !(Math.max(a[0], b[0]) < lo[0] || Math.min(a[0], b[0]) > hi[0] || Math.max(a[1], b[1]) < lo[1] || Math.min(a[1], b[1]) > hi[1]));
  const n = poly.length;
  for (const [a, b] of near) {
    for (let i = 0; i < n; i++) {
      // A margin of 0 still needs the footprint clear of the boundary (an island of the region inside it, a hole's edge across it).
      if (segmentSegment(poly[i], poly[(i + 1) % n], a, b) < Math.max(margin, 1e-9)) return false;
    }
    // A boundary piece wholly inside the footprint (a small hole under it) touches none of its sides.
    if (n >= 3 && inside(a, poly.map((q, i) => [q, poly[(i + 1) % n]] as [Vec2, Vec2]))) return false;
  }
  return true;
}

/**
 * The places a fill pattern copies its seed to, in instance order (instance
 * k + 2 is at places[k]): the layout through `seed`, each place kept where
 * the footprint fits (footprintFits). `boundary`: polylines that together
 * make the region's closed loops (its edges, one polyline each, or whole
 * loops ending where they start), in any order. A string says
 * what is wrong (nothing fits, too many copies).
 */
export function fillPlaces(spec: FillSpec, seed: Vec2, footprint: readonly Vec2[], boundary: readonly Vec2[][]): Vec2[] | string {
  if (!(spec.spacing > 0)) return "the spacing must be more than 0";
  if (spec.spacing2 !== undefined && !(spec.spacing2 > 0)) return "the second spacing must be more than 0";
  const segs = segmentsOf(boundary);
  if (segs.length < 3) return "the region has no boundary to fill inside";
  const pts = boundary.flat();
  const reach = Math.max(...pts.map((p) => Math.hypot(p[0] - seed[0], p[1] - seed[1])));
  const list = candidates(spec, seed, reach);
  if (typeof list === "string") return list;
  const margin = spec.margin ?? 0;
  const out = list.filter((p) => footprintFits(p, footprint, segs, margin));
  if (out.length > MAX_FILL_COPIES) return `${out.length} copies is more than ${MAX_FILL_COPIES}: make the spacing larger`;
  return out;
}

/** A round footprint of radius r (a hole), as a polygon just outside the circle, so a fit is never too close. */
export function roundFootprint(r: number, sides = 24): Vec2[] {
  const R = r / Math.cos(Math.PI / sides);
  return Array.from({ length: sides }, (_, i) => [R * Math.cos((2 * Math.PI * i) / sides), R * Math.sin((2 * Math.PI * i) / sides)] as Vec2);
}

/** A box footprint from its corners relative to the seed. */
export function boxFootprint(min: Vec2, max: Vec2): Vec2[] {
  return [min, [max[0], min[1]], max, [min[0], max[1]]];
}

/** What an edge of the region needs to be drawn as a polyline: the fields of EdgeInfo (src/kernel/topology.ts) it reads. */
export interface BoundaryEdge {
  kind: "line" | "circle" | "other";
  start: Vec3;
  end: Vec3;
  length: number;
  center?: Vec3;
  radius?: number;
  axis?: Vec3;
}

/**
 * An edge as a polyline in 3D: a line its ends, a circle or arc sampled about
 * its centre (counter-clockwise about its axis from its start, as OCCT runs
 * it) every `step` radians, anything else the polyline given (from the mesh,
 * or sampled in the kernel).
 */
export function edgePolyline(e: BoundaryEdge, other: Vec3[] | null, step = Math.PI / 90): Vec3[] {
  if (e.kind === "line") return [e.start, e.end];
  if (e.kind === "circle" && e.center && e.axis && e.radius) {
    const c = e.center;
    const n = norm(e.axis);
    const s0: Vec3 = [e.start[0] - c[0], e.start[1] - c[1], e.start[2] - c[2]];
    const w: Vec3 = [n[1] * s0[2] - n[2] * s0[1], n[2] * s0[0] - n[0] * s0[2], n[0] * s0[1] - n[1] * s0[0]];
    const closed = Math.hypot(e.start[0] - e.end[0], e.start[1] - e.end[1], e.start[2] - e.end[2]) < 1e-7 * Math.max(1, e.radius) && e.length > Math.PI * e.radius;
    const sweep = closed ? 2 * Math.PI : e.length / e.radius;
    const k = Math.max(4, Math.ceil(sweep / step));
    // The ends exactly the edge's own, so neighbouring edges (and a whole circle's ends) meet exactly: the inside test counts on it.
    return Array.from({ length: k + 1 }, (_, i) => {
      if (i === 0) return e.start;
      if (i === k) return closed ? e.start : e.end;
      const t = (sweep * i) / k;
      return [c[0] + Math.cos(t) * s0[0] + Math.sin(t) * w[0], c[1] + Math.cos(t) * s0[1] + Math.sin(t) * w[1], c[2] + Math.cos(t) * s0[2] + Math.sin(t) * w[2]] as Vec3;
    });
  }
  return other ?? [e.start, e.end];
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
