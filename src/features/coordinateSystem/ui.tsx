// A coordinate system's properties: where its origin is, what sets its X and
// Y directions (each a reference that follows the model), the flips, and
// where it is now.

import { Field } from "../../ui/fields";
import { datumText } from "../../ui/props/datumModes";
import type { UiOp } from "../uiDefs";

export const ui: UiOp = {
  op: "coordinateSystem",
  label: "Coordinate system",
  icon: "coordinateSystem",
  fields: [
    {
      kind: "datumRef",
      key: "origin",
      label: "Origin",
      accepts: ["point"],
      optional: true,
      testId: "prop-csys-origin",
      hint: "A vertex, a point, a circle's centre; none: the part's origin",
      prompt: "Pick the origin: a vertex, a point or a circular edge (its centre)",
    },
    {
      kind: "datumRef",
      key: "x",
      label: "X direction",
      accepts: ["axis", "plane", "point"],
      optional: true,
      testId: "prop-csys-x",
      hint: "An edge or axis (along it), a flat face or plane (its normal), or a point (toward it); none: X",
      prompt: "Pick what sets X: an edge, an axis, a face or a point",
    },
    { kind: "bool", key: "reverseX", label: "Reverse X", testId: "prop-csys-reverse-x" },
    {
      kind: "datumRef",
      key: "y",
      label: "Y direction",
      accepts: ["axis", "plane", "point"],
      optional: true,
      testId: "prop-csys-y",
      hint: "The same way, laid square to X; Z follows by the right-hand rule. None: Y",
      prompt: "Pick what sets Y: an edge, an axis, a face or a point",
    },
    { kind: "bool", key: "reverseY", label: "Reverse Y", testId: "prop-csys-reverse-y" },
    {
      kind: "custom",
      key: "where",
      label: "Where",
      render: (p) => (
        <Field label="Now" hint="Use it as a reference: its XY, YZ and ZX planes, X, Y and Z axes and its origin">
          <span className="readout" data-testid="prop-datum-where">
            {datumText(p.view?.datums?.[String(p.f.id)])}
          </span>
        </Field>
      ),
    },
  ],
  summary: (f) => (f.origin ? "at a point" : "at the origin"),
};
