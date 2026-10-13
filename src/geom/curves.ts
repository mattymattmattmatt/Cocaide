// Ellipses and splines as sketch entities: their geometry, and the named
// points of every entity type (what a point ref like "el1.minorEnd" or
// "sp1.p3" stands for).
//
// An ellipse: center, the end of its major semi-axis (`major`) and its minor
// radius. Its point at parameter angle t (radians here, degrees in the
// document) is center + a·cos t·u + b·sin t·v, u the unit major direction,
// v = u turned a quarter left, a = |major − center|, b = minor: the
// eccentric anomaly, the parameter OCCT's ellipses use too. An elliptical arc
// runs counter-clockwise (increasing t) from startAngle to endAngle.
//
// A spline is the interpolating cubic of spline.ts through its points.
//
// Pure, no kernel.

import type { EllipseEntity, SketchEntity, SplineEntity, Vec2 } from "../doc/types";
import { closestOnSpline, interpolate, splineTangentAt, type SplineCurve } from "./spline";

export const DEG = Math.PI / 180;

// ---------------------------------------------------------------- ellipse

/** An ellipse's frame: centre, unit major and minor directions, and the radii along them. */
export interface EllipseGeom {
  c: Vec2;
  u: Vec2;
  v: Vec2;
  /** Radius along u (the major radius as drawn; it may come out shorter than b while dragging). */
  a: number;
  /** Radius along v. */
  b: number;
}

export function ellipseGeom(e: Pick<EllipseEntity, "center" | "major" | "minor">): EllipseGeom {
  const dx = e.major[0] - e.center[0];
  const dy = e.major[1] - e.center[1];
  const a = Math.hypot(dx, dy);
  const u: Vec2 = a > 0 ? [dx / a, dy / a] : [1, 0];
  return { c: e.center, u, v: [-u[1], u[0]], a, b: e.minor };
}

/** The point at parameter angle t (radians). */
export function ellipsePoint(g: EllipseGeom, t: number): Vec2 {
  const ca = g.a * Math.cos(t);
  const sb = g.b * Math.sin(t);
  return [g.c[0] + ca * g.u[0] + sb * g.v[0], g.c[1] + ca * g.u[1] + sb * g.v[1]];
}

/** d/dt of the point at t. */
export function ellipseDeriv(g: EllipseGeom, t: number): Vec2 {
  const sa = -g.a * Math.sin(t);
  const cb = g.b * Math.cos(t);
  return [sa * g.u[0] + cb * g.v[0], sa * g.u[1] + cb * g.v[1]];
}

/** p in the ellipse's own frame: along the major axis, along the minor. */
export function ellipseLocal(g: EllipseGeom, p: Vec2): Vec2 {
  const d: Vec2 = [p[0] - g.c[0], p[1] - g.c[1]];
  return [d[0] * g.u[0] + d[1] * g.u[1], d[0] * g.v[0] + d[1] * g.v[1]];
}

/** The parameter angle (radians) of the ellipse point on the ray from the centre's affine image: exact for points on it. */
export function ellipseParam(g: EllipseGeom, p: Vec2): number {
  const [x, y] = ellipseLocal(g, p);
  return Math.atan2(y / g.b, x / g.a);
}

/**
 * How far p is outside the ellipse, to first order a distance (mm): zero on
 * it, negative inside. Smooth everywhere but the centre, which makes it a
 * good equation for "point on ellipse".
 */
export function ellipseLevel(g: EllipseGeom, p: Vec2): number {
  const [x, y] = ellipseLocal(g, p);
  return (Math.hypot(x / g.a, y / g.b) - 1) * Math.min(g.a, g.b);
}

