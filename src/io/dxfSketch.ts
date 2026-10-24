// Sketches to DXF and DXF into sketches.
//
// Out: a sketch's profile geometry goes on layer PROFILE (lines and arcs that
// meet end to end joined into polylines, closed where they close), its
// construction and reference geometry on CONSTRUCTION (dashed), its points on
// POINTS. Splines go out exactly, as cubic B-splines (each piece between two
// of its points is a Bezier: the knots are those of the sketch spline).
//
// In: the DXF's lines, arcs, circles, polylines (bulges become arcs),
// ellipses and splines become sketch entities, placed with the DXF origin on
// the sketch origin (or centred on it), on the layers chosen. Ends that meet
// (within `tolerance`) are snapped together and tied with coincident
// relations, and lines that are exactly level or plumb get horizontal or
// vertical, so the sketch closes into a profile and keeps its shape when it
// is edited. Pure.

import type { ArcEntity, Constraint, EllipseEntity, LineEntity, SketchEntity, SplineEntity, Vec2 } from "../doc/types";
import { ENTITY_PREFIX, isConstruction } from "../doc/sketch";
import { ellipseGeom, ellipseSpan, splineOf } from "../geom/curves";
import { interpolate } from "../geom/spline";
import { skippedText, type DxfDrawing, type DxfEntity, type DxfLayer, type DxfRead } from "./dxf";
import { boundsOf, ellipsePoint, explodePolyline, joinContours, nurbsPoint, nurbsRange, sampleSpline, translateAll } from "./dxfGeom";

export const SKETCH_LAYERS: DxfLayer[] = [
  { name: "PROFILE", color: 7 },
  { name: "CONSTRUCTION", color: 8, lineType: "DASHED" },
  { name: "POINTS", color: 3 },
];

const DEG = Math.PI / 180;
const r9 = (x: number) => Math.round(x * 1e9) / 1e9 + 0;
const p9 = (p: Vec2): Vec2 => [r9(p[0]), r9(p[1])];

// ================================================================== out

