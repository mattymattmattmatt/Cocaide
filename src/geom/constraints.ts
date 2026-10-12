// Sketch constraints are checked here, not solved. The geometry in the
// document is authoritative and every constraint must already hold; a
// constraint that does not hold fails the sketch with the measured value.
// The solver (solver.ts) is what drives geometry from constraints.

import type { AngleConstraint, Constraint, SketchEntity, Vec2 } from "../doc/types";
import { isDriven, withAxes } from "./axes";
import { closestOnEllipse, closestOnSpline, ellipseGeom, ellipseSupport, entityPoint, splineEndTangent, splineOf } from "./curves";
import { dist2, sub2 } from "./vec";

const CONSTRAINT_TOL = 1e-6;

/** Returns one message per unsatisfied constraint. */
export function checkConstraints(entities: SketchEntity[], constraints: Constraint[]): string[] {
  const byId = new Map(withAxes(entities).map((e) => [e.id, e]));
  const errors: string[] = [];
  constraints.forEach((k, i) => {
    // A driven dimension measures; it holds whatever the geometry is.
    if (isDriven(k)) return;
    const r = evaluate(k, byId);
    if (!(Math.abs(r.actual - r.expected) <= (r.tol ?? CONSTRAINT_TOL))) {
      errors.push(`constraint ${i} (${r.label}) is not satisfied: geometry gives ${fmt(r.actual)}, constraint says ${fmt(r.expected)}`);
    }
  });
  return errors;
}

interface Evaluation {
  label: string;
  actual: number;
  expected: number;
  /** How far off fails it; lengths default to 1e-6 mm. */
  tol?: number;
}

