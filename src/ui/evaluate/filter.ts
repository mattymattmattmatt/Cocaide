// Selection filters and box selection in the 3D view. With a filter on, a
// click picks only those kinds (faces, edges, vertices, planes/axes/points);
// with none on, anything. A box dragged left to right (window) selects what
// lies wholly inside it; right to left (crossing), what it touches. Pure:
// the viewport projects the part to screen pixels and hands the points here.

import type { Vec2 } from "../../doc/types";
import type { PickTarget, Selection, VertexPick } from "../model/selection";

export type FilterKind = "faces" | "edges" | "vertices" | "planes";
export type SelectFilter = ReadonlySet<FilterKind>;

export const NO_FILTER: SelectFilter = new Set();
export const FILTER_KINDS: { kind: FilterKind; label: string; command: string }[] = [
  { kind: "faces", label: "Faces", command: "select.faces" },
  { kind: "edges", label: "Edges", command: "select.edges" },
  { kind: "vertices", label: "Vertices", command: "select.vertices" },
  { kind: "planes", label: "Planes, axes and points", command: "select.planes" },
];

/** The filter with one kind switched on or off. */
export function toggleFilter(f: SelectFilter, kind: FilterKind): SelectFilter {
  const next = new Set(f);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next;
}

/** May a click pick this kind of thing? */
export function allows(f: SelectFilter, kind: PickTarget["kind"]): boolean {
  if (f.size === 0) return true;
  return f.has(kind === "face" ? "faces" : kind === "edge" ? "edges" : kind === "vertex" ? "vertices" : "planes");
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The rectangle with its corners in order; `crossing` when it was dragged right to left. */
export function boxOf(from: Vec2, to: Vec2): { rect: Rect; crossing: boolean } {
  return {
    rect: { x0: Math.min(from[0], to[0]), y0: Math.min(from[1], to[1]), x1: Math.max(from[0], to[0]), y1: Math.max(from[1], to[1]) },
    crossing: to[0] < from[0],
  };
}

export const inRect = (r: Rect, p: Vec2) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;

/** Does segment ab cross or touch the rectangle? */
export function segmentTouches(r: Rect, a: Vec2, b: Vec2): boolean {
  if (inRect(r, a) || inRect(r, b)) return true;
  const corners: Vec2[] = [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x1, r.y1],
    [r.x0, r.y1],
  ];
  return corners.some((c, i) => segmentsCross(a, b, c, corners[(i + 1) % 4]));
}

function segmentsCross(p: Vec2, q: Vec2, r: Vec2, s: Vec2): boolean {
  const o = (a: Vec2, b: Vec2, c: Vec2) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(p, q, r) !== o(p, q, s) && o(r, s, p) !== o(r, s, q);
}

/** Does triangle abc overlap the rectangle? */
export function triangleTouches(r: Rect, a: Vec2, b: Vec2, c: Vec2): boolean {
  if (segmentTouches(r, a, b) || segmentTouches(r, b, c) || segmentTouches(r, c, a)) return true;
  // The rectangle wholly inside the triangle.
  const p: Vec2 = [r.x0, r.y0];
  const s = (u: Vec2, v: Vec2) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const [d1, d2, d3] = [s(a, b), s(b, c), s(c, a)];
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** The part as the box sees it: on-screen pixels (null: behind the camera or cut away). */
export interface Projected {
  /** Per face: its triangles, as screen points. */
  faces: (Vec2 | null)[][][];
  /** Per edge: its polyline segments, as screen points. */
  edges: [Vec2 | null, Vec2 | null][][];
  /** Each vertex of the part (one edge end standing for it). */
  vertices: (VertexPick & { p: Vec2 | null })[];
}

/**
 * What a box selects. With no filter it selects faces; the Edges and Vertices
 * filters make it select those (planes are not boxed). Things hidden behind
 * the camera are left out; a window needs every point inside.
 */
export function boxSelect(r: Rect, crossing: boolean, part: Projected, filter: SelectFilter, skip: { faces?: (i: number) => boolean; edges?: (i: number) => boolean } = {}): Selection {
  const want = filter.size === 0 ? new Set<FilterKind>(["faces"]) : filter;
  const faces: number[] = [];
  const edges: number[] = [];
  const vertices: VertexPick[] = [];
  if (want.has("faces")) {
    part.faces.forEach((tris, i) => {
      if (skip.faces?.(i) || !tris.length) return;
      const pts = tris.flat();
      if (pts.some((p) => !p)) return;
      const ok = crossing ? tris.some(([a, b, c]) => triangleTouches(r, a!, b!, c!)) : pts.every((p) => inRect(r, p!));
      if (ok) faces.push(i);
    });
  }
  if (want.has("edges")) {
    part.edges.forEach((segs, i) => {
      if (skip.edges?.(i) || !segs.length) return;
      if (segs.some(([a, b]) => !a || !b)) return;
      const ok = crossing ? segs.some(([a, b]) => segmentTouches(r, a!, b!)) : segs.every(([a, b]) => inRect(r, a!) && inRect(r, b!));
      if (ok) edges.push(i);
    });
  }
  if (want.has("vertices")) for (const v of part.vertices) if (v.p && inRect(r, v.p)) vertices.push({ edge: v.edge, at: v.at });
  return { faces, edges, ...(vertices.length ? { vertices } : {}) };
}

/** A box's picks added to the selection (Ctrl or Shift held), or in place of it. */
export function mergeBox(sel: Selection, box: Selection, additive: boolean): Selection {
  if (!additive) return box;
  const union = <T>(a: T[] | undefined, b: T[] | undefined, key: (x: T) => string) => {
    const seen = new Set((a ?? []).map(key));
    return [...(a ?? []), ...(b ?? []).filter((x) => !seen.has(key(x)))];
  };
  const vertices = union(sel.vertices, box.vertices, (v) => `${v.edge}:${v.at}`);
  return { ...sel, faces: union(sel.faces, box.faces, String), edges: union(sel.edges, box.edges, String), ...(vertices.length ? { vertices } : {}) };
}
