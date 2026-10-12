// Rib's properties: the sketch (its open line), the thickness and which
// side of the line or plane it goes, whether it reaches along the sketch's
// plane or straight out of it, flip, and in a part of several bodies, which.

import type { FieldSpec } from "../../ui/props/spec";
import type { UiOp } from "../uiDefs";

type Raw = Record<string, unknown>;

export const RIB_FIELDS: FieldSpec[] = [
  { kind: "sketch", key: "sketch", label: "Sketch", testId: "prop-sketch", hint: "An open line (or chain of lines and arcs) where the rib goes" },
  { kind: "number", key: "thickness", label: "Thickness", unit: "mm", min: 0, testId: "prop-thickness" },
  {
    kind: "select",
    key: "side",
    label: "Side",
    testId: "prop-rib-side",
    options: (f) =>
      f.normal
        ? [
            ["both", "Both sides of the line"],
            ["left", "Left of the line"],
            ["right", "Right of the line"],
          ]
        : [
            ["both", "Both sides of the plane"],
            ["left", "In front of the sketch plane"],
            ["right", "Behind the sketch plane"],
          ],
    default: "both",
    omitDefault: true,
  },
  {
    kind: "select",
    key: "normal",
    label: "Extends",
    testId: "prop-rib-direction",
    options: [
      ["parallel", "Along the sketch's plane"],
      ["normal", "Straight out of the sketch"],
    ],
    get: (f) => (f.normal ? "normal" : "parallel"),
    set: (v) => ({ normal: v === "normal" ? true : null }),
    hint: "Along the plane: a gusset drawn on the middle of a bracket. Out of it: a stiffener drawn on a tray's rim",
  },
  { kind: "bool", key: "flip", label: "Flip (reach the other way)", testId: "prop-flip" },
  {
    kind: "select",
    key: "body",
    label: "Body",
    testId: "prop-body",
    options: (_f, c) => c.bodies.map((b): [string, string] => [b, b]),
    when: (_f, c) => c.bodies.length > 1,
  },
];

export const ui: UiOp = {
  op: "rib",
  label: "Rib",
  icon: "rib",
  fields: RIB_FIELDS,
  summary: (f: Raw) => `${f.thickness} mm${f.normal ? ", normal" : ""}`,
  sketchOf: (f) => (typeof f.sketch === "string" ? f.sketch : null),
};
