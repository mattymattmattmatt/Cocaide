// A 3D sketch: points in space and straight lines between them, for a frame
// that isn't flat (a pitched roof, splayed legs). A point is at coordinates,
// or `by` [dx, dy, dz] from an earlier point, so moving one point moves every
// point measured from it: each offset is a dimension, and any of its numbers
// may be an =expression. Lines name their two points, so lines that meet
// share a point and stay together. Pure: validation, the kernel's overlay,
// nodes that follow the sketch and the viewport's drawing all read it.

import type { Vec3 } from "../doc/types";

export interface Sketch3dPoint {
  id: string;
  /** Where it is. */
  at?: Vec3;
  /** Or measured from an earlier point: `by` from `from`. */
  from?: string;
  by?: Vec3;
}

export interface Sketch3dLine {
  id: string;
  start: string;
  end: string;
  /** Kept for the layout, never a member's line. */
  construction?: boolean;
}

export interface Sketch3d {
  points: Sketch3dPoint[];
  lines: Sketch3dLine[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

export type Placed = { ok: true; at: Map<string, Vec3> } | { ok: false; path: string; error: string };

/** Where every point is, in list order (a point is measured from an earlier one); or the first thing wrong. */
export function sketch3dPositions(points: readonly unknown[]): Placed {
  const at = new Map<string, Vec3>();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const path = `points[${i}]`;
    if (!isObject(p) || typeof p.id !== "string" || !p.id) return { ok: false, path, error: 'must be { "id", "at": [x, y, z] } or { "id", "from": <earlier point>, "by": [dx, dy, dz] }' };
    if (at.has(p.id)) return { ok: false, path: `${path}.id`, error: `duplicate point id "${p.id}"` };
    if (p.from !== undefined) {
      if (typeof p.from !== "string" || !at.has(p.from)) return { ok: false, path: `${path}.from`, error: `must name an earlier point (got ${JSON.stringify(p.from)}${at.size ? `; earlier: ${[...at.keys()].join(", ")}` : "; it is the first point, so give it \"at\""})` };
      if (!isVec3(p.by)) return { ok: false, path: `${path}.by`, error: "must be [dx, dy, dz], numbers or =expressions" };
      const o = at.get(p.from)!;
      at.set(p.id, [o[0] + p.by[0], o[1] + p.by[1], o[2] + p.by[2]].map(clean) as Vec3);
    } else {
      if (!isVec3(p.at)) return { ok: false, path: `${path}.at`, error: "must be [x, y, z], numbers or =expressions (or measure it from another point with from and by)" };
      at.set(p.id, p.at.map(clean) as Vec3);
    }
  }
  return { ok: true, at };
}

/** Rounding noise off (1e-9 mm), and -0 as 0. */
const clean = (x: number) => Math.round(x * 1e9) / 1e9 + 0;

/** Each line's two ends, in 3D (lines whose points aren't there are left out). */
export function sketch3dSegments(s: { points?: unknown; lines?: unknown }): { id: string; a: Vec3; b: Vec3; construction: boolean }[] {
  const placed = sketch3dPositions(Array.isArray(s.points) ? s.points : []);
  const at = placed.ok ? placed.at : new Map<string, Vec3>();
  return (Array.isArray(s.lines) ? s.lines : []).flatMap((l) => {
    if (!isObject(l)) return [];
    const a = at.get(String(l.start));
    const b = at.get(String(l.end));
    return a && b ? [{ id: String(l.id), a, b, construction: l.construction === true }] : [];
  });
}

/** The point a link names: "p1.at" (a point), or "l1.start", "l1.end", "l1.mid" (a line's). */
export function sketch3dPoint(s: { points?: unknown; lines?: unknown }, ref: string): Vec3 | string {
  const placed = sketch3dPositions(Array.isArray(s.points) ? s.points : []);
  if (!placed.ok) return `its ${placed.path} ${placed.error}`;
  const [id, which] = ref.split(".");
  const p = placed.at.get(id);
  if (p) return which === "at" ? p : `a point is "${id}.at", not "${ref}"`;
  const line = (Array.isArray(s.lines) ? s.lines : []).find((l) => isObject(l) && l.id === id) as Record<string, unknown> | undefined;
  if (!line) return `it has no ${id} any more: link it to another point or give it coordinates`;
  const a = placed.at.get(String(line.start));
  const b = placed.at.get(String(line.end));
  if (!a || !b) return `${id}'s points aren't there`;
  if (which === "start") return a;
  if (which === "end") return b;
  if (which === "mid") return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2].map(clean) as Vec3;
  return `a line has "start", "end" and "mid", not "${which}"`;
}

/** The next free id with this prefix: p1, p2, ... */
export function nextSketch3dId(taken: Iterable<string>, prefix: string): string {
  const used = new Set(taken);
  for (let k = 1; ; k++) if (!used.has(`${prefix}${k}`)) return `${prefix}${k}`;
}
