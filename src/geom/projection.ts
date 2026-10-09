// Model geometry projected into a sketch plane (DESIGN §2.4): what a sketch's
// reference entity is, and what the sketcher draws, snaps to and offers for
// relations. A straight edge projects to a segment; a circular edge whose
// axis is along the sketch normal to a circle or an arc about its projected
// centre; a circular edge seen edge-on to a segment; a tilted circle would be
// an ellipse and a freeform edge a curve, which a sketch can't reference yet.
// An axis projects to a long segment through where it crosses the plane's
// view, a point to a point.
//
// Pure: the rebuild uses it on the edges it selects, the sketcher on the
// edges of the view, so both draw the same thing.

import type { SketchEntity, Vec2, Vec3 } from "../doc/types";
import { to2D, type Frame } from "./frame";
import { cross3, dist3, dot3, len3, normalize3, scale3, sub3 } from "./vec";

/** What a projection needs of a model edge: the fields of EdgeInfo (src/kernel/topology.ts) it reads. */
export interface EdgeGeometry {
  kind: "line" | "circle" | "other";
  start: Vec3;
  end: Vec3;
  mid: Vec3;
  length: number;
  direction?: Vec3;
  radius?: number;
  center?: Vec3;
  axis?: Vec3;
}

/** A model edge in the sketch plane: entity numbers (no id) the sketch can hold. */
export type ProjectedShape =
  | { type: "line"; start: Vec2; end: Vec2 }
  | { type: "circle"; center: Vec2; radius: number }
  | { type: "arc"; center: Vec2; start: Vec2; end: Vec2; clockwise?: boolean };

export type Projection<T> = { ok: true; shape: T } | { ok: false; error: string };

/** Within this of 1 (or 0), a circle's axis counts as along (or square to) the sketch normal. */
const PARALLEL = 1e-9;
/** Shorter than this (mm) once projected, an edge is seen end-on: a point. */
const POINT = 1e-7;

/** What a sketch can reference, said once for every refusal. */
export const REFERENCEABLE =
  "a sketch can reference straight edges, circular edges facing the sketch (or seen edge-on, as lines), axes, and points of edges (their ends, middles and centres)";

/** A model edge projected into the sketch plane. */
export function projectEdge(edge: EdgeGeometry, frame: Frame): Projection<ProjectedShape> {
  if (edge.kind === "line") {
    const start = to2D(frame, edge.start);
    const end = to2D(frame, edge.end);
    if (dist2(start, end) < POINT) return { ok: false, error: `the straight edge is square to the sketch plane, so it projects to a point; reference one of its ends with a point (at "start" or "end") instead` };
    return { ok: true, shape: { type: "line", start, end } };
  }
  if (edge.kind === "circle" && edge.center && edge.axis && edge.radius) {
    const axis = normalize3(edge.axis);
    const along = dot3(axis, frame.z);
    const center = to2D(frame, edge.center);
    const full = isFullCircle(edge);
    if (Math.abs(along) > 1 - PARALLEL) {
      if (full) return { ok: true, shape: { type: "circle", center, radius: edge.radius } };
      // OCCT runs a circle counter-clockwise about its axis from its first parameter to its last.
      return { ok: true, shape: { type: "arc", center, start: to2D(frame, edge.start), end: to2D(frame, edge.end), ...(along < 0 ? { clockwise: true } : {}) } };
    }
    if (Math.abs(along) < PARALLEL) {
      const [lo, hi] = edgeOnSpan(edge, axis, frame);
      const w = edgeOnDirection(axis, frame);
      const at = (t: number): Vec2 => to2D(frame, add(edge.center!, scale3(w, t)));
      if (hi - lo < POINT) return { ok: false, error: "the circular edge is seen edge-on and end-on: it projects to a point" };
      return { ok: true, shape: { type: "line", start: at(lo), end: at(hi) } };
    }
    return {
      ok: false,
      error: `the circular edge (radius ${round(edge.radius)}) is tilted to the sketch plane, so it would project to an ellipse; ${REFERENCEABLE}`,
    };
  }
  return { ok: false, error: `the edge is ${edge.kind === "circle" ? "a circle without a centre" : "a freeform curve (an ellipse or a spline)"}, which a sketch can't reference; ${REFERENCEABLE}` };
}

