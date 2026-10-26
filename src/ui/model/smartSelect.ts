// Smart selection (Phase P wave 2): from one edge or face picked, the edges
// and faces that go with it, the usual CAD helpers. On an edge: its tangency
// chain (the edges that run on smoothly from it, as a fillet's boundary
// does), the loop it is in (the boundary of the face beside it, the one under
// the pointer), every edge of that face. On a face: the faces that run on
// smoothly from it, the edges of one of its loops. And whether an edge is
// convex (an outside corner, rounded off by a fillet) or concave (an inside
// corner, filled by one).
//
// Pure: works on the rebuild's FaceInfo and EdgeInfo (and its mesh, for the
// tangents of curved edges and the normals of curved faces), so it runs in
// node for the tests.

import type { Vec3 } from "../../doc/types";
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from "../../geom/vec";
import type { EdgeInfo, FaceInfo } from "../../kernel/topology";
import type { MeshData } from "../../kernel/mesh";

/** What the helpers read: the rebuild's faces and edges, and its mesh when there is one. */
export interface PartTopology {
  faces: FaceInfo[];
  edges: EdgeInfo[];
  mesh?: MeshData | null;
}

/** Two directions this close to parallel (or anti-parallel) are tangent: about 3°. */
const TANGENT_COS = Math.cos((3 * Math.PI) / 180);
const KEY = 1e3;

/** A vertex by where it is (to a micrometre): edges that end there share it. */
export const vertexKey = (p: Vec3) => p.map((x) => Math.round(x * KEY) + 0).join(",");

/** The edges that count: real ones, not the seam where a round face meets itself. */
const real = (e: EdgeInfo | undefined): e is EdgeInfo => !!e && !e.seam;

/** For each vertex (by key), the edges that end there. */
function vertexEdges(t: PartTopology): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const e of t.edges) {
    if (!real(e)) continue;
    for (const p of [e.start, e.end]) {
      const k = vertexKey(p);
      const list = out.get(k) ?? [];
      if (!list.includes(e.index)) list.push(e.index);
      out.set(k, list);
    }
  }
  return out;
}

/** The mesh polyline of an edge, as points in order (empty without a mesh). */
function edgePolyline(t: PartTopology, i: number): Vec3[] {
  const r = t.mesh?.edgeRanges[i];
  const segs = t.mesh?.edges;
  if (!r || !segs) return [];
  const pts: Vec3[] = [];
  for (let k = r.start; k < r.start + r.count; k++) {
    const a: Vec3 = [segs[k * 6], segs[k * 6 + 1], segs[k * 6 + 2]];
    const b: Vec3 = [segs[k * 6 + 3], segs[k * 6 + 4], segs[k * 6 + 5]];
    if (!pts.length) pts.push(a);
    pts.push(b);
  }
  return pts;
}

/** The edge's direction where it ends at `p` (its sign does not matter: tangency is about lines). */
export function tangentAt(t: PartTopology, i: number, p: Vec3): Vec3 | null {
  const e = t.edges[i];
  if (!e) return null;
  if (e.kind === "line" && e.direction) return e.direction;
  if (e.kind === "circle" && e.center && e.axis) {
    const r = sub3(p, e.center);
    const d = cross3(e.axis, r);
    return len3(d) > 1e-12 ? normalize3(d) : null;
  }
  // A curve: the mesh segment that touches the end, else the chord to its middle.
  const pts = edgePolyline(t, i);
  if (pts.length >= 2) {
    const near = (q: Vec3) => len3(sub3(q, p));
    const first = near(pts[0]) <= near(pts[pts.length - 1]);
    const [a, b] = first ? [pts[0], pts[1]] : [pts[pts.length - 2], pts[pts.length - 1]];
    const d = sub3(b, a);
    if (len3(d) > 1e-12) return normalize3(d);
  }
  const d = sub3(e.mid, p);
  return len3(d) > 1e-12 ? normalize3(d) : null;
}

/** Are these two directions tangent (parallel either way, within about 3°)? */
const tangent = (a: Vec3 | null, b: Vec3 | null) => !!a && !!b && Math.abs(dot3(a, b)) >= TANGENT_COS;

/**
 * The edge's tangency chain: it and every edge reached from it through
 * vertices where the next edge runs on smoothly (a fillet's boundary, a slot's
 * outline), the clicked edge first. A sharp corner ends it; at a vertex where
 * three or more tangent edges meet, all of them go on.
 */