function evaluate(k: Constraint, byId: Map<string, SketchEntity>): Evaluation {
  const get = (id: string) => byId.get(id)!;
  const pt = (ref: string) => point(ref, byId);
  switch (k.type) {
    case "coincident": {
      const [p, q] = k.points.map(pt);
      return { label: `coincident ${k.points[0]} ${k.points[1]}`, actual: dist2(p, q), expected: 0 };
    }
    case "horizontal":
    case "vertical": {
      const [p, q] = k.entity ? entitySpan(get(k.entity)) : k.points!.map(pt);
      const d = sub2(q, p);
      return { label: `${k.type} ${k.entity ?? k.points!.join(" ")}`, actual: Math.abs(k.type === "horizontal" ? d[1] : d[0]), expected: 0 };
    }
    case "distance":
    case "distanceX":
    case "distanceY": {
      // Measured to a circle's nearest or farthest point: its radius off or on, for each centre in it.
      const rim = (refs: string[]) => conditionOffset(k.condition, refs, byId);
      if (k.lines) {
        const [a, b] = k.lines.map(get);
        const [p, q] = entitySpan(b);
        const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        return { label: `distance ${k.lines[0]} to ${k.lines[1]} = ${fmt(k.value)}`, actual: Math.abs(offset(a, mid)), expected: k.value };
      }
      if (k.line !== undefined) {
        const d = Math.abs(offset(get(k.line), pt(k.point!)));
        if (k.doubled) return { label: `diameter ${k.point} across ${k.line} = ${fmt(k.value)}`, actual: 2 * d, expected: k.value };
        return { label: `distance ${k.point} to ${k.line} = ${fmt(k.value)}`, actual: d + rim([k.point!]), expected: k.value };
      }
      const target = k.entity ?? `${k.points![0]} ${k.points![1]}`;
      const label = `${k.type} ${target} = ${fmt(k.value)}`;
      const [p, q] = k.entity ? entitySpan(get(k.entity)) : k.points!.map(pt);
      if (k.entity && get(k.entity).type === "rect") {
        const r = get(k.entity) as Extract<SketchEntity, { type: "rect" }>;
        return { label, actual: k.type === "distanceX" ? r.w : r.h, expected: k.value };
      }
      const d = sub2(q, p);
      const actual = k.type === "distance" ? Math.hypot(d[0], d[1]) : Math.abs(k.type === "distanceX" ? d[0] : d[1]);
      return { label, actual: actual + rim(k.points ?? []), expected: k.value };
    }
    case "arcLength": {
      const a = get(k.entity);
      return { label: `arc length ${k.entity} = ${fmt(k.value)}`, actual: a.type === "arc" ? arcLength(a) : NaN, expected: k.value };
    }
    case "intersection": {
      const p = pt(k.point);
      const [a, b] = k.entities.map(get);
      return { label: `${k.point} where ${k.entities[0]} and ${k.entities[1]} cross`, actual: Math.max(Math.abs(offset(a, p)), Math.abs(offset(b, p))), expected: 0 };
    }
    case "coradial": {
      const [a, b] = k.entities.map(get);
      return { label: `coradial ${k.entities[0]} ${k.entities[1]}`, actual: dist2(centre(a), centre(b)) + Math.abs(radius(a) - radius(b)), expected: 0 };
    }
    case "radius":
      return { label: `radius ${k.entity} = ${fmt(k.value)}`, actual: radius(get(k.entity)), expected: k.value };
    case "diameter":
      return { label: `diameter ${k.entity} = ${fmt(k.value)}`, actual: 2 * radius(get(k.entity)), expected: k.value };
    case "equal": {
      const [a, b] = k.entities.map(get);
      if (a.type === "ellipse" && b.type === "ellipse") {
        const [g, h] = [ellipseGeom(a), ellipseGeom(b)];
        return { label: `equal ${k.entities[0]} ${k.entities[1]}`, actual: Math.abs(g.a - h.a) + Math.abs(g.b - h.b), expected: 0 };
      }
      const size = (e: SketchEntity) => (e.type === "line" ? dist2(e.start, e.end) : radius(e));
      return { label: `equal ${k.entities[0]} ${k.entities[1]}`, actual: size(a), expected: size(b) };
    }
    case "parallel":
    case "perpendicular":
    case "angle": {
      const [u, v] = k.entities.map((id) => unit(get(id)));
      const between = (Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180) / Math.PI;
      const pair = `${k.entities[0]} ${k.entities[1]}`;
      // Parallel either way along; the angle each way from square for perpendicular.
      if (k.type === "parallel") return { label: `parallel ${pair}`, actual: Math.min(between, 180 - between), expected: 0, tol: ANGLE_TOL };
      if (k.type === "perpendicular") return { label: `perpendicular ${pair}`, actual: between, expected: 90, tol: ANGLE_TOL };
      const { value, supplement } = k as AngleConstraint;
      return { label: `angle ${pair} = ${fmt(value)}°`, actual: supplement ? 180 - between : between, expected: value, tol: ANGLE_TOL };
    }
    case "collinear": {
      const [a, b] = k.entities.map(get);
      const [p, q] = entitySpan(b);
      return { label: `collinear ${k.entities[0]} ${k.entities[1]}`, actual: Math.max(Math.abs(offset(a, p)), Math.abs(offset(a, q))), expected: 0 };
    }
    case "tangent": {
      const [a, b] = k.entities.map(get);
      const label = `tangent ${k.entities[0]} ${k.entities[1]}`;
      if (a.type === "spline" || b.type === "spline") {
        // At the spline's end that meets the other: the directions in line (degrees off).
        const [spline, other] = (a.type === "spline" ? [a, b] : [b, a]) as [Extract<SketchEntity, { type: "spline" }>, SketchEntity];
        return { label, actual: tangentMiss(spline, other), expected: 0, tol: ANGLE_TOL };
      }
      if (a.type === "ellipse" || b.type === "ellipse") {
        // The line as far from the centre as the ellipse reaches across it.
        const [line, el] = (a.type === "ellipse" ? [b, a] : [a, b]) as [SketchEntity, Extract<SketchEntity, { type: "ellipse" }>];
        const u = unit(line);
        return { label, actual: Math.abs(offset(line, el.center)), expected: ellipseSupport(ellipseGeom(el), [-u[1], u[0]]) };
      }
      if (a.type === "line" || b.type === "line") {
        const [line, round] = a.type === "line" ? [a, b] : [b, a];
        return { label, actual: Math.abs(offset(line, centre(round))), expected: radius(round) };
      }
      const d = dist2(centre(a), centre(b));
      const outside = radius(a) + radius(b);
      const inside = Math.abs(radius(a) - radius(b));
      return { label, actual: d, expected: Math.abs(d - outside) < Math.abs(d - inside) ? outside : inside };
    }
    case "concentric": {
      const [a, b] = k.entities.map(get);
      return { label: `concentric ${k.entities[0]} ${k.entities[1]}`, actual: dist2(centre(a), centre(b)), expected: 0 };
    }
    case "midpoint": {
      const [p, q] = entitySpan(get(k.entity));
      const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      return { label: `midpoint ${k.point} of ${k.entity}`, actual: dist2(pt(k.point), mid), expected: 0 };
    }
    case "pointOn": {
      const e = get(k.entity);
      const p = pt(k.point);
      const label = `${k.point} on ${k.entity}`;
      if (e.type === "line") return { label, actual: Math.abs(offset(e, p)), expected: 0 };
      if (e.type === "ellipse") return { label, actual: closestOnEllipse(ellipseGeom(e), p).distance, expected: 0 };
      if (e.type === "spline") return { label, actual: closestOnSpline(splineOf(e), p).distance, expected: 0 };
      return { label, actual: dist2(p, centre(e)), expected: radius(e) };
    }
    case "symmetric": {
      const line = get(k.line);
      if (k.entities) {
        const [a, b] = k.entities.map(get);
        return { label: `symmetric ${k.entities[0]} ${k.entities[1]} about ${k.line}`, actual: mirrorError(a, b, line), expected: 0 };
      }
      const [p, q] = k.points!.map(pt);
      const u = unit(line);
      const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const along = Math.abs((q[0] - p[0]) * u[0] + (q[1] - p[1]) * u[1]);
      return { label: `symmetric ${k.points![0]} ${k.points![1]} about ${k.line}`, actual: Math.max(Math.abs(offset(line, mid)), along), expected: 0 };
    }
    case "offset": {
      // The worst pair: how far its offset is from the value, plus how far off concentric it is.
      let worst = 0;
      k.entities.forEach((b, i) => {
        const o = get(k.offsets[i]);
        let miss: number;
        if (b.includes(".") || b === "origin") miss = dist2(centre(o), pt(b)) + Math.abs(radius(o) - k.value);
        else {
          const base = get(b);
          if (base.type === "line" && o.type === "line") miss = Math.max(Math.abs(Math.abs(offset(base, o.start)) - k.value), Math.abs(Math.abs(offset(base, o.end)) - k.value));
          else miss = dist2(centre(o), centre(base)) + Math.abs(Math.abs(radius(o) - radius(base)) - k.value);
        }
        if (!(miss <= worst)) worst = miss;
      });
      return { label: `offset ${k.offsets.join(" ")} from ${k.entities.join(" ")} = ${fmt(k.value)}`, actual: k.value + worst, expected: k.value };
    }
    case "fix":
      return { label: `fix ${k.entity ?? k.point}`, actual: 0, expected: 0 };
  }
}