/** An axis (a point on it and its direction) as a segment in the sketch, `half` mm each way from the point of it nearest the sketch origin. */
export function projectAxis(origin: Vec3, direction: Vec3, frame: Frame, half: number): Projection<Extract<ProjectedShape, { type: "line" }>> {
  const o = to2D(frame, origin);
  const tip = to2D(frame, add(origin, normalize3(direction)));
  const d: Vec2 = [tip[0] - o[0], tip[1] - o[1]];
  const l = Math.hypot(d[0], d[1]);
  if (l < 1e-9) return { ok: false, error: "the axis is square to the sketch plane, so it projects to a point; reference it with a point, or pick an axis that lies along the sketch" };
  const u: Vec2 = [d[0] / l, d[1] / l];
  // The foot of the sketch origin on the projected axis: the segment is centred where the axis passes nearest it.
  const t = -(o[0] * u[0] + o[1] * u[1]);
  const c: Vec2 = [o[0] + t * u[0], o[1] + t * u[1]];
  return { ok: true, shape: { type: "line", start: [c[0] - half * u[0], c[1] - half * u[1]], end: [c[0] + half * u[0], c[1] + half * u[1]] } };
}

/** A model point in the sketch plane. */
export function projectPoint(p: Vec3, frame: Frame): Vec2 {
  return to2D(frame, p);
}

/** An edge's point: its ends, the middle of its length, or a circle's centre. */
export function edgePointOf(edge: EdgeGeometry, at: "start" | "end" | "mid" | "center"): Vec3 | string {
  if (at === "start") return edge.start;
  if (at === "end") return edge.end;
  if (at === "mid") return edge.mid;
  if (edge.kind === "circle" && edge.center) return edge.center;
  return `"center" is a circular edge's centre, but this edge is ${edge.kind === "line" ? 'straight; use "mid" for its middle' : "not circular"}`;
}

/**
 * The entity with the numbers of the projection of what it references, or
 * why the projection is not that kind of entity (a circle referencing an arc,
 * a line a circle). `name` names the entity in the message.
 */
export function withProjection<E extends SketchEntity>(e: E, shape: ProjectedShape, name: string): E | string {
  if (shape.type !== e.type) {
    const what = shape.type === "line" ? "a line (a straight edge, or a circle seen edge-on)" : shape.type === "circle" ? "a whole circle" : "an arc (part of a circle)";
    return `${name} is ${e.type === "arc" ? "an" : "a"} ${e.type}, but what it references projects to ${what}; reference it with ${shape.type === "line" ? "a line" : shape.type === "circle" ? "a circle" : "an arc"}`;
  }
  const out = { ...e, ...shape } as E & { clockwise?: boolean };
  if (out.type === "arc" && !(shape as { clockwise?: boolean }).clockwise) delete out.clockwise;
  return out;
}

/** A point entity at a projected model point. */
export function withPoint<E extends SketchEntity>(e: E, at: Vec2, name: string): E | string {
  if (e.type !== "point") return `${name} is ${e.type === "arc" ? "an" : "a"} ${e.type}, but what it references is a point; reference it with a point`;
  return { ...e, at };
}

/** Whether the circular edge goes all the way round (its ends meet and it is longer than a half circle). */
export function isFullCircle(edge: EdgeGeometry): boolean {
  const r = edge.radius ?? 0;
  return dist3(edge.start, edge.end) < 1e-7 * Math.max(1, r) && edge.length > Math.PI * r;
}

/** Of a circle seen edge-on: the direction in the sketch plane that its plane projects along. */
function edgeOnDirection(axis: Vec3, frame: Frame): Vec3 {
  const w = cross3(axis, frame.z);
  return scale3(w, 1 / (len3(w) || 1));
}

/** Of a circle (or arc) seen edge-on: how far it reaches each way along edgeOnDirection from its centre. */
function edgeOnSpan(edge: EdgeGeometry, axis: Vec3, frame: Frame): [number, number] {
  const w = edgeOnDirection(axis, frame);
  const r = edge.radius!;
  if (isFullCircle(edge)) return [-r, r];
  // The arc from its start, counter-clockwise about its axis through its sweep: p(θ) = c + cosθ s + sinθ (a × s).
  const s = sub3(edge.start, edge.center!);
  const q = cross3(axis, s);
  const A = dot3(s, w);
  const B = dot3(q, w);
  const sweep = edge.length / r;
  const f = (t: number) => A * Math.cos(t) + B * Math.sin(t);
  const ts = [0, sweep];
  // The extremes of A cos θ + B sin θ, where they fall inside the sweep.
  const t0 = Math.atan2(B, A);
  for (const t of [t0, t0 + Math.PI, t0 + 2 * Math.PI, t0 - Math.PI]) if (t > 0 && t < sweep) ts.push(t);
  const vals = ts.map(f);
  return [Math.min(...vals), Math.max(...vals)];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
