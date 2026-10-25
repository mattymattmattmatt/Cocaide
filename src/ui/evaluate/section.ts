// Section view: up to three planes through the part, cutting away the region
// on the cut side of every plane that is on (one plane: a half; two: a corner
// cut, as the usual CAD tools do), the cut faces capped in a hatch. View state
// only (never the document; remembered per document in this browser). Each
// plane is a default plane, a plane feature or a flat face, moved along its
// normal by an offset, tilted about its own two in-plane axes, and optionally
// flipped. Which bodies are cut can be chosen (the others stay whole). Pure.

import type { Vec3 } from "../../doc/types";
import { DEFAULT_DATUMS, type Datum } from "../../features/datum";
import { planeFrame } from "../../geom/frame";
import { add3, dot3, formatDirection, normalize3, scale3, sub3 } from "../../geom/vec";
import type { FaceInfo } from "../../kernel/topology";
import { DEFAULT_DATUM_LABEL } from "../model/selection";

/** One section plane. */
export interface SectionState {
  /** What the plane is: "Front", "Top", "Right", a plane feature's id, or "face" (a flat face, as it was when picked). */
  on: string;
  /** "Front plane", "plane_1", "Selected face". */
  label: string;
  /** The base plane: a point on it and its normal. */
  origin: Vec3;
  normal: Vec3;
  /** mm along the base normal. */
  offset: number;
  /** Cut away the other side. */
  flip: boolean;
  /** Degrees about the plane's first and second in-plane axes (see planeAxes), turning it about the point the offset puts it at. */
  tilt?: [number, number];
  /** Off: this plane cuts nothing (it keeps its settings). Default on. */
  enabled?: boolean;
}

/** The whole section view: its planes and how it is shown. */
export interface SectionView {
  /** One to three planes. */
  planes: SectionState[];
  /** Shown (the view bar's toggle): off keeps every setting for next time. */
  on: boolean;
  /** The plane the panel shows (an index into planes). */
  active: number;
  /** Draw each plane as a light rectangle with its drag arrow. */
  showPlane: boolean;
  /** The bodies cut (the others shown whole); null: every body. */
  bodies: string[] | null;
  /** The cut faces in one colour, or each in its body's colour. */
  capColour: "single" | "bodies";
  /** The panel folded to its title. */
  collapsed?: boolean;
}

export const MAX_SECTION_PLANES = 3;
/** Tilt limit, degrees either way: further, the plane is nearly along its own offset and can't be dragged sensibly. */
export const MAX_TILT = 85;

const D2R = Math.PI / 180;

/** The base plane's in-plane axes, by the sketch-plane rule: Top → X, Y; Front → X, Z; Right → Y, Z. */
export function planeAxes(normal: Vec3): { u: Vec3; v: Vec3 } {
  const f = planeFrame(normal, [0, 0, 0]);
  return { u: f.x, v: f.y };
}

/** "X" for an axis-aligned direction (either way), else null. */
export function axisWord(v: Vec3): string | null {
  const w = formatDirection(v);
  return /^[+-][XYZ]$/.test(w) ? w.slice(1) : null;
}

/**
 * The plane as it cuts: the point the offset puts it at (the tilt turns about
 * it), its normal tilted (`along`, unflipped: the way the offset grows) and
 * the normal into the side cut away (`normal`, after the flip), its tilted
 * in-plane axes, and the plane equation (normal·p > constant is cut away).
 */
