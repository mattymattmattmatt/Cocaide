// Pure helpers on sketch contents, shared by the sketcher, apply() and the
// write scope.

import { constraintTargets } from "../geom/axes";
import { isExpression } from "./parameters";
import { SKETCH_AXES, type Constraint, type SketchAxis, type SketchEntity } from "./types";

/** "X" or "Y": the sketch's own axis, a line any relation may use (not an entity of the sketch). */
export function isSketchAxis(id: unknown): id is SketchAxis {
  return (SKETCH_AXES as readonly unknown[]).includes(id);
}

/** Reference geometry: the entity is a model edge, axis or point projected into the sketch (DESIGN §2.4). */
export function isReference(e: { ref?: unknown }): boolean {
  return e.ref !== undefined && e.ref !== null;
}

/** Construction geometry: marked so, or a reference not marked otherwise (a converted entity says construction: false). */
export function isConstruction(e: { construction?: boolean; ref?: unknown }): boolean {
  return e.construction ?? isReference(e);
}

/** Entity ids a constraint refers to (the sketch axes X and Y are not entities, so they are left out). */
export function constraintEntities(k: Constraint): string[] {
  return constraintTargets(k).filter((id) => !isSketchAxis(id));
}

/** The entity ids and sketch axes a constraint refers to. */
export { constraintTargets };

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

/**
 * The entity fields written as expressions ("=b / 2"), as solver field refs:
 * "c1.radius", or "l1.start.0" for one coordinate. The solver holds them where
 * the expression puts them.
 */
export function expressionFields(rawEntities: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(rawEntities)) return out;
  for (const e of rawEntities) {
    if (typeof e !== "object" || e === null) continue;
    const id = String((e as { id?: unknown }).id);
    for (const [field, v] of Object.entries(e)) {
      if (isExpression(v)) out.push(`${id}.${field}`);
      else if (Array.isArray(v)) v.forEach((c, k) => isExpression(c) && out.push(`${id}.${field}.${k}`));
    }
  }
  return out;
}
