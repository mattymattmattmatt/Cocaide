// The things in a view you can pick up in VR: the furniture. A part's bodies
// are items; in an assembly, each body of each component (its own name on its
// part). Only furniture moves (walls, benches and robes stay put): a body in a
// part or component named for furniture, or a body named like a piece of it
// (bed, sofa, chair, table, stool, desk...). Pure.

import type { Vec3 } from "../../doc/types";
import type { RebuildView } from "../../worker/protocol";

export interface VrItem {
  /** "component/body", or the body in a part. */
  key: string;
  /** The view's body: the component in an assembly, the body in a part. */
  body: string;
  /** In an assembly: the body's name on its part. */
  partBody?: string;
  faces: number[];
  min: Vec3;
  max: Vec3;
  movable: boolean;
}

const FURNITURE_PART = /furni|loose|fitout-loose/i;
const FURNITURE_BODY = /^(bed|beds|bedside|sofa|couch|chair|chairs|stool|table|desk|armchair|ottoman|lounge|tv|dresser|drawers?_chest|bench_seat|outdoor|daybed_loose|rug|lamp|plant|car)(_|\d|$)/i;

/** Whether a body is furniture (it can be moved in VR). */
export function isFurniture(body: string, partBody?: string): boolean {
  if (FURNITURE_PART.test(body)) return true;
  const own = partBody ?? body;
  return FURNITURE_BODY.test(own);
}

/** The view's items, each body (or component body) once, with its faces and box. */
export function itemsOf(view: RebuildView | null): VrItem[] {
  if (!view?.mesh) return [];
  const m = view.mesh;
  const by = new Map<string, VrItem>();
  view.faces.forEach((f, i) => {
    const body = f.body ?? "";
    const key = f.partBody !== undefined ? `${body}/${f.partBody}` : body;
    let it = by.get(key);
    if (!it) {
      it = { key, body, ...(f.partBody !== undefined ? { partBody: f.partBody } : {}), faces: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], movable: isFurniture(body, f.partBody) };
      by.set(key, it);
    }
    it.faces.push(i);
    const r = m.faceRanges[i];
    if (!r) return;
    for (let t = r.start; t < r.start + r.count; t++) {
      const v = m.indices[t] * 3;
      for (let k = 0; k < 3; k++) {
        const x = m.positions[v + k];
        if (x < it.min[k]) it.min[k] = x;
        if (x > it.max[k]) it.max[k] = x;
      }
    }
  });
  return [...by.values()].filter((it) => Number.isFinite(it.min[0]));
}

/** An item's triangles as a flat list of points (x y z, three a triangle), for a copy of it to carry or ghost. */
export function itemTriangles(view: RebuildView, item: VrItem): Float32Array {
  const m = view.mesh!;
  let n = 0;
  for (const i of item.faces) n += m.faceRanges[i]?.count ?? 0;
  const out = new Float32Array(n * 3);
  let o = 0;
  for (const i of item.faces) {
    const r = m.faceRanges[i];
    if (!r) continue;
    for (let t = r.start; t < r.start + r.count; t++) {
      const v = m.indices[t] * 3;
      out[o++] = m.positions[v];
      out[o++] = m.positions[v + 1];
      out[o++] = m.positions[v + 2];
    }
  }
  return out;
}

/** The item a face belongs to. */
export function itemOfFace(items: VrItem[], face: number): VrItem | null {
  return items.find((it) => it.faces.includes(face)) ?? null;
}

/** The middle of an item's box. */
export const centreOf = (it: { min: Vec3; max: Vec3 }): Vec3 => [(it.min[0] + it.max[0]) / 2, (it.min[1] + it.max[1]) / 2, (it.min[2] + it.max[2]) / 2];

/** The item named by a move (its body, and component when in an assembly). */
export function itemOfMove(items: VrItem[], move: { body: string; component?: string }): VrItem | null {
  return items.find((it) => (move.component !== undefined ? it.body === move.component && it.partBody === move.body : it.body === move.body && it.partBody === undefined)) ?? null;
}

/** A point turned about Z by `deg` about `c`, then moved by `d` (what a move does to a point). */
export function moved(p: Vec3, c: Vec3, deg: number, d: Vec3): Vec3 {
  const a = (deg * Math.PI) / 180;
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + x * Math.cos(a) - y * Math.sin(a) + d[0], c[1] + x * Math.sin(a) + y * Math.cos(a) + d[1], p[2] + d[2]];
}
