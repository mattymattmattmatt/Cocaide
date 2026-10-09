// The sketch's own axes, X and Y: reference lines through its origin that any
// relation or dimension may use by id, as "origin" is a point (DESIGN §2.4).
// The solver and the checks see them as two more line entities whose numbers
// are constants; they never go into the document.
//
// Pure, like the rest of src/geom.

import type { Constraint, LineEntity, SketchAxis, SketchEntity } from "../doc/types";

/** "X" and "Y" (doc/types SKETCH_AXES), here so geometry needs no value from the document layer. */
export const AXIS_IDS: readonly SketchAxis[] = ["X", "Y"];

/** The axes as lines: unit long, from the origin along +x and +y. Relations read them extended, so the length is only a direction. */
export const AXIS_LINES: Readonly<Record<SketchAxis, LineEntity>> = {
  X: { id: "X", type: "line", start: [0, 0], end: [1, 0] },
  Y: { id: "Y", type: "line", start: [0, 0], end: [0, 1] },
};

export function isAxisId(id: unknown): id is SketchAxis {
  return id === "X" || id === "Y";
}

/** The entities with the sketch axes after them (left out when the sketch already has an entity of that id). */
export function withAxes(entities: SketchEntity[]): SketchEntity[] {
  const ids = new Set(entities.map((e) => e.id));
  return [...entities, ...AXIS_IDS.filter((a) => !ids.has(a)).map((a) => AXIS_LINES[a])];
}

/** Numbers the solver must not move: a reference entity's (the model's projection) and the axes'. */
export function isConstant(e: SketchEntity): boolean {
  return (e.ref !== undefined && e.ref !== null) || isAxisId(e.id);
}

/** The entity ids and sketch axes a constraint refers to ("origin" is no entity). */
export function constraintTargets(k: Constraint): string[] {
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
