// Paths in the model, for features that follow a curve (a sweep's path, a
// helix): a sketch's chain of lines and arcs placed in its plane, a chain of
// model edges put in order, or an exact helix; each as one wire of edges in
// order of travel, with what the features need to know about it (where it
// starts and ends and which way it runs there, its length, whether it turns
// smoothly), points and tangents along it, and the auxiliary spine that makes
// a profile twist as it sweeps.

import type { TopoDS_Edge, TopoDS_Wire } from "replicad-opencascadejs";
import type { Vec3 } from "../doc/types";
import type { Chain } from "../features/sweep/chain";
import type { AxisFrame } from "../features/sweep/helix";
import { to3D, type Frame } from "../geom/frame";
import { arcMid } from "../geom/profile";
import { add3, cross3, dist3, dot3, len3, normalize3, scale3, sub3 } from "../geom/vec";
import type { OC, Scope } from "./oc";
import { dir, OpError, pnt } from "./ops";

/** A path as one wire, its edges in order of travel (each oriented the way it is travelled). */
export interface PathShape {
  wire: TopoDS_Wire;
  edges: TopoDS_Edge[];
  closed: boolean;
  length: number;
  start: Vec3;
  /** Unit direction of travel at the start. */
  startTangent: Vec3;
  end: Vec3;
  endTangent: Vec3;
  /** Every joint between edges is tangent (no sharp corners). */
  smooth: boolean;
}

/** A point on a path with its unit tangent and the length travelled to it. */
export interface PathSample {
  p: Vec3;
  t: Vec3;
  s: number;
}

/** How far apart (mm) two edge ends may be and still meet. */
const JOIN_TOL = 1e-4;
/** Joints whose tangents differ by less than this (radians) are smooth. */
const SMOOTH_TOL = 1e-3;

// ------------------------------------------------------------ edges

/** The edges of a sketch chain in the model: lines, arcs, and whole circles starting where the chain starts. */
export function chainEdges(oc: OC, s: Scope, frame: Frame, chain: Chain): TopoDS_Edge[] {
  return chain.segs.map((seg) => {
    let mk;
    if (seg.kind === "line") {
      mk = s.track(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, s, to3D(frame, seg.a)), pnt(oc, s, to3D(frame, seg.b))));
    } else if (Math.abs(seg.sweep) >= 2 * Math.PI - 1e-12) {
      // A whole circle starts at its x direction: point it at the chain's start.
      const c = to3D(frame, seg.c);
      const x = normalize3(sub3(to3D(frame, seg.a), c));
      const axis = seg.sweep > 0 ? frame.z : scale3(frame.z, -1);
      const ax2 = s.track(new oc.gp_Ax2(pnt(oc, s, c), dir(oc, s, axis), dir(oc, s, x)));
      mk = s.track(new oc.BRepBuilderAPI_MakeEdge(s.track(new oc.gp_Circ(ax2, seg.r))));
    } else {
      const arc = s.track(new oc.GC_MakeArcOfCircle(pnt(oc, s, to3D(frame, seg.a)), pnt(oc, s, to3D(frame, arcMid(seg))), pnt(oc, s, to3D(frame, seg.b))));
      if (!arc.IsDone()) throw new OpError(`could not build an arc for "${seg.entity}"`);
      mk = s.track(new oc.BRepBuilderAPI_MakeEdge(arc.Value()));
    }
    if (!mk.IsDone()) throw new OpError(`could not build an edge for "${seg.entity}"`);
    return s.track(mk.Edge());
  });
}

/**
 * An exact helix: a straight line on a cylinder (or, tapered, on a cone)
 * unrolled flat, so its radius and pitch are exact. It starts at
 * frame.origin + radius along frame.x and climbs along frame.z.
 */
