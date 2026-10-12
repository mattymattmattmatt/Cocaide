// Circular pattern's properties: the features it repeats, the axis it turns
// about (from the model: an edge, an axis, a round face, picked in the view;
// or written out as a point and a direction), the count, the angle the
// instances span (equally spaced) and which instances it makes.

import { countPatch, patternRows, seedsOf } from "../linearPattern/instances";
import { seedsField, skipField } from "../linearPattern/fields";
import type { FieldSpec } from "../../ui/props/spec";
import type { UiOp } from "../uiDefs";

type Raw = Record<string, unknown>;

/** An axis given as a point and a direction (the fields below edit it). */
const pointAxis = (f: Raw) => (f.axis as { direction?: unknown } | undefined)?.direction !== undefined;

export const CIRCULAR_PATTERN_FIELDS: FieldSpec[] = [
  seedsField("prop-pattern-features"),
  {
    kind: "select",
    key: "axis",
    label: "Axis",
    testId: "prop-pattern-axis-mode",
    options: [
      ["ref", "From the model (edge, axis, round face)"],
      ["point", "Through a point (written out)"],
    ],
    get: (f) => (pointAxis(f) ? "point" : "ref"),
    // From the model it starts on the Z axis (Use selected picks another); written out, through the origin along +Z.
    set: (mode, f) => (mode === "ref" ? (pointAxis(f) ? { axis: { ref: { datum: "Z" } } } : {}) : pointAxis(f) ? {} : { axis: { origin: [0, 0, 0], direction: [0, 0, 1] } }),
  },
  {
    kind: "datumRef",
    key: "axis.ref",
    label: "Turn about",
    accepts: ["axis"],
    testId: "prop-pattern-axis",
    hint: "A straight or round edge, a cylindrical face, an axis: select it, then Use selected",
    when: (f) => !pointAxis(f),
  },
  { kind: "vec3", key: "axis.origin", label: "Axis through", unit: "mm", when: pointAxis },
  { kind: "direction", key: "axis.direction", label: "Axis direction", when: pointAxis },
  { kind: "number", key: "count", label: "Count", min: 2, testId: "prop-count", hint: "The original counts as one", set: (v, f) => countPatch(f, "count", v) },
  // 360 is the default: the document leaves it out.
  { kind: "number", key: "angle", label: "Angle spanned", unit: "°", min: 0, default: 360, omitDefault: true, hint: "Instances equally spaced: 360 is a full turn; less, and the last lands on the end" },
  { kind: "bool", key: "reverse", label: "Reverse (turn the other way)", testId: "prop-pattern-reverse" },
  skipField((f) => patternRows(f)),
];

export const ui: UiOp = {
  op: "circularPattern",
  label: "Circular pattern",
  icon: "circularPattern",
  fields: CIRCULAR_PATTERN_FIELDS,
  summary: (f) => {
    if (typeof f.count !== "number") return null;
    const skipped = Array.isArray(f.skip) ? f.skip.length : 0;
    const seeds = seedsOf(f).length;
    const angle = typeof f.angle === "number" && f.angle < 360 ? ` over ${f.angle}°` : "";
    return [`${f.count - skipped}×${angle}`, ...(seeds > 1 ? [`${seeds} features`] : []), ...(skipped ? [`${skipped} skipped`] : [])].join(" ");
  },
};
