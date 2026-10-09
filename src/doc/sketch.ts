// Pure helpers on sketch contents, shared by the sketcher, apply() and the
// write scope.

import type { Constraint, SketchEntity } from "./types";

/** Entity ids a constraint refers to. */
export function constraintEntities(k: Constraint): string[] {
  const fromRef = (ref: string) => (ref === "origin" ? [] : [ref.split(".")[0]]);
  switch (k.type) {
    case "coincident":
      return k.points.flatMap(fromRef);
    case "horizontal":
    case "vertical":
      return k.entity ? [k.entity] : k.points!.flatMap(fromRef);
    case "radius":
    case "diameter":
      return [k.entity];
    case "distance":
    case "distanceX":
    case "distanceY":
      return k.entity ? [k.entity] : k.points ? k.points.flatMap(fromRef) : [...fromRef(k.point!), k.line!];
    case "equal":
    case "parallel":
    case "perpendicular":
    case "collinear":
    case "tangent":
    case "concentric":
    case "angle":
      return [...k.entities];
    case "midpoint":
    case "pointOn":
      return [...fromRef(k.point), k.entity];
    case "symmetric":
      return [...k.points.flatMap(fromRef), k.line];
    case "fix":
      return k.entity ? [k.entity] : fromRef(k.point!);
  }
}

/** Removes entities and every constraint that refers to one of them. */
export function removeEntities(entities: SketchEntity[], constraints: Constraint[], ids: string[]): { entities: SketchEntity[]; constraints: Constraint[] } {
  const gone = new Set(ids);
  return {
    entities: entities.filter((e) => !gone.has(e.id)),
    constraints: constraints.filter((k) => !constraintEntities(k).some((id) => gone.has(id))),
  };
}

/** Entity ids a raw constraint refers to, tolerating malformed input (for scope checks). */
export function rawConstraintEntities(k: unknown): string[] {
  try {
    return constraintEntities(k as Constraint).filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}

export const ENTITY_PREFIX: Record<SketchEntity["type"], string> = { line: "l", circle: "c", arc: "a", rect: "r", slot: "s", point: "p" };

/** The first free entity id with the type's prefix: l1, l2, ... */
export function nextEntityId(entities: { id?: unknown }[], prefix: string): string {
  const used = new Set(entities.map((e) => e.id));
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}
