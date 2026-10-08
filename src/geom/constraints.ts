// Sketch constraints are checked here, not solved. The geometry in the
// document is authoritative and every constraint must already hold; a
// constraint that does not hold fails the sketch with the measured value.
// The solver (solver.ts) is what drives geometry from constraints.

import type { AngleConstraint, Constraint, SketchEntity, Vec2 } from "../doc/types";
import { dist2, sub2 } from "./vec";

const CONSTRAINT_TOL = 1e-6;

/** Returns one message per unsatisfied constraint. */
export function checkConstraints(entities: SketchEntity[], constraints: Constraint[]): string[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const errors: string[] = [];
  constraints.forEach((k, i) => {
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
      if (k.line !== undefined) {
        return { label: `distance ${k.point} to ${k.line} = ${fmt(k.value)}`, actual: Math.abs(offset(get(k.line), pt(k.point!))), expected: k.value };
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
      return { label, actual, expected: k.value };
    }
    case "radius":
      return { label: `radius ${k.entity} = ${fmt(k.value)}`, actual: radius(get(k.entity)), expected: k.value };
    case "diameter":
      return { label: `diameter ${k.entity} = ${fmt(k.value)}`, actual: 2 * radius(get(k.entity)), expected: k.value };
    case "equal": {
      const [a, b] = k.entities.map(get);
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
      const value = (k as AngleConstraint).value;
      return { label: `angle ${pair} = ${fmt(value)}°`, actual: between, expected: value, tol: ANGLE_TOL };
    }
    case "collinear": {
      const [a, b] = k.entities.map(get);
      const [p, q] = entitySpan(b);
      return { label: `collinear ${k.entities[0]} ${k.entities[1]}`, actual: Math.max(Math.abs(offset(a, p)), Math.abs(offset(a, q))), expected: 0 };
    }
    case "tangent": {
      const [a, b] = k.entities.map(get);
      const label = `tangent ${k.entities[0]} ${k.entities[1]}`;
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
      return { label, actual: dist2(p, centre(e)), expected: radius(e) };
    }
    case "symmetric": {
      const [p, q] = k.points.map(pt);
      const line = get(k.line);
      const u = unit(line);
      const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const along = Math.abs((q[0] - p[0]) * u[0] + (q[1] - p[1]) * u[1]);
      return { label: `symmetric ${k.points[0]} ${k.points[1]} about ${k.line}`, actual: Math.max(Math.abs(offset(line, mid)), along), expected: 0 };
    }
    case "fix":
      return { label: `fix ${k.entity ?? k.point}`, actual: 0, expected: 0 };
  }
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
    default:
      return [[0, 0], [0, 0]]; // rect is handled by the caller; validation rejects the rest
  }
}

function radius(e: SketchEntity): number {
  if (e.type === "circle") return e.radius;
  if (e.type === "arc") return dist2(e.start, e.center);
  return NaN;
}

export function point(ref: string, byId: Map<string, SketchEntity>): Vec2 {
  if (ref === "origin") return [0, 0];
  const [id, name] = ref.split(".");
  const e = byId.get(id) as unknown as Record<string, Vec2>;
  return e[name];
}

function fmt(x: number): string {
  return String(Math.round(x * 1e6) / 1e6);
}

/** What a constraint measures on the current geometry, and what it asks for. */
export function measureConstraint(entities: SketchEntity[], k: Constraint): { label: string; actual: number; expected: number } {
  return evaluate(k, new Map(entities.map((e) => [e.id, e])));
}
