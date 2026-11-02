// Face and edge provenance (Phase P): which feature made each face and edge
// of the part, and which later features changed it.
//
// How it is worked out. After every feature commits, the part's faces and
// edges are described and matched against what was there before the feature:
// a face lying on the same surface (the same plane, the same cylinder: its
// faceSignature) whose bounding box overlaps a face that was there before is
// that face carried on (it keeps its maker; when its extent changed, the
// feature is added to the ones that modified it); any other face is new, made
// by this feature. Edges go the same way by the line or circle they lie on.
//
// This is geometric matching, not the kernel's shape history. It is used for
// every op alike, so a registry op (src/features/<op>/kernel.ts) gets it
// without doing anything, and it needs nothing kept between rebuilds: the
// answer is the same whichever way the part was built. What it reads as one
// face: a face trimmed by a fillet, a top face a slot cut in two (both pieces
// keep the block's extrude as their maker), two coplanar faces a boss merged.
// What it reads as new: a pattern's copy of a boss whose top lies in the
// seed's plane but elsewhere on it (no overlap), every fillet, hole wall and
// chamfer face. A freeform face (no plane or cylinder) is matched by its
// centre, so one that a later feature trims reads as made by that feature.
//
// Cost: one description of the part's faces (and edges) per feature, plus a
// bounding box per face.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../doc/types";
import { dist3, dot3, scale3, sub3 } from "../geom/vec";
import type { OC, Scope } from "./oc";
import { describeFaces, edgeInfo, faceSignature, listEdges, type EdgeInfo, type FaceInfo } from "./topology";

/** Who made a face or an edge, and who changed it since. */
export interface Origin {
  createdBy: string;
  modifiedBy: string[];
}

/** An axis-aligned box: [min, max]. */
export type Box = [Vec3, Vec3];

/** A face or edge as the matching sees it: what it lies on, where it is, how big it is. */
export interface Snap {
  sig: string;
  box: Box;
  /** Area of a face, length of an edge. */
  size: number;
  centroid: Vec3;
}

export interface Traced extends Snap, Origin {}

/** How far apart two boxes may be and still count as touching (mm). */
const BOX_TOL = 1e-4;
/** Same size and centre within these: the face was left as it was. */
const SAME_REL = 1e-6;
const SAME_DIST = 1e-6;

/**
 * The line or circle an edge lies on, independent of where it ends: a line's
 * direction (sign-free) and its point nearest the origin; a circle's centre,
 * axis (sign-free) and radius. Others by their centre.
 */
export function edgeSignature(e: EdgeInfo): string {
  const r = (x: number, q: number) => Math.round(x / q) * q + 0;
  const v = (a: Vec3, q: number) => a.map((x) => r(x, q).toFixed(6)).join(",");
  const signFree = (d: Vec3): Vec3 => {
    const k = d.findIndex((x) => Math.abs(x) > 1e-9);
    return k >= 0 && d[k] < 0 ? scale3(d, -1) : d;
  };
  if (e.kind === "line" && e.direction) {
    const d = signFree(e.direction);
    const foot = sub3(e.start, scale3(d, dot3(e.start, d)));
    return `line ${v(d, 1e-4)} ${v(foot, 1e-3)}`;
  }
  if (e.kind === "circle" && e.center && e.axis && e.radius !== undefined) {
    return `circle ${r(e.radius, 1e-4).toFixed(4)} ${v(signFree(e.axis), 1e-4)} ${v(e.center, 1e-3)}`;
  }
  return `${e.kind} ${v(e.centroid, 1e-2)}`;
}

/** An edge's box from the points known about it (a whole circle: its centre ± radius). */
export function edgeBox(e: EdgeInfo): Box {
  const pts: Vec3[] = [e.start, e.end, e.mid];
  if (e.kind === "circle" && e.center && e.radius !== undefined && dist3(e.start, e.end) < 1e-9) {
    for (let k = 0; k < 3; k++) {
      const lo: Vec3 = [...e.center];
      const hi: Vec3 = [...e.center];
      lo[k] -= e.radius;
      hi[k] += e.radius;
      pts.push(lo, hi);
    }
  }
  return boxOf(pts);
}

export function boxOf(points: Vec3[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[k]);
    max[k] = Math.max(max[k], p[k]);
  }
  return [min, max];
}

/** How much two boxes overlap (a product of the overlaps along each axis, each padded by BOX_TOL); 0 when they do not touch. */
export function overlap(a: Box, b: Box): number {
  let out = 1;
  for (let k = 0; k < 3; k++) {
    const d = Math.min(a[1][k], b[1][k]) - Math.max(a[0][k], b[0][k]) + BOX_TOL;
    if (d < 0) return 0;
    out *= d + BOX_TOL;
  }
  return out;
}

/**
 * The faces (or edges) after feature `id`, each with its origin: carried on
 * from the one before it overlaps most on the same surface, or made by `id`.
 * Pure: the heart of provenance, tested on its own.
 */
