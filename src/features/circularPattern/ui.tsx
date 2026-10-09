// Circular pattern's properties: the feature it repeats, the axis it turns
// about (a point and a direction), the count and the angle they span.

import { PATTERNABLE } from "../../ui/model/tools/pattern";
import type { UiOp } from "../uiDefs";

/** An axis given as a point and a direction (the fields below edit it). */
const pointAxis = (f: Record<string, unknown>) => (f.axis as { direction?: unknown } | undefined)?.direction !== undefined;

export const ui: UiOp = {
  op: "circularPattern",
  label: "Circular pattern",
  icon: "circularPattern",
  fields: [
    { kind: "feature", key: "feature", label: "Feature", ops: PATTERNABLE, testId: "prop-pattern-feature" },
    { kind: "vec3", key: "axis.origin", label: "Axis through", unit: "mm", when: pointAxis },
    { kind: "direction", key: "axis.direction", label: "Axis direction", when: pointAxis },
    { kind: "number", key: "count", label: "Count", min: 2, testId: "prop-count" },
    // 360 is the default: the document leaves it out.
    { kind: "number", key: "angle", label: "Total angle", unit: "°", min: 0, default: 360, omitDefault: true },
  ],
};
