// Linear pattern's properties: the feature it repeats, a direction, spacing
// and count, and optionally a second direction for a grid.

import { PATTERNABLE } from "../../ui/model/tools/pattern";
import type { UiOp } from "../uiDefs";

const twoWay = (f: Record<string, unknown>) => f.direction2 !== undefined;

export const ui: UiOp = {
  op: "linearPattern",
  label: "Linear pattern",
  icon: "linearPattern",
  fields: [
    { kind: "feature", key: "feature", label: "Feature", ops: PATTERNABLE, testId: "prop-pattern-feature" },
    { kind: "direction", key: "direction", label: "Direction", testId: "prop-pattern-direction" },
    { kind: "number", key: "spacing", label: "Spacing", unit: "mm", min: 0, testId: "prop-spacing" },
    { kind: "number", key: "count", label: "Count", min: 2, testId: "prop-count" },
    {
      kind: "bool",
      key: "direction2",
      label: "Second direction",
      testId: "prop-pattern-second",
      get: twoWay,
      // The three go together: on, a row along +Y at the first spacing; off, all three removed.
      set: (on, f) => (on ? { direction2: [0, 1, 0], spacing2: f.spacing, count2: 2 } : { direction2: null, spacing2: null, count2: null }),
    },
    { kind: "direction", key: "direction2", label: "Direction 2", when: twoWay },
    { kind: "number", key: "spacing2", label: "Spacing 2", unit: "mm", min: 0, when: twoWay },
    { kind: "number", key: "count2", label: "Count 2", min: 2, when: twoWay },
  ],
};
