// Flat geometry for DXF (Phase P): a planar face's outline in its own plane,
// and the bodies that are flat plates (a planar extrusion: end caps,
// gussets, base plates, flat bars cut to shape) with their outlines, ready
// for laser, plasma or waterjet. Lines, arcs, circles and ellipses come out
// exact; other curves as fine polylines (within 0.005 mm). Plain data out
// (src/io/dxf.ts entities, mm), so it crosses the worker boundary.

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec2, Vec3 } from "../doc/types";
import { facePlaneFrame, planeFrame, to2D, type Frame } from "../geom/frame";
import { cross3, dot3, normalize3 } from "../geom/vec";
import type { DxfEntity } from "../io/dxf";
import { boundsOf, entityPoints, joinContours, transformEntity } from "../io/dxfGeom";
import { volumeOf } from "./measure";
import { type OC, type Scope, scoped } from "./oc";
import type { RebuildResult } from "./rebuild";
import { describeFaces, faceInfo, listFaces } from "./topology";

/** What the DXF exports ask the kernel, on the rebuild of the document on screen. */
export type FlatQuery =
  /** A planar face by its index in the rebuild (the viewport's pick). */
  | { kind: "face"; face: number }
  /** Every body that is a flat plate (or only these bodies). */
  | { kind: "plates"; bodies?: string[] };

export type FlatResult =
  | {
      kind: "face";
      /** The outline in the face's own frame: the frame a sketch on that face has (origin: the world origin dropped onto the plane). */
      entities: DxfEntity[];
      frame: Frame;
      area: number;
      body?: string;
    }
  | { kind: "plates"; plates: FlatPlate[]; others: { body: string; why: string }[] }
  | { kind: "error"; error: string };

/** A flat plate: its outline laid flat (its box's corner on the origin, its longest straight edge along x). */
export interface FlatPlate {
  /** The bodies that are this plate (alike in thickness and outline), in part order. */
  bodies: string[];
  thickness: number;
  entities: DxfEntity[];
  /** Width (x) and height (y) of the laid-flat outline, mm. */
  size: [number, number];
  /** Plan area, mm² (the outline less its holes). */
  area: number;
  /** Inner loops: holes and cut-outs. */
  holes: number;
  /** Length of every cut (outline and holes), mm: for quoting. */
  cutLength: number;
}

const LAYER = "CUT";

export function flatQuery(oc: OC, built: RebuildResult, query: FlatQuery): FlatResult {
  if (!built.solid) return { kind: "error", error: "there is no solid yet" };
  if (query.kind === "face") {
    return scoped((s) => {
      const { faces, infos } = describeFaces(oc, s, built.solid!);
      const info = infos[query.face];
      if (!info) return { kind: "error", error: `no face ${query.face} on the part` };
      if (info.type !== "plane" || !info.normal || !info.point) return { kind: "error", error: "that face is not flat: pick a flat face to export it as DXF" };
      const frame = facePlaneFrame(info.normal, info.point);
      const body = built.bodies.find((b) => query.face >= b.faces[0] && query.face < b.faces[1])?.name;
      return { kind: "face", entities: faceEntities(oc, s, faces[query.face], frame), frame, area: info.area, ...(body && built.bodies.length > 1 ? { body } : {}) };
    });
  }
  const wanted = query.bodies ? new Set(query.bodies) : null;
  const plates: (FlatPlate & { key: string })[] = [];
  const others: { body: string; why: string }[] = [];
  for (const b of built.bodies) {
    if (wanted && !wanted.has(b.name)) continue;
    const r = scoped((s) => plateOf(oc, s, b.shape));
    if (typeof r === "string") {
      others.push({ body: b.name, why: r });
      continue;
    }
    // Alike plates (same thickness, area, cut length and loops) are one line, with every body that is one.
    const key = [r.thickness.toFixed(2), r.area.toFixed(1), r.cutLength.toFixed(1), r.holes].join("|");
    const same = plates.find((p) => p.key === key);
    if (same) same.bodies.push(b.name);
    else plates.push({ ...r, bodies: [b.name], key });
  }
  return { kind: "plates", plates: plates.map(({ key: _key, ...p }) => p).sort((a, b) => a.thickness - b.thickness), others };
}

/**
 * The face's edges as DXF entities in the frame: lines, circles, arcs and
 * ellipses exact, other curves as polylines within 0.005 mm; lines and arcs
 * that meet end to end joined into polylines (one per loop of lines and arcs).
 */
export function faceEntities(oc: OC, s: Scope, face: TopoDS_Face, frame: Frame): DxfEntity[] {
  const out: DxfEntity[] = [];
  const ex = s.track(new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) {
    const edge = s.track(oc.TopoDS.Edge(s.track(ex.Current())));
    if (oc.BRep_Tool.Degenerated(edge)) continue;
    out.push(...edgeEntities(oc, s, edge, frame));
  }
  return joinContours(out, 1e-3);
}

