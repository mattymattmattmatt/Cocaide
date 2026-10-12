// Keeping relations sane through a sketch edit. An edit changes some
// entities' numbers (a trimmed line's end, a moved circle) and may rename
// points (a split line's end now belongs to its second piece). Afterwards:
// a relation that named a point that is gone is dropped; a relation on a
// changed entity that no longer holds is dropped (a trimmed line's length,
// a corner that was rounded off); the pieces that stay keep theirs; and a
// relation said twice is said once. Pure.

import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { constraintTargets, isAxisId } from "../axes";
import { measureConstraint, point as pointOf } from "../constraints";

export interface SketchState {
  entities: SketchEntity[];
  constraints: Constraint[];
}

/** What an edit tool makes of the sketch. */
export interface Edit extends SketchState {
  /**
   * Relations the edit would like where they add something (where a trimmed
   * end landed, ends a mirror line joins): the sketcher keeps each one only
   * if it does not over-define the sketch.
   */
  soft?: Constraint[];
  /** The entities the edit made or changed, for the selection afterwards. */
  made?: string[];
  /** What happened, when it is worth saying ("l3 crossed nothing: deleted"). */
  note?: string;
}

/** Lengths within this (mm), and angles within this (degrees), hold. */
const HOLD_TOL = 1e-6;

/** The point names an entity has. */
export function pointNames(e: SketchEntity): string[] {
  switch (e.type) {
    case "line":
      return ["start", "end"];
    case "arc":
      return ["center", "start", "end"];
    case "circle":
    case "rect":
      return ["center"];
    case "slot":
      return ["center1", "center2"];
    case "point":
      return ["at"];
  }
}

