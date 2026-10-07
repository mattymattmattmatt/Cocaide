// Sketch constraints, Phase A: checked, not solved. The geometry in the
// document is authoritative and every constraint must already hold; a
// constraint that does not hold fails the sketch with the measured value.
// The solver that drives geometry from constraints comes with Phase B.

import type { Constraint, SketchEntity, Vec2 } from "../doc/types";
import { dist2, sub2 } from "./vec";

const CONSTRAINT_TOL = 1e-6;

/** Returns one message per unsatisfied constraint. */
export function checkConstraints(entities: SketchEntity[], constraints: Constraint[]): string[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const errors: string[] = [];
  constraints.forEach((k, i) => {
    const r = evaluate(k, byId);
    if (Math.abs(r.actual - r.expected) > CONSTRAINT_TOL) {
      errors.push(`constraint ${i} (${r.label}) is not satisfied: geometry gives ${fmt(r.actual)}, constraint says ${fmt(r.expected)}`);
    }
  });
  return errors;
}

interface Evaluation {
  label: string;
  actual: number;
  expected: number;
}

function evaluate(k: Constraint, byId: Map<string, SketchEntity>): Evaluation {
  const get = (id: string) => byId.get(id)!;
  switch (k.type) {
    case "coincident": {
      const [p, q] = k.points.map((ref) => point(ref, byId));
      return { label: `coincident ${k.points[0]} ${k.points[1]}`, actual: dist2(p, q), expected: 0 };
    }
    case "horizontal":
    case "vertical": {
      const line = get(k.entity) as Extract<SketchEntity, { type: "line" }>;
      const d = sub2(line.end, line.start);
      return { label: `${k.type} ${k.entity}`, actual: Math.abs(k.type === "horizontal" ? d[1] : d[0]), expected: 0 };
    }
    case "distance":
    case "distanceX":
    case "distanceY": {
      const target = k.entity ?? `${k.points![0]} ${k.points![1]}`;
      const label = `${k.type} ${target} = ${fmt(k.value)}`;
      const [p, q] = k.entity ? entitySpan(get(k.entity)) : k.points!.map((ref) => point(ref, byId));
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
    case "equal": {
      const [a, b] = k.entities.map(get);
      const size = (e: SketchEntity) => (e.type === "line" ? dist2(e.start, e.end) : radius(e));
      return { label: `equal ${k.entities[0]} ${k.entities[1]}`, actual: size(a), expected: size(b) };
    }
  }
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
