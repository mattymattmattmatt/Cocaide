// Direct manipulation (drag handles): arrows, arcs and points on the model
// that you drag to change a feature's numbers, live, and which write the new
// value back to the one parameter that owns it (one undo step, or a change in
// the open session). Every feature has its handles: an extrude's depth in each
// direction and its draft, a revolve's angles (an arc about its axis), a
// fillet's radius (and end radius), a chamfer's distances or angle, a shell's
// wall, a draft's angle, a hole's depth and its centre (dragged on its face), a
// pattern's spacing (the second instance) and count (past the last), a plane's
// offset or angle. Flip arrows reverse a direction with a click. Which handles
// a feature has, where they sit, how a drag turns into a value (snapped to the
// steps in Settings, Shift for tenths), and the patch a value makes: all here,
// pure, so Vitest covers it.

import type { Vec2, Vec3 } from "../../doc/types";
import { isExpression } from "../../doc/parameters";
import { DEFAULT_DATUMS } from "../../features/datum";
import { countPatch, seedsOf } from "../../features/linearPattern/instances";
import { centresOf } from "../../features/hole/wizard";
import { facePlaneFrame, to3D, type Frame } from "../../geom/frame";
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from "../../geom/vec";
import { selectEdges, selectFaces } from "../../kernel/selectors";
import type { FaceInfo } from "../../kernel/topology";
import type { EdgeSelector, FaceSelector } from "../../doc/types";
import type { RebuildView } from "../../worker/protocol";
import { fmt } from "../model/selection";
import { intoFace } from "../model/smartSelect";
import { widthAcross } from "../model/smartDefaults";
import type { Raw } from "../model/ToolContext";
import { patchAt } from "../props/spec";

/** A handle's value: a number (a depth, an angle, a count), or a point on a face (a hole's centre). */
export type HandleValue = number | Vec2;

export interface HandleSpec {
  /** "<feature>:<key>" (a hole's centres: "<feature>:center:<i>"). */
  id: string;
  feature: string;
  /** The parameter it drives: "distance", "direction2.distance", "draft.angle", "radius", "count"…; a section plane's "offset". */
  key: string;
  /** "Depth", "Radius", "Count", "Offset". */
  label: string;
  /** The parameter now (a point handle's is `at`). */
  value: number;
  /**
   * How it is dragged: along an arrow (the default), round an arc about an
   * axis ("angle"), on a plane ("point"); "flip" is a button that reverses a
   * direction when clicked; "section" is a section plane's arrow (view state).
   */
  kind?: "section" | "angle" | "point" | "flip";
  /** An arrow: where the value is `offset`, and its unit direction. An arc: its centre. A point: unused (the frame's origin). */
  origin: Vec3;
  dir: Vec3;
  /** How much the value changes per mm along the arrow (per degree round an arc). */
  scale: number;
  /** The value where the handle stands at `origin` (a count's arrow starts at the original: 1). */
  offset?: number;
  /** The least value (a depth stays above 0; with `inclusive`, the least is allowed: a count of 2). */
  min: number | null;
  max?: number | null;
  inclusive?: boolean;
  /** An arc: its axis (right-handed: the value grows turning about it), where the value is 0 (unit, square to the axis), its radius (mm). */
  axis?: Vec3;
  zero?: Vec3;
  radius?: number;
  /** A point: the face's frame (its x and y are the point's) and the point now. */
  frame?: Frame;
  at?: Vec2;
  /** The step a drag snaps to: the length step (Settings, default 1 mm), the angle step (1°), or whole numbers. */
  snap?: "length" | "angle" | "count";
  /** Why it can't be dragged (an expression sets the value), or undefined. */
  locked?: string;
  /** The patch a value makes (default: the value at `key`; nested keys send their whole object). */
  write?(f: Raw, value: HandleValue): Raw;
  /** A section plane's arrow: which plane (0–2). */
  plane?: number;
}

/** A feature's handle (never a section plane's). */
export type FeatureHandle = HandleSpec;

/** The drag steps: Settings → Units' spin steps (src/ui/sketcher/modify.ts). */
export interface DragSteps {
  length: number;
  angle: number;
}
export const DEFAULT_STEPS: DragSteps = { length: 1, angle: 1 };

const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Where an arc handle's ball is for a value: `radius` from the centre, turned from `zero` about `axis`. */
function onArc(h: HandleSpec, value: number): Vec3 {
  const a = rad((value - (h.offset ?? 0)) / h.scale);
  const z = h.zero!;
  const w = cross3(h.axis!, z);
  return add3(h.origin, scale3(add3(scale3(z, Math.cos(a)), scale3(w, Math.sin(a))), h.radius!));
}

/** Where the handle is for a value: an arrow's tip, an arc's ball, a point. */
export function handleTip(h: HandleSpec, value: HandleValue = h.kind === "point" ? (h.at ?? [0, 0]) : h.value): Vec3 {
  if (h.kind === "point" && h.frame) {
    const p = Array.isArray(value) ? value : (h.at ?? [0, 0]);
    return to3D(h.frame, p);
  }
  const v = typeof value === "number" ? value : h.value;
  if (h.kind === "angle" && h.axis && h.zero && h.radius !== undefined) return onArc(h, v);
  if (h.kind === "flip") return h.origin;
  return add3(h.origin, scale3(h.dir, (v - (h.offset ?? 0)) / h.scale));
}