export function helixEdge(oc: OC, s: Scope, frame: AxisFrame, radius: number, pitch: number, turns: number, opts: { leftHanded?: boolean; taper?: number } = {}): TopoDS_Edge {
  const ax3 = s.track(new oc.gp_Ax3(pnt(oc, s, frame.origin), dir(oc, s, frame.z), dir(oc, s, frame.x)));
  const taper = ((opts.taper ?? 0) * Math.PI) / 180;
  // On a cone the second parameter runs along the slanted side: a pitch along the axis is pitch / cos(taper) along it.
  const surface = Math.abs(taper) > 1e-9 ? s.track(new oc.Geom_ConicalSurface(ax3, taper, radius)) : s.track(new oc.Geom_CylindricalSurface(ax3, radius));
  const climb = pitch / Math.cos(taper);
  const du = 2 * Math.PI * (opts.leftHanded ? -1 : 1);
  const line = s.track(new oc.Geom2d_Line(s.track(new oc.gp_Pnt2d(0, 0)), s.track(new oc.gp_Dir2d(du, climb))));
  const trimmed = s.track(new oc.Geom2d_TrimmedCurve(line, 0, Math.hypot(du, climb) * turns, true, true));
  const mk = s.track(new oc.BRepBuilderAPI_MakeEdge(trimmed, surface));
  if (!mk.IsDone()) throw new OpError("could not build the helix");
  const edge = s.track(mk.Edge());
  // The edge lives on the surface only until its 3D curve is made.
  oc.BRepLib.BuildCurves3d(edge);
  return edge;
}

/** How an edge is travelled: point and unit tangent at a fraction 0..1 of its parameter range, in its own orientation. */
function traveller(oc: OC, s: Scope, edge: TopoDS_Edge) {
  const curve = s.track(new oc.BRepAdaptor_Curve(edge));
  const u0 = curve.FirstParameter();
  const u1 = curve.LastParameter();
  const reversed = edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
  return (k: number): { p: Vec3; t: Vec3 } => {
    const u = reversed ? u1 - k * (u1 - u0) : u0 + k * (u1 - u0);
    const r = curve.EvalD1(u);
    const p: Vec3 = [r.Point.X(), r.Point.Y(), r.Point.Z()];
    let t: Vec3 = [r.D1.X(), r.D1.Y(), r.D1.Z()];
    r.Point.delete();
    r.D1.delete();
    const l = len3(t);
    t = l > 1e-15 ? scale3(t, (reversed ? -1 : 1) / l) : t;
    return { p, t };
  };
}

function edgeLength(oc: OC, s: Scope, edge: TopoDS_Edge): number {
  const props = s.track(new oc.GProp_GProps());
  oc.BRepGProp.LinearProperties(edge, props, false, false);
  return props.Mass();
}

/**
 * Model edges put in order end to end, each turned to run the way the chain
 * is travelled: from the free end with the lowest coordinates (open), or from
 * the first edge (closed). An error when they do not make one chain.
 */
