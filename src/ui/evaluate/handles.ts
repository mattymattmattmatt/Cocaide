// Direct manipulation (drag handles): an arrow on an extrude's end or on an
// offset plane that you drag to change its depth or offset, live, and which
// writes the new number back to the one parameter that owns it (one undo
// step). Which handles a feature has, where they sit, how a drag along one
// turns into a parameter value (snapped to whole millimetres), and which
// feature owns a picked end face: all here, pure, so Vitest covers it.

import type { Vec3 } from "../../doc/types";
import { isExpression } from "../../doc/parameters";
import { add3, dot3, len3, normalize3, scale3, sub3 } from "../../geom/vec";
import type { FaceInfo } from "../../kernel/topology";
import type { RebuildView } from "../../worker/protocol";
import { fmt } from "../model/selection";
import type { Raw } from "../model/ToolContext";

export interface HandleSpec {
  /** "<feature>:<key>" */
  id: string;
  feature: string;
  /** The parameter it drives: "distance" (a top-level field) or "direction2.distance"; a section plane's "offset". */
  key: "distance" | "direction2.distance" | "offset";
  /** Where the parameter is 0 along the arrow, and the arrow's unit direction. */
  origin: Vec3;
  dir: Vec3;
  /** The parameter now. */
  value: number;
  /** How much the parameter changes per mm the handle moves along `dir` (2 for a midplane extrude, whose end moves half as far). */
  scale: number;
  /** The least the parameter may be (a depth stays above 0; an offset may go negative). */
  min: number | null;
  /** Why it can't be dragged (an expression sets the value), or undefined. */
  locked?: string;
  /** "Depth", "Offset", "Depth (second direction)". */
  label: string;
  /** A section plane's arrow (view state, not a feature): the view moves the plane itself. */
  kind?: "section";
  /** Which section plane (0–2). */
  plane?: number;
}

/** A feature's handle (never a section plane's): its key is a feature parameter. */
export type FeatureHandle = HandleSpec & { key: "distance" | "direction2.distance" };

/** Where the arrow's tip is now: the end the parameter puts it at. */
export function handleTip(h: HandleSpec, value = h.value): Vec3 {
  return add3(h.origin, scale3(h.dir, value / h.scale));
}

/** The middle of the profile a sketch outlines (world): where its extrude's arrows stand. */
export function sketchAnchor(view: RebuildView | null, sketch: string): { at: Vec3; normal: Vec3 } | null {
  const sk = view?.sketches.find((s) => s.id === sketch);
  if (!sk?.ok) return null;
  const pts = sk.polylines.filter((p) => !p.construction && !p.reference).flatMap((p) => p.points);
  const all = pts.length ? pts : sk.points.map((p) => p.at);
  if (!all.length) return null;
  const sum = all.reduce((s, p) => add3(s, p), [0, 0, 0] as Vec3);
  return { at: scale3(sum, 1 / all.length), normal: sk.frame.z };
}

const raw = (f: Raw, key: string): unknown => (key.includes(".") ? (f[key.split(".")[0]] as Raw | undefined)?.[key.split(".")[1]] : f[key]);

/**
 * The handles of a feature: an extrude or cut's blind (or midplane) depth in
 * each direction, an offset plane's distance. `resolved` has expressions
 * evaluated (its numbers place the arrows); `rawFeature` is the document's
 * (an expression there locks the handle).
 */
