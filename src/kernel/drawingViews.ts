// Views of the rebuilt part for a drawing (Phase Q; Phase L's project.ts did
// the named looks): OCCT's hidden-line removal projects every body at once,
// so one body hides another, and the visible and hidden edges come back per
// body. What this adds:
//
// - Every projected edge carries a KEY naming the model edge it is, made from
//   the edge's provenance (the feature that made it, src/kernel/provenance.ts)
//   and its place among that feature's edges of its kind: "extrude_1/l3",
//   "hole_1/c0". A side of a round face seen from the side (a silhouette, no
//   model edge) is keyed by the face: "revolve_1/s0a". The keys do not depend
//   on the view, so a dimension's GeoRef finds the same edge after a rebuild
//   that left that feature's edges alone (src/drafting/georef.ts).
// - Sections: the bodies cut along a line drawn on a parent view (full,
//   offset, half and aligned sections, a depth), and broken-out sections; the
//   cut faces come back as loops for hatching, per body.
// - Smooth (tangent) edges, kept apart so a view can draw or drop them.
// - Shading: the faces as triangles, each with its shade, for shaded views.
//
// The HLR output edges are matched to the model edges in 2D: an output edge
// lies along the projection of the model edge it came from; where several
// project onto the same line, a visible one is the nearest the viewer.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec2, Vec3, ViewLook } from "../doc/types";
import { auxiliaryFrame, depthOf, frameFrom, inView, projectedFrame, sectionFrame, sectionSide, toModel, toModelPoint, viewFrame, type ViewFrame } from "../drafting/views";
import type { ProjectDirection, Projection } from "../doc/types";
import { boundingBoxOf } from "./measure";
import { tessellate } from "./mesh";
import { type OC, type Scope, scoped } from "./oc";
import { describeFaces, edgeInfo, listEdges, listFaces, type EdgeInfo, type FaceInfo } from "./topology";
import { edgeSignature } from "./provenance";

/** How a view's frame is had: given, from a look, or from its parent's. */
export type FrameSpec =
  | { frame: ViewFrame }
  | { look: ViewLook }
  | { parent: string; projected: ProjectDirection; projection: Projection }
  | { parent: string; section: Vec2[]; flip?: boolean }
  /** Square to an edge of the parent, by its key. */
  | { parent: string; auxiliary: string; flip?: boolean };

export interface SectionSpec {
  /** The cutting line on the parent view (the parent's frame, view mm). */
  line: Vec2[];
  flip?: boolean;
  half?: boolean;
  aligned?: boolean;
  /** How far behind the cut to keep, mm. */
  depth?: number;
}

export interface ViewSpec {
  id: string;
  /** Phase L: a look alone. */
  look?: ViewLook;
  frame?: FrameSpec;
  /** Only these bodies. */
  bodies?: string[];
  /** Cut along a line on the parent (the spec's frame names the parent). */
  section?: SectionSpec;
  brokenOut?: { profile: Vec2[]; depth: number }[];
  /** Also the faces as shaded triangles. */
  shaded?: boolean;
}

export interface ProjectedBody {
  name: string;
  /** Polylines, view mm: sharp edges and outlines (smooth edges are in `edges` only). */
  visible: Vec2[][];
  hidden: Vec2[][];
}

/** What a model edge is, in model mm. */
export interface ModelEdge {
  kind: "line" | "circle" | "other";
  start: Vec3;
  end: Vec3;
  length: number;
  center?: Vec3;
  radius?: number;
  axis?: Vec3;
}

export interface ProjectedEdge {
  /** The model edge it is ("extrude_1/l3"), the same in every view. */
  key: string;
  body: string;
  /** The feature that made the edge (its key's first part). */
  feature?: string;
  /** "sharp" (faces meet at an angle), "smooth" (tangent faces), "outline" (a round face's side), "cut" (made by the section). */
  type: "sharp" | "smooth" | "outline" | "cut";
  visible: boolean;
  /** View mm. */
  pts: Vec2[];
  /** How it looks in the view: a line, a true circle or arc (seen end on), or another curve. */
  look: "line" | "circle" | "arc" | "curve";
  /** Seen end on: its centre and radius in the view; an arc's angles (radians, counter-clockwise from +x). */
  circle?: { c: Vec2; r: number; a0?: number; a1?: number };
  model?: ModelEdge;
}

/** A face the section cut, as loops in the view (even-odd: holes are loops inside). */
export interface SectionRegion {
  body: string;
  loops: Vec2[][];
  /** The cut face's area, mm². */
  area: number;
  /** "section" or the broken-out section it is from ("brokenOut"). */
  from: "section" | "brokenOut";
}

/** A triangle of a face for a shaded view: its corners (view mm), its shade 0 (dark) to 1, its depth. */
export interface ShadedTriangle {
  body: string;
  pts: [Vec2, Vec2, Vec2];
  shade: number;
  depth: number;
}

export interface ProjectedView {
  id: string;
  look?: ViewLook;
  frame: ViewFrame;
  bodies: ProjectedBody[];
  edges: ProjectedEdge[];
  sections?: SectionRegion[];
  shaded?: ShadedTriangle[];
  /** The cut's plane in the view, for an aligned section: where its two halves meet. */
  problems?: string[];
}