/** The arc's points from its zero to a value (for drawing it), `n` steps. */
export function arcPoints(h: HandleSpec, value = h.value, n = 32): Vec3[] {
  if (h.kind !== "angle" || !h.axis || !h.zero || h.radius === undefined) return [];
  const end = (value - (h.offset ?? 0)) / h.scale;
  return Array.from({ length: n + 1 }, (_, i) => onArc(h, (h.offset ?? 0) + ((end * i) / n) * h.scale));
}

/** "12 mm", "45°", "6", "30, -10". */
export function handleText(h: HandleSpec, value: HandleValue = h.kind === "point" ? (h.at ?? [0, 0]) : h.value): string {
  if (Array.isArray(value)) return `${fmt(value[0])}, ${fmt(value[1])}`;
  if (h.snap === "count") return `${fmt(value)}`;
  if (h.snap === "angle") return `${fmt(value)}°`;
  return `${fmt(value)} mm`;
}

/** The step a drag snaps to for this handle, and Shift's finer one. */
export function stepOf(h: HandleSpec, fine: boolean, steps: DragSteps = DEFAULT_STEPS): number {
  if (h.snap === "count") return 1;
  const s = h.snap === "angle" ? steps.angle : steps.length;
  return fine ? s / 10 : s;
}

/** A value kept to the handle's limits (a depth one step above 0; a count from its least, inclusive). */
function limited(h: HandleSpec, v: number, step: number): number {
  if (h.min !== null && (h.inclusive ? v < h.min : v <= h.min)) v = h.inclusive ? h.min : h.min + step;
  if (h.max !== undefined && h.max !== null && v > h.max) v = h.max;
  return r6(v);
}

/**
 * The value a drag gives: the start value moved by how far the pointer went
 * along the arrow (`moved`, mm; round an arc: degrees), snapped to the step
 * (`fine`: a tenth of it), never below the handle's least value.
 */
export function dragValue(h: HandleSpec, start: number, moved: number, fine = false, steps: DragSteps = DEFAULT_STEPS): number {
  const step = stepOf(h, fine, steps);
  return limited(h, Math.round(r6(start + moved * h.scale) / step) * step, step);
}

/** The patch that sets a handle's parameter (nested fields are sent whole: patches are shallow). */
export function handlePatch(h: HandleSpec, f: Raw, value: HandleValue | string): Raw {
  // A value typed where the handle shows it may be an "=expression": it goes in as written.
  return h.write ? h.write(f, value as HandleValue) : patchAt(f, h.key, value);
}