export function featureHandles(resolved: Raw, rawFeature: Raw, view: RebuildView | null): FeatureHandle[] {
  const id = String(resolved.id);
  const locked = (key: string) => {
    const v = raw(rawFeature, key);
    return isExpression(v) ? `${key} is set by the expression ${v}: change it in Properties` : undefined;
  };
  if ((resolved.op === "extrude" || resolved.op === "cut") && typeof resolved.sketch === "string" && resolved.from === undefined) {
    const anchor = sketchAnchor(view, resolved.sketch);
    if (!anchor) return [];
    const d = normalize3((resolved.direction as Vec3 | undefined) ?? anchor.normal);
    const start = add3(anchor.at, scale3(anchor.normal, typeof resolved.startOffset === "number" ? resolved.startOffset : 0));
    const extent = (resolved.extent as string | undefined) ?? "blind";
    const out: FeatureHandle[] = [];
    if ((extent === "blind" || extent === "midplane") && typeof resolved.distance === "number") {
      out.push({
        id: `${id}:distance`,
        feature: id,
        key: "distance",
        origin: start,
        dir: d,
        value: resolved.distance,
        scale: extent === "midplane" ? 2 : 1,
        min: 0,
        locked: locked("distance"),
        label: extent === "midplane" ? "Depth (both ways)" : "Depth",
      });
    }
    const d2 = resolved.direction2 as Raw | undefined;
    if (extent !== "midplane" && d2 && (d2.extent ?? "blind") === "blind" && typeof d2.distance === "number") {
      out.push({ id: `${id}:direction2.distance`, feature: id, key: "direction2.distance", origin: start, dir: scale3(d, -1), value: d2.distance, scale: 1, min: 0, locked: locked("direction2.distance"), label: "Depth (second direction)" });
    }
    return out;
  }
  if (resolved.op === "plane" && (resolved.mode ?? "offset") === "offset" && typeof resolved.distance === "number") {
    const plane = view?.datums?.[id];
    if (plane?.kind !== "plane") return [];
    // The plane's normal is its reference's, turned round when flipped; the distance runs along the reference's.
    const along = resolved.flip === true ? scale3(plane.normal, -1) : plane.normal;
    const origin = sub3(plane.origin, scale3(along, resolved.distance));
    return [{ id: `${id}:distance`, feature: id, key: "distance", origin, dir: along, value: resolved.distance, scale: 1, min: null, locked: locked("distance"), label: "Offset" }];
  }
  return [];
}

/**
 * The parameter a drag gives: the start value moved by how far the pointer
 * went along the arrow (`moved`, mm), snapped to whole millimetres (`fine`:
 * tenths), never below the handle's least value (then one step above it).
 */
export function dragValue(h: HandleSpec, start: number, moved: number, fine = false): number {
  const step = fine ? 0.1 : 1;
  let v = Math.round((start + moved * h.scale) / step) * step;
  v = Math.round(v * 1e6) / 1e6 + 0;
  if (h.min !== null && v <= h.min) v = h.min + step;
  return Math.round(v * 1e6) / 1e6 + 0;
}

/** The patch that sets a handle's parameter (nested fields are sent whole: patches are shallow). */
export function handlePatch(h: HandleSpec, f: Raw, value: number): Raw {
  if (h.key === "distance") return { distance: value };
  return { direction2: { ...((f.direction2 as Raw | undefined) ?? {}), distance: value } };
}

/** The ruler's ticks along a handle: every 1, 5, 10… mm, whichever keeps them `minPx` apart on screen. */
export function rulerStep(pxPerMm: number, minPx = 6): number {
  for (const s of [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) if (s * pxPerMm >= minPx) return s;
  return 1000;
}

/** "Depth 12 mm". */
export function handleText(h: HandleSpec, value = h.value): string {
  return `${fmt(value)} mm`;
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
    const rawF = features.find((g) => g.id === f.id) ?? f;
    for (const h of featureHandles(f, rawF, view)) {
      if (h.feature !== f.id || (f.op !== "extrude" && f.op !== "cut")) continue;
      // The face lies on the end's plane (the arrow's tip is on it, the arrow crosses it).
      if (Math.abs(dot3(normalize3(face.normal), h.dir)) < 0.1) continue;
      if (Math.abs(dot3(sub3(face.point, handleTip(h)), normalize3(face.normal))) < 1e-6) return h;
    }
  }
  return null;
}

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

/** Is v a usable direction? */
export function usable(v: Vec3): boolean {
  return len3(v) > 1e-9;
}
