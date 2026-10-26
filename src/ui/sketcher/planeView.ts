// The sketch plane as the 3D view shows it (Phase P wave 2A): the sketcher
// draws over the WebGL view in screen pixels, and with an orthographic
// camera a plane maps to the screen by an affine map (u, v) → (x, y):
//
//   x = a u + c v + e,   y = b u + d v + f
//
// where (a, b) and (c, d) are the sketch's x and y axes on the screen, in
// pixels per mm, and (e, f) is where its origin is. The canvas puts the map on
// its world group as an SVG matrix(a, b, c, d, e, f), so its geometry stays in
// sketch millimetres (and getScreenCTM still maps sketch mm to the screen);
// sizes that must not change with the view (dots, text, pick distances) use
// the map's local scale, and text and glyphs are drawn upright at their mapped
// anchors. A plane seen nearly edge-on (under EDGE_ON_DEG to the line of
// sight) maps to a sliver: drawing pauses there. Facing the plane (within
// FACING_DEG) the view is the flat sketch page of old. Pure.

import { useSyncExternalStore } from "react";
import type { SketchEntity, Vec2, Vec3 } from "../../doc/types";
import { to3D, type Frame } from "../../geom/frame";
import { entityPolylines } from "../../geom/profile";
import type { SectionView } from "../evaluate/section";

/** What the sketcher needs of the 3D view's camera (orthographic): its screen axes in the world, where it looks, its scale and size. */
export interface ViewCamera {
  /** Unit vectors, world: screen right, screen up, and into the screen (the line of sight). */
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  /** The world point at the middle of the view. */
  target: Vec3;
  /** World mm per screen pixel. */
  wpp: number;
  /** The view's size, CSS pixels. */
  width: number;
  height: number;
  /** The other sketches are shown in the view (its Sketches toggle): they can be picked. */
  sketches: boolean;
}

/** The plane's map to the screen, and how the plane is seen. */
export interface PlaneMap {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  /** Pixels per mm, the map's local scale (the square root of its area scale): what view-independent sizes are measured with. */
  scale: number;
  /** |cos| of the angle between the line of sight and the plane's normal: 1 facing it, 0 edge-on. */
  facingCos: number;
  /** Seen within FACING_DEG of square on: the flat sketch page. */
  facing: boolean;
  /** Seen within EDGE_ON_DEG of edge-on: drawing pauses. */
  edgeOn: boolean;
}

/** Under this angle to the line of sight, degrees, the plane is too edge-on to draw on. */
export const EDGE_ON_DEG = 10;
/** Within this of square on, degrees, the view faces the plane. */
export const FACING_DEG = 0.5;

const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

/** A world point on the screen: CSS pixels from the view's top left (orthographic: straight along the line of sight). */
export function toScreen(cam: ViewCamera, p: Vec3): Vec2 {
  const q: Vec3 = [p[0] - cam.target[0], p[1] - cam.target[1], p[2] - cam.target[2]];
  return [cam.width / 2 + dot(q, cam.right) / cam.wpp, cam.height / 2 - dot(q, cam.up) / cam.wpp];
}

/** The plane of `frame` seen through the camera: the affine map from its (u, v) to the screen. */
export function planeMap(cam: ViewCamera, frame: Frame): PlaneMap {
  const [e, f] = toScreen(cam, frame.origin);
  const a = dot(frame.x, cam.right) / cam.wpp;
  const b = -dot(frame.x, cam.up) / cam.wpp;
  const c = dot(frame.y, cam.right) / cam.wpp;
  const d = -dot(frame.y, cam.up) / cam.wpp;
  const facingCos = Math.min(1, Math.abs(dot(frame.z, cam.forward)));
  return finish({ a, b, c, d, e, f, facingCos });
}

/**
 * The flat sketch page: x right, y up, `scale` pixels per mm, the sketch point
 * (cx, cy) in the middle of a w × h view. What the canvas shows before the
 * 3D view has reported its camera.
 */
export function flatMap(cx: number, cy: number, scale: number, w: number, h: number): PlaneMap {
  return finish({ a: scale, b: 0, c: 0, d: -scale, e: w / 2 - cx * scale, f: h / 2 + cy * scale, facingCos: 1 });
}

function finish(m: Omit<PlaneMap, "scale" | "facing" | "edgeOn">): PlaneMap {
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  return { ...m, scale, facing: m.facingCos >= Math.cos((FACING_DEG * Math.PI) / 180), edgeOn: m.facingCos < Math.sin((EDGE_ON_DEG * Math.PI) / 180) };
}

/** A sketch point (mm) on the screen (pixels). */
export function mapPoint(m: PlaneMap, p: Vec2): Vec2 {
  return [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f];
}