/** The ruler's ticks along a handle: every 1, 5, 10… mm, whichever keeps them `minPx` apart on screen. */
export function rulerStep(pxPerMm: number, minPx = 6): number {
  for (const s of [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) if (s * pxPerMm >= minPx) return s;
  return 1000;
}

// ------------------------------------------------------------ dragging

/** Closest point parameter on an axis (origin, unit dir) to a ray: how far along the axis the pointer is. */
export function alongAxis(origin: Vec3, dir: Vec3, rayOrigin: Vec3, rayDir: Vec3): number | null {
  const u = normalize3(dir);
  const v = normalize3(rayDir);
  const w = sub3(origin, rayOrigin);
  const b = dot3(u, v);
  const den = 1 - b * b;
  // Looking straight down the arrow: no way to tell how far along it the pointer is.
  if (den < 1e-6) return null;
  const d = dot3(u, w);
  const e = dot3(v, w);
  return (b * e - d) / den;
}

/** Where the ray meets the plane through `p` square to `n` (null: along it). */
function onPlane(p: Vec3, n: Vec3, rayOrigin: Vec3, rayDir: Vec3): Vec3 | null {
  const den = dot3(rayDir, n);
  if (Math.abs(den) < 1e-6 * len3(rayDir) * len3(n)) return null;
  const t = dot3(sub3(p, rayOrigin), n) / den;
  return add3(rayOrigin, scale3(rayDir, t));
}

/** The pointer's angle (degrees) round an arc handle's axis, from its zero; null when the arc is seen edge on. */
export function angleAt(h: HandleSpec, rayOrigin: Vec3, rayDir: Vec3): number | null {
  if (!h.axis || !h.zero) return null;
  const p = onPlane(h.origin, h.axis, rayOrigin, rayDir);
  if (!p) return null;
  const d = sub3(p, h.origin);
  const w = cross3(h.axis, h.zero);
  return (Math.atan2(dot3(d, w), dot3(d, h.zero)) * 180) / Math.PI;
}

/** The pointer on a point handle's plane, in its frame (null: the plane seen edge on). */
export function pointAt(h: HandleSpec, rayOrigin: Vec3, rayDir: Vec3): Vec2 | null {
  if (!h.frame) return null;
  const p = onPlane(h.frame.origin, h.frame.z, rayOrigin, rayDir);
  if (!p) return null;
  const d = sub3(p, h.frame.origin);
  return [dot3(d, h.frame.x), dot3(d, h.frame.y)];
}

/** A drag under way: the handle, its value when grabbed, where it was grabbed, and (an arc) how far round it has turned. */
export interface HandleDrag {
  h: HandleSpec;
  start: HandleValue;
  grab: number | Vec2;
  /** An arc: the pointer's angle last time, and the degrees turned since the grab (so it can go past ±180°). */
  last?: number;
  turned?: number;
}

/** Grabs a handle where the pointer's ray is; null when it can't be dragged from this view (the arrow points at the eye). */
export function beginDrag(h: HandleSpec, rayOrigin: Vec3, rayDir: Vec3): HandleDrag | null {
  if (h.kind === "angle") {
    const a = angleAt(h, rayOrigin, rayDir);
    return a === null ? null : { h, start: h.value, grab: a, last: a, turned: 0 };
  }
  if (h.kind === "point") {
    const p = pointAt(h, rayOrigin, rayDir);
    return p === null ? null : { h, start: h.at ?? [0, 0], grab: p };
  }
  const t = alongAxis(h.origin, h.dir, rayOrigin, rayDir);
  return t === null ? null : { h, start: h.value, grab: t };
}

/** The value the drag gives with the pointer's ray here (null: no reading from this ray). Mutates the arc's turn count. */
export function moveDrag(g: HandleDrag, rayOrigin: Vec3, rayDir: Vec3, fine = false, steps: DragSteps = DEFAULT_STEPS): HandleValue | null {
  const { h } = g;
  if (h.kind === "angle") {
    const a = angleAt(h, rayOrigin, rayDir);
    if (a === null) return null;
    let delta = a - g.last!;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    g.last = a;
    g.turned = (g.turned ?? 0) + delta;
    return dragValue(h, g.start as number, g.turned, fine, steps);
  }
  if (h.kind === "point") {
    const p = pointAt(h, rayOrigin, rayDir);
    if (!p) return null;
    const step = stepOf(h, fine, steps);
    const s = g.start as Vec2;
    const q = g.grab as Vec2;
    return [r6(Math.round((s[0] + p[0] - q[0]) / step) * step), r6(Math.round((s[1] + p[1] - q[1]) / step) * step)];
  }
  const t = alongAxis(h.origin, h.dir, rayOrigin, rayDir);
  if (t === null) return null;
  return dragValue(h, g.start as number, t - (g.grab as number), fine, steps);
}

// ------------------------------------------------------------ where handles go

/** A point of the part's frame: where on a default axis does it fall? (Handles stay off the origin's axes, where they hide.) */
function onDefaultAxis(p: Vec3, tol: number): boolean {
  const near = (a: number, b: number) => Math.abs(a) < tol && Math.abs(b) < tol;
  return near(p[1], p[2]) || near(p[0], p[2]) || near(p[0], p[1]);
}

/**
 * A point on a face where a handle can stand: the face's middle, or, when
 * that is on one of the origin's axes (a face centred on the origin), half
 * of the way from it toward the face's farthest corner, so the handle is not
 * hidden behind the origin's own arrows.
 */
function clearOfAxes(p: Vec3, face: FaceInfo, view: RebuildView): Vec3 {
  const size = Math.sqrt(face.area) || 1;
  if (!onDefaultAxis(p, size * 0.03)) return p;
  const range = view.mesh?.faceRanges[face.index];
  if (!view.mesh || !range) return p;
  const { positions, indices } = view.mesh;
  let far: Vec3 | null = null;
  let best = -1;
  for (let k = range.start; k < range.start + range.count; k++) {
    const v = indices[k];
    const q: Vec3 = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    const d = len3(sub3(q, p));
    if (d > best) {
      best = d;
      far = q;
    }
  }
  return far ? add3(p, scale3(sub3(far, p), 0.5)) : p;
}

/** The middle of a face's far edge along `n` (a side wall's rim at the opening), from its mesh; its middle without one. */
function rimOf(face: FaceInfo, n: Vec3, view: RebuildView): Vec3 {
  const range = view.mesh?.faceRanges[face.index];
  if (!view.mesh || !range) return face.centroid;
  const { positions, indices } = view.mesh;
  let top = -Infinity;
  for (let k = range.start; k < range.start + range.count; k++) {
    const v = indices[k];
    top = Math.max(top, positions[v * 3] * n[0] + positions[v * 3 + 1] * n[1] + positions[v * 3 + 2] * n[2]);
  }
  return add3(face.centroid, scale3(n, top - dot3(face.centroid, n)));
}

/** Is a 2D point inside a closed polyline (even-odd)? */
function inside2(p: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-12) + xi) c = !c;
  }
  return c;
}

/**
 * Where a sketch's extrude stands its arrows (world), and the sketch's normal:
 * the middle of its profile; when that falls on one of the origin's axes
 * (a rectangle drawn round the origin), a point inside the profile away from
 * them, so the handles are never hidden behind the origin's own arrows.
 */
