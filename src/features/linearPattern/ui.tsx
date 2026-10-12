// Linear pattern's properties: the features it repeats, a direction (written
// out, or taken from an edge, an axis or a face's normal picked in the view,
// so it follows the model), spacing and count, optionally a second direction
// for a grid, and which instances it makes.

import type { FieldSpec } from "../../ui/props/spec";
import type { UiOp } from "../uiDefs";
import { seedsField, skipField } from "./fields";
import { countPatch, patternRows, seedsOf } from "./instances";

type Raw = Record<string, unknown>;

const twoWay = (f: Raw) => f.direction2 !== undefined || f.along2 !== undefined;

/** The direction of one row: written out ("direction"), or from the model ("along", a straight edge, an axis, a flat face's normal). */
function directionFields(n: "" | "2"): FieldSpec[] {
  const written = `direction${n}`;
  const along = `along${n}`;
  const label = n ? "Direction 2" : "Direction";
  const when = (f: Raw) => (n ? twoWay(f) : true);
  return [
    { kind: "direction", key: written, label, testId: `prop-pattern-direction${n}`, when: (f) => when(f) && f[along] === undefined },
    {
      kind: "datumRef",
      key: along,
      label: n ? "Direction 2 from" : "Direction from",
      accepts: ["axis", "plane"],
      optional: true,
      testId: `prop-pattern-along${n}`,
      hint: "A straight edge or an axis (its direction), or a flat face or a plane (its normal): Use selected edge",
      when,
      // From the model, the written-out direction goes; back to None, it comes back along +X (+Y for the second).
      set: (ref) => (ref ? { [along]: ref, [written]: null } : { [along]: null, [written]: n ? [0, 1, 0] : [1, 0, 0] }),
    },
    { kind: "bool", key: `reverse${n}`, label: "Reverse", testId: `prop-pattern-reverse${n}`, when },
  ];
}

/** A second direction for a new grid: +Y, or +X when the first direction runs along Y (they must differ). */
export function secondDirection(f: Raw): [number, number, number] {
  const d = Array.isArray(f.direction) ? (f.direction as unknown[]).map(Number) : [1, 0, 0];
  const n = Math.hypot(d[0] || 0, d[1] || 0, d[2] || 0) || 1;
  return Math.abs((d[1] || 0) / n) > 0.9 ? [1, 0, 0] : [0, 1, 0];
}

/** Turning the second direction off: the skips on the first row stay, the others go. */
export function firstRowSkips(f: Raw): Raw {
  const count = typeof f.count === "number" ? f.count : Infinity;
  const kept = Array.isArray(f.skip) ? (f.skip as unknown[]).filter((n): n is number => typeof n === "number" && n <= count) : [];
  return { skip: kept.length && kept.length < count - 1 ? kept : null };
}

export const LINEAR_PATTERN_FIELDS: FieldSpec[] = [
  seedsField("prop-pattern-features"),
  ...directionFields(""),
  { kind: "number", key: "spacing", label: "Spacing", unit: "mm", min: 0, testId: "prop-spacing" },
  { kind: "number", key: "count", label: "Count", min: 2, testId: "prop-count", hint: "The original counts as one", set: (v, f) => countPatch(f, "count", v) },
  {
    kind: "bool",
    key: "direction2",
    label: "Second direction",
    testId: "prop-pattern-second",
    get: twoWay,
    // They go together: on, a row square to the first direction at the first spacing; off, all of them removed (and the skips of the other rows).
    set: (on, f) => (on ? { direction2: secondDirection(f), spacing2: f.spacing, count2: 2 } : { direction2: null, along2: null, reverse2: null, spacing2: null, count2: null, ...firstRowSkips(f) }),
  },
  ...directionFields("2"),
  { kind: "number", key: "spacing2", label: "Spacing 2", unit: "mm", min: 0, when: twoWay },
  { kind: "number", key: "count2", label: "Count 2", min: 2, when: twoWay, set: (v, f) => countPatch(f, "count2", v) },
  skipField((f) => patternRows(f)),
];

export const ui: UiOp = {
  op: "linearPattern",
  label: "Linear pattern",
  icon: "linearPattern",
  fields: LINEAR_PATTERN_FIELDS,
  summary: (f) => {
    const seeds = seedsOf(f).length;
    const total = typeof f.count === "number" ? f.count * (typeof f.count2 === "number" && twoWay(f) ? f.count2 : 1) : null;
    const skipped = Array.isArray(f.skip) ? f.skip.length : 0;
    if (total === null) return null;
    return [`${total - skipped}×`, ...(seeds > 1 ? [`${seeds} features`] : []), ...(skipped ? [`${skipped} skipped`] : [])].join(" ");
  },
};