/** A sketch direction (or a displacement, mm) on the screen (pixels): the map without its offset. */
export function mapVector(m: PlaneMap, v: Vec2): Vec2 {
  return [m.a * v[0] + m.c * v[1], m.b * v[0] + m.d * v[1]];
}

/** The sketch point (mm) under a screen point (pixels): the map undone. Null when the plane is seen exactly edge-on. */
export function unmapPoint(m: PlaneMap, x: number, y: number): Vec2 | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return null;
  const dx = x - m.e;
  const dy = y - m.f;
  return [(m.d * dx - m.c * dy) / det, (-m.b * dx + m.a * dy) / det];
}

/** The map as an SVG transform. */
export function svgMatrix(m: PlaneMap): string {
  return `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map((x) => +x.toFixed(9)).join(" ")})`;
}

/** The part of the plane a w × h screen shows, in sketch mm (the box round the screen's corners mapped back); null edge-on. */
export function visibleBounds(m: PlaneMap, w: number, h: number): { min: Vec2; max: Vec2 } | null {
  const corners = [unmapPoint(m, 0, 0), unmapPoint(m, w, 0), unmapPoint(m, 0, h), unmapPoint(m, w, h)];
  if (corners.some((p) => !p)) return null;
  const xs = corners.map((p) => p![0]);
  const ys = corners.map((p) => p![1]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

/** How far (pixels) a screen point is from a screen polyline, and the share (0..1 of the segment) along the nearest segment. */
export function screenDistance(p: Vec2, poly: Vec2[]): { d: number; segment: number; t: number } {
  let best = { d: Infinity, segment: 0, t: 0 };
  if (poly.length === 1) return { d: Math.hypot(p[0] - poly[0][0], p[1] - poly[0][1]), segment: 0, t: 0 };
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    if (d < best.d) best = { d, segment: i - 1, t };
  }
  return best;
}

// ---------------------------------------------------------------- the sketch in the view

/**
 * The world points the sketch spans (flat xyz), for the view's Fit and its
 * drawn plane: every entity's outline (a reference to an axis is left out:
 * it is drawn long enough to cross the whole part).
 */
export function sketchWorldPoints(entities: SketchEntity[], frame: Frame): number[] {
  const out: number[] = [];
  for (const e of entities) {
    if (e.ref && "datum" in e.ref && e.type === "line") continue;
    const lines = e.type === "point" ? [[e.at]] : entityPolylines(e, Math.PI / 16);
    for (const pl of lines) for (const p of pl) out.push(...to3D(frame, p));
  }
  return out;
}

/**
 * "Section at sketch plane": the part cut away in front of the sketch plane
 * (on the side its normal points to, where you look from facing it), a hair
 * in front so a face the sketch lies on stays, capped as the section view caps.
 */
export function sketchPlaneSection(frame: Frame): SectionView {
  return {
    planes: [{ on: "sketch", label: "Sketch plane", origin: [...frame.origin], normal: [...frame.z], offset: 1e-3, flip: false }],
    on: true,
    active: 0,
    showPlane: false,
    bodies: null,
    capColour: "single",
  };
}

// ---------------------------------------------------------------- the camera feed

/**
 * The 3D view's camera as it changes, for the sketch canvas alone: the view
 * sets it after every frame that moves it, and only what subscribes (the
 * canvas) draws again, not the whole app.
 */
export class CameraFeed {
  private value: ViewCamera | null = null;
  private readonly listeners = new Set<() => void>();
  get current(): ViewCamera | null {
    return this.value;
  }
  set(next: ViewCamera | null): void {
    if (sameCamera(this.value, next)) return;
    this.value = next;
    for (const l of [...this.listeners]) l();
  }
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

/** The feed's camera, kept up to date in a component. */
export function useCameraFeed(feed: CameraFeed | null | undefined): ViewCamera | null {
  return useSyncExternalStore(
    feed?.subscribe ?? noSubscribe,
    () => feed?.current ?? null,
    () => null,
  );
}

const noSubscribe = () => () => {};

function sameCamera(p: ViewCamera | null, q: ViewCamera | null): boolean {
  if (!p || !q) return p === q;
  const close = (u: Vec3, v: Vec3, eps: number) => Math.abs(u[0] - v[0]) < eps && Math.abs(u[1] - v[1]) < eps && Math.abs(u[2] - v[2]) < eps;
  return (
    p.width === q.width &&
    p.height === q.height &&
    p.sketches === q.sketches &&
    Math.abs(p.wpp - q.wpp) <= 1e-12 * Math.max(1, p.wpp) &&
    close(p.right, q.right, 1e-12) &&
    close(p.up, q.up, 1e-12) &&
    close(p.target, q.target, 1e-9 * Math.max(1, p.wpp))
  );
}