export function sketchAnchor(view: RebuildView | null, sketch: string): { at: Vec3; normal: Vec3; frame: Frame; outline: Vec3[] } | null {
  const sk = view?.sketches.find((s) => s.id === sketch);
  if (!sk?.ok) return null;
  const lines = sk.polylines.filter((p) => !p.construction && !p.reference);
  const pts = lines.flatMap((p) => p.points);
  const all = pts.length ? pts : sk.points.map((p) => p.at);
  if (!all.length) return null;
  const f = sk.frame;
  const to2 = (p: Vec3): Vec2 => [dot3(sub3(p, f.origin), f.x), dot3(sub3(p, f.origin), f.y)];
  const flat = all.map(to2);
  const lo: Vec2 = [Math.min(...flat.map((p) => p[0])), Math.min(...flat.map((p) => p[1]))];
  const hi: Vec2 = [Math.max(...flat.map((p) => p[0])), Math.max(...flat.map((p) => p[1]))];
  const mid: Vec2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-6);
  const world = (p: Vec2) => to3D(f, p);
  let at = world(mid);
  if (onDefaultAxis(at, size * 0.02)) {
    // Off the axes: a quarter of the way to a corner of the profile's box, inside the profile where it can be.
    const loops = lines.map((l) => l.points.map(to2));
    const inProfile = (p: Vec2) => !loops.length || loops.some((l) => l.length > 2 && inside2(p, l));
    const candidates: Vec2[] = [
      [mid[0] + (hi[0] - lo[0]) * 0.25, mid[1] + (hi[1] - lo[1]) * 0.25],
      [mid[0] - (hi[0] - lo[0]) * 0.25, mid[1] + (hi[1] - lo[1]) * 0.25],
      [mid[0] + (hi[0] - lo[0]) * 0.25, mid[1] - (hi[1] - lo[1]) * 0.25],
      [mid[0] + (hi[0] - lo[0]) * 0.25, mid[1]],
    ];
    const pick = candidates.find((c) => inProfile(c) && !onDefaultAxis(world(c), size * 0.02)) ?? candidates[0];
    at = world(pick);
  }
  return { at, normal: f.z, frame: f, outline: all };
}

const raw = (f: Raw, key: string): unknown => key.split(".").reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? (v as Raw)[k] : undefined), f);

/** An axis (a line in the part) a feature names: a default axis, an axis feature, a straight or round edge, a round face; null when it can't be read off the view. */
export function axisOf(ref: unknown, view: RebuildView | null): { origin: Vec3; direction: Vec3 } | null {
  if (!ref || typeof ref !== "object") return null;
  const r = ref as { datum?: string; edge?: EdgeSelector; face?: FaceSelector; origin?: Vec3; direction?: Vec3; ref?: unknown };
  if (r.ref) return axisOf(r.ref, view);
  if (Array.isArray(r.origin) && Array.isArray(r.direction)) return { origin: r.origin, direction: normalize3(r.direction) };
  if (typeof r.datum === "string") {
    const d = Object.hasOwn(DEFAULT_DATUMS, r.datum) ? DEFAULT_DATUMS[r.datum] : view?.datums?.[r.datum];
    if (d?.kind === "axis") return { origin: d.origin, direction: normalize3(d.direction) };
    if (d?.kind === "plane") return { origin: d.origin, direction: normalize3(d.normal) };
    return null;
  }
  if (r.edge && view) {
    const e = selectEdges(view.edges, view.faces, r.edge).matches[0];
    if (e?.kind === "line" && e.direction) return { origin: e.start, direction: e.direction };
    if (e?.kind === "circle" && e.center && e.axis) return { origin: e.center, direction: e.axis };
    return null;
  }
  if (r.face && view) {
    const f = selectFaces(view.faces, r.face).matches[0];
    if (f?.type === "cylinder" && f.cylinder) return { origin: f.cylinder.origin, direction: f.cylinder.axis };
    if (f?.type === "plane" && f.normal) return { origin: f.centroid, direction: f.normal };
  }
  return null;
}

/** The first face a face selector (or list) finds on the view. */
function firstFace(sel: unknown, view: RebuildView | null): FaceInfo | undefined {
  if (!view || !sel) return undefined;
  const list = Array.isArray(sel) ? sel : [sel];
  for (const s of list) {
    const f = selectFaces(view.faces, s as FaceSelector).matches[0];
    if (f) return f;
  }
  return undefined;
}

/** The first edge an edge value (or the edges of its faces) finds on the view. */
function firstEdge(f: Raw, view: RebuildView | null): number | undefined {
  if (!view) return undefined;
  const sels = f.edges === undefined ? [] : Array.isArray(f.edges) ? f.edges : [f.edges];
  for (const s of sels) {
    const m = selectEdges(view.edges, view.faces, s as EdgeSelector).matches[0];
    if (m) return m.index;
  }
  const face = firstFace(f.faces, view);
  return face ? view.edges.find((e) => !e.seam && e.faces.includes(face.index))?.index : undefined;
}

/** A point along an edge (0 its start, 1 its end; a curve: its middle). */
function alongEdge(view: RebuildView, edge: number, t: number): Vec3 {
  const e = view.edges[edge];
  if (e.kind !== "line") return e.mid;
  return add3(e.start, scale3(sub3(e.end, e.start), t));
}

/** Where a seed feature stands (the middle of an extrude's profile, a hole's first centre), for a pattern's handles. */
function seedAnchor(seed: Raw | undefined, view: RebuildView | null): Vec3 | null {
  if (!seed || !view) return null;
  if ((seed.op === "extrude" || seed.op === "cut") && typeof seed.sketch === "string") {
    const a = sketchAnchor(view, seed.sketch);
    if (!a) return null;
    const off = typeof seed.startOffset === "number" ? seed.startOffset : 0;
    return add3(a.at, scale3(a.normal, off));
  }
  if (seed.op === "hole") {
    const face = firstFace(seed.face, view);
    const c = centresOf(seed)[0] as number[] | undefined;
    if (!face?.normal || !face.point || !c || c.some((x) => typeof x !== "number")) return null;
    return to3D(facePlaneFrame(face.normal, face.point), [c[0], c[1]]);
  }
  return null;
}

