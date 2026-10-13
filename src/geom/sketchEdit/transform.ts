// Move, copy, rotate and scale entities, as CAD users expect them.
//
// The picked entities are moved by a translation, a rotation about a point,
// or a scale about a point (copy: copies are made and moved instead). The
// relations among the picked entities come along (a scaled sketch's lengths
// scale with it). Relations to what was not picked: "keep relations" keeps
// them, and the sketcher's solve then pulls the rest along (or back, where a
// dimension says so); without it, those that no longer hold are dropped, so
// the entities go exactly where they were sent. Copies take only their own
// relations. Rectangles and slots are exploded first when they would turn.

import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { constraintTargets, isAxisId } from "../axes";
import { dist2, sub2 } from "../vec";
import { movedCurve } from "../curves";
import { explodeAll } from "./explode";
import { freshIds, mapRefs, PREFIX, settle, type Edit, type SketchState } from "./relations";

export type Transform =
  | { kind: "move"; by: Vec2 }
  | { kind: "rotate"; center: Vec2; angle: number /* degrees, anticlockwise */ }
  | { kind: "scale"; center: Vec2; factor: number };

export interface TransformOptions {
  /** Copies moved, the originals left (Copy Entities). */
  copy?: boolean;
  /** Keep relations to entities that were not picked (Move and Rotate). */
  keepRelations?: boolean;
  /** Copies made one after another, each moved on from the last (Copy only; default 1). */
  count?: number;
}

/** The transformation as a map of points, and what it does to lengths. */
function mapping(t: Transform): { f: (p: Vec2) => Vec2; k: number } {
  if (t.kind === "move") return { f: (p) => [p[0] + t.by[0], p[1] + t.by[1]], k: 1 };
  if (t.kind === "scale") return { f: (p) => [t.center[0] + (p[0] - t.center[0]) * t.factor, t.center[1] + (p[1] - t.center[1]) * t.factor], k: t.factor };
  const a = (t.angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  return {
    f: (p) => {
      const d = sub2(p, t.center);
      return [t.center[0] + d[0] * cos - d[1] * sin, t.center[1] + d[0] * sin + d[1] * cos];
    },
    k: 1,
  };
}

/** The entity transformed (a rectangle or slot only by moves and scales: they are exploded before they turn). */
function transformed(e: SketchEntity, f: (p: Vec2) => Vec2, k: number, id: string): SketchEntity {
  switch (e.type) {
    case "line":
      return { ...e, id, start: f(e.start), end: f(e.end) };
    case "circle":
      return { ...e, id, center: f(e.center), radius: e.radius * k };
    case "arc":
      return { ...e, id, center: f(e.center), start: f(e.start), end: f(e.end) };
    case "point":
      return { ...e, id, at: f(e.at) };
    case "rect":
      return { ...e, id, center: f(e.center), w: e.w * k, h: e.h * k };
    case "slot":
      return { ...e, id, center1: f(e.center1), center2: f(e.center2), width: e.width * k };
    case "ellipse":
    case "spline":
      return { ...movedCurve(e, f, k), id };
  }
}

/**
 * A dimension among scaled entities scales with them (angles don't). One
 * typed as an expression ("=width") becomes the plain number it scales to:
 * kept, the expression would put the old size back when the sketch is saved.
 */
function scaled(k: Constraint, factor: number): Constraint {
  if (factor === 1 || !("value" in k) || k.type === "angle") return k;
  const { expr: _expr, ...rest } = k as Constraint & { expr?: string };
  return { ...rest, value: k.value * factor } as Constraint;
}

/** The picked entities moved, turned or scaled (or copies of them, with `copy`). */
export function transformEntities(stateIn: SketchState, ids: string[], t: Transform, opts: TransformOptions = {}): Edit | string {
  if (!ids.length) return "pick the entities to move first";
  if (t.kind === "scale" && !(t.factor > 0)) return "the scale factor must be more than 0";
  for (const id of ids) {
    const e = stateIn.entities.find((x) => x.id === id);
    if (!e) return `there is no entity "${id}"`;
    if (e.ref) return `${id} follows the model (a reference): it can't be moved; Convert Entities makes a copy that can`;
  }
  // A rectangle or slot entity can't turn: it becomes lines and arcs first.
  const { state, ids: picked } = t.kind === "rotate" ? explodeAll(stateIn, ids) : { state: stateIn, ids };
  const set = new Set(picked);
  const { f, k } = mapping(t);
  // A relation among the picked entities alone (the origin is not one of them; an axis only gives a direction).
  const inside = (c: Constraint) => {
    const targets = constraintTargets(c).filter((id) => !isAxisId(id));
    return targets.length > 0 && targets.every((id) => set.has(id)) && !JSON.stringify(c).includes('"origin"');
  };
  if (opts.copy) {
    const fresh = freshIds(state.entities);
    const made: SketchEntity[] = [];
    const own: Constraint[] = [];
    const n = Math.max(1, Math.round(opts.count ?? 1));
    let source = picked.map((id) => state.entities.find((e) => e.id === id)!);
    let sourceRels = state.constraints.filter((c) => inside(c) && c.type !== "fix");
    for (let i = 0; i < n; i++) {
      const ids2 = new Map<string, string>();
      const copies = source.map((e) => {
        const c = transformed(e, f, k, fresh(PREFIX[e.type]));
        ids2.set(e.id, c.id);
        return c;
      });
      const rels = sourceRels.flatMap((c) => {
        const m = mapRefs(
          scaled(c, k),
          (ref) => {
            if (ref === "origin") return null;
            const [owner, name] = ref.split(".");
            return ids2.has(owner) ? `${ids2.get(owner)}.${name}` : null;
          },
          (id) => (isAxisId(id) ? id : (ids2.get(id) ?? null)),
        );
        return m ? [m] : [];
      });
      made.push(...copies);
      own.push(...rels);
      source = copies;
      sourceRels = rels;
    }
    const entities = [...state.entities, ...made];
    // A copy's relations to the axes (level, plumb) hold only if it didn't turn: settle keeps those that do.
    return { entities, constraints: settle(entities, [...state.constraints, ...own], made.map((e) => e.id)), made: made.map((e) => e.id) };
  }
  const entities = state.entities.map((e) => (set.has(e.id) ? transformed(e, f, k, e.id) : e));
  const constraints = state.constraints.map((c) => (inside(c) ? scaled(c, k) : c));
  const kept = new Set(opts.keepRelations ? constraints.filter((c) => !inside(c) && constraintTargets(c).some((id) => set.has(id))) : []);
  // A fix on something moved held it where it was: it is the user's move now, so it goes on holding where it went.
  return { entities, constraints: settle(entities, constraints, picked, kept), made: picked };
}

/** The angle (degrees, anticlockwise) from a to b seen from the centre. */
export function angleBetween(center: Vec2, a: Vec2, b: Vec2): number {
  if (dist2(a, center) < 1e-12 || dist2(b, center) < 1e-12) return 0;
  const t = Math.atan2(b[1] - center[1], b[0] - center[0]) - Math.atan2(a[1] - center[1], a[0] - center[0]);
  const deg = (t * 180) / Math.PI;
  return deg > 180 ? deg - 360 : deg <= -180 ? deg + 360 : deg;
}
