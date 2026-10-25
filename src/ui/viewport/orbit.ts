// How the 3D view turns, the way desktop CAD does it: the part spins in place.
// A rotation turns about a centre chosen when it starts, independent of the
// point the camera looks at (which panning and zooming at the pointer move):
//   1. the centre pinned by a middle-click on the part, if there is one;
//   2. else, with the visible part mostly on screen, the middle of its box;
//   3. else (zoomed in so the part overflows the view) the point of the part
//      under the middle of the view, or, between parts, the nearest point of
//      the part to it.
// The centre keeps its place on the screen while the view turns about it, so
// the part never swings off into empty space. Also here: the turn itself
// (free, or keeping Z up like a turntable), how fast a drag turns, re-seating
// the look-at point at the part's depth, framing points tightly from a
// direction, zoom to an area, and blending two cameras for the animated view
// changes. Pure: three.js maths only, no WebGL.

import * as THREE from "three";

/** The camera as the controls move it: where it is, what it looks at, which way is up. */
export interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
}

export const clonePose = (p: Pose): Pose => ({ position: p.position.clone(), target: p.target.clone(), up: p.up.clone() });

/** The camera's forward (unit, from the eye to the target), true up and right. */
export function poseAxes(p: Pose): { forward: THREE.Vector3; up: THREE.Vector3; right: THREE.Vector3 } {
  const forward = p.target.clone().sub(p.position).normalize();
  const right = forward.clone().cross(p.up).normalize();
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
  const up = right.clone().cross(forward).normalize();
  return { forward, up, right };
}

// ------------------------------------------------------------------ the rotation centre

/** Below this share of the part's box on screen, the part "overflows" the view: turn about the part under the middle instead. */
export const MOSTLY_ON_SCREEN = 0.6;

/**
 * How much of a box is on screen: the share of the rectangle its corners
 * project to that lies inside the view (0–1). 0 when a corner is behind a
 * perspective camera (the part fills and overflows the view). The camera's
 * matrices must be current.
 */
export function onScreenShare(box: THREE.Box3, camera: THREE.Camera): number {
  if (box.isEmpty()) return 0;
  const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const v = new THREE.Vector3();
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        if (perspective && v.z > -1e-9) return 0;
        v.applyMatrix4(camera.projectionMatrix);
        x0 = Math.min(x0, v.x);
        x1 = Math.max(x1, v.x);
        y0 = Math.min(y0, v.y);
        y1 = Math.max(y1, v.y);
      }
  const w = x1 - x0;
  const h = y1 - y0;
  const ix = Math.max(0, Math.min(1, x1) - Math.max(-1, x0));
  const iy = Math.max(0, Math.min(1, y1) - Math.max(-1, y0));
  // A flat or tiny box (seen edge on): judge by its middle.
  const sx = w < 1e-9 ? (x0 >= -1 && x0 <= 1 ? 1 : 0) : ix / w;
  const sy = h < 1e-9 ? (y0 >= -1 && y0 <= 1 ? 1 : 0) : iy / h;
  return sx * sy;
}

export type CentreWhy = "pinned" | "box" | "under" | "nearest" | "target";

export interface CentreInput {
  /** The camera that draws (perspective or orthographic), matrices current. */
  camera: THREE.Camera;
  /** The visible bodies' bounding box (null or empty: nothing shown). */
  box: THREE.Box3 | null;
  /** The centre pinned by a middle-click, if any. */
  pinned: THREE.Vector3 | null;
  /** The part under the middle of the view (a ray pick), if any. */
  underCentre(): THREE.Vector3 | null;
  /** The point of the part nearest the ray through the middle of the view. */
  nearestToCentre(): THREE.Vector3 | null;
  /** What to turn about when there is no part at all: the point the camera looks at. */
  fallback: THREE.Vector3;
}

