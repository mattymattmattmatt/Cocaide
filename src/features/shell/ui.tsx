// Shell's properties: the faces removed (picked in the view; none for a
// closed hollow body), the wall thickness, inward or outward, and in a part of
// several bodies, which body.

import type { UiOp } from "../uiDefs";

type Raw = Record<string, unknown>;

const faceCount = (f: Raw) => (Array.isArray(f.faces) ? f.faces.length : 0);

export const ui: UiOp = {
  op: "shell",
  label: "Shell",
  icon: "shell",
  fields: [
    { kind: "faces", key: "faces", label: "Faces removed", optional: true, testId: "prop-faces", hint: "Open the shell there; none: a closed hollow body" },
    { kind: "number", key: "thickness", label: "Wall", unit: "mm", min: 0, testId: "prop-thickness" },
    { kind: "bool", key: "outward", label: "Walls outside the body", testId: "prop-outward", hint: "The body as it is becomes the cavity" },
    {
      kind: "select",
      key: "body",
      label: "Body",
      testId: "prop-body",
      options: (_f, c) => [["", "The body the faces are on"], ...c.bodies.map((b): [string, string] => [b, b])],
      get: (f) => f.body ?? "",
      set: (v) => ({ body: v === "" ? null : v }),
      when: (_f, c) => c.bodies.length > 1,
    },
  ],
  summary: (f) => `${f.thickness} mm${faceCount(f) ? "" : ", closed"}`,
};
