// A reference plane's properties: how it is made (the mode), what from (the
// references that mode takes, each picked from the defaults, the plane
// features or the view), its distance, angle or place along an edge, flip,
// and where it is now.

import { Field } from "../../ui/fields";
import { datumText, refFields, refsOf, switchMode } from "../../ui/props/datumModes";
import type { DatumRef } from "../../doc/types";
import type { UiOp } from "../uiDefs";
import { PLANE_MODE_SPECS, PLANE_MODES, type PlaneMode } from "./doc";

type Raw = Record<string, unknown>;

export const PLANE_MODE_LABEL: Record<PlaneMode, string> = {
  offset: "Offset from a plane",
  angle: "At an angle about an axis",
  threePoints: "Through three points",
  midplane: "Mid-plane of two planes",
  normalToEdge: "Normal to an edge",
  parallelThroughPoint: "Parallel, through a point",
};

const REF_LABELS: Record<PlaneMode, string[]> = {
  offset: ["Plane"],
  angle: ["Plane", "Axis"],
  threePoints: ["Point 1", "Point 2", "Point 3"],
  midplane: ["Plane 1", "Plane 2"],
  normalToEdge: ["Edge", "Through point"],
  parallelThroughPoint: ["Plane", "Through point"],
};

const modeOf = (f: Raw): PlaneMode => (PLANE_MODES.includes(f.mode as PlaneMode) ? (f.mode as PlaneMode) : "offset");

/** A reference in a word or two, for the tree: "Top", "a face". */
export function refWord(r: DatumRef | undefined): string {
  if (!r) return "?";
  return "datum" in r ? r.datum : "face" in r ? "a face" : "edge" in r ? (r.at ? "a vertex" : "an edge") : "a point";
}

export const ui: UiOp = {
  op: "plane",
  label: "Plane",
  icon: "plane",
  fields: [
    {
      kind: "select",
      key: "mode",
      label: "Type",
      options: PLANE_MODES.map((m): [string, string] => [m, PLANE_MODE_LABEL[m]]),
      get: modeOf,
      set: (v, f, c) => switchMode(f, String(v), PLANE_MODE_SPECS, c.before, { distance: 10, angle: 45 }, c),
    },
    ...refFields(PLANE_MODE_SPECS, REF_LABELS, modeOf),
    { kind: "number", key: "distance", label: "Distance", unit: "mm", default: 0, hint: "Along the plane's normal; negative goes behind it", when: (f) => modeOf(f) === "offset" },
    { kind: "number", key: "angle", label: "Angle", unit: "°", hint: "Turned about the axis, right-handed", when: (f) => modeOf(f) === "angle" },
    {
      kind: "number",
      key: "t",
      label: "Along the edge",
      min: 0,
      default: 0,
      hint: "0 is its start, 0.5 its middle, 1 its end",
      when: (f) => modeOf(f) === "normalToEdge" && refsOf(f).length < 2 && !!refsOf(f)[0] && "edge" in refsOf(f)[0],
    },
    { kind: "bool", key: "flip", label: "Flip the normal" },
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
      case "offset":
        return `${String(f.distance ?? 0)} mm from ${refWord(refs[0])}`;
      case "angle":
        return `${String(f.angle ?? 0)}° about ${refWord(refs[1])}`;
      case "threePoints":
        return "through 3 points";
      case "midplane":
        return "mid-plane";
      case "normalToEdge":
        return "normal to an edge";
      case "parallelThroughPoint":
        return `parallel to ${refWord(refs[0])}`;
    }
  },
};