export function tangencyChain(t: PartTopology, start: number): number[] {
  if (!real(t.edges[start])) return [];
  const byVertex = vertexEdges(t);
  const seen = new Set([start]);
  const out = [start];
  const queue = [start];
  while (queue.length) {
    const i = queue.shift()!;
    const e = t.edges[i];
    for (const p of [e.start, e.end]) {
      const here = tangentAt(t, i, p);
      for (const j of byVertex.get(vertexKey(p)) ?? []) {
        if (seen.has(j)) continue;
        if (!tangent(here, tangentAt(t, j, p))) continue;
        seen.add(j);
        out.push(j);
        queue.push(j);
      }
    }
  }
  return out;
}

/** The face's edges, split into its loops (edges joined end to end): the outer boundary and each hole's. */
export function faceLoops(t: PartTopology, face: number): number[][] {
  const mine = t.edges.filter((e) => real(e) && e.faces.includes(face)).map((e) => e.index);
  const left = new Set(mine);
  const loops: number[][] = [];
  while (left.size) {
    const first = left.values().next().value!;
    left.delete(first);
    const loop = [first];
    const keys = new Set([vertexKey(t.edges[first].start), vertexKey(t.edges[first].end)]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const j of [...left]) {
        const e = t.edges[j];
        const a = vertexKey(e.start);
        const b = vertexKey(e.end);
        if (keys.has(a) || keys.has(b)) {
          left.delete(j);
          loop.push(j);
          keys.add(a);
          keys.add(b);
          grew = true;
        }
      }
    }
    loops.push(loop);
  }
  return loops;
}

/** Of the faces an edge bounds, the one meant: the face under the pointer beside it when known, else a flat one, else the first. */
export function faceBeside(t: PartTopology, edge: number, under?: number): number | undefined {
  const e = t.edges[edge];
  if (!real(e)) return undefined;
  if (under !== undefined && e.faces.includes(under)) return under;
  return e.faces.find((f) => t.faces[f]?.type === "plane") ?? e.faces[0];
}

/** The loop the edge is in, on the face beside it (the one under the pointer): the edge first. */
export function loopOf(t: PartTopology, edge: number, under?: number): number[] {
  const face = faceBeside(t, edge, under);
  if (face === undefined) return [];
  const loop = faceLoops(t, face).find((l) => l.includes(edge)) ?? [edge];
  return [edge, ...loop.filter((i) => i !== edge)];
}

/** Every edge of the face beside the edge (the one under the pointer). */
export function faceEdgesOf(t: PartTopology, edge: number, under?: number): number[] {
  const face = faceBeside(t, edge, under);
  if (face === undefined) return [];
  return [edge, ...faceLoops(t, face).flat().filter((i) => i !== edge)];
}

/** The loop of a face nearest a point on it (where it was clicked): its outer boundary, or a hole's edge round it. */
export function faceLoopNear(t: PartTopology, face: number, p?: Vec3): number[] {
  const loops = faceLoops(t, face);
  if (loops.length <= 1 || !p) return loops[0] ?? [];
  const distance = (loop: number[]) => Math.min(...loop.map((i) => pointToEdge(t, i, p)));
  return [...loops].sort((a, b) => distance(a) - distance(b))[0];
}

/** How far a point is from an edge (its mesh polyline, or its ends and middle). */
function pointToEdge(t: PartTopology, i: number, p: Vec3): number {
  const pts = edgePolyline(t, i);
  const e = t.edges[i];
  const list = pts.length >= 2 ? pts : [e.start, e.mid, e.end];
  let best = Infinity;
  for (let k = 0; k + 1 < list.length; k++) best = Math.min(best, pointToSegment(p, list[k], list[k + 1]));
  return best;
}

function pointToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub3(b, a);
  const l2 = dot3(ab, ab);
  const s = l2 > 0 ? Math.max(0, Math.min(1, dot3(sub3(p, a), ab) / l2)) : 0;
  return len3(sub3(p, add3(a, scale3(ab, s))));
}

