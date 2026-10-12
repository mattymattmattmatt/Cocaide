// Shared, pure pieces of the sweep, loft and rib editors and tools: the
// operation fields (as revolve has them), and what a sketch can be used as
// (a closed profile, a path, a point at a loft's end).

import type { SketchEntity } from "../../doc/types";
import { buildProfile } from "../../geom/profile";
import type { FieldSpec } from "../../ui/props/spec";
import { ChainError, sketchChain } from "./chain";

type Raw = Record<string, unknown>;

/** The operation as it will be: the one written, else add when there is a body before it, else new. */
export const operationOf = (f: Raw, bodies: string[]) => (typeof f.operation === "string" ? f.operation : f.newBody !== undefined ? "new" : f.body !== undefined || bodies.length > 0 ? "add" : "new");

/** The operation select and the body fields that go with it (DESIGN §2.5); `cut` names the remove choice ("Cut (swept cut)"). */
export function operationFields(cut: string): FieldSpec[] {
  return [
    {
      kind: "select",
      key: "operation",
      label: "Operation",
      testId: "prop-operation",
      options: [
        ["add", "Add material"],
        ["remove", cut],
        ["new", "New body"],
        ["intersect", "Keep the common part"],
      ],
      get: (f, c) => operationOf(f, c.bodies),
      // The body fields belong to one operation each: switching clears them.
      set: (v, _f, c) => ({ operation: v === (c.bodies.length > 0 ? "add" : "new") ? null : v, body: null, bodies: null, newBody: null }),
    },
    {
      kind: "select",
      key: "body",
      label: "Body",
      testId: "prop-body",
      options: (_f, c) => c.bodies.map((b): [string, string] => [b, b]),
      when: (f, c) => c.bodies.length > 1 && ["add", "intersect"].includes(operationOf(f, c.bodies)),
    },
    { kind: "bodies", key: "bodies", label: "Cut from", allowEmpty: true, emptyHint: "none ticked: every body it reaches", testId: "prop-bodies", when: (f, c) => c.bodies.length > 1 && operationOf(f, c.bodies) === "remove" },
  ];
}

/** What a sketch can be used as: a closed profile, a path (one chain of lines and arcs), a lone point, or nothing. */
export type SketchUse = "profile" | "path" | "point" | "none";

export function sketchUse(entities: readonly SketchEntity[]): SketchUse {
  const p = buildProfile(entities as SketchEntity[]);
  if (p.ok && p.regions.length > 0) return "profile";
  try {
    sketchChain(entities, "a path");
    return "path";
  } catch (e) {
    if (!(e instanceof ChainError)) throw e;
  }
  const live = entities.filter((e) => !(e.construction ?? !!e.ref));
  return live.length === 1 && live[0].type === "point" ? "point" : "none";
}

/** A sketch's entities, from a raw feature. */
export const entitiesOf = (sketch: Raw | undefined): SketchEntity[] => (Array.isArray(sketch?.entities) ? (sketch.entities as SketchEntity[]) : []);

/** Is the sketch one open chain (a rib's line, a path with two ends)? */
export function isOpenChain(entities: readonly SketchEntity[]): boolean {
  try {
    return !sketchChain(entities, "a path").closed;
  } catch {
    return false;
  }
}
