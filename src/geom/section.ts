// A weldment profile's section (Phase I): its sketch at one size, and what
// the section measures. Pure: runs in the browser, the worker and Node.
//
// The area is exact (from the profile's loops). The centroid, the envelope
// and the second moments are taken from the loops sampled finely enough that
// arcs are within a few millionths of a millimetre of their chords.

import { resolveSketch } from "../doc/commands";
import { resolveExpressions } from "../doc/parameters";
import type { ProfileDef, ProfileSize, SketchEntity, Vec2 } from "../doc/types";
import { buildProfile, sampleSeg, type Loop, type Region } from "./profile";

/** Steel, for kg/m when the part names no material. */
export const STEEL_DENSITY = 7850;

export interface SectionProps {
  /** mm² */
  area: number;
  /** In the profile's own plane: what a "centroid" anchor puts on the member line. */
  centroid: Vec2;
  /** Width along x, height along y, mm. */
  envelope: [number, number];
  min: Vec2;
  max: Vec2;
  /** Second moments of area about the centroid, mm⁴: Ix about the x axis, Iy about y. */
  ix: number;
  iy: number;
  /** Closed loops inside the outline: a tube, not a bar. */
  hollow: boolean;
  /** The outline is far from its convex hull: an angle, a channel. */
  open: boolean;
  /** Every outer loop is round. */
  round: boolean;
  regions: Region[];
}

/** A profile's size by designation; the first when none is given. */
export function profileSize(def: ProfileDef, designation?: string): ProfileSize | undefined {
  return designation === undefined ? def.sizes[0] : def.sizes.find((s) => s.designation === designation);
}

/**
 * The profile's sketch at one size: its dimensions take that size's values and
 * the sketch is solved again, so geometry drawn at 40 follows "=b" to 50.
 */
export function sizedEntities(def: ProfileDef, size: ProfileSize): { ok: true; entities: SketchEntity[] } | { ok: false; error: string } {
  const values = { ...def.parameters, ...size.values };
  const solved = resolveSketch({ id: def.name, op: "sketch", entities: def.entities, constraints: def.constraints ?? [] }, values);
  if (!solved.ok) return { ok: false, error: solved.error };
  const errors: string[] = [];
  const entities = resolveExpressions(solved.feature.entities, values, errors) as SketchEntity[];
  return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true, entities };
}

export function sectionOf(entities: SketchEntity[]): { ok: true; props: SectionProps } | { ok: false; error: string } {
  const profile = buildProfile(entities);
  if (!profile.ok) return { ok: false, error: profile.error };
  if (profile.regions.length === 0) return { ok: false, error: "the sketch has no closed profile" };
  let a = 0;
  let sx = 0;
  let sy = 0;
  let ixx = 0;
  let iyy = 0;
  const lo: Vec2 = [Infinity, Infinity];
  const hi: Vec2 = [-Infinity, -Infinity];
  let hull = 0;
  for (const region of profile.regions) {
    for (const loop of [region.outer, ...region.holes]) {
      const pts = polygon(loop);
      for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[(i + 1) % pts.length];
        const c = x0 * y1 - x1 * y0;
        a += c / 2;
        sx += ((x0 + x1) * c) / 6;
        sy += ((y0 + y1) * c) / 6;
        ixx += ((y0 * y0 + y0 * y1 + y1 * y1) * c) / 12;
        iyy += ((x0 * x0 + x0 * x1 + x1 * x1) * c) / 12;
      }
      if (loop === region.outer) {
        for (const p of pts) {
          lo[0] = Math.min(lo[0], p[0]);
          lo[1] = Math.min(lo[1], p[1]);
          hi[0] = Math.max(hi[0], p[0]);
          hi[1] = Math.max(hi[1], p[1]);
        }
        hull += hullArea(pts);
      }
    }
  }
  const cx = sx / a;
  const cy = sy / a;
  const outerArea = profile.regions.reduce((t, r) => t + r.outer.area, 0);
  return {
    ok: true,
    props: {
      area: profile.area,
      centroid: [clean(cx), clean(cy)],
      envelope: [clean(hi[0] - lo[0]), clean(hi[1] - lo[1])],
      min: [clean(lo[0]), clean(lo[1])],
      max: [clean(hi[0]), clean(hi[1])],
      ix: clean(ixx - a * cy * cy),
      iy: clean(iyy - a * cx * cx),
      hollow: profile.regions.some((r) => r.holes.length > 0),
      open: outerArea < 0.9 * hull,
      round: profile.regions.every((r) => r.outer.segs.every((s) => s.kind === "arc")),
      regions: profile.regions,
    },
  };
}

/** The section of a profile at one of its sizes. */
export function sectionAt(def: ProfileDef, designation?: string): { ok: true; props: SectionProps } | { ok: false; error: string } {
  const size = profileSize(def, designation);
  if (!size) return { ok: false, error: `${def.name} has no size "${designation}"` };
  const sized = sizedEntities(def, size);
  if (!sized.ok) return sized;
  return sectionOf(sized.entities);
}

/** kg per metre of a section, at a density in kg/m³. */
export function kgPerMetre(area: number, density = STEEL_DENSITY): number {
  return area * 1e-6 * density;
}

/** Tags the geometry suggests: what kind of section, its shape and its envelope. */
export function suggestTags(p: SectionProps): string[] {
  const tags: string[] = [];
  tags.push(p.hollow ? "hollow" : p.open ? "open" : "solid");
  const [w, h] = p.envelope;
  if (p.round) tags.push("round");
  else if (!p.open && Math.abs(w - h) <= 1e-6 * Math.max(w, h)) tags.push("square");
  else if (!p.open) tags.push("rectangular");
  tags.push(`${fmt(w)}x${fmt(h)}`);
  return tags;
}

/** The outer boundary of a section, sampled finely: every point its envelope or support can reach. */
export function sectionOutline(p: SectionProps): Vec2[] {
  return p.regions.flatMap((r) => polygon(r.outer));
}

function polygon(loop: Loop): Vec2[] {
  const pts: Vec2[] = [];
  for (const s of loop.segs) {
    const run = sampleSeg(s, Math.PI / 720);
    pts.push(...run.slice(0, -1));
  }
  return pts;
}

/** Area of the convex hull of some points (monotone chain). */
function hullArea(points: Vec2[]): number {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return 0;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let a = 0;
  for (let i = 0; i < hull.length; i++) a += hull[i][0] * hull[(i + 1) % hull.length][1] - hull[(i + 1) % hull.length][0] * hull[i][1];
  return Math.abs(a) / 2;
}

function clean(x: number): number {
  const r = Math.round(x * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

function fmt(x: number): string {
  return String(Math.round(x * 100) / 100);
}