export function sectionFrame(s: SectionState): { point: Vec3; along: Vec3; normal: Vec3; u: Vec3; v: Vec3; constant: number; cosTilt: number } {
  const n = normalize3(s.normal);
  const { u, v } = planeAxes(n);
  const point = add3(s.origin, scale3(n, s.offset));
  const [a, b] = (s.tilt ?? [0, 0]).map((x) => x * D2R);
  // About u by a, then about v by b, in the frame (u, v, n).
  const rot = (x: number, y: number, z: number): Vec3 => {
    // About u (local x): y, z turn.
    const y1 = y * Math.cos(a) - z * Math.sin(a);
    const z1 = y * Math.sin(a) + z * Math.cos(a);
    // About v (local y): x, z turn.
    const x2 = x * Math.cos(b) + z1 * Math.sin(b);
    const z2 = -x * Math.sin(b) + z1 * Math.cos(b);
    return add3(add3(scale3(u, x2), scale3(v, y1)), scale3(n, z2));
  };
  const along = normalize3(rot(0, 0, 1));
  const tu = normalize3(rot(1, 0, 0));
  const tv = normalize3(rot(0, 1, 0));
  const normal = s.flip ? scale3(along, -1) : along;
  return { point, along, normal, u: tu, v: tv, constant: dot3(normal, point), cosTilt: dot3(along, n) };
}

/** The plane as drawn: the normal points into the side cut away; points with normal·p > constant are removed. */
export function sectionPlane(s: SectionState): { normal: Vec3; point: Vec3; constant: number } {
  const f = sectionFrame(s);
  return { normal: f.normal, point: f.point, constant: f.constant };
}

/** Is a point cut away by this one plane (on the removed side, beyond a hair)? */
export function isCutAway(s: SectionState | null, p: Vec3): boolean {
  if (!s) return false;
  const { normal, constant } = sectionPlane(s);
  return dot3(normal, p) - constant > 1e-6;
}

/** The planes that cut now: none while the view is off, else the ones switched on. */
export function activePlanes(view: SectionView | null): SectionState[] {
  if (!view || !view.on) return [];
  return view.planes.filter((p) => p.enabled !== false);
}

/** Is this body cut by the section (the others are shown whole)? */
export function cutsBody(view: SectionView | null, body: string | undefined): boolean {
  if (!view || !view.bodies) return true;
  return body === undefined ? true : view.bodies.includes(body);
}

/**
 * Is a point cut away by the section view: on the cut side of every active
 * plane (a corner cut with two or three), in a body that is cut.
 */
export function cutAwayBy(view: SectionView | null, p: Vec3, body?: string): boolean {
  const planes = activePlanes(view);
  if (!planes.length || !cutsBody(view, body)) return false;
  return planes.every((s) => isCutAway(s, p));
}

/** The planes a section can be on: the three default planes, then the plane features that built. */
export function sectionChoices(datums: Readonly<Record<string, Datum>> = {}): { id: string; label: string }[] {
  return [
    ...(["Front", "Top", "Right"] as const).map((id) => ({ id, label: DEFAULT_DATUM_LABEL[id] })),
    ...Object.entries(datums)
      .filter(([, d]) => d.kind === "plane")
      .map(([id]) => ({ id, label: id })),
  ];
}

type Box = { min: Vec3; max: Vec3 };

const corners = (box: Box): Vec3[] => {
  const out: Vec3[] = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) out.push([x, y, z]);
  return out;
};

/** Half the part's extent along a normal, and its middle, from the bounding box: where the offset slider runs. */
export function extentAlong(normal: Vec3, origin: Vec3, box: Box | null): { min: number; max: number; middle: number } {
  const n = normalize3(normal);
  if (!box) return { min: -50, max: 50, middle: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of corners(box)) {
    const t = dot3(c, n) - dot3(origin, n);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return { min: lo, max: hi, middle: (lo + hi) / 2 };
}

/**
 * The plane drawn over the part: a rectangle on the (tilted) plane, round the
 * part's box as seen square to the plane, with a margin; its corners in
 * order, its middle, and where the drag arrow stands: on its far edge along
 * the plane's second axis, a quarter of the way along from the end the first
 * axis starts at (clear of the part, and of the origin's triad, which stands
 * right under the edge's middle on a part drawn round the origin).
 */
export function sectionRect(s: SectionState, box: Box | null, margin = 0.08): { corners: [Vec3, Vec3, Vec3, Vec3]; centre: Vec3; anchor: Vec3 } {
  const f = sectionFrame(s);
  const pts = box ? corners(box) : [add3(f.point, scale3(add3(f.u, f.v), 50)), sub3(f.point, scale3(add3(f.u, f.v), 50))];
  let a0 = Infinity;
  let a1 = -Infinity;
  let b0 = Infinity;
  let b1 = -Infinity;
  for (const p of pts) {
    const d = sub3(p, f.point);
    const a = dot3(d, f.u);
    const b = dot3(d, f.v);
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
    b0 = Math.min(b0, b);
    b1 = Math.max(b1, b);
  }
  const m = Math.max(a1 - a0, b1 - b0, 1) * margin;
  [a0, a1, b0, b1] = [a0 - m, a1 + m, b0 - m, b1 + m];
  const at = (a: number, b: number) => add3(f.point, add3(scale3(f.u, a), scale3(f.v, b)));
  return { corners: [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)], centre: at((a0 + a1) / 2, (b0 + b1) / 2), anchor: at(a0 + (a1 - a0) / 4, b1) };
}

