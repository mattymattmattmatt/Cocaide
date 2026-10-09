// A reference axis's properties: how it is made, what from, reversed or not,
// and where it is now.

import { Field } from "../../ui/fields";
import { datumText, refFields, refsOf, switchMode } from "../../ui/props/datumModes";
import { refWord } from "../plane/ui";
import type { UiOp } from "../uiDefs";
import { AXIS_MODE_SPECS, AXIS_MODES, type AxisMode } from "./doc";

type Raw = Record<string, unknown>;

export const AXIS_MODE_LABEL: Record<AxisMode, string> = {
  twoPoints: "Through two points",
  edge: "Along an edge",
  cylinder: "Axis of a cylinder",
  twoPlanes: "Where two planes meet",
  pointNormal: "Through a point, square to a plane",
};

const REF_LABELS: Record<AxisMode, string[]> = {
  twoPoints: ["Point 1", "Point 2"],
  edge: ["Edge"],
  cylinder: ["Round face"],
  twoPlanes: ["Plane 1", "Plane 2"],
  pointNormal: ["Point", "Plane"],
};

const modeOf = (f: Raw): AxisMode => (AXIS_MODES.includes(f.mode as AxisMode) ? (f.mode as AxisMode) : "twoPlanes");

export const ui: UiOp = {
  op: "axis",
  label: "Axis",
  icon: "axis",
  fields: [
    {
      kind: "select",
      key: "mode",
      label: "Type",
      options: AXIS_MODES.map((m): [string, string] => [m, AXIS_MODE_LABEL[m]]),
      get: modeOf,
      set: (v, f, c) => switchMode(f, String(v), AXIS_MODE_SPECS, c.before),
    },
    ...refFields(AXIS_MODE_SPECS, REF_LABELS, modeOf),
    { kind: "bool", key: "flip", label: "Reverse the direction" },
    {
      kind: "custom",
      key: "where",
      label: "Where",
      render: (p) => (
        <Field label="Now">
          <span className="readout" data-testid="prop-datum-where">
            {datumText(p.view?.datums?.[String(p.f.id)])}
          </span>
        </Field>
      ),
    },
  ],
  summary(f) {
    const refs = refsOf(f);
    switch (modeOf(f)) {
      case "twoPoints":
        return "through 2 points";
      case "edge":
        return "along an edge";
      case "cylinder":
        return "of a cylinder";
      case "twoPlanes":
        return `${refWord(refs[0])} ∩ ${refWord(refs[1])}`;
      case "pointNormal":
        return `square to ${refWord(refs[1])}`;
    }
  },
};