/** Arcs are drawn in steps of at most this angle. */
const ARC_STEP = Math.PI / 36;
/** Curves that are neither lines nor arcs: this many steps. */
const CURVE_STEPS = 48;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A body as projected: its shape (maybe cut) and its model edges with their keys. */
interface Prepared {
  name: string;
  shape: TopoDS_Shape;
  edges: KeyedEdge[];
  /** Round faces, for the outlines. */
  rounds: { key: string; axis: Vec3; origin: Vec3; radius: number; feature?: string }[];
}

interface KeyedEdge {
  key: string;
  feature?: string;
  info: EdgeInfo;
  /** Sampled, model mm. */
  pts3: Vec3[];
}

/** The letter an edge's key has for what it is. */
function letter(e: EdgeInfo): string {
  return e.kind === "line" ? "l" : e.kind === "circle" ? "c" : "o";
}

/**
 * The keys of a body's edges (labelled with their makers): per maker and
 * kind, in a fixed order (radius, then position), numbered from 0.
 */
export function edgeKeys(edges: { kind: EdgeInfo["kind"]; createdBy?: string; radius?: number; centroid: Vec3; seam?: boolean }[]): string[] {
  const groups = new Map<string, number[]>();
  edges.forEach((e, i) => {
    const g = `${e.createdBy ?? "?"}/${letter(e as EdgeInfo)}`;
    groups.set(g, [...(groups.get(g) ?? []), i]);
  });
  const out: string[] = new Array(edges.length);
  const q = (x: number) => Math.round(x * 1000) / 1000;
  for (const [g, list] of groups) {
    list.sort((a, b) => {
      const ea = edges[a];
      const eb = edges[b];
      const ra = q(ea.radius ?? 0) - q(eb.radius ?? 0);
      if (ra) return ra;
      for (let k = 0; k < 3; k++) {
        const d = q(ea.centroid[k]) - q(eb.centroid[k]);
        if (d) return d;
      }
      return a - b;
    });
    list.forEach((i, n) => (out[i] = `${g}${n}`));
  }
  return out;
}

/** The round faces' keys, as edgeKeys does for edges: "<maker>/s<n>". */
function roundKeys(faces: FaceInfo[]): string[] {
  return edgeKeys(faces.map((f) => ({ kind: "other" as const, createdBy: f.createdBy, radius: f.cylinder?.radius, centroid: f.centroid }))).map((k) => k.replace(/\/o(\d+)$/, "/s$1"));
}

/** Samples an edge, model mm. */
function sample(oc: OC, s: Scope, edge: Parameters<typeof edgeInfo>[2]): Vec3[] {
  const curve = s.track(new oc.BRepAdaptor_Curve(edge));
  const t0 = curve.FirstParameter();
  const t1 = curve.LastParameter();
  const type = curve.GetType();
  const n =
    type === oc.GeomAbs_CurveType.GeomAbs_Line
      ? 1
      : type === oc.GeomAbs_CurveType.GeomAbs_Circle || type === oc.GeomAbs_CurveType.GeomAbs_Ellipse
        ? Math.max(2, Math.ceil(Math.abs(t1 - t0) / ARC_STEP))
        : CURVE_STEPS;
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const p = curve.Value(t0 + ((t1 - t0) * i) / n);
    pts.push([p.X(), p.Y(), p.Z()]);
    p.delete();
  }
  return pts;
}

export interface BuiltPart {
  bodies: { name: string; shape: TopoDS_Shape }[];
  /** Labels edges and faces described from the part with the features that made them. */
  label(topo: { faces: FaceInfo[]; edges: EdgeInfo[] }): void;
}

/** A body's model edges (seams left out) with their keys, and its round faces. */
function keyed(oc: OC, s: Scope, body: { name: string; shape: TopoDS_Shape }, label: BuiltPart["label"]): { edges: KeyedEdge[]; rounds: Prepared["rounds"]; infos: EdgeInfo[] } {
  const { faces, infos: faceInfos } = describeFaces(oc, s, body.shape);
  const list = listEdges(oc, s, body.shape);
  const infos = list.edges.map((e, i) => edgeInfo(oc, s, e, i));
  // Seams: an edge that bounds one face only is where a closed surface meets itself.
  const count = new Array(infos.length).fill(0);
  for (const face of faces) {
    const seen = new Set<number>();
    const ex = s.track(new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; ex.More(); ex.Next()) {
      const i = list.find(s.track(oc.TopoDS.Edge(s.track(ex.Current()))));
      if (i >= 0 && !seen.has(i)) {
        seen.add(i);
        count[i]++;
      }
    }
  }
  infos.forEach((e, i) => (e.seam = count[i] === 1));
  label({ faces: faceInfos, edges: infos });
  const keys = edgeKeys(infos);
  const edges: KeyedEdge[] = [];
  infos.forEach((info, i) => {
    if (info.seam) return;
    edges.push({ key: keys[i], ...(info.createdBy ? { feature: info.createdBy } : {}), info, pts3: sample(oc, s, list.edges[i]) });
  });
  const round = faceInfos.filter((f) => f.type === "cylinder" && f.cylinder);
  const rk = roundKeys(round);
  const rounds = round.map((f, i) => ({ key: rk[i], axis: f.cylinder!.axis, origin: f.cylinder!.origin, radius: f.cylinder!.radius, ...(f.createdBy ? { feature: f.createdBy } : {}) }));
  return { edges, rounds, infos };
}