/**
 * The drag arrow on a plane: it stands on the rectangle's far edge (see
 * sectionRect) and points the way the offset grows (along the tilted normal). `origin` is where the
 * arrow's foot would be at offset 0; the foot is at origin + dir · offset /
 * scale (scale: offset per mm the plane moves, 1 / cos of the tilt). Null when
 * the plane is tilted too far to drag along its normal.
 */
export function offsetArrow(s: SectionState, box: Box | null): { origin: Vec3; dir: Vec3; scale: number; tip: Vec3 } | null {
  const f = sectionFrame(s);
  if (f.cosTilt < 0.1) return null;
  // The anchor moves straight along the tilted normal as the offset changes (by cos tilt per mm of offset).
  const { anchor } = sectionRect(s, box);
  const scale = 1 / f.cosTilt;
  const origin = sub3(anchor, scale3(f.along, s.offset / scale));
  return { origin, dir: f.along, scale, tip: anchor };
}

/**
 * A section on `on`: a default plane or plane feature by id, or the flat face
 * given. It starts through the middle of the part (rounded to a millimetre),
 * which is where a section is usually wanted; a face's starts on the face, a
 * hair inside it.
 */
export function sectionOn(on: string, datums: Readonly<Record<string, Datum>>, box: Box | null, face?: FaceInfo): SectionState | string {
  if (on === "face") {
    if (!face || face.type !== "plane" || !face.normal || !face.point) return "Section on a face needs one flat face: click it first.";
    // Cut away what is in front of the face (the way it faces), just inside it: the face itself stays.
    return { on, label: "Selected face", origin: face.point, normal: face.normal, offset: -0.01, flip: false };
  }
  const d = Object.hasOwn(DEFAULT_DATUMS, on) ? DEFAULT_DATUMS[on] : datums[on];
  if (!d || d.kind !== "plane") return `${on} is not a plane.`;
  const ext = extentAlong(d.normal, d.origin, box);
  const offset = Object.hasOwn(DEFAULT_DATUMS, on) ? Math.round(ext.middle) : 0;
  return { on, label: Object.hasOwn(DEFAULT_DATUM_LABEL, on) ? DEFAULT_DATUM_LABEL[on] : on, origin: d.origin, normal: d.normal, offset, flip: false };
}

/** A section view of one plane, shown, with the plane drawn. */
export function sectionViewOf(first: SectionState): SectionView {
  return { planes: [first], on: true, active: 0, showPlane: true, bodies: null, capColour: "single" };
}

/**
 * Another plane for the view (up to three): the first default plane not in
 * use yet (Front, Top, Right), through the middle of the part. The same view
 * when it already has three.
 */
export function addPlane(view: SectionView, datums: Readonly<Record<string, Datum>>, box: Box | null): SectionView {
  if (view.planes.length >= MAX_SECTION_PLANES) return view;
  const used = new Set(view.planes.map((p) => p.on));
  const id = (["Front", "Top", "Right"] as const).find((x) => !used.has(x)) ?? "Front";
  const s = sectionOn(id, datums, box) as SectionState;
  return { ...view, planes: [...view.planes, s], active: view.planes.length, on: true };
}