/** A face's outward normal at a point on (or by) it: a plane's own; a cylinder's from its axis; else the nearest mesh vertex's. */
export function normalAt(t: PartTopology, face: number, p: Vec3): Vec3 | null {
  const f = t.faces[face];
  if (!f) return null;
  if (f.type === "plane" && f.normal) return f.normal;
  if (f.type === "cylinder" && f.cylinder) {
    const c = f.cylinder;
    const r = sub3(p, c.origin);
    const radial = sub3(r, scale3(c.axis, dot3(r, c.axis)));
    if (len3(radial) < 1e-12) return null;
    const n = normalize3(radial);
    return c.concave ? scale3(n, -1) : n;
  }
  const range = t.mesh?.faceRanges[face];
  if (!t.mesh || !range) return null;
  const { positions, normals, indices } = t.mesh;
  let best = -1;
  let bestD = Infinity;
  for (let k = range.start; k < range.start + range.count; k++) {
    const v = indices[k];
    const d = (positions[v * 3] - p[0]) ** 2 + (positions[v * 3 + 1] - p[1]) ** 2 + (positions[v * 3 + 2] - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  if (best < 0) return null;
  return normalize3([normals[best * 3], normals[best * 3 + 1], normals[best * 3 + 2]]);
}

/** Do the two faces meet smoothly along this edge (their normals agree at its middle)? */
export function smoothAlong(t: PartTopology, edge: number): boolean {
  const e = t.edges[edge];
  if (!real(e) || e.faces.length !== 2) return false;
  const [a, b] = e.faces.map((f) => normalAt(t, f, e.mid));
  return !!a && !!b && dot3(a, b) >= TANGENT_COS;
}

/** The face and every face that runs on smoothly from it (across edges where they meet tangentially), it first. */
export function tangentFaces(t: PartTopology, start: number): number[] {
  if (!t.faces[start]) return [];
  const seen = new Set([start]);
  const out = [start];
  const queue = [start];
  while (queue.length) {
    const f = queue.shift()!;
    for (const e of t.edges) {
      if (!real(e) || !e.faces.includes(f) || e.faces.length !== 2) continue;
      const other = e.faces[0] === f ? e.faces[1] : e.faces[0];
      if (seen.has(other) || !smoothAlong(t, e.index)) continue;
      seen.add(other);
      out.push(other);
      queue.push(other);
    }
  }
  return out;
}

export type Convexity = "convex" | "concave" | "smooth";

/** A point of the face near `p` but off the edge: the middle of its mesh triangle nearest `p`, else its centroid. */
function pointInside(t: PartTopology, face: number, p: Vec3): Vec3 | null {
  const range = t.mesh?.faceRanges[face];
  if (t.mesh && range && range.count >= 3) {
    const { positions, indices } = t.mesh;
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (let k = range.start; k + 2 < range.start + range.count; k += 3) {
      const c: Vec3 = [0, 0, 0];
      for (let j = 0; j < 3; j++) for (let a = 0; a < 3; a++) c[a] += positions[indices[k + j] * 3 + a] / 3;
      const d = len3(sub3(c, p));
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) return best;
  }
  return t.faces[face]?.centroid ?? null;
}

/**
 * From the middle of an edge, the way into one of the faces it bounds (in the
 * face, square to the edge): where a fillet's or chamfer's edge on that face
 * runs. Null when it can't be told.
 */
export function intoFace(t: PartTopology, edge: number, face: number, at?: Vec3): Vec3 | null {
  const e = t.edges[edge];
  if (!real(e)) return null;
  const m = at ?? e.mid;
  const along = tangentAt(t, edge, m);
  const n = normalAt(t, face, m);
  if (!along || !n) return null;
  const u = cross3(n, along);
  if (len3(u) < 1e-12) return null;
  const inside = pointInside(t, face, m);
  if (!inside) return null;
  return dot3(sub3(inside, m), u) >= 0 ? normalize3(u) : scale3(normalize3(u), -1);
}

/**
 * An outside corner (convex: a fillet rounds it off, taking material away),
 * an inside one (concave: a fillet fills it), or neither (the faces meet
 * smoothly there). From the edge's middle, step into one face (square to the
 * edge, in that face): at a convex edge that goes below the other face's
 * tangent plane, at a concave one above it.
 */
export function convexity(t: PartTopology, edge: number): Convexity {
  const e = t.edges[edge];
  if (!real(e) || e.faces.length !== 2) return "smooth";
  if (smoothAlong(t, edge)) return "smooth";
  const m = e.mid;
  const along = tangentAt(t, edge, m);
  if (!along) return "smooth";
  /** The direction from the edge into the face, in the face (square to the edge). */
  const into = (face: number, n: Vec3): Vec3 | null => {
    const u = cross3(n, along);
    if (len3(u) < 1e-12) return null;
    const inside = pointInside(t, face, m);
    if (!inside) return null;
    const s = dot3(sub3(inside, m), u);
    return s >= 0 ? normalize3(u) : scale3(normalize3(u), -1);
  };
  const [fa, fb] = e.faces;
  const na = normalAt(t, fa, m);
  const nb = normalAt(t, fb, m);
  if (!na || !nb) return "smooth";
  const ua = into(fa, na);
  const ub = into(fb, nb);
  if (!ua || !ub) return "smooth";
  const s = dot3(ua, nb) + dot3(ub, na);
  return s < -1e-6 ? "convex" : s > 1e-6 ? "concave" : "smooth";
}

/** Edge picks a fillet or chamfer field keeps: all of them, only outside corners, or only inside ones. */
export type EdgeKindFilter = "all" | "convex" | "concave";

export function passes(t: PartTopology, edge: number, filter: EdgeKindFilter): boolean {
  if (filter === "all") return true;
  const c = convexity(t, edge);
  return c === "smooth" || c === filter;
}