/** One sketch entity as DXF entities on `layer` (before lines and arcs are joined). */
export function sketchEntityToDxf(e: SketchEntity, layer: string): DxfEntity[] {
  switch (e.type) {
    case "line":
      return [{ type: "line", a: e.start, b: e.end, layer }];
    case "circle":
      return [{ type: "circle", c: e.center, r: e.radius, layer }];
    case "arc": {
      const a = Math.atan2(e.start[1] - e.center[1], e.start[0] - e.center[0]) / DEG;
      const b = Math.atan2(e.end[1] - e.center[1], e.end[0] - e.center[0]) / DEG;
      const r = Math.hypot(e.start[0] - e.center[0], e.start[1] - e.center[1]);
      // DXF arcs run counter-clockwise: a clockwise arc is the same arc from its end.
      return [{ type: "arc", c: e.center, r, start: e.clockwise ? b : a, end: e.clockwise ? a : b, layer }];
    }
    case "rect": {
      const [x0, x1, y0, y1] = [e.center[0] - e.w / 2, e.center[0] + e.w / 2, e.center[1] - e.h / 2, e.center[1] + e.h / 2];
      return [{ type: "polyline", points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true, layer }];
    }
    case "slot": {
      const d = [e.center2[0] - e.center1[0], e.center2[1] - e.center1[1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      const n: Vec2 = [(-d[1] / l) * (e.width / 2), (d[0] / l) * (e.width / 2)];
      const p1: Vec2 = [e.center1[0] - n[0], e.center1[1] - n[1]];
      const p2: Vec2 = [e.center2[0] - n[0], e.center2[1] - n[1]];
      const p3: Vec2 = [e.center2[0] + n[0], e.center2[1] + n[1]];
      const p4: Vec2 = [e.center1[0] + n[0], e.center1[1] + n[1]];
      // Two half turns: bulge tan(180° / 4) = 1, counter-clockwise.
      return [{ type: "polyline", points: [p1, p2, p3, p4], bulges: [0, 1, 0, 1], closed: true, layer }];
    }
    case "point":
      return [{ type: "point", at: e.at, layer: layer === "CONSTRUCTION" ? layer : "POINTS" }];
    case "ellipse": {
      const g = ellipseGeom(e);
      const span = ellipseSpan(e);
      const whole = Math.abs(span.sweep) >= 2 * Math.PI - 1e-12;
      // DXF wants the major axis the longer: drawn the other way round, the axes swap and the parameter turns back a quarter.
      const swap = g.b > g.a;
      const major: Vec2 = swap ? [g.v[0] * g.b, g.v[1] * g.b] : [g.u[0] * g.a, g.u[1] * g.a];
      const ratio = swap ? g.a / g.b : g.b / g.a;
      const start = span.start - (swap ? Math.PI / 2 : 0);
      return [{ type: "ellipse", c: g.c, major, ratio, start: whole ? 0 : start, end: whole ? 2 * Math.PI : start + span.sweep, layer }];
    }
    case "spline": {
      const curve = splineOf(e);
      // Exact: the Bezier pieces as one cubic B-spline, each inner knot three times.
      const control: Vec2[] = [curve.spans[0][0]];
      for (const s of curve.spans) control.push(s[1], s[2], s[3]);
      const t = curve.knots;
      const knots = [t[0], t[0], t[0], t[0]];
      for (let i = 1; i < t.length - 1; i++) knots.push(t[i], t[i], t[i]);
      knots.push(t[t.length - 1], t[t.length - 1], t[t.length - 1], t[t.length - 1]);
      return [{ type: "spline", degree: 3, control, knots, ...(e.closed ? { closed: true } : {}), layer }];
    }
  }
}

/** A sketch's entities as a DXF drawing: profile on PROFILE, construction and references on CONSTRUCTION, points on POINTS. */
export function sketchToDxf(entities: SketchEntity[]): DxfDrawing {
  const out: DxfEntity[] = [];
  for (const e of entities) out.push(...sketchEntityToDxf(e, isConstruction(e) ? "CONSTRUCTION" : "PROFILE"));
  return { entities: joinContours(out, 1e-6), layers: SKETCH_LAYERS };
}

// =================================================================== in

export interface InsertOptions {
  /** The layers to take (default: every layer the file draws on). */
  layers?: string[];
  /** Move the drawing so the middle of its box is on the sketch origin (default: the DXF origin on the sketch origin). */
  centre?: boolean;
  /** Ends closer than this (mm) are joined (default 0.01). */
  tolerance?: number;
  /** Multiply every size by this (a drawing whose units were wrong: 25.4 reads inches as mm). */
  scale?: number;
}

export interface Inserted {
  entities: SketchEntity[];
  constraints: Constraint[];
  /** Ends snapped together, relations added. */
  joined: number;
  /** "Inserted 42 entities (3 texts skipped)". */
  report: string;
}

/**
 * The DXF's geometry as new sketch entities and relations, beside `existing`
 * (whose ids they keep clear of). Ellipses keep their shape; splines pass
 * through points sampled from the file's curve (its fit points when it has
 * them), within a hundredth of a millimetre.
 */
export function dxfToSketch(read: DxfRead, existing: SketchEntity[], opts: InsertOptions = {}): Inserted {
  const tol = opts.tolerance ?? 0.01;
  const layers = opts.layers ? new Set(opts.layers) : null;
  let source = read.entities.filter((e) => e.type !== "text" && (!layers || layers.has(e.layer ?? "0")));
  if (opts.scale && opts.scale !== 1) {
    const k = opts.scale;
    source = source.flatMap((e) => scaled(e, k));
  }
  if (opts.centre) {
    const box = boundsOf(source);
    if (box) source = translateAll(source, [-(box.min[0] + box.max[0]) / 2, -(box.min[1] + box.max[1]) / 2]);
  }
  const used = new Set(existing.map((e) => e.id));
  const id = (type: SketchEntity["type"]) => {
    const prefix = ENTITY_PREFIX[type];
    for (let n = 1; ; n++) {
      const x = `${prefix}${n}`;
      if (!used.has(x)) {
        used.add(x);
        return x;
      }
    }
  };
  const made: SketchEntity[] = [];
  let curvesSkipped = 0;
  for (const e of source.flatMap((x) => (x.type === "polyline" ? explodePolyline(x) : [x]))) {
    const s = toSketch(e, id, tol);
    if (s) made.push(s);
    else curvesSkipped++;
  }
  const constraints: Constraint[] = [];
  const joined = joinEnds(made, tol, constraints);
  // Level and plumb lines say so, so dragging one keeps it square.
  for (const e of made) {
    if (e.type !== "line") continue;
    const dx = e.end[0] - e.start[0];
    const dy = e.end[1] - e.start[1];
    const l = Math.hypot(dx, dy);
    if (Math.abs(dy) <= 1e-9 * Math.max(1, l)) constraints.push({ type: "horizontal", entity: e.id });
    else if (Math.abs(dx) <= 1e-9 * Math.max(1, l)) constraints.push({ type: "vertical", entity: e.id });
  }
  const skipped = { ...read.skipped };
  const texts = read.entities.filter((e) => e.type === "text").length;
  if (texts) skipped.text = (skipped.text ?? 0) + texts;
  if (curvesSkipped) skipped["degenerate curve"] = curvesSkipped;
  const left = skippedText(skipped);
  const units = read.units.scale !== 1 ? `, ${read.units.name} converted to mm` : read.units.assumed ? ", units not given: read as mm" : "";
  const report = `Inserted ${made.length} entit${made.length === 1 ? "y" : "ies"}${left || units ? ` (${[left && `${left} skipped`, units.replace(/^, /, "")].filter(Boolean).join("; ")})` : ""}`;
  return { entities: made, constraints, joined, report };
}

function scaled(e: DxfEntity, k: number): DxfEntity[] {
  return [scaleEntity(e, k)];
}

/** Every coordinate and size of the entity times k (k > 0). */
function scaleEntity(e: DxfEntity, k: number): DxfEntity {
  const s = (p: Vec2): Vec2 => [p[0] * k, p[1] * k];
  switch (e.type) {
    case "line":
      return { ...e, a: s(e.a), b: s(e.b) };
    case "circle":
      return { ...e, c: s(e.c), r: e.r * k };
    case "arc":
      return { ...e, c: s(e.c), r: e.r * k };
    case "polyline":
      return { ...e, points: e.points.map(s) };
    case "ellipse":
      return { ...e, c: s(e.c), major: s(e.major) };
    case "spline":
      return { ...e, control: e.control.map(s), ...(e.fit ? { fit: e.fit.map(s) } : {}) };
    case "point":
      return { ...e, at: s(e.at) };
    case "text":
      return { ...e, at: s(e.at), height: e.height * k };
  }
}

function toSketch(e: DxfEntity, id: (t: SketchEntity["type"]) => string, tol: number): SketchEntity | null {
  switch (e.type) {
    case "line":
      if (Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) <= 1e-6) return null;
      return { id: id("line"), type: "line", start: p9(e.a), end: p9(e.b) };
    case "circle":
      return { id: id("circle"), type: "circle", center: p9(e.c), radius: r9(e.r) };
    case "arc": {
      const start = p9([e.c[0] + e.r * Math.cos(e.start * DEG), e.c[1] + e.r * Math.sin(e.start * DEG)]);
      const end = p9([e.c[0] + e.r * Math.cos(e.end * DEG), e.c[1] + e.r * Math.sin(e.end * DEG)]);
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 1e-6) return { id: id("circle"), type: "circle", center: p9(e.c), radius: r9(e.r) };
      return fitArc({ id: id("arc"), type: "arc", center: p9(e.c), start, end });
    }
    case "ellipse": {
      const a = Math.hypot(e.major[0], e.major[1]);
      if (!(a > 1e-6) || !(e.ratio > 1e-9)) return null;
      const span = (((e.end - e.start) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const whole = span < 1e-9;
      if (Math.abs(e.ratio - 1) < 1e-12) {
        // A round "ellipse" is a circle or an arc.
        if (whole) return { id: id("circle"), type: "circle", center: p9(e.c), radius: r9(a) };
        const rot = Math.atan2(e.major[1], e.major[0]) / DEG;
        return toSketch({ type: "arc", c: e.c, r: a, start: rot + e.start / DEG, end: rot + e.end / DEG }, id, tol);
      }
      const el: EllipseEntity = { id: id("ellipse"), type: "ellipse", center: p9(e.c), major: p9([e.c[0] + e.major[0], e.c[1] + e.major[1]]), minor: r9(a * e.ratio) };
      if (!whole) {
        el.startAngle = r9(e.start / DEG);
        el.endAngle = r9((e.start + span) / DEG);
      }
      return el;
    }
    case "spline":
      return splineFrom(e, id, tol);
    case "point":
      return { id: id("point"), type: "point", at: p9(e.at) };
    default:
      return null;
  }
}

/** The arc with its centre moved (a hair) so both ends are exactly as far from it: on the ends' perpendicular bisector, nearest the old centre. */
function fitArc(a: ArcEntity): ArcEntity {
  const m: Vec2 = [(a.start[0] + a.end[0]) / 2, (a.start[1] + a.end[1]) / 2];
  const d: Vec2 = [a.end[0] - a.start[0], a.end[1] - a.start[1]];
  const l = Math.hypot(d[0], d[1]);
  if (l < 1e-12) return a;
  const n: Vec2 = [-d[1] / l, d[0] / l];
  const t = (a.center[0] - m[0]) * n[0] + (a.center[1] - m[1]) * n[1];
  return { ...a, center: [m[0] + n[0] * t, m[1] + n[1] * t] };
}

/**
 * A sketch spline for a DXF spline: through its fit points when it has them,
 * else through points of its curve, more where the sketch spline would stray
 * more than `tol` from it; its ends leave the way the file's curve does.
 */
function splineFrom(e: Extract<DxfEntity, { type: "spline" }>, id: (t: SketchEntity["type"]) => string, tol: number): SplineEntity | null {
  const closed = !!e.closed;
  const clean = (pts: Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of pts) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 1e-6) out.push(p9(p));
    if (closed && out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-6) out.pop();
    return out;
  };
  if (e.control.length < 2) {
    const pts = clean(e.fit ?? []);
    if (pts.length < (closed ? 3 : 2)) return null;
    return { id: id("spline"), type: "spline", points: pts, ...(closed ? { closed: true } : {}) };
  }
  const [t0, t1] = nurbsRange(e.degree, e.knots, e.control.length);
  const at = (t: number) => nurbsPoint(e.degree, e.knots, e.control, e.weights, t);
  // Start with the knots and the middle of each knot span, then add points where the fit strays.
  let params = [...new Set(e.knots.filter((k) => k >= t0 && k <= t1))].sort((x, y) => x - y);
  if (params.length < 2) params = [t0, t1];
  params = params.flatMap((t, i) => (i === 0 ? [t] : [(params[i - 1] + t) / 2, t]));
  const tangent = (t: number, end: boolean): number => {
    const h = (t1 - t0) * 1e-6;
    const p = at(end ? t - h : t);
    const q = at(end ? t : t + h);
    return Math.atan2(q[1] - p[1], q[0] - p[0]) / DEG;
  };
  const build = (ps: number[]): SplineEntity | null => {
    const pts = clean(ps.map(at));
    if (pts.length < (closed ? 3 : 2)) return null;
    return {
      id: "",
      type: "spline",
      points: pts,
      ...(closed ? { closed: true } : { startTangent: r9(tangent(t0, false)), endTangent: r9(tangent(t1, true)) }),
    };
  };
  let best = build(params);
  for (let round = 0; best && round < 4; round++) {
    let curve;
    try {
      curve = splineOf(best);
    } catch {
      break;
    }
    // Compare at the middle of each piece of the sketch spline against the file's curve sampled finely.
    const fine = sampleSpline(e, tol / 4);
    let worst = 0;
    for (const span of curve.spans) {
      const m: Vec2 = [(span[0][0] + 3 * span[1][0] + 3 * span[2][0] + span[3][0]) / 8, (span[0][1] + 3 * span[1][1] + 3 * span[2][1] + span[3][1]) / 8];
      worst = Math.max(worst, distanceToPolyline(m, fine));
    }
    if (worst <= tol || params.length > 400) break;
    params = params.flatMap((t, i) => (i === 0 ? [t] : [(params[i - 1] + t) / 2, t]));
    best = build(params);
  }
  if (!best) return null;
  // The tangents read here are degrees from the sketch's x axis.
  try {
    interpolate(best.points, closed);
  } catch {
    return null;
  }
  return { ...best, id: id("spline") };
}