/** A point of an entity. */
export function pointAtRef(entities: SketchEntity[], ref: string): Vec2 | null {
  try {
    const p = pointOf(ref, new Map(entities.map((e) => [e.id, e])));
    return Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

const isPointRef = (x: string) => x === "origin" || x.includes(".");

/**
 * The constraint with its point refs and entity ids mapped. A mapper that
 * returns null for something the constraint needs drops the constraint; an
 * offset relation loses only the pairs that name it.
 */
export function mapRefs(k: Constraint, point: (ref: string) => string | null, entity: (id: string) => string | null = (id) => id): Constraint | null {
  const p = (ref: string) => (ref === "origin" ? ref : point(ref));
  const e = (id: string) => (isAxisId(id) ? id : entity(id));
  if (k.type === "offset") {
    const pairs = k.entities.flatMap((b, i) => {
      const base = isPointRef(b) ? p(b) : e(b);
      const off = e(k.offsets[i]);
      return base && off ? [[base, off] as const] : [];
    });
    return pairs.length ? { ...k, entities: pairs.map(([b]) => b), offsets: pairs.map(([, o]) => o) } : null;
  }
  const out = { ...k } as Record<string, unknown>;
  const all = <T extends string>(xs: T[] | undefined, f: (x: string) => string | null): string[] | null | undefined => {
    if (!xs) return undefined;
    const ys = xs.map(f);
    return ys.every((y): y is string => y !== null) ? ys : null;
  };
  if ("points" in k && k.points) {
    const ys = all(k.points, p);
    if (!ys) return null;
    out.points = ys;
  }
  if ("point" in k && k.point !== undefined) {
    const y = p(k.point);
    if (!y) return null;
    out.point = y;
  }
  if ("entity" in k && k.entity !== undefined) {
    const y = e(k.entity);
    if (!y) return null;
    out.entity = y;
  }
  if ("line" in k && k.line !== undefined) {
    const y = e(k.line);
    if (!y) return null;
    out.line = y;
  }
  if ("entities" in k && k.entities) {
    const ys = all(k.entities, e);
    if (!ys) return null;
    out.entities = ys;
  }
  return out as unknown as Constraint;
}

/** Does the relation hold on this geometry (and name only things that are there)? */
export function holds(entities: SketchEntity[], k: Constraint): boolean {
  try {
    const m = measureConstraint(entities, k);
    return Math.abs(m.actual - m.expected) <= HOLD_TOL;
  } catch {
    return false;
  }
}

/** Does every entity and point the relation names exist? */
export function namesExist(entities: SketchEntity[], k: Constraint): boolean {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const refs: string[] = [];
  if ("points" in k && k.points) refs.push(...k.points);
  if ("point" in k && k.point) refs.push(k.point);
  if (k.type === "offset") refs.push(...k.entities.filter(isPointRef));
  for (const r of refs) {
    if (r === "origin") continue;
    const [id, name] = r.split(".");
    const e = byId.get(id);
    if (!e || !pointNames(e).includes(name)) return false;
  }
  return constraintTargets(k).every((id) => isAxisId(id) || byId.has(id));
}

/** A relation's identity, ignoring the order of what it pairs: two relations with one key say the same thing. */
export function relationKey(k: Constraint): string {
  const sorted = (xs: readonly string[]) => [...xs].sort().join("|");
  switch (k.type) {
    case "coincident":
      return `coincident:${sorted(k.points)}`;
    case "horizontal":
    case "vertical":
      return k.points ? `${k.type}:${sorted(k.points)}` : `${k.type}:${k.entity}`;
    case "equal":
    case "parallel":
    case "perpendicular":
    case "collinear":
    case "tangent":
    case "concentric":
      return `${k.type}:${sorted(k.entities)}`;
    case "symmetric":
      return `symmetric:${sorted(k.entities ?? k.points!)}@${k.line}`;
    default:
      return JSON.stringify(k);
  }
}

/** True for a relation that pairs a thing with itself (a corner coincident with itself after a rename). */
function degenerate(k: Constraint): boolean {
  if (k.type === "coincident") return k.points[0] === k.points[1];
  if ((k.type === "horizontal" || k.type === "vertical") && k.points) return k.points[0] === k.points[1];
  if ((k.type === "distance" || k.type === "distanceX" || k.type === "distanceY") && k.points) return k.points[0] === k.points[1];
  if ("entities" in k && k.entities && k.type !== "offset") return k.entities[0] === k.entities[1];
  if ((k.type === "pointOn" || k.type === "midpoint") && k.point.split(".")[0] === k.entity) return true;
  return false;
}

/**
 * The relations after an edit: those naming something that is gone go, as do
 * those touching a `changed` entity that no longer hold (unless in `keep`),
 * those that pair a thing with itself, and repeats.
 */
export function settle(entities: SketchEntity[], constraints: Constraint[], changed: Iterable<string>, keep: ReadonlySet<Constraint> = new Set()): Constraint[] {
  const touched = new Set(changed);
  const seen = new Set<string>();
  const out: Constraint[] = [];
  for (const k of constraints) {
    if (!namesExist(entities, k) || degenerate(k)) continue;
    if (!keep.has(k) && constraintTargets(k).some((id) => touched.has(id)) && !holds(entities, k)) continue;
    const key = relationKey(k);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/** Fresh ids beside the sketch's: l1, l2, … the first free of each prefix, never one handed out twice. */
export function freshIds(entities: { id: string }[]): (prefix: string) => string {
  const used = new Set(entities.map((e) => e.id));
  return (prefix) => {
    for (let n = 1; ; n++) {
      const id = `${prefix}${n}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
}

/** The id prefix for each entity type. */
export const PREFIX: Record<SketchEntity["type"], string> = { line: "l", circle: "c", arc: "a", rect: "r", slot: "s", point: "p" };

/** The entities with one replaced (by id), or several. */
export function replaced(entities: SketchEntity[], ...next: SketchEntity[]): SketchEntity[] {
  const byId = new Map(next.map((e) => [e.id, e]));
  return entities.map((e) => byId.get(e.id) ?? e);
}

/** Point refs at p (within tol): the ends, centres and points of the entities, as a trimmed end would join them. */
export function refsAt(entities: SketchEntity[], p: Vec2, tol: number, skip: (id: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const e of entities) {
    if (skip(e.id)) continue;
    for (const name of pointNames(e)) {
      if (name === "center" && e.type !== "point") continue;
      const q = pointAtRef(entities, `${e.id}.${name}`);
      if (q && Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol) out.push(`${e.id}.${name}`);
    }
  }
  return out;
}

/** Entity ids a set of constraints names (the axes left out). */
export function namedEntities(constraints: Constraint[]): Set<string> {
  return new Set(constraints.flatMap(constraintTargets).filter((id) => !isAxisId(id)));
}