/** The centre a rotation starting now turns about, and why it was chosen. */
export function rotationCentre(i: CentreInput): { point: THREE.Vector3; why: CentreWhy } {
  if (i.pinned) return { point: i.pinned.clone(), why: "pinned" };
  if (!i.box || i.box.isEmpty()) return { point: i.fallback.clone(), why: "target" };
  if (onScreenShare(i.box, i.camera) >= MOSTLY_ON_SCREEN) return { point: i.box.getCenter(new THREE.Vector3()), why: "box" };
  const under = i.underCentre();
  if (under) return { point: under.clone(), why: "under" };
  const near = i.nearestToCentre();
  if (near) return { point: near.clone(), why: "nearest" };
  return { point: i.box.getCenter(new THREE.Vector3()), why: "box" };
}

/**
 * The point (of a flat list of x, y, z) nearest a ray's line, measured square
 * to it; `keep(i)` leaves points out (hidden bodies, what a section cuts away),
 * and `ahead` keeps only points in front of the ray's origin (perspective).
 */
export function nearestToRay(positions: ArrayLike<number>, origin: THREE.Vector3, dir: THREE.Vector3, opts: { keep?: (i: number) => boolean; ahead?: boolean } = {}): THREE.Vector3 | null {
  const d = dir.clone().normalize();
  let best = -1;
  let bestD = Infinity;
  const n = Math.floor(positions.length / 3);
  for (let i = 0; i < n; i++) {
    if (opts.keep && !opts.keep(i)) continue;
    const px = positions[i * 3] - origin.x;
    const py = positions[i * 3 + 1] - origin.y;
    const pz = positions[i * 3 + 2] - origin.z;
    const t = px * d.x + py * d.y + pz * d.z;
    if (opts.ahead && t <= 0) continue;
    const q = px * px + py * py + pz * pz - t * t;
    if (q < bestD) {
      bestD = q;
      best = i;
    }
  }
  return best < 0 ? null : new THREE.Vector3(positions[best * 3], positions[best * 3 + 1], positions[best * 3 + 2]);
}

/**
 * The point of a set of segments (a flat list, six numbers each: x, y, z of
 * one end, then of the other) nearest a ray's line, measured square to it:
 * the part's edges, so a long straight member whose mesh has vertices only
 * at its ends still gives the point of it beside the middle of the view, not
 * an end far off. `keep(i, at)` leaves a segment's nearest point out (hidden,
 * cut away); `ahead` keeps only points in front of the ray's origin.
 */
export function nearestOnSegments(segments: ArrayLike<number>, origin: THREE.Vector3, dir: THREE.Vector3, opts: { keep?: (i: number, at: THREE.Vector3) => boolean; ahead?: boolean } = {}): THREE.Vector3 | null {
  const d = dir.clone().normalize();
  const a = new THREE.Vector3();
  const u = new THREE.Vector3();
  const w = new THREE.Vector3();
  const p = new THREE.Vector3();
  let best: THREE.Vector3 | null = null;
  let bestD = Infinity;
  const n = Math.floor(segments.length / 6);
  for (let i = 0; i < n; i++) {
    a.set(segments[i * 6], segments[i * 6 + 1], segments[i * 6 + 2]);
    u.set(segments[i * 6 + 3], segments[i * 6 + 4], segments[i * 6 + 5]).sub(a);
    w.copy(a).sub(origin);
    // Along the segment, the place nearest the line (clamped to its ends): s = (b·e − u·w) / (u·u − b²), b = u·d, e = d·w.
    const uu = u.dot(u);
    const b = u.dot(d);
    const den = uu - b * b;
    const s = den > 1e-12 * Math.max(uu, 1e-12) ? THREE.MathUtils.clamp((b * d.dot(w) - u.dot(w)) / den, 0, 1) : 0;
    p.copy(a).addScaledVector(u, s);
    const t = p.clone().sub(origin).dot(d);
    if (opts.ahead && t <= 0) continue;
    const q = p.clone().sub(origin).lengthSq() - t * t;
    if (q < bestD && (!opts.keep || opts.keep(i, p))) {
      bestD = q;
      best = p.clone();
    }
  }
  return best;
}