function distanceToPolyline(p: Vec2, pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const l2 = d[0] * d[0] + d[1] * d[1];
    const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]));
  }
  return best;
}

/** An entity end that can join another: its point ref, where it is, and how freely it moves (lower moves first). */
interface End {
  ref: string;
  at: Vec2;
  /** 0: a line end (moves freely); 1: a spline end; 2: an arc end (its centre follows); 3: an elliptical arc end (stays). */
  stiffness: number;
}

function endsOf(e: SketchEntity): End[] {
  switch (e.type) {
    case "line":
      return [
        { ref: `${e.id}.start`, at: e.start, stiffness: 0 },
        { ref: `${e.id}.end`, at: e.end, stiffness: 0 },
      ];
    case "arc":
      return [
        { ref: `${e.id}.start`, at: e.start, stiffness: 2 },
        { ref: `${e.id}.end`, at: e.end, stiffness: 2 },
      ];
    case "spline":
      return e.closed
        ? []
        : [
            { ref: `${e.id}.p0`, at: e.points[0], stiffness: 1 },
            { ref: `${e.id}.p${e.points.length - 1}`, at: e.points[e.points.length - 1], stiffness: 1 },
          ];
    case "ellipse": {
      if (e.startAngle === undefined || e.endAngle === undefined) return [];
      const g = ellipseGeom(e);
      const pt = (deg: number): Vec2 => ellipsePoint(g.c, [g.u[0] * g.a, g.u[1] * g.a], g.b / g.a, deg * DEG);
      return [
        { ref: `${e.id}.start`, at: pt(e.startAngle), stiffness: 3 },
        { ref: `${e.id}.end`, at: pt(e.endAngle), stiffness: 3 },
      ];
    }
    default:
      return [];
  }
}

