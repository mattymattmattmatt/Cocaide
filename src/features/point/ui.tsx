// A reference point's properties: how it is made, what from (or its
// coordinates), and where it is now.

import { Field } from "../../ui/fields";
import { datumText, refFields, switchMode } from "../../ui/props/datumModes";
import type { UiOp } from "../uiDefs";
import { POINT_MODE_SPECS, POINT_MODES, type PointMode } from "./doc";

type Raw = Record<string, unknown>;

export const POINT_MODE_LABEL: Record<PointMode, string> = {
  coords: "At coordinates",
  center: "Centre of an arc or a face",
  intersection: "Where an axis crosses a plane",
  onEdge: "Along an edge",
};

const REF_LABELS: Record<PointMode, string[]> = {
  coords: [],
  center: ["Edge or face"],
  intersection: ["Axis", "Plane"],
  onEdge: ["Edge"],
};

const modeOf = (f: Raw): PointMode => (POINT_MODES.includes(f.mode as PointMode) ? (f.mode as PointMode) : "coords");

export const ui: UiOp = {
  op: "point",
  label: "Point",
  icon: "datumPoint",
  fields: [
    {
      kind: "select",
      key: "mode",
      label: "Type",
      options: POINT_MODES.map((m): [string, string] => [m, POINT_MODE_LABEL[m]]),
      get: modeOf,
      set: (v, f, c) => switchMode(f, String(v), POINT_MODE_SPECS, c.before, { at: [0, 0, 0], t: 0.5 }),
    },
    ...refFields(POINT_MODE_SPECS, REF_LABELS, modeOf),
    { kind: "vec3", key: "at", label: "At", unit: "mm", default: [0, 0, 0], when: (f) => modeOf(f) === "coords" },
    { kind: "number", key: "t", label: "Along the edge", min: 0, default: 0.5, hint: "0 is its start, 0.5 its middle, 1 its end", when: (f) => modeOf(f) === "onEdge" },
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
    switch (modeOf(f)) {
      case "coords":
        return Array.isArray(f.at) ? (f.at as unknown[]).map(String).join(", ") : null;
      case "center":
        return "centre";
      case "intersection":
        return "axis ∩ plane";
      case "onEdge":
        return `on an edge at ${String(f.t ?? 0.5)}`;
    }
  },
};