export function orderEdges(oc: OC, s: Scope, edges: TopoDS_Edge[], what: string): { edges: TopoDS_Edge[]; closed: boolean } {
  if (edges.length === 0) throw new OpError(`${what}: no edges`);
  const ends = edges.map((e) => {
    const go = traveller(oc, s, e);
    return [go(0).p, go(1).p] as const;
  });
  const nodes: Vec3[] = [];
  const nodeOf = (p: Vec3) => {
    const i = nodes.findIndex((q) => dist3(p, q) <= JOIN_TOL);
    if (i >= 0) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  const at = ends.map(([a, b]) => [nodeOf(a), nodeOf(b)] as const);
  const degree = nodes.map((_, n) => at.filter(([i, j]) => i === n || j === n).length);
  const fmt = (p: Vec3) => `[${p.map((x) => Math.round(x * 1e3) / 1e3).join(", ")}]`;
  const branch = degree.findIndex((d) => d > 2);
  if (branch >= 0) throw new OpError(`${what}: three or more of the edges meet at ${fmt(nodes[branch])}; a path is one chain without branches`);
  const free = degree.flatMap((d, n) => (d === 1 ? [n] : []));
  const startNode = free.length ? free.sort((m, n) => nodes[m][0] - nodes[n][0] || nodes[m][1] - nodes[n][1] || nodes[m][2] - nodes[n][2])[0] : at[0][0];
  const used = new Array(edges.length).fill(false);
  const out: TopoDS_Edge[] = [];
  let node = startNode;
  for (;;) {
    const k = at.findIndex(([i, j], e) => !used[e] && (i === node || j === node));
    if (k < 0) break;
    used[k] = true;
    const forward = at[k][0] === node;
    out.push(forward ? edges[k] : s.track(oc.TopoDS.Edge(s.track(edges[k].Reversed()))));
    node = forward ? at[k][1] : at[k][0];
  }
  if (used.some((u) => !u)) throw new OpError(`${what}: the edges do not join end to end into one chain (${used.filter((u) => !u).length} of them are apart from the rest); pick edges that follow on from each other`);
  return { edges: out, closed: free.length === 0 };
}

/** The path these edges make, in this order (each already oriented for travel). */
export function pathOf(oc: OC, s: Scope, edges: TopoDS_Edge[], closed: boolean): PathShape {
  const mw = s.track(new oc.BRepBuilderAPI_MakeWire());
  for (const e of edges) mw.Add(e);
  if (!mw.IsDone()) throw new OpError(`the path's edges do not join into one wire (${mw.Error()})`);
  const wire = s.track(mw.Wire());
  const goes = edges.map((e) => traveller(oc, s, e));
  const first = goes[0](0);
  const last = goes[goes.length - 1](1);
  let smooth = true;
  const joints = closed ? edges.length : edges.length - 1;
  for (let i = 0; i < joints; i++) {
    const a = goes[i](1).t;
    const b = goes[(i + 1) % edges.length](0).t;
    if (dot3(a, b) < Math.cos(SMOOTH_TOL)) smooth = false;
  }
  return {
    wire,
    edges,
    closed,
    length: edges.reduce((t, e) => t + edgeLength(oc, s, e), 0),
    start: first.p,
    startTangent: first.t,
    end: last.p,
    endTangent: last.t,
    smooth,
  };
}

/** The same path travelled the other way. */
export function reversedPath(oc: OC, s: Scope, path: PathShape): PathShape {
  const edges = [...path.edges].reverse().map((e) => s.track(oc.TopoDS.Edge(s.track(e.Reversed()))));
  return pathOf(oc, s, edges, path.closed);
}

/** The closed path started at its k-th edge's start. */
export function rotatedPath(oc: OC, s: Scope, path: PathShape, k: number): PathShape {
  if (k === 0) return path;
  return pathOf(oc, s, [...path.edges.slice(k), ...path.edges.slice(0, k)], path.closed);
}

// ------------------------------------------------------------ along it

/**
 * Points along the path: each edge in at least `perEdge` steps, more where it
 * turns (a step at most `maxTurn` radians of tangent) and where it is long
 * (at most `maxStep` mm). The first point is the start; a joint is listed once.
 */
export function samplePath(oc: OC, s: Scope, path: PathShape, opts: { perEdge?: number; maxTurn?: number; maxStep?: number } = {}): PathSample[] {
  const perEdge = opts.perEdge ?? 4;
  const maxTurn = opts.maxTurn ?? Math.PI / 24;
  const out: PathSample[] = [];
  let travelled = 0;
  path.edges.forEach((edge, i) => {
    const go = traveller(oc, s, edge);
    const length = edgeLength(oc, s, edge);
    // How much the tangent turns along the edge, from a coarse look.
    let turn = 0;
    let prev = go(0).t;
    for (let k = 1; k <= 32; k++) {
      const t = go(k / 32).t;
      turn += Math.acos(Math.max(-1, Math.min(1, dot3(prev, t))));
      prev = t;
    }
    const n = Math.max(perEdge, Math.ceil(turn / maxTurn), opts.maxStep ? Math.ceil(length / opts.maxStep) : 0);
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const { p, t } = go(k / n);
      out.push({ p, t, s: travelled + (length * k) / n });
    }
    travelled += length;
  });
  return out;
}

/**
 * Normals along the samples that turn as little as the path lets them (a
 * rotation-minimising frame, by double reflection), starting from `n0`
 * (made square to the first tangent).
 */