/** The view without plane i (the last plane can't go: close the view instead). */
export function removePlane(view: SectionView, i: number): SectionView {
  if (view.planes.length <= 1 || i < 0 || i >= view.planes.length) return view;
  const planes = view.planes.filter((_, k) => k !== i);
  return { ...view, planes, active: Math.min(view.active > i ? view.active - 1 : view.active, planes.length - 1) };
}

/** The view with plane i changed. */
export function setPlane(view: SectionView, i: number, next: SectionState): SectionView {
  return { ...view, planes: view.planes.map((p, k) => (k === i ? next : p)) };
}

/**
 * Planes on plane features follow them: moved when the feature moves; a
 * plane whose feature is gone is dropped (named in `gone`); the view is null
 * when no plane is left. The same object back when nothing changed.
 */
export function followDatums(view: SectionView, datums: Readonly<Record<string, Datum>>): { view: SectionView | null; gone: string[] } {
  const gone: string[] = [];
  let changed = false;
  const same = (a: readonly number[], b: readonly number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  const planes: SectionState[] = [];
  for (const p of view.planes) {
    if (p.on === "face" || Object.hasOwn(DEFAULT_DATUMS, p.on)) {
      planes.push(p);
      continue;
    }
    const d = datums[p.on];
    if (d?.kind !== "plane") {
      gone.push(p.on);
      changed = true;
      continue;
    }
    if (!same(d.origin, p.origin) || !same(d.normal, p.normal)) {
      planes.push({ ...p, origin: d.origin, normal: d.normal });
      changed = true;
    } else planes.push(p);
  }
  if (!changed) return { view, gone };
  if (!planes.length) return { view: null, gone };
  return { view: { ...view, planes, active: Math.min(view.active, planes.length - 1) }, gone };
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** One stored plane made safe, or null. */
function parsePlane(raw: unknown): SectionState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.on !== "string" || !isVec3(r.origin) || !isVec3(r.normal) || Math.hypot(...r.normal) < 1e-9) return null;
  const s: SectionState = { on: r.on, label: typeof r.label === "string" ? r.label : r.on, origin: r.origin, normal: r.normal, offset: num(r.offset, 0), flip: r.flip === true };
  if (Array.isArray(r.tilt) && r.tilt.length === 2) {
    const t = r.tilt.map((x) => Math.max(-MAX_TILT, Math.min(MAX_TILT, num(x, 0)))) as [number, number];
    if (t[0] || t[1]) s.tilt = t;
  }
  if (r.enabled === false) s.enabled = false;
  return s;
}

/**
 * A stored section view made safe: anything odd is dropped (null when no
 * plane survives). A single plane as stored before (one SectionState) reads
 * as a view of that plane.
 */
export function parseSectionView(raw: unknown): SectionView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.planes)) {
    const one = parsePlane(raw);
    return one ? sectionViewOf(one) : null;
  }
  const planes = r.planes.map(parsePlane).filter((p): p is SectionState => !!p).slice(0, MAX_SECTION_PLANES);
  if (!planes.length) return null;
  return {
    planes,
    on: r.on !== false,
    active: Math.max(0, Math.min(planes.length - 1, Math.round(num(r.active, 0)))),
    showPlane: r.showPlane !== false,
    bodies: Array.isArray(r.bodies) ? r.bodies.filter((b): b is string => typeof b === "string") : null,
    capColour: r.capColour === "bodies" ? "bodies" : "single",
    ...(r.collapsed === true ? { collapsed: true } : {}),
  };
}

/** "Tilt about X" for an axis-aligned in-plane axis, else "Tilt 1" / "Tilt 2". */
export function tiltLabels(s: SectionState): [string, string] {
  const { u, v } = planeAxes(s.normal);
  const a = axisWord(u);
  const b = axisWord(v);
  return [a ? `Tilt about ${a}` : "Tilt 1", b ? `Tilt about ${b}` : "Tilt 2"];
}

/** The cut side in words, for the panel: "cuts away +Y" (the way the normal into the cut points), or the direction. */
export function cutSideText(s: SectionState): string {
  const n = sectionFrame(s).normal;
  return `cuts away the ${formatDirection(n)} side`;
}

