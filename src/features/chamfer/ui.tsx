// Chamfer's properties: the edges it bevels (picked in the view) and its distance.

import type { UiOp } from "../uiDefs";

export const ui: UiOp = {
  op: "chamfer",
  label: "Chamfer",
  icon: "chamfer",
  fields: [
    { kind: "edges", key: "edges", label: "Edges" },
    { kind: "number", key: "distance", label: "Distance", unit: "mm", min: 0, testId: "prop-chamfer-distance" },
  ],
};