function edgeEntities(oc: OC, s: Scope, edge: TopoDS_Edge, frame: Frame): DxfEntity[] {
  const curve = s.track(new oc.BRepAdaptor_Curve(edge));
  const t0 = curve.FirstParameter();
  const t1 = curve.LastParameter();
  const at3 = (t: number): Vec3 => {
    const p = curve.EvalD0(t) as unknown as { X(): number; Y(): number; Z(): number; delete(): void };
    const v: Vec3 = [p.X(), p.Y(), p.Z()];
    p.delete();
    return v;
  };
  const at = (t: number): Vec2 => to2D(frame, at3(t));
  const type = curve.GetType();
  if (type === oc.GeomAbs_CurveType.GeomAbs_Line) return [{ type: "line", a: at(t0), b: at(t1), layer: LAYER }];
  const whole = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-9;
  if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
    // The centre from three points of the edge, in the plane: right whatever placement the edge carries.
    const [p, m, q] = whole ? [at(t0), at(t0 + (2 * Math.PI) / 3), at(t0 + (4 * Math.PI) / 3)] : [at(t0), at((t0 + t1) / 2), at(t1)];
    const c = circumcentre(p, m, q);
    if (c) {
      const r = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (whole) return [{ type: "circle", c, r, layer: LAYER }];
      const ang = (x: Vec2) => (Math.atan2(x[1] - c[1], x[0] - c[0]) * 180) / Math.PI;
      const ccw = (a: number, b: number) => (((b - a) % 360) + 360) % 360;
      const [a, mid, b] = [ang(p), ang(m), ang(q)];
      // Counter-clockwise from start to end must pass the middle; otherwise the edge runs clockwise in this frame.
      return [ccw(a, mid) < ccw(a, b) ? { type: "arc", c, r, start: a, end: b, layer: LAYER } : { type: "arc", c, r, start: b, end: a, layer: LAYER }];
    }
  }
  if (type === oc.GeomAbs_CurveType.GeomAbs_Ellipse) {
    const e = ellipseIn(oc, s, curve, frame, t0, t1, at3);
    if (e) return [e];
  }
  return [{ type: "polyline", points: samplePoints(at, t0, t1, 0.005), layer: LAYER }];
}

/** The ellipse of an elliptical edge in the frame, checked against the edge's own points (null when they disagree). */
function ellipseIn(oc: OC, s: Scope, curve: InstanceType<OC["BRepAdaptor_Curve"]>, frame: Frame, t0: number, t1: number, at3: (t: number) => Vec3): DxfEntity | null {
  const el = s.track(curve.Ellipse());
  const loc = s.track(el.Location());
  const xd = s.track(s.track(el.XAxis()).Direction());
  const yd = s.track(s.track(el.YAxis()).Direction());
  const C: Vec3 = [loc.X(), loc.Y(), loc.Z()];
  const X: Vec3 = [xd.X(), xd.Y(), xd.Z()];
  const Y: Vec3 = [yd.X(), yd.Y(), yd.Z()];
  const R = el.MajorRadius();
  const r = el.MinorRadius();
  const point = (t: number): Vec3 => [0, 1, 2].map((k) => C[k] + R * Math.cos(t) * X[k] + r * Math.sin(t) * Y[k]) as Vec3;
  for (const t of [t0, (t0 + t1) / 2, t1]) {
    const a = point(t);
    const b = at3(t);
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-6 * Math.max(1, R)) return null;
  }
  void oc;
  const c2 = to2D(frame, C);
  const x2 = to2D(frame, [C[0] + X[0], C[1] + X[1], C[2] + X[2]]);
  const major: Vec2 = [(x2[0] - c2[0]) * R, (x2[1] - c2[1]) * R];
  // Seen from the frame's side, Y is a quarter left of X (parameters as they are) or right (they run backwards).
  const left = dot3(cross3(X, Y), frame.z) > 0;
  const whole = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-9;
  if (whole) return { type: "ellipse", c: c2, major, ratio: r / R, start: 0, end: 2 * Math.PI, layer: LAYER };
  return left ? { type: "ellipse", c: c2, major, ratio: r / R, start: t0, end: t1, layer: LAYER } : { type: "ellipse", c: c2, major, ratio: r / R, start: -t1, end: -t0, layer: LAYER };
}

function circumcentre(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

/** Points along a curve from t0 to t1, halving any piece whose middle strays more than tol from its chord. */
function samplePoints(at: (t: number) => Vec2, t0: number, t1: number, tol: number): Vec2[] {
  let ts = Array.from({ length: 17 }, (_, i) => t0 + ((t1 - t0) * i) / 16);
  for (let pass = 0; pass < 10; pass++) {
    const next: number[] = [ts[0]];
    let split = false;
    for (let i = 1; i < ts.length; i++) {
      const a = at(ts[i - 1]);
      const b = at(ts[i]);
      const mt = (ts[i - 1] + ts[i]) / 2;
      const m = at(mt);
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const off = l < 1e-12 ? Math.hypot(m[0] - a[0], m[1] - a[1]) : Math.abs((m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0])) / l;
      if (off > tol) {
        next.push(mt);
        split = true;
      }
      next.push(ts[i]);
    }
    ts = next;
    if (!split || ts.length > 5000) break;
  }
  return ts.map(at);
}

