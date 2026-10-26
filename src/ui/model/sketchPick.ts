// Another sketch's entity picked in the 3D view, for a feature session's
// reference field (Phase P wave 2, with wave 2A's { sketch, entity, at? }
// references): the sketches the view draws are hit on screen (their lines,
// arcs, circles and points; near an end, a middle or a centre, that point),
// and the hit becomes the reference the field takes, where its kind fits: a
// line is an axis, an arc or a circle its axis or its centre, an end or a
// middle a point. Pure: Vitest checks it with a plain projection.

import type { EdgePoint, SketchEntity, SketchEntityRef, Vec2, Vec3 } from "../../doc/types";
import { SKETCH_REF_POINTS, sketchRefKinds, sketchRefText, type DatumKind } from "../../features/datum";
import { to3D, type Frame } from "../../geom/frame";
import { entityPolylines } from "../../geom/profile";

/** A drawn sketch, as the rebuild sends it: its solved entities on its frame. */
export interface PickableSketch {
  id: string;
  ok: boolean;
  entities: SketchEntity[];
  frame: Frame;
}

/** An entity of a sketch under the pointer. */
export interface SketchEntityHit {
  sketch: string;
  entity: string;
  type: string;
  /** The point of it the pointer is on (an end, the middle, the centre), if any. */
  at?: EdgePoint;
  /** Where, in 3D. */
  point: Vec3;
  /** How far from the pointer, pixels. */
  px: number;
}

/** Pixels from an entity that still hit it, and from one of its points that hit the point. */
export const SKETCH_PICK_PX = 7;
export const SKETCH_POINT_PX = 9;

const TYPES = new Set(["line", "arc", "circle", "point"]);

/** The named points of an entity (its ends, middle, centre), in the sketch. */
function namedPoints(e: SketchEntity, polyline: Vec2[]): [EdgePoint, Vec2][] {
  const allowed = SKETCH_REF_POINTS[e.type] ?? [];
  const out: [EdgePoint, Vec2][] = [];
  const add = (at: EdgePoint, p: Vec2 | undefined) => p && allowed.includes(at) && out.push([at, p]);
  if (e.type === "line") {
    add("start", e.start);
    add("end", e.end);
    add("mid", [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]);
  } else if (e.type === "arc") {
    add("start", e.start);
    add("end", e.end);
    add("center", e.center);
    add("mid", polyline[Math.floor(polyline.length / 2)]);
  } else if (e.type === "circle") {
    add("center", e.center);
  }
  return out;
}

/** The distance from p to the segment a–b (screen pixels). */
function toSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * The sketch entity nearest the pointer at (x, y) on screen, within
 * SKETCH_PICK_PX; a point of one within SKETCH_POINT_PX (an end, the middle,
 * a centre, a sketch point) wins as that point. Null: none. `project`: 3D to screen pixels (null behind the camera).
 */
export function sketchEntityAt(sketches: readonly PickableSketch[], project: (p: Vec3) => [number, number] | null, x: number, y: number): SketchEntityHit | null {
  const at: [number, number] = [x, y];
  // A point (an end, a middle, a centre, a sketch point) near the pointer wins over the curves through it, as snapping does.
  let point: SketchEntityHit | null = null;
  let curve: SketchEntityHit | null = null;
  const consider = (hit: SketchEntityHit) => {
    const isPoint = !!hit.at || hit.type === "point";
    const best = isPoint ? point : curve;
    if (best && best.px <= hit.px) return;
    if (isPoint) point = hit;
    else curve = hit;
  };
  for (const s of sketches) {
    if (!s.ok) continue;
    for (const e of s.entities) {
      if (!TYPES.has(e.type)) continue;
      const base = { sketch: s.id, entity: e.id, type: e.type };
      if (e.type === "point") {
        const p3 = to3D(s.frame, e.at);
        const q = project(p3);
        const d = q ? Math.hypot(q[0] - x, q[1] - y) : Infinity;
        if (d <= SKETCH_POINT_PX) consider({ ...base, point: p3, px: d });
        continue;
      }
      const lines = entityPolylines(e);
      const poly = lines[0] ?? [];
      for (const [name, p] of namedPoints(e, poly)) {
        const p3 = to3D(s.frame, p);
        const q = project(p3);
        const d = q ? Math.hypot(q[0] - x, q[1] - y) : Infinity;
        if (d <= SKETCH_POINT_PX) consider({ ...base, at: name, point: p3, px: d });
      }
      for (const line of lines) {
        const pts = line.map((p) => to3D(s.frame, p));
        const scr = pts.map(project);
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = scr[i];
          const b = scr[i + 1];
          if (!a || !b) continue;
          const d = toSegment(at, a, b);
          if (d <= SKETCH_PICK_PX) consider({ ...base, point: pts[i], px: d });
        }
      }
    }
  }
  return point ?? curve;
}

/**
 * The reference a field that accepts these kinds takes from a hit: the
 * entity itself where its kind fits (a line as an axis, an arc or a circle
 * as its axis, or its centre as a point), else the point of it the pointer
 * is on; or what is wrong.
 */
export function sketchRefFor(hit: SketchEntityHit, accepts: readonly DatumKind[]): SketchEntityRef | string {
  const ref = (at?: EdgePoint): SketchEntityRef => ({ sketch: hit.sketch, entity: hit.entity, ...(at ? { at } : {}) });
  if (hit.at && accepts.includes("point") && sketchRefKinds(hit.type, hit.at).includes("point")) return ref(hit.at);
  const whole = sketchRefKinds(hit.type);
  if (accepts.some((k) => whole.includes(k))) return ref();
  if (accepts.includes("point") && hit.type === "line") return ref("mid");
  const what = sketchRefText(ref());
  return whole.length ? `${what} is ${kinds(whole)}, but ${kinds(accepts)} is needed here` : `${what} can't be a reference: only lines, arcs, circles and points can`;
}

/** "an axis or a point". */
const kinds = (list: readonly DatumKind[]) => list.map((k) => (k === "axis" ? "an axis" : `a ${k}`)).join(" or ");
