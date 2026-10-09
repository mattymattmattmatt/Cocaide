// Scale's properties: the factor, the fixed point (the origin or each body's
// own centroid), and which bodies (none ticked: every body).

import type { UiOp } from "../uiDefs";

export const ui: UiOp = {
  op: "scale",
  label: "Scale",
  icon: "scaleBody",
  fields: [
    { kind: "number", key: "factor", label: "Factor", min: 0, testId: "prop-factor", hint: "2 doubles every length (8 times the volume); 0.5 halves them" },
    {
      kind: "select",
      key: "about",
      label: "About",
      testId: "prop-about",
      options: [
        ["origin", "The origin"],
        ["centroid", "Each body's centroid"],
      ],
      default: "origin",
      omitDefault: true,
    },
    { kind: "bodies", key: "bodies", label: "Bodies", allowEmpty: true, emptyHint: "none ticked: every body", testId: "prop-bodies" },
  ],
  summary: (f) => `×${f.factor}`,
};