/** How far a point is from a ray's line, square to it. */
export function distanceToRay(p: THREE.Vector3, origin: THREE.Vector3, dir: THREE.Vector3): number {
  const d = dir.clone().normalize();
  const w = p.clone().sub(origin);
  const t = w.dot(d);
  return Math.sqrt(Math.max(0, w.lengthSq() - t * t));
}

// ------------------------------------------------------------------ the turn

const Z = new THREE.Vector3(0, 0, 1);

/** Radians a pixel of drag turns: dragging across the view's height turns half a turn (180°) at 100 %. */
export function turnPerPixel(viewHeightPx: number, speed = 1): number {
  return (Math.PI / Math.max(1, viewHeightPx)) * speed;
}

/**
 * The camera turned about `centre`: `yaw` about the screen's up (or, keeping
 * Z up, about world Z) and `pitch` about the screen's right, radians. The
 * centre keeps its place on the screen. Keeping Z up, the view is first
 * levelled (no roll) and never tips over the top: it stops looking straight
 * down or up.
 */
export function orbit(p: Pose, centre: THREE.Vector3, yaw: number, pitch: number, keepZUp = false): Pose {
  let { up, right, forward } = poseAxes(p);
  let yawAxis = up;
  if (keepZUp) {
    // Level the view: screen up in the plane of Z and the view direction (unless looking straight down or up).
    if (Math.abs(forward.dot(Z)) < 0.9999) {
      up = Z.clone().addScaledVector(forward, -Z.dot(forward)).normalize();
      right = forward.clone().cross(up).normalize();
    }
    yawAxis = Z;
    // The camera's height above the horizon (radians, +π/2 looking straight down), kept within ±π/2.
    const elevation = Math.asin(THREE.MathUtils.clamp(-forward.dot(Z), -1, 1));
    // A turn about the right axis by `pitch` lowers the camera by `pitch` (drag down: look from higher, pitch < 0).
    const next = THREE.MathUtils.clamp(elevation - pitch, -Math.PI / 2, Math.PI / 2);
    pitch = elevation - next;
  }
  const q = new THREE.Quaternion().setFromAxisAngle(yawAxis, yaw).multiply(new THREE.Quaternion().setFromAxisAngle(right, pitch));
  const c = centre.clone();
  return {
    position: p.position.clone().sub(c).applyQuaternion(q).add(c),
    target: p.target.clone().sub(c).applyQuaternion(q).add(c),
    up: up.clone().applyQuaternion(q).normalize(),
  };
}

/**
 * The look-at point moved along the line of sight to the depth of `centre`
 * (the part being turned), so panning and zooming afterwards move the part at
 * the pointer's pace. The view does not change: in perspective the eye stays
 * put; orthographic, the eye moves with it (keeping the zoom, which there is
 * the eye's distance).
 */
export function reseat(p: Pose, centre: THREE.Vector3, orthographic: boolean): Pose {
  const { forward } = poseAxes(p);
  const dist = p.target.distanceTo(p.position);
  const depth = centre.clone().sub(p.position).dot(forward);
  if (orthographic) {
    const shift = forward.clone().multiplyScalar(depth - dist);
    return { position: p.position.clone().add(shift), target: p.target.clone().add(shift), up: p.up.clone() };
  }
  // In perspective, a centre at or behind the eye is no depth to look at.
  if (depth <= dist * 1e-3) return clonePose(p);
  return { position: p.position.clone(), target: p.position.clone().addScaledVector(forward, depth), up: p.up.clone() };
}

// ------------------------------------------------------------------ framing

/**
 * Where to put the camera to frame `points` seen from `dir` (unit, toward the
 * camera) with `up`: tight on what you see (not a sphere round it), with a
 * margin. `aspect` is the view's width over height, `fov` the vertical field
 * of view in degrees: the orthographic frame is the one the perspective
 * camera sees at the target, so one distance suits both.
 */