/** The point refs that are a circle's or an arc's centre ("c1.center"): what a distance's min or max condition applies to. */
export function roundCentres(refs: string[], byId: Map<string, SketchEntity>): string[] {
  return refs.filter((r) => {
    const [id, name] = r.split(".");
    const t = byId.get(id)?.type;
    return name === "center" && (t === "circle" || t === "arc");
  });
}

/** How much a min (−) or max (+) condition adds to a distance: the radii of the circles and arcs it measures to. */
function conditionOffset(condition: string | undefined, refs: string[], byId: Map<string, SketchEntity>): number {
  if (condition !== "min" && condition !== "max") return 0;
  const sum = roundCentres(refs, byId).reduce((s, r) => s + radius(byId.get(r.split(".")[0])!), 0);
  return condition === "min" ? -sum : sum;
}

/** An arc's sweep, radians, 0 to 2π, the way it runs (counter-clockwise unless clockwise). */
export function arcSweep(a: Extract<SketchEntity, { type: "arc" }>): number {
  const t0 = Math.atan2(a.start[1] - a.center[1], a.start[0] - a.center[0]);
  const t1 = Math.atan2(a.end[1] - a.center[1], a.end[0] - a.center[0]);
  let s = a.clockwise ? t0 - t1 : t1 - t0;
  while (s <= 0) s += 2 * Math.PI;
  while (s > 2 * Math.PI) s -= 2 * Math.PI;
  return s;
}

/** An arc's length along it. */
export function arcLength(a: Extract<SketchEntity, { type: "arc" }>): number {
  return dist2(a.start, a.center) * arcSweep(a);
}

/** p mirrored about the line (extended). */
function reflect(line: SketchEntity, p: Vec2): Vec2 {
  const [a] = entitySpan(line);
  const u = unit(line);
  const t = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
  const f: Vec2 = [a[0] + t * u[0], a[1] + t * u[1]];
  return [2 * f[0] - p[0], 2 * f[1] - p[1]];
}

/**
 * How far b is from a's mirror image about the line: the worst point, with
 * the ends paired the nearer way (a copy's ends may run either way), and a
 * radius off by as much counts as much.
 */
function mirrorError(a: SketchEntity, b: SketchEntity, line: SketchEntity): number {
  const m = (p: Vec2) => reflect(line, p);
  const ends = (e: SketchEntity): Vec2[] => (e.type === "line" || e.type === "arc" ? [e.start, e.end] : []);
  let err = a.type === b.type ? 0 : Infinity;
  if (a.type !== "line") err = Math.max(err, dist2(m(centre(a)), centre(b)), Math.abs(radius(a) - radius(b)));
  const [p, q] = ends(a);
  const [r, s] = ends(b);
  if (p && q && r && s) err = Math.max(err, Math.min(Math.max(dist2(m(p), r), dist2(m(q), s)), Math.max(dist2(m(p), s), dist2(m(q), r))));
  return err;
}

/** Degrees off for an angle relation to fail: 1e-6 of a degree. */
const ANGLE_TOL = 1e-6;