/** Sizes the part: its box's diagonal. */
function partSize(oc: OC, s: Scope, shapes: TopoDS_Shape[]): { diag: number; min: Vec3; max: Vec3 } {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const sh of shapes) {
    const b = boundingBoxOf(oc, s, sh);
    if (!b) continue;
    min = min.map((v, k) => Math.min(v, b.min[k])) as Vec3;
    max = max.map((v, k) => Math.max(v, b.max[k])) as Vec3;
  }
  if (!Number.isFinite(min[0])) return { diag: 1, min: [0, 0, 0], max: [0, 0, 0] };
  return { diag: Math.max(1, Math.hypot(...sub(max, min))), min, max };
}

/** A prism through everything: `poly` (view mm in `f`) swept along f's eye from far behind to far in front. */
function prismThrough(oc: OC, s: Scope, f: ViewFrame, poly: Vec2[], back: number, front: number): TopoDS_Shape {
  const wire = s.track(new oc.BRepBuilderAPI_MakeWire());
  for (let i = 0; i < poly.length; i++) {
    const a = toModelPoint(poly[i], f, back);
    const b = toModelPoint(poly[(i + 1) % poly.length], f, back);
    const e = s.track(new oc.BRepBuilderAPI_MakeEdge(s.track(new oc.gp_Pnt(...a)), s.track(new oc.gp_Pnt(...b))));
    wire.Add(s.track(e.Edge()));
  }
  const face = s.track(s.track(new oc.BRepBuilderAPI_MakeFace(s.track(wire.Wire()), true)).Face());
  const dv = toModelPoint([0, 0], f, front - back);
  const p = s.track(new oc.BRepPrimAPI_MakePrism(face, s.track(new oc.gp_Vec(...dv)), false, true));
  if (!p.IsDone()) throw new Error("could not build the section's cutting tool");
  return s.track(p.Shape());
}