export function minimalNormals(samples: PathSample[], n0: Vec3): Vec3[] {
  const t0 = samples[0].t;
  let r = normalize3(sub3(n0, scale3(t0, dot3(n0, t0))));
  const out: Vec3[] = [r];
  for (let i = 0; i + 1 < samples.length; i++) {
    const v1 = sub3(samples[i + 1].p, samples[i].p);
    const c1 = dot3(v1, v1);
    if (c1 < 1e-24) {
      out.push(r);
      continue;
    }
    const rL = sub3(r, scale3(v1, (2 / c1) * dot3(v1, r)));
    const tL = sub3(samples[i].t, scale3(v1, (2 / c1) * dot3(v1, samples[i].t)));
    const v2 = sub3(samples[i + 1].t, tL);
    const c2 = dot3(v2, v2);
    r = c2 < 1e-24 ? rL : sub3(rL, scale3(v2, (2 / c2) * dot3(v2, rL)));
    const t = samples[i + 1].t;
    r = normalize3(sub3(r, scale3(t, dot3(r, t))));
    out.push(r);
  }
  return out;
}

/** Any unit vector square to `t`. */
export function squareTo(t: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize3(cross3(t, ref));
}

/**
 * The auxiliary spine that twists a sweep: a curve running beside the path,
 * a little way off it, that turns `twist` degrees about it from start to end.
 * MakePipeShell points the profile's normal at it (each section's plane meets
 * it), so the profile turns with it. The untwisted normal is `base`: for a
 * helix, outward from the axis (as the helix's own sweep keeps it); else the
 * rotation-minimising frame.
 */
export function twistSpine(oc: OC, s: Scope, path: PathShape, twist: number, base: { axis: Vec3; origin: Vec3 } | null): TopoDS_Wire {
  const samples = samplePath(oc, s, path, { perEdge: 8, maxTurn: Math.PI / 32 });
  // Enough points that the twist turns at most 3° between them.
  const needed = Math.ceil(Math.abs(twist) / 3);
  const fine = samples.length < needed ? samplePath(oc, s, path, { perEdge: Math.ceil(needed / path.edges.length), maxTurn: Math.PI / 32 }) : samples;
  const normals = base
    ? fine.map(({ p, t }) => {
        const rel = sub3(p, base.origin);
        const radial = sub3(rel, scale3(base.axis, dot3(rel, base.axis)));
        const r = sub3(radial, scale3(t, dot3(radial, t)));
        return len3(r) > 1e-12 ? normalize3(r) : squareTo(t);
      })
    : minimalNormals(fine, squareTo(fine[0].t));
  // The tightest bend, so the spine stays well inside it.
  let tightest = Infinity;
  for (let i = 0; i + 1 < fine.length; i++) {
    const ds = fine[i + 1].s - fine[i].s;
    const turn = Math.acos(Math.max(-1, Math.min(1, dot3(fine[i].t, fine[i + 1].t))));
    if (turn > 1e-9) tightest = Math.min(tightest, ds / turn);
  }
  const eps = Math.min(1, path.length / 100, tightest / 5);
  const rad = (twist * Math.PI) / 180;
  const pts = fine.map(({ p, t, s: along }, i) => {
    const a = rad * (along / path.length);
    const n = normals[i];
    const b = cross3(t, n);
    return add3(p, scale3(add3(scale3(n, Math.cos(a)), scale3(b, Math.sin(a))), eps));
  });
  const periodic = path.closed && dist3(pts[0], pts[pts.length - 1]) < 1e-7;
  const used = periodic ? pts.slice(0, -1) : pts;
  const arr = s.track(new oc.NCollection_Array1_gp_Pnt(1, used.length));
  used.forEach((p, i) => arr.SetValue(i + 1, pnt(oc, s, p)));
  const interp = s.track(new oc.GeomAPI_Interpolate(s.track(new oc.NCollection_HArray1_gp_Pnt(arr)), periodic, 1e-9));
  interp.Perform();
  if (!interp.IsDone()) throw new OpError("could not build the curve that twists the sweep");
  const mk = s.track(new oc.BRepBuilderAPI_MakeEdge(s.track(interp.Curve())));
  if (!mk.IsDone()) throw new OpError("could not build the curve that twists the sweep");
  return s.track(s.track(new oc.BRepBuilderAPI_MakeWire(s.track(mk.Edge()))).Wire());
}

/** Where each edge of the path starts. */
export function edgeStarts(oc: OC, s: Scope, path: PathShape): Vec3[] {
  return path.edges.map((e) => traveller(oc, s, e)(0).p);
}