/** A line's unit direction (a slot's axis). */
function unit(e: SketchEntity): Vec2 {
  const [p, q] = entitySpan(e);
  const d = sub2(q, p);
  const n = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / n, d[1] / n];
}

/** A point's signed distance from a line, extended: positive on its left. */
function offset(line: SketchEntity, p: Vec2): number {
  const [a] = entitySpan(line);
  const u = unit(line);
  return u[0] * (p[1] - a[1]) - u[1] * (p[0] - a[0]);
}

function centre(e: SketchEntity): Vec2 {
  return "center" in e ? e.center : [NaN, NaN];
}

/** The two points a distance on an entity measures between. */
function entitySpan(e: SketchEntity): [Vec2, Vec2] {
  switch (e.type) {
    case "line":
      return [e.start, e.end];
    case "slot":
      return [e.center1, e.center2];
    case "ellipse":
      return [e.center, e.major]; // its major axis: what horizontal and vertical level
    default:
      return [[0, 0], [0, 0]]; // rect is handled by the caller; validation rejects the rest
  }
}

function radius(e: SketchEntity): number {
  if (e.type === "circle") return e.radius;
  if (e.type === "arc") return dist2(e.start, e.center);
  return NaN;
}

/**
 * Which end of an open spline a tangent relation with `other` is at: the end
 * nearer the other entity (a joined end is on it). True: the last point.
 */
export function splineTangentEnd(spline: Extract<SketchEntity, { type: "spline" }>, other: SketchEntity): boolean {
  const first = spline.points[0];
  const last = spline.points[spline.points.length - 1];
  return distanceTo(other, last) < distanceTo(other, first);
}

/** How far p is from an entity's curve (a line as drawn, a circle's or arc's circle, a spline's ends). */
function distanceTo(e: SketchEntity, p: Vec2): number {
  if (e.type === "line") {
    const d = sub2(e.end, e.start);
    const l2 = d[0] * d[0] + d[1] * d[1] || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - e.start[0]) * d[0] + (p[1] - e.start[1]) * d[1]) / l2));
    return dist2(p, [e.start[0] + t * d[0], e.start[1] + t * d[1]]);
  }
  if (e.type === "circle" || e.type === "arc") return Math.abs(dist2(p, e.center) - radius(e));
  if (e.type === "spline") return e.closed ? closestOnSpline(splineOf(e), p).distance : Math.min(dist2(p, e.points[0]), dist2(p, e.points[e.points.length - 1]));
  if (e.type === "ellipse") return closestOnEllipse(ellipseGeom(e), p).distance;
  return Infinity;
}

/**
 * The unit direction a tangent at a spline's end must have, by what it is
 * tangent to (either way along): a line's direction; square to a circle's or
 * arc's radius through that end; another spline's nearer end tangent.
 */
export function tangentTarget(spline: Extract<SketchEntity, { type: "spline" }>, other: SketchEntity, end: boolean): Vec2 | null {
  const at = end ? spline.points[spline.points.length - 1] : spline.points[0];
  let w: Vec2;
  if (other.type === "line") w = unit(other);
  else if (other.type === "circle" || other.type === "arc") {
    const r = sub2(at, other.center);
    w = [-r[1], r[0]];
  } else if (other.type === "spline" && !other.closed) w = splineEndTangent(other, splineTangentEnd(other, spline));
  else return null;
  const l = Math.hypot(w[0], w[1]) || 1;
  return [w[0] / l, w[1] / l];
}

/** Degrees a spline's end is off tangent to the other entity there. */
function tangentMiss(spline: Extract<SketchEntity, { type: "spline" }>, other: SketchEntity): number {
  if (spline.closed) return NaN;
  const end = splineTangentEnd(spline, other);
  const t = splineEndTangent(spline, end);
  const w = tangentTarget(spline, other, end);
  if (!w) return NaN;
  const sin = Math.abs(t[0] * w[1] - t[1] * w[0]);
  return (Math.asin(Math.min(1, sin)) * 180) / Math.PI;
}

export function point(ref: string, byId: Map<string, SketchEntity>): Vec2 {
  if (ref === "origin") return [0, 0];
  const [id, name] = ref.split(".");
  const e = byId.get(id);
  if (e?.type === "ellipse" || e?.type === "spline") return entityPoint(e, name)!;
  return (e as unknown as Record<string, Vec2>)[name];
}

function fmt(x: number): string {
  return String(Math.round(x * 1e6) / 1e6);
}

/** What a constraint measures on the current geometry, and what it asks for. */
export function measureConstraint(entities: SketchEntity[], k: Constraint): { label: string; actual: number; expected: number } {
  return evaluate(k, new Map(withAxes(entities).map((e) => [e.id, e])));
}
