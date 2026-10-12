// The sketcher's draft and its dimensions (pure, so tests read them): what an
// "=expression" typed on a dimension reads while the sketch is open (the
// document's names, with this sketch's dimensions as the draft has them),
// expressions worked out again as the dimensions they read change, driven
// dimensions measured from the geometry, and loops refused.

import type { Constraint, SketchEntity } from "../../doc/types";
import { dimensionNames } from "../../doc/dimensions";
import { namesIn } from "../../doc/expr";
import { evaluate, type Parameters } from "../../doc/parameters";
import { isDriven } from "../../geom/axes";
import { measureConstraint } from "../../geom/constraints";

/**
 * A constraint in the draft. A dimension typed as "=b" is solved with its
 * value and written back as the expression (`expr`); `was` is the name the
 * document knew it by when the sketch opened, so expressions elsewhere that
 * read it follow a rename (or a shift of its default name) on Finish.
 */
export type Dimension = Constraint & { expr?: string; was?: string };

/** Each dimension with the name the document knows it by (`was`), so a rename in the sketcher reaches what reads it. */
export function withOldNames(constraints: Constraint[]): Constraint[] {
  const names = dimensionNames(constraints);
  return constraints.map((k, i) => (names[i] ? ({ ...k, was: names[i] } as Dimension) : k));
}

/** The document's names, with this sketch's dimensions by their full names at their draft values. */
export function draftParameters(doc: Parameters, sketch: string, constraints: Constraint[]): Parameters {
  const out: Parameters = { ...doc };
  const names = dimensionNames(constraints);
  constraints.forEach((k, i) => {
    if (names[i] && "value" in k && typeof k.value === "number") out[`${sketch}.${names[i]}`] = k.value;
  });
  return out;
}

/**
 * The constraints with each dimension typed as an "=expression" worked out
 * again over the draft (one may read another of the sketch: "=sketch_1.d1 / 2"),
 * a few rounds deep for chains. Driven dimensions are measured, not worked out.
 */
export function reexpress(constraints: Constraint[], doc: Parameters, sketch: string): Constraint[] {
  let out = constraints;
  for (let round = 0; round < 4; round++) {
    const params = draftParameters(doc, sketch, out);
    let changed = false;
    out = out.map((k) => {
      const d = k as Dimension;
      if (!d.expr || isDriven(k) || !("value" in k)) return k;
      const r = evaluate(d.expr, params);
      if (!r.ok || r.value === k.value) return k;
      changed = true;
      return { ...k, value: r.value } as Constraint;
    });
    if (!changed) break;
  }
  return out;
}

/** Each driven dimension's value set to what the geometry measures. The same array when none changed. */
export function measureDriven(entities: SketchEntity[], constraints: Constraint[]): Constraint[] {
  if (!constraints.some(isDriven)) return constraints;
  let changed = false;
  const out = constraints.map((k) => {
    if (!isDriven(k) || !("value" in k)) return k;
    try {
      const v = Math.round(measureConstraint(entities, k).actual * 1e9) / 1e9;
      if (!Number.isFinite(v) || v === k.value) return k;
      changed = true;
      return { ...k, value: v } as Constraint;
    } catch {
      return k;
    }
  });
  return changed ? out : constraints;
}

/**
 * The names going round when dimension `index` of the draft takes `expr`
 * ("sketch_1.d1 → sketch_1.d2 → sketch_1.d1"), or null. Only the sketch's own
 * dimensions are followed: the document refuses longer loops on Finish.
 */
export function draftCycle(constraints: Constraint[], index: number, expr: string, sketch: string): string | null {
  const names = dimensionNames(constraints);
  const self = `${sketch}.${names[index]}`;
  const exprOf = (full: string): string | undefined => {
    if (full === self) return expr;
    const i = names.findIndex((n) => n && `${sketch}.${n}` === full);
    return i >= 0 ? (constraints[i] as Dimension).expr : undefined;
  };
  const walk = (name: string, path: string[]): string | null => {
    const e = exprOf(name);
    if (!e) return null;
    for (const n of namesIn(e)) {
      if (n === self) return [...path, n].join(" → ");
      if (path.includes(n)) continue;
      const r = walk(n, [...path, n]);
      if (r) return r;
    }
    return null;
  };
  return walk(self, [self]);
}
