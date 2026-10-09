// What the viewport draws of the reference geometry, as SOLIDWORKS shows it:
// the default planes (Front, Top, Right) hidden until selected or shown with
// their eye; plane, axis and point features shown; each one's eye in the tree
// and a "Planes" toggle for all of them. Planes are rectangles sized to the
// part (its bounding box seen along the plane's normal, plus a margin; about
// 100 mm with no part), axes run across the part, points are markers.
// Showing and hiding is view state, never the document: it is remembered per
// browser. Pure: Vitest covers it in node (the hook at the end only stores it).

import { useCallback, useState } from "react";
import type { Vec3 } from "../../doc/types";
import { DEFAULT_DATUMS, type Datum } from "../../features/datum";
import { add3, cross3, dot3, normalize3, scale3, sub3 } from "../../geom/vec";

/** The default reference geometry the tree lists at its top, in SOLIDWORKS's order. */
export const TREE_DATUMS = ["Front", "Top", "Right", "Origin"] as const;
/** The defaults that are planes. */
export const DEFAULT_PLANES = ["Front", "Top", "Right"] as const;

export interface Box {
  min: Vec3;
  max: Vec3;
}

/** One plane, axis or point to draw. */
export type DatumShape =
  | { kind: "plane"; id: string; isDefault: boolean; corners: [Vec3, Vec3, Vec3, Vec3]; normal: Vec3; label: Vec3 }
  | { kind: "axis"; id: string; isDefault: boolean; ends: [Vec3, Vec3]; label: Vec3 }
  | { kind: "point"; id: string; isDefault: boolean; at: Vec3; label: Vec3 };

/** Half the side of a plane with no part to fit: a 100 mm square. */
const EMPTY_HALF = 50;

/** The box's eight corners. */
function corners(b: Box): Vec3[] {
  return Array.from({ length: 8 }, (_, i) => [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]] as Vec3);
}

/** A margin around a span of `size` mm: a tenth of it, at least 5 mm. */
const margin = (size: number) => Math.max(5, size * 0.1);

/**
 * A plane's rectangle: the part's box seen along its normal (and, for a
 * default plane, the origin too, so it sits round the origin as in
 * SOLIDWORKS), plus a margin; a 100 mm square on the plane's origin with no
 * part. Corners in order round the rectangle; the label at its far corner.
 */
export function planeRect(d: Extract<Datum, { kind: "plane" }>, box: Box | null, isDefault = false): { corners: [Vec3, Vec3, Vec3, Vec3]; label: Vec3 } {
  const n = normalize3(d.normal);
  const x = normalize3(d.xDir);
  const y = cross3(n, x);
  let [u0, u1, v0, v1] = [-EMPTY_HALF, EMPTY_HALF, -EMPTY_HALF, EMPTY_HALF];
  if (box) {
    const pts = corners(box).map((p) => sub3(p, d.origin));
    const us = pts.map((p) => dot3(p, x));
    const vs = pts.map((p) => dot3(p, y));
    if (isDefault) us.push(0), vs.push(0);
    [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
    const m = margin(Math.max(u1 - u0, v1 - v0));
    [u0, u1, v0, v1] = [u0 - m, u1 + m, v0 - m, v1 + m];
  }
  const at = (u: number, v: number) => add3(d.origin, add3(scale3(x, u), scale3(y, v)));
  return { corners: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)], label: at(u0, v1) };
}

/** An axis's two ends: across the part's box (seen along the axis) plus a margin; 100 mm long round its origin with no part. */
export function axisEnds(d: Extract<Datum, { kind: "axis" }>, box: Box | null): [Vec3, Vec3] {
  const u = normalize3(d.direction);
  let [t0, t1] = [-EMPTY_HALF, EMPTY_HALF];
  if (box) {
    const ts = corners(box).map((p) => dot3(sub3(p, d.origin), u));
    [t0, t1] = [Math.min(...ts), Math.max(...ts)];
    const m = margin(t1 - t0);
    [t0, t1] = [t0 - m, t1 + m];
  }
  return [add3(d.origin, scale3(u, t0)), add3(d.origin, scale3(u, t1))];
}