/** The nearest point of the (whole) ellipse to p. */
export function closestOnEllipse(g: EllipseGeom, p: Vec2): { t: number; at: Vec2; distance: number } {
  // Start from the best of a coarse ring, then Newton on (P(t) − p)·P'(t) = 0.
  let t = 0;
  let best = Infinity;
  for (let k = 0; k < 32; k++) {
    const s = (k / 32) * 2 * Math.PI;
    const q = ellipsePoint(g, s);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < best) (best = d), (t = s);
  }
  for (let it = 0; it < 12; it++) {
    const q = ellipsePoint(g, t);
    const d1 = ellipseDeriv(g, t);
    const d2: Vec2 = [q[0] - g.c[0], q[1] - g.c[1]]; // P'' = −(P − c)
    const f = (q[0] - p[0]) * d1[0] + (q[1] - p[1]) * d1[1];
    const df = d1[0] * d1[0] + d1[1] * d1[1] - ((q[0] - p[0]) * d2[0] + (q[1] - p[1]) * d2[1]);
    if (Math.abs(df) < 1e-15) break;
    const step = f / df;
    t -= Math.max(-0.5, Math.min(0.5, step));
    if (Math.abs(step) < 1e-14) break;
  }
  const at = ellipsePoint(g, t);
  return { t, at, distance: Math.hypot(at[0] - p[0], at[1] - p[1]) };
}

/** Half the ellipse's width across direction n (a unit vector): how far its tangent lines square to n are from the centre. */
export function ellipseSupport(g: EllipseGeom, n: Vec2): number {
  const nu = n[0] * g.u[0] + n[1] * g.u[1];
  const nv = n[0] * g.v[0] + n[1] * g.v[1];
  return Math.hypot(g.a * nu, g.b * nv);
}

/** An elliptical arc (startAngle and endAngle both set), not a whole ellipse. */
export function isEllipticalArc(e: EllipseEntity): boolean {
  return e.startAngle !== undefined && e.endAngle !== undefined;
}

/** Where an ellipse starts (radians) and how far it turns, counter-clockwise: 0 and 2π for a whole one. */
export function ellipseSpan(e: EllipseEntity): { start: number; sweep: number } {
  if (!isEllipticalArc(e)) return { start: 0, sweep: 2 * Math.PI };
  const t0 = e.startAngle! * DEG;
  let sweep = (e.endAngle! - e.startAngle!) * DEG;
  sweep %= 2 * Math.PI;
  if (sweep <= 0) sweep += 2 * Math.PI;
  return { start: t0, sweep };
}

/** The end of the minor semi-axis, the point at 90°. */
export function minorEnd(g: EllipseGeom): Vec2 {
  return [g.c[0] + g.b * g.v[0], g.c[1] + g.b * g.v[1]];
}

/** An ellipse's area (whole): πab. */
export function ellipseArea(e: Pick<EllipseEntity, "center" | "major" | "minor">): number {
  const g = ellipseGeom(e);
  return Math.PI * g.a * g.b;
}

/** An ellipse's length round (or along an arc), by Gauss–Legendre on the parameter. */
export function ellipseLength(e: EllipseEntity): number {
  const g = ellipseGeom(e);
  const { start, sweep } = ellipseSpan(e);
  const parts = 64;
  const nodes = [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)];
  const weights = [5 / 9, 8 / 9, 5 / 9];
  let s = 0;
  for (let k = 0; k < parts; k++) {
    const t0 = start + (sweep * k) / parts;
    const h = sweep / parts;
    nodes.forEach((x, i) => {
      const d = ellipseDeriv(g, t0 + (h * (x + 1)) / 2);
      s += (weights[i] * Math.hypot(d[0], d[1]) * h) / 2;
    });
  }
  return s;
}

// ----------------------------------------------------------------- spline

/** A spline entity's curve. Throws SplineError for fewer than two points or two in the same place. */
export function splineOf(e: SplineEntity): SplineCurve {
  const dir = (deg: number | undefined): Vec2 | null => (deg === undefined ? null : [Math.cos(deg * DEG), Math.sin(deg * DEG)]);
  return interpolate(e.points, !!e.closed, e.closed ? null : dir(e.startTangent), e.closed ? null : dir(e.endTangent));
}

/** Point ref name of a spline's i-th point. */
export const splinePointName = (i: number): string => `p${i}`;

/** The index a spline point name stands for ("p3" → 3), or -1. */
export function splinePointIndex(name: string): number {
  const m = /^p(0|[1-9]\d*)$/.exec(name);
  return m ? Number(m[1]) : -1;
}

/** The unit tangent at a spline's first (end false) or last point, the way it runs. */
export function splineEndTangent(e: SplineEntity, end: boolean): Vec2 {
  const s = splineOf(e);
  const d = end ? s.derivs[s.derivs.length - 1] : s.derivs[0];
  const l = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / l, d[1] / l];
}

export { closestOnSpline, splineTangentAt };

