// Selectors are queries, re-run after every rebuild. A selector that does not
// resolve to what the operation needs is an error, never a guess.

import type { FaceSelector } from "../doc/types";
import { dot3, formatDirection, normalize3 } from "../geom/vec";
import type { FaceInfo } from "./topology";

const ANGLE_TOL = 1e-9;
const LENGTH_TOL = 1e-6;
const AREA_REL_TOL = 1e-9;

export interface Selection {
  matches: FaceInfo[];
  /** Set when `pick` could not choose because several faces tie. */
  tie?: "largest" | "smallest";
}

export function selectFaces(infos: FaceInfo[], selector: FaceSelector): Selection {
  const matches = infos.filter((f) => matchesFace(f, selector));
  if (selector.pick === "all" || matches.length <= 1) return { matches };
  const sign = selector.pick === "largest" ? 1 : -1;
  const best = Math.max(...matches.map((f) => sign * f.area));
  const tol = AREA_REL_TOL * Math.max(1, Math.abs(best));
  const top = matches.filter((f) => Math.abs(sign * f.area - best) <= tol);
  return top.length > 1 ? { matches: top, tie: selector.pick } : { matches: top };
}

function matchesFace(f: FaceInfo, sel: FaceSelector): boolean {
  if (sel.type === "planar") {
    if (f.type !== "plane" || !f.normal) return false;
    if (dot3(f.normal, normalize3(sel.normal)) < 1 - ANGLE_TOL) return false;
    if (sel.offset !== undefined && Math.abs((f.offset ?? NaN) - sel.offset) > LENGTH_TOL) return false;
    return true;
  }
  if (f.type !== "cylinder" || !f.cylinder) return false;
  if (sel.radius !== undefined && Math.abs(f.cylinder.radius - sel.radius) > LENGTH_TOL) return false;
  if (sel.axis !== undefined && Math.abs(dot3(f.cylinder.axis, normalize3(sel.axis))) < 1 - ANGLE_TOL) return false;
  return true;
}

/** "1 planar face normal +Z", "1 cylindrical face radius 3.3", ... */
export function describeWanted(sel: FaceSelector, count: number): string {
  const noun = count === 1 ? "face" : "faces";
  if (sel.type === "planar") {
    const at = sel.offset === undefined ? "" : ` at offset ${sel.offset}`;
    return `${count} planar ${noun} normal ${formatDirection(sel.normal)}${at}`;
  }
  const parts = [`${count} cylindrical ${noun}`];
  if (sel.radius !== undefined) parts.push(`radius ${sel.radius}`);
  if (sel.axis !== undefined) parts.push(`axis ${formatDirection(sel.axis)}`);
  return parts.join(" ");
}

/** Error text for a selection that is not exactly `wanted` faces, or null when it is. */
export function selectionError(sel: FaceSelector, result: Selection, wanted: number): string | null {
  if (result.matches.length === wanted) return null;
  const n = result.matches.length;
  const tied = result.tie ? ` tied for ${result.tie} area` : "";
  return `selector matched ${n} ${n === 1 ? "face" : "faces"}${tied} (wanted ${describeWanted(sel, wanted)})`;
}