/** The shapes to draw for these datums (by id, in order), sized to the part. */
export function datumShapes(datums: Readonly<Record<string, Datum>>, box: Box | null): DatumShape[] {
  return Object.entries(datums).map(([id, d]): DatumShape => {
    const isDefault = Object.hasOwn(DEFAULT_DATUMS, id);
    if (d.kind === "plane") {
      const r = planeRect(d, box, isDefault);
      return { kind: "plane", id, isDefault, corners: r.corners, normal: normalize3(d.normal), label: r.label };
    }
    if (d.kind === "axis") {
      const ends = axisEnds(d, box);
      return { kind: "axis", id, isDefault, ends, label: ends[1] };
    }
    return { kind: "point", id, isDefault, at: d.at, label: d.at };
  });
}

// ---------------------------------------------------------------- showing and hiding

/** What the user has shown and hidden: per reference (by id), and all planes, axes and points at once. */
export interface DatumView {
  /** Eye toggles: true shown, false hidden; absent, the default (default planes hidden, the rest shown). */
  shown: Record<string, boolean>;
  /** The "Planes" view toggle: off hides every plane, axis and point (the origin keeps its own eye). */
  planes: boolean;
}

export const DEFAULT_DATUM_VIEW: DatumView = { shown: {}, planes: true };

/** Shown unless toggled: plane, axis and point features, and the origin; not the default planes. */
export function shownByDefault(id: string): boolean {
  return !(DEFAULT_PLANES as readonly string[]).includes(id);
}

/** Is the reference's eye open (shown when not selected)? */
export function eyeOpen(id: string, v: DatumView): boolean {
  return v.shown[id] ?? shownByDefault(id);
}

/** Is it drawn now? A selected one always is (as SOLIDWORKS shows a plane picked in the tree). */
export function datumVisible(id: string, v: DatumView, selected: readonly string[] = []): boolean {
  if (selected.includes(id)) return true;
  if (!v.planes && id !== "Origin") return false;
  return eyeOpen(id, v);
}

/** The view after the eye of `id` is clicked: it flips; an override equal to the default is dropped. */
export function toggleEye(v: DatumView, id: string): DatumView {
  const open = !eyeOpen(id, v);
  const shown = { ...v.shown };
  if (open === shownByDefault(id)) delete shown[id];
  else shown[id] = open;
  return { ...v, shown };
}

/** The view after "Show"/"Hide" on one reference: also turns "Planes" on when showing one while all are hidden. */
export function setShown(v: DatumView, id: string, open: boolean): DatumView {
  const shown = { ...v.shown };
  if (open === shownByDefault(id)) delete shown[id];
  else shown[id] = open;
  return { shown, planes: open && id !== "Origin" ? true : v.planes };
}

/** A stored view, checked: anything malformed is the default. */
export function parseDatumView(text: string | null): DatumView {
  try {
    const v = text ? JSON.parse(text) : null;
    if (!v || typeof v !== "object" || typeof v.planes !== "boolean" || typeof v.shown !== "object" || v.shown === null) return DEFAULT_DATUM_VIEW;
    const shown = Object.fromEntries(Object.entries(v.shown as Record<string, unknown>).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
    return { shown, planes: v.planes };
  } catch {
    return DEFAULT_DATUM_VIEW;
  }
}

const STORE = "cocaide.datumView.v1";

/** The datum view state, remembered in this browser (a private window may refuse: it then holds for this visit). */
export function useDatumView(): [DatumView, (next: DatumView) => void] {
  const [view, setView] = useState<DatumView>(() => {
    try {
      return parseDatumView(localStorage.getItem(STORE));
    } catch {
      return DEFAULT_DATUM_VIEW;
    }
  });
  const set = useCallback((next: DatumView) => {
    setView(next);
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      // Storage refused: the choice still holds until the page is closed.
    }
  }, []);
  return [view, set];
}
