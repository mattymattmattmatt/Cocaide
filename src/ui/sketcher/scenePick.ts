// What the pointer is on in the 3D view, as the sketch sees it (Phase P wave
// 2A). In a turned view the model's edges and the other sketches' entities
// are not drawn flat on the sketch plane (their projections would pile up):
// they are hovered where the 3D view shows them, and a hit stands for its
// projection in the sketch, the same stand-in ("@e12", "@s:sketch_1:l2") a
// click on it gives in the flat view, with the point a click there lands on
// (the hit carried square onto the plane). The model is hit by the view's own
// picking (it knows what faces hide); other sketches are hit here, on screen.
// Also: the selection box, in screen pixels. Pure.

import type { SketchEntity, Vec2, Vec3 } from "../../doc/types";
import { to2D } from "../../geom/frame";
import { entityPolylines } from "../../geom/profile";
import { REFERENCEABLE } from "../../geom/projection";
import type { PickTarget } from "../model/selection";
import type { SketchItem } from "./draft";
import { modelEdge, modelId, type ModelEdge, type ModelView } from "./model";
import { screenDistance, toScreen, type ViewCamera } from "./planeView";

/** Pixels from an entity that still hit it, and from a point (an end, a centre) that hit the point rather than the entity. */
export const PICK_PX = 7;
export const VERTEX_PX = 8;

/** Something under the pointer in the 3D view, as a stand-in of the sketch. */
export interface SceneHit {
  /** What a click picks: a stand-in entity or point, or (Convert Entities) a face. */
  item: SketchItem;
  /** The stand-in entity it is (or a point of): what snapping and inference use. Null for a face. */
  standIn: SketchEntity | null;
  /** Where a click lands in the sketch, mm: what was hit carried square onto the plane. */
  at: Vec2;
  /** How far it is from the pointer, pixels. */
  px: number;
  /** Its outline in 3D, lit up while hovered; the point hit in 3D. */
  poly3: Vec3[];
  point3?: Vec3;
  /** A model edge (true) or another sketch's entity: a model edge wins a tie. */
  model: boolean;
  /** A round face's axis: the cylinder's outline as the view shows it, lit up with the axis. */
  outline3?: Vec3[][];
}

/** A model edge under the pointer that a sketch can't reference (seen end-on, a tilted circle): why, for the tip, and its outline. */
export interface SceneMiss {
  problem: string;
  poly3: Vec3[];
  outline3?: Vec3[][];
}

/**
 * The view's pick (a vertex, an edge, a face) as the sketch's stand-in. A
 * vertex is its edge's stand-in's end ("@e12.start"); an edge its stand-in;
 * a face, with `faces` (Convert Entities), one of the faces along the sketch;
 * with `axes` (picking, not drawing), a round face's axis ("@f3"), a weak hit
 * (PICK_PX away: an edge or another sketch's entity near the pointer wins);
 * else nothing. `local` is the pointer in the view's pixels.
 */
export function standInFor(pick: PickTarget | null, m: ModelView, cam: ViewCamera, local: Vec2, opts: { faces?: boolean; axes?: boolean } = {}): SceneHit | SceneMiss | null {
  if (!pick || pick.kind === "datum") return null;
  if (pick.kind === "face") {
    if (opts.faces) {
      if (!m.faces.some((f) => f.index === pick.index)) return null;
      return { item: { kind: "face", index: pick.index }, standIn: null, at: to2D(m.frame, pick.point), px: 0, poly3: [], point3: pick.point, model: true };
    }
    // A round face (or its outline in the view) stands for its axis, when picking rather than drawing.
    const axis = opts.axes ? m.axes.find((a) => a.axisOf?.face === pick.index) : undefined;
    if (!axis?.axisOf) return null;
    const outline3 = cylinderOutline(axis.axisOf, cam.forward);
    if (!axis.entity) return { problem: axis.problem ?? REFERENCEABLE, poly3: axis.poly3, outline3 };
    const near = alongAxis(axis.axisOf, pick.point);
    return { item: { kind: "entity", id: axis.id }, standIn: axis.entity, at: to2D(m.frame, near), px: PICK_PX, poly3: axis.poly3, point3: near, model: true, outline3 };
  }
  const index = pick.kind === "vertex" ? pick.edge : pick.index;
  const edge = modelEdge(m, modelId(index));
  if (!edge) return null;
  if (!edge.entity) return { problem: edge.problem ?? REFERENCEABLE, poly3: edge.poly3 };
  const e = edge.entity;
  if (pick.kind === "vertex" && (e.type === "line" || e.type === "arc")) {
    const at = e[pick.at];
    return { item: { kind: "point", ref: `${edge.id}.${pick.at}` }, standIn: e, at, px: dist(local, toScreen(cam, pick.point)), poly3: edge.poly3, point3: pick.point, model: true };
  }
  return { item: { kind: "entity", id: edge.id }, standIn: e, at: to2D(m.frame, pick.point), px: polyDistance(local, edge.poly3, cam).d, poly3: edge.poly3, point3: pick.point, model: true };
}

/**
 * The other sketch's entity (or its end, centre, a point entity) nearest the
 * pointer on screen, within PICK_PX (VERTEX_PX for points, which win over the
 * line they end). `skip` leaves out those hit another way (drawn on the plane).
 */
