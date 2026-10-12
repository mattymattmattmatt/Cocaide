// Chamfer's properties: the edges it bevels (picked edges, every edge of
// picked faces, the edges earlier features made) and its kind: equal
// distances, two distances, or a distance and an angle, with flip to swap
// which face takes the first distance.

import { chamferType, chamferTypePatch, edgeChoiceFields, type ChamferType } from "../../ui/props/edgeTreat";
import type { UiOp } from "../uiDefs";

export const ui: UiOp = {
  op: "chamfer",
  label: "Chamfer",
  icon: "chamfer",
  fields: [
    ...edgeChoiceFields("prop-chamfer"),
    {
      kind: "select",
      key: "distance2",
      label: "Type",
      testId: "prop-chamfer-type",
      options: [
        ["equal", "Equal distance"],
        ["distances", "Distance – distance"],
        ["angle", "Angle – distance"],
      ],
      get: (f) => chamferType(f),
      set: (v, f) => chamferTypePatch(f, v as ChamferType),
    },
    { kind: "number", key: "distance", label: "Distance", unit: "mm", min: 0, testId: "prop-chamfer-distance", when: (f) => chamferType(f) !== "distances" },
    { kind: "number", key: "distance", label: "Distance 1", unit: "mm", min: 0, testId: "prop-chamfer-distance", when: (f) => chamferType(f) === "distances" },
    { kind: "number", key: "distance2", label: "Distance 2", unit: "mm", min: 0, testId: "prop-chamfer-distance2", when: (f) => chamferType(f) === "distances" },
    { kind: "number", key: "angle", label: "Angle", unit: "°", min: 0, testId: "prop-chamfer-angle", when: (f) => chamferType(f) === "angle", hint: "From the face that takes the distance" },
    {
      kind: "bool",
      key: "flip",
      label: "Flip direction",
      testId: "prop-chamfer-flip",
      when: (f) => chamferType(f) !== "equal",
      hint: "Swap which face takes the first distance",
    },
  ],
  summary: (f) => (typeof f.distance !== "number" ? null : typeof f.distance2 === "number" ? `${f.distance} × ${f.distance2}` : typeof f.angle === "number" ? `${f.distance} × ${f.angle}°` : `${f.distance}`),
};
