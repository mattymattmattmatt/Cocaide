// Section view: a plane through the part, the side its normal points to cut
// away, the cut faces capped in a hatch. View state only (never the
// document). The plane is a default plane, a plane feature or a flat face,
// moved along its normal by an offset and optionally flipped. Pure.

import type { Vec3 } from "../../doc/types";
import { DEFAULT_DATUMS, type Datum } from "../../features/datum";
import { add3, dot3, normalize3, scale3 } from "../../geom/vec";
import type { FaceInfo } from "../../kernel/topology";
import { DEFAULT_DATUM_LABEL } from "../model/selection";

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
}

/** The plane as drawn: the normal points into the side cut away; points with normal·p > constant are removed. */
export function sectionPlane(s: SectionState): { normal: Vec3; point: Vec3; constant: number } {
  const n = normalize3(s.normal);
  const point = add3(s.origin, scale3(n, s.offset));
  const normal = s.flip ? scale3(n, -1) : n;
  return { normal, point, constant: dot3(normal, point) };
}

/** Is a point cut away (on the removed side, beyond a hair)? */
export function isCutAway(s: SectionState | null, p: Vec3): boolean {
  if (!s) return false;
  const { normal, constant } = sectionPlane(s);
  return dot3(normal, p) - constant > 1e-6;
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

/** Half the part's extent along a normal, and its middle, from the bounding box: where the offset slider runs. */
export function extentAlong(normal: Vec3, origin: Vec3, box: { min: Vec3; max: Vec3 } | null): { min: number; max: number; middle: number } {
  const n = normalize3(normal);
  if (!box) return { min: -50, max: 50, middle: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) {
        const t = dot3([x, y, z], n) - dot3(origin, n);
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
  return { min: lo, max: hi, middle: (lo + hi) / 2 };
}

/**
 * A section on `on`: a default plane or plane feature by id, or the flat face
 * given. It starts through the middle of the part (rounded to a millimetre),
 * which is where a section is usually wanted; a face's starts on the face, a
 * hair inside it.
 */
export function sectionOn(on: string, datums: Readonly<Record<string, Datum>>, box: { min: Vec3; max: Vec3 } | null, face?: FaceInfo): SectionState | string {
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