/**
 * Snaps ends that meet within `tol` onto one point (the stiffest end's: an
 * elliptical arc's end cannot move, an arc's moves with its centre, a line's
 * freely) and ties each group with coincident relations. Returns how many
 * ends were joined.
 */
function joinEnds(entities: SketchEntity[], tol: number, constraints: Constraint[]): number {
  const ends = entities.flatMap(endsOf);
  // A grid of cells `tol` wide finds the neighbours of each end without comparing every pair.
  const cell = Math.max(tol, 1e-9);
  const key = (p: Vec2, dx = 0, dy = 0) => `${Math.floor(p[0] / cell) + dx},${Math.floor(p[1] / cell) + dy}`;
  const grid = new Map<string, number[]>();
  ends.forEach((e, i) => {
    const k = key(e.at);
    grid.set(k, [...(grid.get(k) ?? []), i]);
  });
  const group = new Array<number>(ends.length).fill(-1);
  const groups: number[][] = [];
  for (let i = 0; i < ends.length; i++) {
    if (group[i] >= 0) continue;
    const members = [i];
    group[i] = groups.length;
    for (let m = 0; m < members.length; m++) {
      const p = ends[members[m]].at;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const j of grid.get(key(p, dx, dy)) ?? []) {
            if (group[j] >= 0) continue;
            if (Math.hypot(ends[j].at[0] - p[0], ends[j].at[1] - p[1]) <= tol) {
              group[j] = groups.length;
              members.push(j);
            }
          }
    }
    groups.push(members);
  }
  const byId = new Map(entities.map((e, i) => [e.id, i]));
  let joined = 0;
  for (const g of groups) {
    if (g.length < 2) continue;
    // Two ends of one entity (a line from a point back to it) are not a joint.
    const owners = new Set(g.map((i) => ends[i].ref.split(".")[0]));
    if (owners.size < 2) continue;
    const anchor = g.reduce((best, i) => (ends[i].stiffness > ends[best].stiffness ? i : best), g[0]);
    const at = ends[anchor].at;
    for (const i of g) {
      if (i === anchor) continue;
      const [eid, name] = ends[i].ref.split(".");
      const k = byId.get(eid)!;
      entities[k] = moveEnd(entities[k], name, at);
      constraints.push({ type: "coincident", points: [ends[anchor].ref, ends[i].ref] });
      joined++;
    }
  }
  return joined;
}

function moveEnd(e: SketchEntity, name: string, at: Vec2): SketchEntity {
  if (e.type === "line") return name === "start" ? ({ ...e, start: at } as LineEntity) : ({ ...e, end: at } as LineEntity);
  if (e.type === "arc") return fitArc(name === "start" ? { ...e, start: at } : { ...e, end: at });
  if (e.type === "spline") {
    const i = Number(name.slice(1));
    const points = e.points.map((p, j) => (j === i ? at : p));
    return { ...e, points };
  }
  return e;
}
