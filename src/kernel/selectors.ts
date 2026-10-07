// Selectors are queries, re-run after every rebuild. A selector that does not
// resolve to what the operation needs is an error, never a guess.

import type { EdgeSelector, FaceSelector } from "../doc/types";
import { dot3, formatDirection, normalize3 } from "../geom/vec";
import type { EdgeInfo, FaceInfo } from "./topology";

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

// ----------------------------------------------------------------- edges

export interface EdgeSelection {
  matches: EdgeInfo[];
  tie?: "longest" | "shortest";
  /** A nested face selector could not resolve (empty or tied); the message says which. */
  error?: string;
}

export function selectEdges(edges: EdgeInfo[], faces: FaceInfo[], sel: EdgeSelector, path = "edges"): EdgeSelection {
  const faceSet = (fs: FaceSelector, where: string): Set<number> | string => {
    const r = selectFaces(faces, fs);
    if (r.matches.length === 0) return `${where}: selector matched 0 faces (wanted ${describeWanted(fs, 1)} or more)`;
    if (r.tie) return `${where}: selector matched ${r.matches.length} faces tied for ${r.tie} area`;
    return new Set(r.matches.map((f) => f.index));
  };
  let on: Set<number> | undefined;
  let between: [Set<number>, Set<number>] | undefined;
  if (sel.onFace) {
    const r = faceSet(sel.onFace, `${path}.onFace`);
    if (typeof r === "string") return { matches: [], error: r };
    on = r;
  }
  if (sel.between) {
    const a = faceSet(sel.between[0], `${path}.between[0]`);
    if (typeof a === "string") return { matches: [], error: a };
    const b = faceSet(sel.between[1], `${path}.between[1]`);
    if (typeof b === "string") return { matches: [], error: b };
    between = [a, b];
  }
  const matches = edges.filter((e) => {
    if (e.seam) return false;
    if (sel.kind && e.kind !== sel.kind) return false;
    if (sel.direction && (e.kind !== "line" || Math.abs(dot3(e.direction!, normalize3(sel.direction))) < 1 - ANGLE_TOL)) return false;
    if (sel.radius !== undefined && (e.kind !== "circle" || Math.abs(e.radius! - sel.radius) > LENGTH_TOL)) return false;
    if (sel.length !== undefined && Math.abs(e.length - sel.length) > LENGTH_TOL) return false;
    if (on && !e.faces.some((f) => on!.has(f))) return false;
    if (between) {
      const [a, b] = between;
      const ok = e.faces.some((fa) => a.has(fa) && e.faces.some((fb) => fb !== fa && b.has(fb)));
      if (!ok) return false;
    }
    return true;
  });
  if (sel.pick === "all" || matches.length <= 1) return { matches };
  const sign = sel.pick === "longest" ? 1 : -1;
  const best = Math.max(...matches.map((e) => sign * e.length));
  const top = matches.filter((e) => Math.abs(sign * e.length - best) <= LENGTH_TOL);
  return top.length > 1 ? { matches: top, tie: sel.pick } : { matches: top };
}

/** "line edges parallel to +Z on the planar face normal +Z", for error messages. */
export function describeEdgeSelector(sel: EdgeSelector): string {
  const parts = [sel.kind ? `${sel.kind} edges` : "edges"];
  if (sel.direction) parts.push(`parallel to ${formatDirection(sel.direction)}`);
  if (sel.radius !== undefined) parts.push(`radius ${sel.radius}`);
  if (sel.length !== undefined) parts.push(`length ${sel.length}`);
  if (sel.onFace) parts.push(`on ${describeWanted(sel.onFace, 1).replace(/^1 /, "the ")}`);
  if (sel.between) {
    parts.push(
      `between ${describeWanted(sel.between[0], 1).replace(/^1 /, "the ")} and ${describeWanted(sel.between[1], 1).replace(/^1 /, "the ")}`,
    );
  }
  if (sel.pick !== "all") parts.push(`(${sel.pick})`);
  return parts.join(" ");
}

/** Error text when an edge selection is empty, ambiguous or broken; null when usable. */
export function edgeSelectionError(sel: EdgeSelector, result: EdgeSelection, path = "edges"): string | null {
  if (result.error) return result.error;
  if (result.tie) {
    return `${path}: selector matched ${result.matches.length} edges tied for ${result.tie} (wanted 1 of ${describeEdgeSelector(sel)})`;
  }
  if (result.matches.length === 0) return `${path}: selector matched 0 edges (wanted ${describeEdgeSelector(sel)})`;
  return null;
}