export function framePoints(points: ArrayLike<number>, dir: THREE.Vector3, up: THREE.Vector3, aspect: number, fov: number, opts: { margin?: number; perspective?: boolean; keep?: (i: number) => boolean } = {}): { target: THREE.Vector3; dist: number } | null {
  const d = dir.clone().normalize();
  const r = up.clone().cross(d).normalize();
  if (r.lengthSq() < 1e-12) return null;
  const u = d.clone().cross(r).normalize();
  let a0 = Infinity;
  let a1 = -Infinity;
  let b0 = Infinity;
  let b1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  const n = Math.floor(points.length / 3);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (opts.keep && !opts.keep(i)) continue;
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    const a = x * r.x + y * r.y + z * r.z;
    const b = x * u.x + y * u.y + z * u.z;
    const c = x * d.x + y * d.y + z * d.z;
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
    b0 = Math.min(b0, b);
    b1 = Math.max(b1, b);
    z0 = Math.min(z0, c);
    z1 = Math.max(z1, c);
    any = true;
  }
  if (!any) return null;
  const margin = opts.margin ?? 1.1;
  const halfA = (a1 - a0) / 2;
  const halfB = (b1 - b0) / 2;
  // Not to nothing: a point or a line alone still gets a little room round it.
  const span = Math.max(halfA, halfB, z1 - z0, 1e-3);
  const halfH = Math.max(halfB, halfA / Math.max(aspect, 1e-6), span * 0.05) * margin;
  const t = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const midZ = (z0 + z1) / 2;
  const target = r.clone().multiplyScalar((a0 + a1) / 2).addScaledVector(u, (b0 + b1) / 2).addScaledVector(d, midZ);
  // In perspective the nearest points must fit too: stand back by their height in front of the middle.
  const dist = halfH / t + (opts.perspective ? (z1 - z0) / 2 : 0);
  return { target, dist };
}

/**
 * Zoom to an area dragged on the view (pixels within the view): where its
 * middle is (normalised device coordinates) and how much smaller the frame
 * gets (the new frame's size over the old). Null for a box too small to mean
 * anything (a few pixels).
 */
export function areaZoom(rect: { x0: number; y0: number; x1: number; y1: number }, width: number, height: number): { ndc: [number, number]; factor: number } | null {
  const w = Math.abs(rect.x1 - rect.x0);
  const h = Math.abs(rect.y1 - rect.y0);
  if (w < 6 && h < 6) return null;
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const factor = Math.max(w / width, h / height);
  return { ndc: [(cx / width) * 2 - 1, -((cy / height) * 2 - 1)], factor: Math.max(factor, 1e-4) };
}

// ------------------------------------------------------------------ animated view changes

/** A camera as an orientation, the point it looks at and how far back it stands: what a view change blends. */
export interface Rig {
  quat: THREE.Quaternion;
  target: THREE.Vector3;
  dist: number;
}

/** The rig of a pose: the camera looks down its own −Z, up its +Y (three's convention). */
export function rigOf(p: Pose): Rig {
  const m = new THREE.Matrix4().lookAt(p.position, p.target, p.up);
  return { quat: new THREE.Quaternion().setFromRotationMatrix(m), target: p.target.clone(), dist: Math.max(p.position.distanceTo(p.target), 1e-9) };
}

export function poseOf(r: Rig): Pose {
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(r.quat);
  return { position: r.target.clone().addScaledVector(back, r.dist), target: r.target.clone(), up: new THREE.Vector3(0, 1, 0).applyQuaternion(r.quat) };
}

/** Between two rigs at t (0–1): the orientation slerped (the short way round), the target eased in a line, the distance geometrically (zooms feel even). */
export function blendRig(a: Rig, b: Rig, t: number): Rig {
  return {
    quat: a.quat.clone().slerp(b.quat, t),
    target: a.target.clone().lerp(b.target, t),
    dist: a.dist * Math.pow(b.dist / a.dist, t),
  };
}

/** Ease in and out (cubic): starts and stops gently. */
export function ease(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** How long a view change glides, milliseconds. */
export const VIEW_GLIDE_MS = 280;