/** A direction a pattern runs: written out, or from a reference (an edge, an axis, a face's or plane's normal). */
function directionOf(f: Raw, n: "" | "2", view: RebuildView | null): Vec3 | null {
  const written = f[`direction${n}`];
  let d: Vec3 | null = Array.isArray(written) ? normalize3(written as Vec3) : axisOf(f[`along${n}`], view)?.direction ?? null;
  if (!d || len3(d) < 1e-9) return null;
  if (f[`reverse${n}`] === true) d = scale3(d, -1);
  return d;
}

/**
 * The handles of a feature. `resolved` has expressions evaluated (its numbers
 * place the handles); `rawFeature` is the document's (an expression there
 * locks the handle); `view` is the part the feature is built on (in a session:
 * the part before it); `features`, the features with expressions evaluated
 * (a pattern's seed, a revolve's sketch).
 */
export function featureHandles(resolved: Raw, rawFeature: Raw, view: RebuildView | null, features: Raw[] = []): FeatureHandle[] {
  const id = String(resolved.id);
  const locked = (key: string) => {
    const v = raw(rawFeature, key);
    return isExpression(v) ? `${key} is set by the expression ${v}: change it in Properties` : undefined;
  };
  const num = (key: string) => {
    const v = raw(resolved, key);
    return typeof v === "number" ? v : undefined;
  };
  const out: FeatureHandle[] = [];
  const op = resolved.op;

  if ((op === "extrude" || op === "cut") && typeof resolved.sketch === "string" && resolved.from === undefined) {
    const anchor = sketchAnchor(view, resolved.sketch);
    if (!anchor) return [];
    const d = normalize3((resolved.direction as Vec3 | undefined) ?? anchor.normal);
    const start = add3(anchor.at, scale3(anchor.normal, typeof resolved.startOffset === "number" ? resolved.startOffset : 0));
    const extent = (resolved.extent as string | undefined) ?? "blind";
    const distance = num("distance");
    if ((extent === "blind" || extent === "midplane") && distance !== undefined) {
      out.push({ id: `${id}:distance`, feature: id, key: "distance", origin: start, dir: d, value: distance, scale: extent === "midplane" ? 2 : 1, min: 0, locked: locked("distance"), label: extent === "midplane" ? "Depth (both ways)" : "Depth", snap: "length" });
    }
    const d2 = resolved.direction2 as Raw | undefined;
    if (extent !== "midplane" && d2 && (d2.extent ?? "blind") === "blind" && typeof d2.distance === "number") {
      out.push({ id: `${id}:direction2.distance`, feature: id, key: "direction2.distance", origin: start, dir: scale3(d, -1), value: d2.distance, scale: 1, min: 0, locked: locked("direction2.distance"), label: "Depth (second direction)", snap: "length" });
    }
    // The draft: an arc at a side of the profile, from straight up the wall to where the wall leans.
    const draft = num("draft.angle");
    if (draft !== undefined && distance !== undefined && extent === "blind") {
      // The middle of the profile's side toward the sketch's +x: the far x of its outline, half way up its y.
      const fr = anchor.frame;
      const xs = anchor.outline.map((p) => dot3(sub3(p, fr.origin), fr.x));
      const ys = anchor.outline.map((p) => dot3(sub3(p, fr.origin), fr.y));
      const side = to3D(fr, [Math.max(...xs), (Math.min(...ys) + Math.max(...ys)) / 2]);
      const o0 = sub3(side, anchor.at);
      const o = normalize3(len3(sub3(o0, scale3(d, dot3(o0, d)))) > 1e-9 ? sub3(o0, scale3(d, dot3(o0, d))) : anchor.frame.x);
      const outward = (resolved.draft as Raw | undefined)?.outward === true;
      out.push({
        id: `${id}:draft.angle`,
        feature: id,
        key: "draft.angle",
        kind: "angle",
        origin: add3(side, scale3(anchor.normal, typeof resolved.startOffset === "number" ? resolved.startOffset : 0)),
        dir: d,
        axis: normalize3(outward ? cross3(d, o) : cross3(o, d)),
        zero: d,
        radius: Math.max(distance * 0.8, 1),
        value: draft,
        scale: 1,
        min: 0,
        max: 45,
        locked: locked("draft.angle"),
        label: "Draft",
        snap: "angle",
      });
    }
    // Reverse: the arrow's base, a click turns it round.
    out.push({
      id: `${id}:flip`,
      feature: id,
      key: "direction",
      kind: "flip",
      origin: start,
      dir: d,
      value: 0,
      scale: 1,
      min: null,
      label: "Reverse",
      write: () => ({ direction: d.map((c) => r6(-c)) }),
    });
    return out;
  }

  if (op === "plane" && (resolved.mode ?? "offset") === "offset" && typeof resolved.distance === "number") {
    const plane = view?.datums?.[id];
    if (plane?.kind !== "plane") return [];
    // The plane's normal is its reference's, turned round when flipped; the distance runs along the reference's.
    const along = resolved.flip === true ? scale3(plane.normal, -1) : plane.normal;
    const origin = sub3(plane.origin, scale3(along, resolved.distance));
    return [{ id: `${id}:distance`, feature: id, key: "distance", origin, dir: along, value: resolved.distance, scale: 1, min: null, locked: locked("distance"), label: "Offset", snap: "length" }];
  }

  if (op === "plane" && resolved.mode === "angle" && typeof resolved.angle === "number") {
    const plane = view?.datums?.[id];
    const refs = Array.isArray(resolved.refs) ? resolved.refs : [];
    const hinge = axisOf(refs[1], view);
    const base = axisOf(refs[0], view);
    if (plane?.kind !== "plane" || !hinge || !base) return [];
    const a = normalize3(hinge.direction);
    const n0 = normalize3(sub3(base.direction, scale3(a, dot3(base.direction, a))));
    const centre = add3(hinge.origin, scale3(a, dot3(sub3(plane.origin, hinge.origin), a)));
    return [{ id: `${id}:angle`, feature: id, key: "angle", kind: "angle", origin: centre, dir: a, axis: a, zero: n0, radius: 15, value: resolved.angle, scale: 1, min: null, locked: locked("angle"), label: "Angle", snap: "angle" }];
  }

  if (op === "revolve" && typeof resolved.sketch === "string") {
    const anchor = sketchAnchor(view, resolved.sketch);
    if (!anchor) return [];
    let axis: { origin: Vec3; direction: Vec3 } | null = null;
    const ax = resolved.axis as { line?: string } | undefined;
    if (ax && typeof ax.line === "string") {
      const sk = view?.sketches.find((s) => s.id === resolved.sketch);
      const line = (sk?.entities ?? (features.find((g) => g.id === resolved.sketch)?.entities as Raw[] | undefined) ?? []).find((e) => (e as { id?: unknown }).id === ax.line) as { start?: Vec2; end?: Vec2 } | undefined;
      if (sk && line?.start && line.end) {
        const a = to3D(sk.frame, line.start);
        const b = to3D(sk.frame, line.end);
        if (len3(sub3(b, a)) > 1e-9) axis = { origin: a, direction: normalize3(sub3(b, a)) };
      }
    } else axis = axisOf(resolved.axis, view);
    if (!axis) return [];
    const dirn = resolved.reverse === true ? scale3(axis.direction, -1) : axis.direction;
    const centre = add3(axis.origin, scale3(axis.direction, dot3(sub3(anchor.at, axis.origin), axis.direction)));
    const r = len3(sub3(anchor.at, centre));
    if (r < 1e-6) return [];
    const zero = normalize3(sub3(anchor.at, centre));
    const angle = num("angle") ?? 360;
    const mid = resolved.midplane === true;
    const write = (key: "angle" | "angle2") => (_f: Raw, v: HandleValue) => ({ [key]: key === "angle" && v === 360 ? null : v });
    out.push({ id: `${id}:angle`, feature: id, key: "angle", kind: "angle", origin: centre, dir: dirn, axis: dirn, zero, radius: r, value: angle, scale: mid ? 2 : 1, min: 0, max: 360, locked: locked("angle"), label: mid ? "Angle (both ways)" : "Angle", snap: "angle", write: write("angle") });
    const angle2 = num("angle2");
    if (!mid && angle2 !== undefined) {
      out.push({ id: `${id}:angle2`, feature: id, key: "angle2", kind: "angle", origin: centre, dir: scale3(dirn, -1), axis: scale3(dirn, -1), zero, radius: r, value: angle2, scale: 1, min: 0, max: 360, locked: locked("angle2"), label: "Angle 2", snap: "angle", write: write("angle2") });
    }
    if (!mid) out.push({ id: `${id}:flip`, feature: id, key: "reverse", kind: "flip", origin: anchor.at, dir: cross3(dirn, zero), value: 0, scale: 1, min: null, label: "Reverse", write: (f) => ({ reverse: f.reverse === true ? null : true }) });
    return out;
  }

  if ((op === "fillet" || op === "chamfer") && view) {
    const edge = firstEdge(resolved, view);
    if (edge === undefined) return [];
    const e = view.edges[edge];
    // A fillet's radius is the same on both faces: its arrow runs into the wider one (it has room to be dragged out).
    const [fa, fb] = op === "fillet" && e.faces.length === 2 && widthAcross(view, e.faces[1], edge) > widthAcross(view, e.faces[0], edge) ? [e.faces[1], e.faces[0]] : e.faces;
    const variable = op === "fillet" && num("radius2") !== undefined;
    const at = variable ? alongEdge(view, edge, 0.15) : e.mid;
    const ua = fa !== undefined ? intoFace(view, edge, fa, at) : null;
    const ub = fb !== undefined ? intoFace(view, edge, fb, at) : null;
    if (!ua) return [];
    if (op === "fillet") {
      const r = num("radius");
      if (r !== undefined) out.push({ id: `${id}:radius`, feature: id, key: "radius", origin: at, dir: ua, value: r, scale: 1, min: 0, locked: locked("radius"), label: variable ? "Start radius" : "Radius", snap: "length" });
      const r2 = num("radius2");
      if (r2 !== undefined) {
        const end = alongEdge(view, edge, 0.85);
        const ue = intoFace(view, edge, fa, end) ?? ua;
        out.push({ id: `${id}:radius2`, feature: id, key: "radius2", origin: end, dir: ue, value: r2, scale: 1, min: 0, locked: locked("radius2"), label: "End radius", snap: "length" });
      }
      return out;
    }
    const d = num("distance");
    if (d === undefined) return [];
    out.push({ id: `${id}:distance`, feature: id, key: "distance", origin: at, dir: resolved.flip === true && ub ? ub : ua, value: d, scale: 1, min: 0, locked: locked("distance"), label: num("distance2") !== undefined ? "Distance 1" : "Distance", snap: "length" });
    const d2 = num("distance2");
    if (d2 !== undefined && ub) out.push({ id: `${id}:distance2`, feature: id, key: "distance2", origin: at, dir: resolved.flip === true ? ua : ub, value: d2, scale: 1, min: 0, locked: locked("distance2"), label: "Distance 2", snap: "length" });
    const angle = num("angle");
    if (angle !== undefined && ub) {
      const first = resolved.flip === true ? ub : ua;
      const other = resolved.flip === true ? ua : ub;
      const centre = add3(at, scale3(first, d));
      const zero = scale3(first, -1);
      const w = sub3(other, scale3(zero, dot3(other, zero)));
      if (len3(w) > 1e-9) out.push({ id: `${id}:angle`, feature: id, key: "angle", kind: "angle", origin: centre, dir: zero, axis: normalize3(cross3(zero, normalize3(w))), zero, radius: Math.max(d * 1.2, 1), value: angle, scale: 1, min: 0, max: 89, locked: locked("angle"), label: "Angle", snap: "angle" });
    }
    return out;
  }

  if (op === "shell" && view) {
    const faces = Array.isArray(resolved.faces) ? resolved.faces : [];
    const t = num("thickness");
    if (t === undefined) return [];
    const planes = view.faces.filter((f) => f.type === "plane" && f.normal && (typeof resolved.body !== "string" || f.body === resolved.body));
    // The way the opening faces: the removed face's normal (it is gone from the shelled part, so from its selector too).
    const removed = firstFace(faces, view);
    const open = removed?.normal ?? (faces[0] as { normal?: Vec3 } | undefined)?.normal;
    // On the rim of the widest side wall, where the wall's thickness shows (in the part before the shell and in the shelled part alike);
    // a closed shell: on its largest flat face, clear of the origin's axes.
    const side = open ? planes.filter((f) => Math.abs(dot3(f.normal!, open)) < 1e-6).sort((a, b) => b.area - a.area)[0] : undefined;
    const face = side ?? removed ?? [...planes].sort((a, b) => b.area - a.area)[0];
    if (!face?.normal) return [];
    const at = side && open ? rimOf(side, open, view) : clearOfAxes(face.centroid, face, view);
    const outward = resolved.outward === true;
    out.push({ id: `${id}:thickness`, feature: id, key: "thickness", origin: at, dir: outward ? face.normal : scale3(face.normal, -1), value: t, scale: 1, min: 0, locked: locked("thickness"), label: "Wall", snap: "length" });
    out.push({ id: `${id}:flip`, feature: id, key: "outward", kind: "flip", origin: at, dir: face.normal, value: 0, scale: 1, min: null, label: outward ? "Walls inside" : "Walls outside", write: (f) => ({ outward: f.outward === true ? null : true }) });
    return out;
  }

  if (op === "draft" && view) {
    const face = firstFace(resolved.faces, view);
    const neutral = axisOf(resolved.neutral, view);
    const angle = num("angle");
    if (!face?.normal || !neutral || angle === undefined) return [];
    const n = resolved.flip === true ? scale3(neutral.direction, -1) : neutral.direction;
    const axis = cross3(face.normal, n);
    if (len3(axis) < 1e-9) return [];
    return [{ id: `${id}:angle`, feature: id, key: "angle", kind: "angle", origin: clearOfAxes(face.centroid, face, view), dir: n, axis: normalize3(axis), zero: normalize3(n), radius: Math.max(Math.sqrt(face.area) * 0.35, 2), value: angle, scale: 1, min: 0, max: 45, locked: locked("angle"), label: "Draft", snap: "angle" }];
  }

  if (op === "hole" && view && typeof resolved.points !== "string") {
    const face = firstFace(resolved.face, view);
    if (!face?.normal || !face.point || face.type !== "plane") return [];
    const frame = facePlaneFrame(face.normal, face.point);
    const centres = centresOf(resolved) as unknown[][];
    const rawCentres = centresOf(rawFeature) as unknown[][];
    centres.forEach((c, i) => {
      if (typeof c[0] !== "number" || typeof c[1] !== "number") return;
      const expr = rawCentres[i]?.find((x) => isExpression(x));
      out.push({
        id: `${id}:center:${i}`,
        feature: id,
        key: centres.length === 1 ? "center" : "centers",
        kind: "point",
        origin: to3D(frame, [c[0], c[1]]),
        dir: face.normal!,
        frame,
        at: [c[0], c[1]],
        value: 0,
        scale: 1,
        min: null,
        locked: expr ? `the centre is set by the expression ${String(expr)}: change it in Properties` : undefined,
        label: centres.length === 1 ? "Centre" : `Centre ${i + 1}`,
        snap: "length",
        write: (f, v) => {
          const list = (centresOf(f) as unknown[][]).map((x) => [...x]);
          list[i] = v as Vec2;
          return list.length === 1 ? { center: list[0], centers: null } : { centers: list, center: null };
        },
      });
    });
    const depth = num("depth");
    const first = centres[0];
    if (depth !== undefined && typeof first?.[0] === "number" && typeof first[1] === "number") {
      out.push({ id: `${id}:depth`, feature: id, key: "depth", origin: to3D(frame, [first[0], first[1]]), dir: scale3(face.normal, -1), value: depth, scale: 1, min: 0, locked: locked("depth"), label: "Depth", snap: "length" });
    }
    return out;
  }

  if (op === "linearPattern") {
    const seed = features.find((g) => g.id === seedsOf(resolved)[0]);
    const anchor = seedAnchor(seed, view);
    if (!anchor) return [];
    for (const n of ["", "2"] as const) {
      if (n === "2" && resolved.direction2 === undefined && resolved.along2 === undefined) continue;
      const d = directionOf(resolved, n, view);
      const spacing = num(`spacing${n}`);
      const count = num(`count${n}`);
      if (!d || spacing === undefined || count === undefined || spacing <= 0) continue;
      const suffix = n ? " 2" : "";
      out.push({ id: `${id}:spacing${n}`, feature: id, key: `spacing${n}`, origin: anchor, dir: d, value: spacing, scale: 1, min: 0, locked: locked(`spacing${n}`), label: `Spacing${suffix}`, snap: "length" });
      // The count's knob sits a little past the last copy: drag it on by a spacing for one more.
      out.push({
        id: `${id}:count${n}`,
        feature: id,
        key: `count${n}`,
        origin: anchor,
        dir: d,
        value: count,
        offset: 0.6,
        scale: 1 / spacing,
        min: 2,
        max: 200,
        inclusive: true,
        locked: locked(`count${n}`),
        label: `Count${suffix}`,
        snap: "count",
        write: (f, v) => countPatch(f, n ? "count2" : "count", v),
      });
    }
    return out;
  }

  if (op === "circularPattern") {
    const seed = features.find((g) => g.id === seedsOf(resolved)[0]);
    const anchor = seedAnchor(seed, view);
    const axis = axisOf(resolved.axis, view);
    const count = num("count");
    if (!anchor || !axis || count === undefined || count < 2) return [];
    const a = resolved.reverse === true ? scale3(axis.direction, -1) : axis.direction;
    const centre = add3(axis.origin, scale3(axis.direction, dot3(sub3(anchor, axis.origin), axis.direction)));
    const r = len3(sub3(anchor, centre));
    if (r < 1e-6) return [];
    const zero = normalize3(sub3(anchor, centre));
    const span = num("angle") ?? 360;
    const full = Math.abs(span - 360) < 1e-9;
    const step = full ? 360 / count : span / (count - 1);
    out.push({
      id: `${id}:spacing`,
      feature: id,
      key: "angle",
      kind: "angle",
      origin: centre,
      dir: a,
      axis: a,
      zero,
      radius: r,
      value: r6(step),
      scale: 1,
      min: 0,
      max: 360 / (count - 1),
      locked: locked("angle") ?? locked("count"),
      label: "Spacing",
      snap: "angle",
      // Spaced this far apart: the angle the copies span (a full turn when they close it).
      write: (_f, v) => {
        const s = v as number;
        return Math.abs(s * count - 360) < 1e-6 ? { angle: null } : { angle: r6(s * (count - 1)) };
      },
    });
    out.push({
      id: `${id}:count`,
      feature: id,
      key: "count",
      kind: "angle",
      origin: centre,
      dir: a,
      axis: a,
      zero,
      radius: r,
      value: count,
      offset: 0.6,
      scale: 1 / step,
      min: 2,
      max: 200,
      inclusive: true,
      locked: locked("count"),
      label: "Count",
      snap: "count",
      write: (f, v) => countPatch(f, "count", v),
    });
    return out;
  }
  return out;
}

/**
 * The extrude or cut whose blind end a picked flat face is: the face lies on
 * the plane its depth puts the end at (the newest such feature wins, since
 * it made the face last). Null when no handle owns it.
 */
export function ownerOfFace(face: FaceInfo | undefined, resolved: Raw[], features: Raw[], view: RebuildView | null): HandleSpec | null {
  if (!face || face.type !== "plane" || !face.normal || !face.point) return null;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const f = resolved[i];
    if (f.suppressed === true) continue;
    if (f.op !== "extrude" && f.op !== "cut") continue;
    const rawF = features.find((g) => g.id === f.id) ?? f;
    for (const h of featureHandles(f, rawF, view)) {
      if (h.feature !== f.id || (h.key !== "distance" && h.key !== "direction2.distance") || h.kind) continue;
      // The face lies on the end's plane (the arrow's tip is on it, the arrow crosses it).
      if (Math.abs(dot3(normalize3(face.normal), h.dir)) < 0.1) continue;
      if (Math.abs(dot3(sub3(face.point, handleTip(h)), normalize3(face.normal))) < 1e-6) return h;
    }
  }
  return null;
}

/** Is v a usable direction? */
export function usable(v: Vec3): boolean {
  return len3(v) > 1e-9;
}
