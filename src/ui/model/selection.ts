// What is selected in the 3D view, and how a click changes it, as SOLIDWORKS
// does: a plain click selects that one face or edge; Ctrl- or Shift-click adds
// it, or takes it out again if it was in. Faces and edges mix freely.
//
// Pure: no three.js, so Vitest covers it in node.

import type { Vec3 } from "../../doc/types";
import { formatDirection } from "../../geom/vec";
import type { EdgeInfo, FaceInfo } from "../../kernel/topology";

/** A click on the part: which B-rep face or edge, and where. */
export type PickTarget = { kind: "face" | "edge"; index: number; point: Vec3 };

export interface Selection {
  faces: number[];
  edges: number[];
  /** Where the last face was clicked; a new hole goes here. */
  point?: Vec3;
}

export const EMPTY_SELECTION: Selection = { faces: [], edges: [] };

/**
 * The selection after a click on `target` (null: empty space). `additive`
 * when Ctrl, Shift or Cmd is held: the target goes in, or comes out if it
 * was in; a click on empty space then keeps what is selected.
 */
export function pickInto(sel: Selection, target: PickTarget | null, additive: boolean): Selection {
  if (!target) return additive ? sel : EMPTY_SELECTION;
  if (!additive) return target.kind === "face" ? { faces: [target.index], edges: [], point: target.point } : { faces: [], edges: [target.index] };
  if (target.kind === "edge") {
    const has = sel.edges.includes(target.index);
    return { ...sel, edges: has ? sel.edges.filter((e) => e !== target.index) : [...sel.edges, target.index] };
  }
  if (sel.faces.includes(target.index)) {
    const faces = sel.faces.filter((f) => f !== target.index);
    // The click point belongs to the face clicked last: with no face left there is none.
    const { point: _point, ...rest } = sel;
    return faces.length ? { ...sel, faces } : { ...rest, faces };
  }
  return { ...sel, faces: [...sel.faces, target.index], point: target.point };
}

/** "planar face of base · normal +Z · offset 6", for a face under the pointer or selected alone. */
export function describeFace(f: FaceInfo | undefined): string {
  if (!f) return "face";
  const of = f.body ? ` of ${f.body}` : "";
  if (f.type === "plane" && f.normal) return `planar face${of} · normal ${formatDirection(f.normal)} · offset ${fmt(f.offset ?? 0)}`;
  if (f.type === "cylinder" && f.cylinder) return `cylindrical face${of} · Ø${fmt(2 * f.cylinder.radius)} · ${f.cylinder.concave ? "hole wall" : "boss"}`;
  return (f.type === "cone" ? "conical face" : "freeform face") + of;
}

/** "straight edge · +X · length 80", for an edge under the pointer or selected alone. */
export function describeEdge(e: EdgeInfo | undefined): string {
  if (!e) return "edge";
  const of = e.body ? ` of ${e.body}` : "";
  if (e.kind === "line") return `straight edge${of} · ${formatDirection(e.direction!)} · length ${fmt(e.length)}`;
  if (e.kind === "circle") return `circular edge${of} · Ø${fmt(2 * e.radius!)}`;
  return `curved edge${of} · length ${fmt(e.length)}`;
}

/**
 * The selection chip's text: one face or edge described, more counted
 * ("3 faces", "2 faces + 1 edge"). Empty when nothing is selected.
 */
export function selectionText(sel: Selection, faces: FaceInfo[], edges: EdgeInfo[]): string {
  const nf = sel.faces.length;
  const ne = sel.edges.length;
  if (nf === 1 && ne === 0) return describeFace(faces[sel.faces[0]]);
  if (ne === 1 && nf === 0) return describeEdge(edges[sel.edges[0]]);
  return [nf ? `${nf} face${nf === 1 ? "" : "s"}` : "", ne ? `${ne} edge${ne === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ");
}

export function fmt(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}
