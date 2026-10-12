// How defined a sketch is, as SOLIDWORKS's status bar and Display/Delete
// Relations say it: "Under defined · 3 DOF", "Fully defined", "Over defined:
// d4 conflicts with Horizontal l1, d1", a dangling reference, or an empty
// sketch. Over-definition is diagnosed the SketchXpert way: the smallest set
// of constraints that conflict, with one-click fixes (delete one, or make a
// dimension driven). Pure, so tests read it directly.

import type { Constraint, SketchEntity } from "../../doc/types";
import { dimensionNames } from "../../doc/dimensions";
import { constraintTargets, isDriven } from "../../geom/axes";
import { measureConstraint } from "../../geom/constraints";
import { conflictSet, redundantConstraints, sketchStatus } from "../../geom/solver";
import { RELATION } from "./annotate";

export type HealthState = "empty" | "under" | "full" | "over" | "dangling";

export interface Fix {
  label: string;
  action: { kind: "delete"; index: number } | { kind: "driven"; index: number };
  testId: string;
}

export interface SketchHealth {
  state: HealthState;
  /** Degrees of freedom left (null when the sketch can't be read). */
  dof: number | null;
  /** Entities and points that can still move (blue). */
  free: Set<string>;
  freePoints: Set<string>;
  /** Entities in a constraint of the conflicting set (red). */
  conflicts: Set<string>;
  /** Constraint indices: the smallest set that over-defines the sketch. */
  conflicting: number[];
  /** Constraints that name a reference entity whose model edge is gone. */
  dangling: number[];
  /** The status line: "Under defined · 3 DOF". */
  text: string;
  /** One-click repairs for an over-defined sketch. */
  fixes: Fix[];
}

/**
 * What a constraint is called in a message: a dimension by its name (d4,
 * width), a relation by its kind and what it holds ("Horizontal l1").
 */
export function constraintName(k: Constraint, index: number, constraints: Constraint[]): string {
  const name = dimensionNames(constraints)[index];
  if (name) return name;
  return `${RELATION[k.type].label} ${constraintTargets(k).join(" ") || "origin"}`.trim();
}

/** Ids of the reference entities whose model edge (or axis, point) is gone: they are drawn brown, and their relations dangle. */
export type Dangling = ReadonlySet<string>;

export function sketchHealth(entities: SketchEntity[], constraints: Constraint[], dangling: Dangling = new Set()): SketchHealth {
  const empty: SketchHealth = { state: "empty", dof: 0, free: new Set(), freePoints: new Set(), conflicts: new Set(), conflicting: [], dangling: [], text: "Empty sketch", fixes: [] };
  if (!entities.length) return empty;
  let st: ReturnType<typeof sketchStatus>;
  try {
    st = sketchStatus(entities, constraints);
  } catch {
    return { ...empty, state: "over", dof: null, text: "Over defined: the sketch can't be read" };
  }
  const base = { dof: st.dof, free: st.free, freePoints: st.freePoints, conflicts: new Set<string>(), conflicting: [] as number[], fixes: [] as Fix[] };
  const hanging = constraints.flatMap((k, i) => (constraintTargets(k).some((id) => dangling.has(id)) ? [i] : []));
  // Over defined: a constraint that doesn't hold, or one that repeats the others.
  const unmet = constraints.some((k) => {
    if (isDriven(k)) return false;
    try {
      const m = measureConstraint(entities, k);
      return !(Math.abs(m.actual - m.expected) <= 1e-6);
    } catch {
      return true;
    }
  });
  let over = unmet;
  if (!over) {
    try {
      over = redundantConstraints(entities, constraints).some(Boolean);
    } catch {
      over = true;
    }
  }
  if (over) {
    let set: number[] = [];
    try {
      set = conflictSet(entities, constraints);
    } catch {
      set = [];
    }
    const names = set.map((i) => constraintName(constraints[i], i, constraints));
    // The newest of them is the one that conflicts "with" the rest, as SOLIDWORKS words it.
    const text = set.length > 1 ? `Over defined: ${names[names.length - 1]} conflicts with ${names.slice(0, -1).reverse().join(", ")}` : set.length === 1 ? `Over defined: ${names[0]} can't be met` : "Over defined";
    const fixes: Fix[] = [...set].reverse().flatMap((i, n) => {
      const name = names[set.length - 1 - n];
      const k = constraints[i];
      return [
        ...("value" in k ? [{ label: `Make ${name} driven`, action: { kind: "driven" as const, index: i }, testId: `fix-driven-${i}` }] : []),
        { label: `Delete ${name}`, action: { kind: "delete" as const, index: i }, testId: `fix-delete-${i}` },
      ];
    });
    const conflicts = new Set(set.flatMap((i) => constraintTargets(constraints[i])));
    return { ...base, state: "over", conflicts, conflicting: set, dangling: hanging, text, fixes };
  }
  if (hanging.length) {
    const lost = [...new Set(hanging.flatMap((i) => constraintTargets(constraints[i]).filter((id) => dangling.has(id))))];
    return { ...base, state: "dangling", dangling: hanging, text: `Dangling: ${lost.join(", ")} lost ${lost.length === 1 ? "its" : "their"} model geometry` };
  }
  if (st.dof === 0) return { ...base, state: "full", dangling: [], text: "Fully defined" };
  return { ...base, state: "under", dangling: [], text: `Under defined · ${st.dof} DOF` };
}

export type RelationFilter = "all" | "dangling" | "over" | "selected";

/** The rows Display/Delete Relations shows under a filter: their constraint indices. */
export function filterRelations(constraints: Constraint[], filter: RelationFilter, health: Pick<SketchHealth, "conflicting" | "dangling">, selected: ReadonlySet<string> = new Set()): number[] {
  return constraints.flatMap((k, i) => {
    if (filter === "dangling" && !health.dangling.includes(i)) return [];
    if (filter === "over" && !health.conflicting.includes(i)) return [];
    if (filter === "selected" && !constraintTargets(k).some((id) => selected.has(id))) return [];
    return [i];
  });
}
