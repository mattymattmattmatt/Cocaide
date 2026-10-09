// Fillet's properties: the edges it rounds (picked in the view) and its radius.

import type { UiOp } from "../uiDefs";

export const ui: UiOp = {
  op: "fillet",
  label: "Fillet",
  icon: "fillet",
  fields: [
    { kind: "edges", key: "edges", label: "Edges" },
    { kind: "number", key: "radius", label: "Radius", unit: "mm", min: 0, testId: "prop-radius" },
  ],
};