export function inherit(before: readonly Traced[], now: readonly Snap[], id: string): Traced[] {
  const bySig = new Map<string, Traced[]>();
  for (const r of before) bySig.set(r.sig, [...(bySig.get(r.sig) ?? []), r]);
  return now.map((n) => {
    const same = bySig.get(n.sig) ?? [];
    // Left as it was: the same face, the same maker and changes.
    const kept = same.find((r) => Math.abs(r.size - n.size) <= SAME_REL * Math.max(1, n.size) && dist3(r.centroid, n.centroid) <= SAME_DIST);
    if (kept) return { ...n, createdBy: kept.createdBy, modifiedBy: kept.modifiedBy };
    let best: Traced | null = null;
    let most = 0;
    for (const r of same) {
      const o = overlap(r.box, n.box);
      if (o > most) {
        most = o;
        best = r;
      }
    }
    if (!best) return { ...n, createdBy: id, modifiedBy: [] };
    const modifiedBy = best.createdBy === id || best.modifiedBy.at(-1) === id ? best.modifiedBy : [...best.modifiedBy, id];
    return { ...n, createdBy: best.createdBy, modifiedBy };
  });
}

/** Of `records`, the origin of the one that is this face or edge (the same surface or line, the nearest centre). */
function originOf(records: Map<string, Traced[]>, sig: string, centroid: Vec3): Origin | null {
  const same = records.get(sig);
  if (!same?.length) return null;
  let best = same[0];
  for (const r of same) if (dist3(r.centroid, centroid) < dist3(best.centroid, centroid)) best = r;
  return best;
}

/** A face's box. Tracked in `s`. */
function faceBoxes(oc: OC, s: Scope, faces: ReturnType<typeof describeFaces>["faces"]): Box[] {
  return faces.map((f) => {
    const box = s.track(new oc.Bnd_Box());
    oc.BRepBndLib.Add(f, box, false);
    if (box.IsVoid()) return [[0, 0, 0], [0, 0, 0]] as Box;
    const lo = s.track(box.CornerMin());
    const hi = s.track(box.CornerMax());
    return [
      [lo.X(), lo.Y(), lo.Z()],
      [hi.X(), hi.Y(), hi.Z()],
    ] as Box;
  });
}

/** The part's faces and edges as the matching sees them. */
export function snapshot(oc: OC, s: Scope, shape: TopoDS_Shape | null): { faces: Snap[]; edges: Snap[] } {
  if (!shape) return { faces: [], edges: [] };
  const { faces, infos } = describeFaces(oc, s, shape);
  const boxes = faceBoxes(oc, s, faces);
  const edgeInfos = listEdges(oc, s, shape).edges.map((e, i) => edgeInfo(oc, s, e, i));
  return {
    faces: infos.map((f, i) => ({ sig: faceSignature(f), box: boxes[i], size: f.area, centroid: f.centroid })),
    edges: edgeInfos.map((e) => ({ sig: edgeSignature(e), box: edgeBox(e), size: e.length, centroid: e.centroid })),
  };
}

/** The provenance of a part as its features are built, one after another. */
export class Provenance {
  private faces: Traced[] = [];
  private edges: Traced[] = [];
  private faceIndex = new Map<string, Traced[]>();
  private edgeIndex = new Map<string, Traced[]>();

  /** Feature `id` has just changed the part, which is now `now` (its faces and edges, from snapshot). */
  record(id: string, now: { faces: Snap[]; edges: Snap[] }): void {
    this.faces = inherit(this.faces, now.faces, id);
    this.edges = inherit(this.edges, now.edges, id);
    this.faceIndex = index(this.faces);
    this.edgeIndex = index(this.edges);
  }

  /** Gives each face and edge (described from the part as it stands now) its createdBy and modifiedBy, in place. */
  label(topo: { faces: FaceInfo[]; edges: EdgeInfo[] }): void {
    for (const f of topo.faces) {
      const o = originOf(this.faceIndex, faceSignature(f), f.centroid);
      if (o) setOrigin(f, o);
    }
    for (const e of topo.edges) {
      const o = originOf(this.edgeIndex, edgeSignature(e), e.centroid);
      if (o) setOrigin(e, o);
    }
  }

  /** The faces of the part each feature made (for "the edges a feature made" and the agent's packets), by face signature. */
  madeBy(id: string): Set<string> {
    return new Set(this.faces.filter((r) => r.createdBy === id).map((r) => r.sig));
  }
}

function index(records: Traced[]): Map<string, Traced[]> {
  const out = new Map<string, Traced[]>();
  for (const r of records) out.set(r.sig, [...(out.get(r.sig) ?? []), r]);
  return out;
}

function setOrigin(x: { createdBy?: string; modifiedBy?: string[] }, o: Origin): void {
  x.createdBy = o.createdBy;
  if (o.modifiedBy.length) x.modifiedBy = [...o.modifiedBy];
  else delete x.modifiedBy;
}

/**
 * The provenance of the rebuild running now, if any. The rebuild is
 * synchronous: it sets this while it runs, so every description of the part
 * a feature makes (describePart) carries createdBy for the selectors to use,
 * without each op passing it along.
 */
let active: Provenance | null = null;

export function withProvenance<T>(p: Provenance, run: () => T): T {
  const was = active;
  active = p;
  try {
    return run();
  } finally {
    active = was;
  }
}

/** Labels faces and edges with the running rebuild's provenance (nothing outside a rebuild). */
export function labelActive(topo: { faces: FaceInfo[]; edges: EdgeInfo[] }): void {
  active?.label(topo);
}