function booleanOp(oc: OC, s: Scope, kind: "cut" | "common", a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape {
  const progress = s.track(new oc.Message_ProgressRange());
  const op = s.track(kind === "cut" ? new oc.BRepAlgoAPI_Cut(a, b, progress) : new oc.BRepAlgoAPI_Common(a, b, progress));
  if (!op.IsDone()) throw new Error(`the section's ${kind} failed in the kernel`);
  return s.track(op.Shape());
}

function rotated(oc: OC, s: Scope, shape: TopoDS_Shape, origin: Vec3, axis: Vec3, angle: number): TopoDS_Shape {
  const t = s.track(new oc.gp_Trsf());
  t.SetRotation(s.track(new oc.gp_Ax1(s.track(new oc.gp_Pnt(...origin)), s.track(new oc.gp_Dir(...axis)))), angle);
  return s.track(s.track(new oc.BRepBuilderAPI_Transform(shape, t, true, false)).Shape());
}

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const unit2 = (a: Vec2): Vec2 => {
  const l = Math.hypot(a[0], a[1]);
  return [a[0] / l, a[1] / l];
};

/** A cut: the planes the cut faces lie on (model), for finding them after. */
interface CutPlane {
  point: Vec3;
  normal: Vec3;
}

/**
 * Cuts the bodies along a section line drawn on the parent (frame `pf`):
 * what is on the viewer's side goes. Returns the cut shapes (the caller keeps
 * them in its scope) and the planes the cut faces lie on.
 */
function sectionCut(oc: OC, s: Scope, pf: ViewFrame, spec: SectionSpec, shapes: TopoDS_Shape[], size: number): { shapes: (TopoDS_Shape | null)[]; planes: CutPlane[] } {
  const E = size * 4;
  const line = spec.line;
  const n = sectionSide(line, spec.flip);
  const N = toModel(n, pf);
  if (spec.aligned && line.length === 3) {
    const [A, B, C] = line;
    const u0 = unit2(sub2(B, A));
    const u1 = unit2(sub2(C, B));
    const n0 = n;
    const n1: Vec2 = spec.flip ? [u1[1], -u1[0]] : [-u1[1], u1[0]];
    const m = unit2(add2(mul2(n0, -1), mul2(n1, -1)));
    const far0 = sub2(A, mul2(u0, E));
    const far1 = add2(C, mul2(u1, E));
    const k0: Vec2[] = [far0, B, add2(B, mul2(m, E)), sub2(far0, mul2(n0, E))];
    const k1: Vec2[] = [B, far1, sub2(far1, mul2(n1, E)), add2(B, mul2(m, E))];
    // Each polygon wound counter-clockwise for a face the prism sweeps the right way.
    const tool0 = prismThrough(oc, s, pf, ccw(k0), -E, E);
    const tool1 = prismThrough(oc, s, pf, ccw(k1), -E, E);
    const angle = Math.atan2(u1[0] * u0[1] - u1[1] * u0[0], u1[0] * u0[0] + u1[1] * u0[1]);
    const pivot = toModelPoint(B, pf);
    const out = shapes.map((sh) => {
      const a = booleanOp(oc, s, "common", sh, tool0);
      const b = rotated(oc, s, booleanOp(oc, s, "common", sh, tool1), pivot, pf.eye, angle);
      return compound(oc, s, [a, b]);
    });
    return { shapes: out, planes: [{ point: pivot, normal: N }] };
  }
  const d0 = unit2(sub2(line[1], line[0]));
  const dk = unit2(sub2(line[line.length - 1], line[line.length - 2]));
  const start = sub2(line[0], mul2(d0, E));
  const end = spec.half ? line[line.length - 1] : add2(line[line.length - 1], mul2(dk, E));
  const poly: Vec2[] = [start, ...line, end, add2(end, mul2(n, E)), add2(start, mul2(n, E))];
  const removal = prismThrough(oc, s, pf, ccw(poly), -E, E);
  let tools = [removal];
  if (spec.depth !== undefined) {
    // Beyond the depth behind the line goes too.
    const back = line.map((p) => sub2(p, mul2(n, spec.depth!)));
    const bs = sub2(back[0], mul2(d0, E));
    const be = add2(back[back.length - 1], mul2(dk, E));
    tools = [...tools, prismThrough(oc, s, pf, ccw([bs, ...back, be, sub2(be, mul2(n, E)), sub2(bs, mul2(n, E))]), -E, E)];
  }
  const out = shapes.map((sh) => tools.reduce((acc, t) => booleanOp(oc, s, "cut", acc, t), sh));
  // The planes of the runs parallel to the first (the jogs of an offset line are seen edge on).
  const planes: CutPlane[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const d = unit2(sub2(line[i + 1], line[i]));
    if (Math.abs(d[0] * d0[1] - d[1] * d0[0]) < 1e-6) planes.push({ point: toModelPoint(line[i], pf), normal: N });
  }
  return { shapes: out, planes };
}

/** A polygon wound counter-clockwise. */
function ccw(poly: Vec2[]): Vec2[] {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a < 0 ? [...poly].reverse() : poly;
}

function compound(oc: OC, s: Scope, shapes: TopoDS_Shape[]): TopoDS_Shape {
  const builder = s.track(new oc.TopoDS_Builder());
  const c = s.track(new oc.TopoDS_Compound());
  builder.MakeCompound(c);
  for (const sh of shapes) builder.Add(c, sh);
  return c;
}

/** The faces of `shape` lying on one of the planes, facing the viewer, as loops in the view. */
function cutFaces(oc: OC, s: Scope, shape: TopoDS_Shape, planes: CutPlane[], f: ViewFrame, body: string, from: SectionRegion["from"], tol: number): SectionRegion[] {
  const out: SectionRegion[] = [];
  for (const face of listFaces(oc, s, shape)) {
    const adaptor = s.track(new oc.BRepAdaptor_Surface(face, true));
    if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) continue;
    const pln = s.track(adaptor.Plane());
    const ax = s.track(pln.Axis());
    const d = s.track(ax.Direction());
    const loc = s.track(pln.Location());
    const normal: Vec3 = [d.X(), d.Y(), d.Z()];
    const point: Vec3 = [loc.X(), loc.Y(), loc.Z()];
    const on = planes.some((p) => Math.abs(Math.abs(dot3(normal, p.normal)) - 1) < 1e-6 && Math.abs(dot3(sub(point, p.point), p.normal)) < tol);
    if (!on) continue;
    const props = s.track(new oc.GProp_GProps());
    oc.BRepGProp.SurfaceProperties(face, props, false, false);
    const loops: Vec2[][] = [];
    const wires = s.track(new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; wires.More(); wires.Next()) {
      const pieces: Vec2[][] = [];
      const ex = s.track(new oc.TopExp_Explorer(s.track(wires.Current()), oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; ex.More(); ex.Next()) pieces.push(sample(oc, s, s.track(oc.TopoDS.Edge(s.track(ex.Current())))).map((p) => inView(p, f)));
      const loop = chain(pieces, tol);
      if (loop.length >= 3) loops.push(loop);
    }
    if (loops.length) out.push({ body, loops, area: props.Mass(), from });
  }
  return out;
}

/** Joins edge polylines end to end into one closed loop (the edges of a wire, in any order and direction). */
export function chain(pieces: Vec2[][], tol: number): Vec2[] {
  const left = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  if (!left.length) return [];
  const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol * 10;
  const loop = left.shift()!;
  while (left.length) {
    const tail = loop[loop.length - 1];
    let i = left.findIndex((p) => near(p[0], tail));
    let piece: Vec2[];
    if (i >= 0) piece = left.splice(i, 1)[0];
    else {
      i = left.findIndex((p) => near(p[p.length - 1], tail));
      if (i < 0) break;
      piece = left.splice(i, 1)[0].reverse();
    }
    loop.push(...piece.slice(1));
  }
  if (loop.length > 1 && near(loop[0], loop[loop.length - 1])) loop.pop();
  return loop;
}

/** The frame a spec asks for; `frames` holds the frames of the specs before it, by id. */
export function frameOf(spec: ViewSpec, frames: Map<string, ViewFrame>, edgeAt: (parent: string, key: string) => [Vec2, Vec2] | null): ViewFrame {
  const f = spec.frame ?? { look: spec.look ?? "front" };
  if ("frame" in f) return f.frame;
  if ("look" in f) return viewFrame(f.look);
  const parent = frames.get(f.parent);
  if (!parent) throw new Error(`${spec.id}: its parent ${f.parent} is not projected`);
  if ("projected" in f) return projectedFrame(parent, f.projected, f.projection);
  if ("section" in f) return sectionFrame(parent, f.section, f.flip);
  const edge = edgeAt(f.parent, f.auxiliary);
  if (!edge) throw new Error(`${spec.id}: no straight edge ${f.auxiliary} in ${f.parent}`);
  return auxiliaryFrame(parent, edge[0], edge[1], f.flip);
}

/**
 * Projects the part for each view. Views are done in order; a view whose
 * frame comes from a parent must come after it.
 */
export function projectDrawingViews(oc: OC, part: BuiltPart, specs: ViewSpec[], cache: KeyCache = new Map(), known?: Map<string, ProjectedView>): ProjectedView[] {
  const frames = new Map<string, ViewFrame>();
  const done = new Map<string, ProjectedView>();
  const out: ProjectedView[] = [];
  for (const spec of specs) {
    // Projected before (the same spec of the same rebuild): kept.
    const hit = known?.get(spec.id);
    if (hit) {
      frames.set(spec.id, hit.frame);
      done.set(spec.id, hit);
      out.push(hit);
      continue;
    }
    const edgeAt = (parent: string, key: string): [Vec2, Vec2] | null => {
      const pv = done.get(parent);
      const e = pv?.edges.find((x) => x.key === key && x.look === "line");
      return e ? [e.pts[0], e.pts[e.pts.length - 1]] : null;
    };
    let frame: ViewFrame;
    try {
      frame = frameOf(spec, frames, edgeAt);
    } catch (e) {
      const pv: ProjectedView = { id: spec.id, frame: viewFrame("front"), bodies: [], edges: [], problems: [(e as Error).message] };
      out.push(pv);
      continue;
    }
    frames.set(spec.id, frame);
    const parentFrame = spec.frame && "parent" in spec.frame ? frames.get(spec.frame.parent) : undefined;
    const pv = scoped((s) => projectOne(oc, s, part, spec, frame, parentFrame, cache));
    if (spec.look) pv.look = spec.look;
    done.set(spec.id, pv);
    out.push(pv);
  }
  return out;
}

/** Each body's keyed model edges, by name: worked out once per rebuild. */
export type KeyCache = Map<string, { edges: KeyedEdge[]; rounds: Prepared["rounds"] }>;

function projectOne(oc: OC, s: Scope, part: BuiltPart, spec: ViewSpec, f: ViewFrame, parentFrame: ViewFrame | undefined, cache: KeyCache): ProjectedView {
  const problems: string[] = [];
  const chosen = part.bodies.filter((b) => !spec.bodies || spec.bodies.includes(b.name));
  if (spec.bodies) for (const b of spec.bodies) if (!part.bodies.some((x) => x.name === b)) problems.push(`no body "${b}" (bodies: ${part.bodies.map((x) => x.name).join(", ")})`);
  const size = partSize(oc, s, chosen.map((b) => b.shape));
  const tol = Math.max(1e-4, size.diag * 1e-6);
  // The model edges, keyed on the bodies as built (a cut keeps the keys of what it leaves).
  const original = chosen.map((b) => {
    let k = cache.get(b.name);
    if (!k) {
      const { edges, rounds } = keyed(oc, s, b, part.label);
      k = { edges, rounds };
      cache.set(b.name, k);
    }
    return { name: b.name, ...k };
  });
  let shapes: (TopoDS_Shape | null)[] = chosen.map((b) => b.shape);
  let planes: CutPlane[] = [];
  const sections: SectionRegion[] = [];
  if (spec.section && parentFrame) {
    try {
      const cut = sectionCut(oc, s, parentFrame, spec.section, chosen.map((b) => b.shape), size.diag);
      shapes = cut.shapes;
      planes = cut.planes;
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  if (spec.brokenOut?.length) {
    const front = Math.max(...corners(size).map((p) => depthOf(p, f)));
    const E = size.diag * 4;
    for (const b of spec.brokenOut) {
      try {
        const tool = prismThrough(oc, s, f, ccw(b.profile), front - b.depth, front + E);
        shapes = shapes.map((sh) => (sh ? booleanOp(oc, s, "cut", sh, tool) : sh));
        planes = [...planes, { point: toModelPoint([0, 0], f, front - b.depth), normal: f.eye }];
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
  }
  const cutting = planes.length > 0;
  const prepared: Prepared[] = [];
  chosen.forEach((b, i) => {
    const shape = shapes[i];
    if (!shape || shape.IsNull()) return;
    if (!cutting) {
      prepared.push({ name: b.name, shape, edges: original[i].edges, rounds: original[i].rounds });
      return;
    }
    // A cut body: its edges that lie on an edge as built keep that edge's key; the rest are the cut's.
    const list = listEdges(oc, s, shape);
    const bySig = new Map<string, KeyedEdge[]>();
    for (const e of original[i].edges) bySig.set(edgeSignature(e.info), [...(bySig.get(edgeSignature(e.info)) ?? []), e]);
    const edges: KeyedEdge[] = [];
    const fresh: { info: EdgeInfo; pts3: Vec3[] }[] = [];
    list.edges.forEach((edge, k) => {
      const info = edgeInfo(oc, s, edge, k);
      const pts3 = sample(oc, s, edge);
      const same = (bySig.get(edgeSignature(info)) ?? []).find((o) => distToPolyline3(info.mid, o.pts3) < tol * 10);
      if (same) edges.push({ ...same, info, pts3 });
      else fresh.push({ info, pts3 });
    });
    const keys = edgeKeys(fresh.map((x) => ({ ...x.info, createdBy: "cut" })));
    fresh.forEach((x, k) => edges.push({ key: keys[k], feature: "cut", info: x.info, pts3: x.pts3 }));
    prepared.push({ name: b.name, shape, edges, rounds: original[i].rounds });
    sections.push(...cutFaces(oc, s, shape, planes, f, b.name, spec.section ? "section" : "brokenOut", tol * 10));
  });
  const view = hlr(oc, s, prepared, f, tol);
  view.id = spec.id;
  if (sections.length) view.sections = sections;
  if (spec.shaded) view.shaded = shade(oc, prepared, f);
  if (problems.length) view.problems = problems;
  return view;
}

function corners(b: { min: Vec3; max: Vec3 }): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

function distToPolyline3(p: Vec3, pts: Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const ab = sub(pts[i + 1], a);
    const l2 = dot3(ab, ab);
    const t = l2 > 0 ? Math.max(0, Math.min(1, dot3(sub(p, a), ab) / l2)) : 0;
    const q: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    best = Math.min(best, Math.hypot(...sub(p, q)));
  }
  return best;
}

/** One model edge in the view: its 2D polyline with depths, and its box. */
interface Flat {
  e: KeyedEdge;
  body: string;
  pts: Vec2[];
  depth: number[];
  min: Vec2;
  max: Vec2;
}

/** The hidden-line projection, its output matched to the model edges. */
function hlr(oc: OC, s: Scope, bodies: Prepared[], f: ViewFrame, tol: number): ProjectedView {
  const view: ProjectedView = { id: "", frame: f, bodies: [], edges: [] };
  if (!bodies.length) return view;
  const ax = s.track(new oc.gp_Ax2(s.track(new oc.gp_Pnt(0, 0, 0)), s.track(new oc.gp_Dir(...f.eye)), s.track(new oc.gp_Dir(...f.right))));
  const algo = new oc.HLRBRep_Algo();
  try {
    for (const b of bodies) algo.Add(b.shape, 0);
    algo.Projector(s.track(new oc.HLRAlgo_Projector(ax)));
    algo.Update();
    algo.Hide();
    const out = s.track(new oc.HLRBRep_HLRToShape(algo));
    // Every model edge, flat in the view, in a grid for finding the ones under a point.
    const flats: Flat[] = [];
    for (const b of bodies)
      for (const e of b.edges) {
        const pts = e.pts3.map((p) => inView(p, f));
        const min: Vec2 = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
        const max: Vec2 = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
        flats.push({ e, body: b.name, pts, depth: e.pts3.map((p) => depthOf(p, f)), min, max });
      }
    const grid = new Grid(flats, tol);
    for (const b of bodies) {
      const visible: Vec2[][] = [];
      const hidden: Vec2[][] = [];
      const take = (compound: TopoDS_Shape, vis: boolean, type: "sharp" | "smooth" | "outline") => {
        for (const pts of polylines(oc, s, compound)) {
          if (type !== "smooth") (vis ? visible : hidden).push(pts);
          view.edges.push(type === "outline" ? outline(pts, vis, b, f, tol) : match(pts, vis, type, b.name, grid, f, tol));
        }
      };
      take(out.VCompound(b.shape), true, "sharp");
      take(out.OutLineVCompound(b.shape), true, "outline");
      take(out.Rg1LineVCompound(b.shape), true, "smooth");
      take(out.HCompound(b.shape), false, "sharp");
      take(out.OutLineHCompound(b.shape), false, "outline");
      take(out.Rg1LineHCompound(b.shape), false, "smooth");
      view.bodies.push({ name: b.name, visible, hidden });
    }
    // What matched no model edge (a cone's or a torus's side, a curve the kernel split): numbered by where it is.
    const loose = view.edges.filter((e) => !e.key);
    const mid = (e: ProjectedEdge) => along(e.pts, [0.5])[0];
    loose.sort((a, b) => mid(a)[0] - mid(b)[0] || mid(a)[1] - mid(b)[1]);
    loose.forEach((e, n) => (e.key = e.type === "outline" ? `?/s${n}a` : `?/x${n}`));
    // Model edges the projection drew nothing of (wholly hidden behind a coincident one) are still known, as hidden.
    const seen = new Set(view.edges.map((e) => e.key));
    for (const fl of flats) {
      if (seen.has(fl.e.key) || fl.e.info.seam) continue;
      seen.add(fl.e.key);
      view.edges.push({ ...edgeOf(fl.e, fl.body, f, fl.pts, false, "sharp"), pts: fl.pts });
    }
  } finally {
    algo.delete();
  }
  return view;
}

/** A bucket grid over the flat model edges' boxes. */
class Grid {
  private readonly cell: number;
  private readonly cells = new Map<string, Flat[]>();
  constructor(
    readonly all: Flat[],
    private readonly tol: number,
  ) {
    let w = 1;
    for (const f of all) w = Math.max(w, f.max[0] - f.min[0], f.max[1] - f.min[1]);
    this.cell = Math.max(w / 16, tol * 100, 1e-3);
    for (const f of all) for (const k of this.keys(f.min, f.max)) this.cells.set(k, [...(this.cells.get(k) ?? []), f]);
  }
  private keys(min: Vec2, max: Vec2): string[] {
    const c = this.cell;
    const out: string[] = [];
    for (let i = Math.floor((min[0] - this.tol) / c); i <= Math.floor((max[0] + this.tol) / c); i++)
      for (let j = Math.floor((min[1] - this.tol) / c); j <= Math.floor((max[1] + this.tol) / c); j++) out.push(`${i},${j}`);
    return out;
  }
  near(p: Vec2): Flat[] {
    return this.cells.get(`${Math.floor(p[0] / this.cell)},${Math.floor(p[1] / this.cell)}`) ?? [];
  }
}

/** Distance from p to a polyline, and the depth there. */
function onFlat(p: Vec2, fl: Flat): { d: number; depth: number } {
  let best = { d: Infinity, depth: 0 };
  for (let i = 0; i + 1 < fl.pts.length; i++) {
    const a = fl.pts[i];
    const b = fl.pts[i + 1];
    const ab = sub2(b, a);
    const l2 = ab[0] * ab[0] + ab[1] * ab[1];
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
    const q = add2(a, mul2(ab, t));
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best.d) best = { d, depth: fl.depth[i] + (fl.depth[i + 1] - fl.depth[i]) * t };
  }
  if (fl.pts.length === 1) best = { d: Math.hypot(p[0] - fl.pts[0][0], p[1] - fl.pts[0][1]), depth: fl.depth[0] };
  return best;
}

/** Points along a polyline at fractions of its length. */
function along(pts: Vec2[], ts: number[]): Vec2[] {
  const seg: number[] = [0];
  for (let i = 1; i < pts.length; i++) seg.push(seg[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = seg[seg.length - 1];
  return ts.map((t) => {
    const want = total * t;
    let i = 1;
    while (i < pts.length - 1 && seg[i] < want) i++;
    const span = seg[i] - seg[i - 1];
    const k = span > 0 ? (want - seg[i - 1]) / span : 0;
    return add2(pts[i - 1], mul2(sub2(pts[i], pts[i - 1]), k));
  });
}

/** The model edge an output edge is: the one it lies along (the nearest the viewer when several do). */
function match(pts: Vec2[], visible: boolean, type: "sharp" | "smooth", body: string, grid: Grid, f: ViewFrame, tol: number): ProjectedEdge {
  const probes = along(pts, [0.5, 0.2, 0.8]);
  const lim = Math.max(tol * 50, 2e-3);
  let best: { fl: Flat; depth: number } | null = null;
  for (const fl of grid.near(probes[0])) {
    if (fl.body !== body) continue;
    let ok = true;
    let depth = 0;
    for (const p of probes) {
      const r = onFlat(p, fl);
      if (r.d > lim) {
        ok = false;
        break;
      }
      if (p === probes[0]) depth = r.depth;
    }
    if (!ok) continue;
    if (!best || depth > best.depth + tol || (Math.abs(depth - best.depth) <= tol && fl.e.key < best.fl.e.key)) best = { fl, depth };
  }
  if (!best) return { key: "", body, type, visible, pts, look: "curve" };
  return edgeOf(best.fl.e, body, f, pts, visible, type);
}

function edgeOf(e: KeyedEdge, body: string, f: ViewFrame, pts: Vec2[], visible: boolean, type: ProjectedEdge["type"]): ProjectedEdge {
  const i = e.info;
  const model: ModelEdge = { kind: i.kind, start: i.start, end: i.end, length: i.length, ...(i.center ? { center: i.center, radius: i.radius, axis: i.axis } : {}) };
  let look: ProjectedEdge["look"] = i.kind === "line" ? "line" : "curve";
  let circle: ProjectedEdge["circle"];
  if (i.kind === "circle" && i.axis && i.center && i.radius !== undefined && Math.abs(dot3(norm3(i.axis), f.eye)) > 0.99999) {
    const c = inView(i.center, f);
    const full = Math.hypot(...sub(i.start, i.end)) < 1e-7;
    look = full ? "circle" : "arc";
    circle = { c, r: i.radius };
    if (!full) {
      // The arc's ends, counter-clockwise from a0 to a1 in the view, passing its middle.
      const ang = (p: Vec3) => {
        const q = inView(p, f);
        return Math.atan2(q[1] - c[1], q[0] - c[0]);
      };
      let a0 = ang(i.start);
      let a1 = ang(i.end);
      const am = ang(i.mid);
      const inside = (a: number, lo: number, hi: number) => {
        const t = (x: number) => ((x - lo) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        return t(a) <= t(hi);
      };
      if (!inside(am, a0, a1)) [a0, a1] = [a1, a0];
      circle.a0 = a0;
      circle.a1 = a1;
    }
  }
  return { key: e.key, body, ...(e.feature ? { feature: e.feature } : {}), type, visible, pts, look, ...(circle ? { circle } : {}), model };
}

/** A side of a round face: keyed by the face whose side it is. */
function outline(pts: Vec2[], visible: boolean, b: Prepared, f: ViewFrame, tol: number): ProjectedEdge {
  const probes = along(pts, [0.2, 0.5, 0.8]);
  for (const r of b.rounds) {
    const a = inView(r.axis, f);
    const la = Math.hypot(a[0], a[1]);
    if (la < 1e-6) continue;
    const u: Vec2 = [a[0] / la, a[1] / la];
    const o = inView(r.origin, f);
    const sides = probes.map((p) => (p[0] - o[0]) * -u[1] + (p[1] - o[1]) * u[0]);
    const lim = Math.max(tol * 50, r.radius * 1e-4, 2e-3);
    if (sides.every((d) => Math.abs(Math.abs(d) - r.radius) < lim) && sides.every((d) => Math.sign(d) === Math.sign(sides[0]))) {
      const side = sides[0] > 0 ? "a" : "b";
      return { key: `${r.key}${side}`, body: b.name, ...(r.feature ? { feature: r.feature } : {}), type: "outline", visible, pts, look: "line" };
    }
  }
  return { key: "", body: b.name, type: "outline", visible, pts, look: "curve" };
}

function polylines(oc: OC, s: Scope, compound: TopoDS_Shape): Vec2[][] {
  s.track(compound);
  if (compound.IsNull()) return [];
  const out: Vec2[][] = [];
  for (const edge of listEdges(oc, s, compound).edges) {
    const curve = s.track(new oc.BRepAdaptor_Curve(edge));
    const t0 = curve.FirstParameter();
    const t1 = curve.LastParameter();
    const type = curve.GetType();
    const n =
      type === oc.GeomAbs_CurveType.GeomAbs_Line
        ? 1
        : type === oc.GeomAbs_CurveType.GeomAbs_Circle || type === oc.GeomAbs_CurveType.GeomAbs_Ellipse
          ? Math.max(2, Math.ceil(Math.abs(t1 - t0) / ARC_STEP))
          : CURVE_STEPS;
    const pts: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const p = curve.Value(t0 + ((t1 - t0) * i) / n);
      pts.push([round4(p.X()), round4(p.Y())]);
      p.delete();
    }
    out.push(pts);
  }
  return out;
}

/** The faces as triangles, each shaded by how squarely it faces a light over the viewer's left shoulder. */
function shade(oc: OC, bodies: Prepared[], f: ViewFrame): ShadedTriangle[] {
  const light = norm3([...toModel([-0.45, 0.6], f).map((x, k) => x + f.eye[k] * 0.9)] as Vec3);
  const out: ShadedTriangle[] = [];
  for (const b of bodies) {
    const m = tessellate(oc, b.shape);
    const P = (i: number): Vec3 => [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]];
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const a = P(m.indices[t]);
      const bb = P(m.indices[t + 1]);
      const c = P(m.indices[t + 2]);
      const n = cross3(sub(bb, a), sub(c, a));
      const ln = Math.hypot(...n);
      if (ln < 1e-12) continue;
      const nn: Vec3 = [n[0] / ln, n[1] / ln, n[2] / ln];
      if (dot3(nn, f.eye) <= 0) continue;
      const lambert = Math.max(0, dot3(nn, light));
      out.push({ body: b.name, pts: [inView(a, f), inView(bb, f), inView(c, f)], shade: 0.35 + 0.65 * lambert, depth: (depthOf(a, f) + depthOf(bb, f) + depthOf(c, f)) / 3 });
    }
  }
  out.sort((x, y) => x.depth - y.depth);
  return out;
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4 + 0;
}

/** A spec's cache key: the same spec of the same rebuild projects the same. */
export function specKey(spec: ViewSpec, parentFrame?: ViewFrame): string {
  const { id: _id, ...rest } = spec;
  return JSON.stringify({ ...rest, ...(parentFrame ? { parentFrame } : {}) });
}

export { frameFrom };
