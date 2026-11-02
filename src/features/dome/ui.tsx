// A dome's properties: the flat face it stands on (picked in the view), its
// height, its shape, and whether it rises out of the face or sinks in.

import type { UiOp } from "../uiDefs";
import { DOME_SHAPES } from "./doc";

const SHAPE_LABEL: Record<(typeof DOME_SHAPES)[number], string> = { spherical: "Spherical cap", elliptical: "Elliptical (meets the sides smoothly)" };

export const ui: UiOp = {
  op: "dome",
  label: "Dome",
  icon: "dome",
  fields: [
    { kind: "face", key: "face", label: "Face", testId: "prop-dome-face", hint: "The flat face it stands on", prompt: "Pick the flat face for the dome" },
    { kind: "number", key: "height", label: "Height", unit: "mm", min: 0, testId: "prop-dome-height", hint: "From the face to the dome's top" },
    { kind: "select", key: "shape", label: "Shape", options: DOME_SHAPES.map((s): [string, string] => [s, SHAPE_LABEL[s]]), default: "spherical", omitDefault: true, testId: "prop-dome-shape" },
    { kind: "bool", key: "reverse", label: "Into the body (a dish)", testId: "prop-dome-reverse" },
  ],
  summary: (f) => [typeof f.height === "number" ? `${f.height} mm` : null, f.reverse ? "dish" : null].filter(Boolean).join(" ") || null,
};