export function otherSketchAt(m: ModelView, cam: ViewCamera, local: Vec2, skip: (o: ModelEdge) => boolean = () => false): SceneHit | null {
  let best: SceneHit | null = null;
  for (const o of m.others) {
    if (!o.entity || !o.source || skip(o)) continue;
    for (const p of o.source.points) {
      const d = dist(local, toScreen(cam, p.at));
      if (d > VERTEX_PX || (best && best.item.kind === "point" && d >= best.px)) continue;
      // The point of the stand-in: a sketch point's stand-in is its own point ("at").
      best = { item: { kind: "point", ref: `${o.id}.${p.name}` }, standIn: o.entity, at: to2D(m.frame, p.at), px: d, poly3: o.poly3, point3: p.at, model: false };
    }
    if (best?.item.kind === "point" || o.entity.type === "point") continue;
    const hit = polyDistance(local, o.poly3, cam);
    if (hit.d > PICK_PX || (best && hit.d >= best.px)) continue;
    const a = o.poly3[hit.segment];
    const b = o.poly3[Math.min(hit.segment + 1, o.poly3.length - 1)];
    const point3: Vec3 = [a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t, a[2] + (b[2] - a[2]) * hit.t];
    best = { item: { kind: "entity", id: o.id }, standIn: o.entity, at: to2D(m.frame, point3), px: hit.d, poly3: o.poly3, point3, model: false };
  }
  return best;
}

/** The nearer of two hits; a model edge within 1.5 px of another sketch's entity wins (they often lie on each other: a profile and the edges extruded from it). */
export function nearer(a: SceneHit | null, b: SceneHit | null): SceneHit | null {
  if (!a || !b) return a ?? b;
  if (Math.abs(a.px - b.px) <= 1.5) return a.model ? a : b.model ? b : a;
  return a.px < b.px ? a : b;
}

/** The point of a round face's axis nearest p (within the face's length). */
export function alongAxis(c: NonNullable<ModelEdge["axisOf"]>, p: Vec3): Vec3 {
  const t = Math.min(Math.max((p[0] - c.origin[0]) * c.axis[0] + (p[1] - c.origin[1]) * c.axis[1] + (p[2] - c.origin[2]) * c.axis[2], Math.min(...c.axial)), Math.max(...c.axial));
  return [c.origin[0] + c.axis[0] * t, c.origin[1] + c.axis[1] * t, c.origin[2] + c.axis[2] * t];
}

/**
 * A cylinder's outline as a view looking along `forward` shows it: the two
 * lines along its length on either side, a radius off the axis square to the
 * view; none when the view looks along the axis (its circular edges are its outline then).
 */
export function cylinderOutline(c: NonNullable<ModelEdge["axisOf"]>, forward: Vec3): Vec3[][] {
  const a = c.axis;
  const s: Vec3 = [a[1] * forward[2] - a[2] * forward[1], a[2] * forward[0] - a[0] * forward[2], a[0] * forward[1] - a[1] * forward[0]];
  const n = Math.hypot(s[0], s[1], s[2]);
  if (n < 1e-6) return [];
  const at = (t: number, k: number): Vec3 => [0, 1, 2].map((i) => c.origin[i] + a[i] * t + (s[i] / n) * c.radius * k) as Vec3;
  return [1, -1].map((k) => [at(c.axial[0], k), at(c.axial[1], k)]);
}

/** A 3D polyline's distance from a screen point (pixels), with where along it. */
function polyDistance(local: Vec2, poly3: Vec3[], cam: ViewCamera) {
  return screenDistance(local, poly3.map((p) => toScreen(cam, p)));
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// ---------------------------------------------------------------- the selection box

/**
 * What a selection box picks, the usual CAD way: dragged left to right on the
 * screen (a window), the entities wholly inside it; right to left (crossing),
 * every entity inside it or crossing its edge. The box is in screen pixels
 * (`a` where it started, `b` where it is); `onScreen` maps sketch mm there,
 * so a box over a turned sketch picks what it covers on the screen.
 */
export function boxPick(entities: SketchEntity[], a: Vec2, b: Vec2, onScreen: (p: Vec2) => Vec2 = (p) => p): SketchItem[] {
  const min: Vec2 = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
  const max: Vec2 = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const inside = (p: Vec2) => p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1];
  const windowed = b[0] >= a[0];
  return entities
    .filter((e) => {
      const lines = (e.type === "point" ? [[e.at]] : entityPolylines(e)).map((pl) => pl.map(onScreen));
      const pts = lines.flat();
      if (!pts.length) return false;
      if (windowed) return pts.every(inside);
      if (pts.some(inside)) return true;
      return lines.some((l) => l.some((p, i) => i > 0 && segmentMeetsBox(l[i - 1], p, min, max)));
    })
    .map((e) => ({ kind: "entity" as const, id: e.id }));
}

/** Does the segment cross the box (Liang–Barsky)? */
function segmentMeetsBox(p: Vec2, q: Vec2, min: Vec2, max: Vec2): boolean {
  let t0 = 0;
  let t1 = 1;
  const d: Vec2 = [q[0] - p[0], q[1] - p[1]];
  for (const [pk, qk] of [
    [-d[0], p[0] - min[0]],
    [d[0], max[0] - p[0]],
    [-d[1], p[1] - min[1]],
    [d[1], max[1] - p[1]],
  ]) {
    if (pk === 0) {
      if (qk < 0) return false;
      continue;
    }
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}