/**
 * An ellipse or a spline put through a similarity f (a move, a turn, a
 * scale by k; no mirror): its points through f, its minor radius times k,
 * its spline end tangents turned as f turns directions. An ellipse's
 * parameter angles are along its own axes, so they stay.
 */
export function movedCurve<E extends EllipseEntity | SplineEntity>(e: E, f: (p: Vec2) => Vec2, k = 1): E {
  if (e.type === "ellipse") return { ...e, center: f(e.center), major: f(e.major), minor: e.minor * k };
  const s = e as SplineEntity;
  const o = f([0, 0]);
  const x = f([1, 0]);
  const turn = (Math.atan2(x[1] - o[1], x[0] - o[0]) * 180) / Math.PI;
  const out: SplineEntity = { ...s, points: s.points.map(f) };
  if (s.startTangent !== undefined) out.startTangent = s.startTangent + turn;
  if (s.endTangent !== undefined) out.endTangent = s.endTangent + turn;
  return out as E;
}

// ------------------------------------------------------- named points

/** The point names an entity has: what may follow "<id>." in a point ref. */
export function pointNames(e: SketchEntity): string[] {
  switch (e.type) {
    case "line":
      return ["start", "end"];
    case "circle":
      return ["center"];
    case "arc":
      return ["start", "end", "center"];
    case "rect":
      return ["center"];
    case "slot":
      return ["center1", "center2"];
    case "point":
      return ["at"];
    case "ellipse":
      return isEllipticalArc(e) ? ["center", "major", "minorEnd", "start", "end"] : ["center", "major", "minorEnd"];
    case "spline":
      return e.points.map((_, i) => splinePointName(i));
  }
}

/** The point an entity's named point is, or undefined when it has no such point. */
export function entityPoint(e: SketchEntity, name: string): Vec2 | undefined {
  if (e.type === "ellipse") {
    const g = ellipseGeom(e);
    if (name === "center") return e.center;
    if (name === "major") return e.major;
    if (name === "minorEnd") return minorEnd(g);
    if (isEllipticalArc(e) && (name === "start" || name === "end")) return ellipsePoint(g, (name === "start" ? e.startAngle! : e.endAngle!) * DEG);
    return undefined;
  }
  if (e.type === "spline") {
    const i = splinePointIndex(name);
    return i >= 0 && i < e.points.length ? e.points[i] : undefined;
  }
  if (!pointNames(e).includes(name)) return undefined;
  return (e as unknown as Record<string, Vec2>)[name];
}

/**
 * The entity with one named point put at p, as near as the entity allows: a
 * spline's point or an ellipse's centre or major end exactly; an elliptical
 * arc's end slides along the ellipse to the parameter nearest p; any other
 * entity's point field set. A name the entity lacks leaves it as it is.
 */
export function withPointAt(e: SketchEntity, name: string, p: Vec2): SketchEntity {
  if (e.type === "spline") {
    const i = splinePointIndex(name);
    if (i < 0 || i >= e.points.length) return e;
    return { ...e, points: e.points.map((q, k) => (k === i ? p : q)) };
  }
  if (e.type === "ellipse") {
    if (name === "center" || name === "major") return { ...e, [name]: p };
    if (isEllipticalArc(e) && (name === "start" || name === "end")) return { ...e, [`${name}Angle`]: ellipseParam(ellipseGeom(e), p) / DEG };
    return e;
  }
  if (!pointNames(e).includes(name)) return e;
  return { ...e, [name]: p } as SketchEntity;
}

/** Ellipses and splines: curves that are neither straight nor round. */
export function isFreeCurve(e: SketchEntity): e is EllipseEntity | SplineEntity {
  return e.type === "ellipse" || e.type === "spline";
}

/** The ends of an open curve as point refs (a line's, an arc's, an elliptical arc's, an open spline's); none for closed ones. */
export function endRefs(e: SketchEntity): [string, string] | null {
  if (e.type === "line" || e.type === "arc") return [`${e.id}.start`, `${e.id}.end`];
  if (e.type === "ellipse") return isEllipticalArc(e) ? [`${e.id}.start`, `${e.id}.end`] : null;
  if (e.type === "spline") return e.closed ? null : [`${e.id}.p0`, `${e.id}.${splinePointName(e.points.length - 1)}`];
  return null;
}
