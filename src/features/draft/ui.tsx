// Draft's properties: the faces to taper (picked in the view), the neutral
// plane they keep their size on (a default plane, a plane feature, or a flat
// face picked), the angle, and which way the part pulls out of the mould.

import type { UiOp } from "../uiDefs";

export const ui: UiOp = {
  op: "draft",
  label: "Draft",
  icon: "draft",
  fields: [
    { kind: "faces", key: "faces", label: "Faces to draft", testId: "prop-faces" },
    { kind: "datumRef", key: "neutral", label: "Neutral plane", accepts: ["plane"], testId: "prop-neutral", hint: "The faces keep their size here and lean in away from it" },
    { kind: "number", key: "angle", label: "Angle", unit: "°", min: 0, testId: "prop-angle" },
    { kind: "bool", key: "flip", label: "Flip the pull direction (lean out)", testId: "prop-flip" },
  ],
  summary: (f) => `${f.angle}°`,
};