/**
 * The body as a flat plate, or why it is not one. A plate is a prism: two
 * flat faces facing apart, as large as each other, the volume their area
 * times the distance between them, nothing beyond them, and thinner than it
 * is wide (else it is a bar or a tube on end).
 */
function plateOf(oc: OC, s: Scope, body: TopoDS_Shape): Omit<FlatPlate, "bodies"> | string {
  const faces = listFaces(oc, s, body);
  const infos = faces.map((f, i) => faceInfo(oc, s, f, i));
  const volume = volumeOf(oc, s, body);
  const flats = infos.filter((f) => f.type === "plane" && f.normal && f.offset !== undefined).sort((a, b) => b.area - a.area);
  if (flats.length < 2) return "not a flat plate: it has no two flat faces facing apart";
  const vertices = vertexPoints(oc, s, body);
  const tried: Vec3[] = [];
  let reason = "not a flat plate: no pair of its flat faces bounds it like a plate's sides";
  for (const top of flats.slice(0, 8)) {
    const n = normalize3(top.normal!);
    if (tried.some((d) => Math.abs(dot3(d, n)) > 1 - 1e-9)) continue;
    tried.push(n);
    const bottom = flats.find((f) => dot3(f.normal!, n) < -1 + 1e-9);
    if (!bottom) continue;
    const thickness = top.offset! + bottom.offset!;
    if (!(thickness > 1e-6)) continue;
    if (Math.abs(bottom.area - top.area) > 1e-6 * top.area + 1e-6) {
      reason = "not a flat plate: its two sides differ (a chamfer, countersink or step on one side)";
      continue;
    }
    if (Math.abs(volume - top.area * thickness) > 1e-5 * volume + 1e-6) {
      reason = "not a flat plate: its edges are not square to its faces all round";
      continue;
    }
    if (vertices.some((p) => dot3(p, n) > top.offset! + 1e-6 || dot3(p, n) < -bottom.offset! - 1e-6)) continue;
    // Laid flat: seen from the top face, its longest straight edge along x, its box's corner on the origin.
    const frame0 = facePlaneFrame(n, top.point!);
    let entities = faceEntities(oc, s, faces[top.index], frame0);
    const along = longestLine(entities);
    if (along) {
      const angle = Math.atan2(along[1], along[0]);
      const c = Math.cos(-angle);
      const si = Math.sin(-angle);
      entities = entities.flatMap((e) => transformEntity(e, { a: c, b: -si, c: si, d: c, e: 0, f: 0 }));
    }
    const box = boundsOf(entities);
    if (!box) continue;
    const w = box.max[0] - box.min[0];
    const h = box.max[1] - box.min[1];
    if (thickness > Math.min(w, h) + 1e-6) {
      reason = `not a flat plate: it is ${round(thickness)} mm thick but only ${round(Math.min(w, h))} mm across (a bar or tube on end)`;
      continue;
    }
    entities = entities.flatMap((e) => transformEntity(e, { a: 1, b: 0, c: 0, d: 1, e: -box.min[0], f: -box.min[1] }));
    const loops = entities.filter((e) => e.type === "circle" || (e.type === "polyline" && e.closed) || (e.type === "ellipse" && Math.abs(e.end - e.start - 2 * Math.PI) < 1e-9) || (e.type === "spline" && e.closed)).length;
    const cutLength = entities.reduce((sum, e) => sum + polylineLength(entityPoints(e, 1e-3)), 0);
    return { thickness: round(thickness), entities, size: [round(w), round(h)], area: round(top.area), holes: Math.max(0, loops - 1), cutLength: round(cutLength) };
  }
  return reason;
}

function vertexPoints(oc: OC, s: Scope, shape: TopoDS_Shape): Vec3[] {
  const out: Vec3[] = [];
  const ex = s.track(new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) {
    const p = s.track(oc.BRep_Tool.Pnt(s.track(oc.TopoDS.Vertex(s.track(ex.Current())))));
    out.push([p.X(), p.Y(), p.Z()]);
  }
  return out;
}

/** The direction of the longest straight piece of the outline (lines, and the straight pieces of polylines). */
function longestLine(entities: DxfEntity[]): Vec2 | null {
  let best: Vec2 | null = null;
  let bestLength = 0;
  const consider = (a: Vec2, b: Vec2) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > bestLength + 1e-9) {
      bestLength = l;
      best = [b[0] - a[0], b[1] - a[1]];
    }
  };
  for (const e of entities) {
    if (e.type === "line") consider(e.a, e.b);
    if (e.type === "polyline") {
      const n = e.points.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) if (!e.bulges?.[i]) consider(e.points[i], e.points[(i + 1) % n]);
    }
  }
  return best;
}

function polylineLength(pts: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

const round = (x: number) => Math.round(x * 1000) / 1000 + 0;

/** A frame from a normal alone (the usual sketch rule), for callers that have no point. */
export function frameFor(normal: Vec3, origin: Vec3 = [0, 0, 0]): Frame {
  return planeFrame(normal, origin);
}
