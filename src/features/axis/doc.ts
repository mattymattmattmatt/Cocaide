// axis: a reference axis (DESIGN §2.2), an endless line made from other
// geometry in one of five ways; it makes no body. Revolves, circular
// patterns and other planes and points use it by { "datum": "<id>" }.

import type { DatumRef, FeatureBase } from "../../doc/types";
import { askFromRefs, checkModeRefs, datumRefsAt, modeTakes, type ModeSpec } from "../datum";
import type { FeatureDef } from "../defs";

export const AXIS_MODES = ["twoPoints", "edge", "cylinder", "twoPlanes", "pointNormal"] as const;
export type AxisMode = (typeof AXIS_MODES)[number];

export interface AxisFeature extends FeatureBase {
  op: "axis";
  mode: AxisMode;
  refs: DatumRef[];
  /** Turned end for end: its direction reversed. */
  flip?: boolean;
}

const POINT = { what: "a point (a vertex, a point feature, the origin or [x, y, z])", kinds: ["point" as const] };
const PLANE = { what: "a plane (a default plane, a plane feature or a flat face)", kinds: ["plane" as const] };

export const AXIS_MODE_SPECS: Readonly<Record<AxisMode, ModeSpec>> = {
  twoPoints: { refs: [POINT, POINT], fields: [], about: "through two points, from the first toward the second" },
  edge: {
    refs: [{ what: "an edge: straight (along it, start to end) or round (its axis)", kinds: ["axis"], forms: ["edge"], wholeEdge: true }],
    fields: [],
    about: "along a straight edge, or the axis of a circular edge",
  },
  cylinder: {
    refs: [{ what: "a cylindrical or conical face", kinds: ["axis"], forms: ["face"] }],
    fields: [],
    about: "the axis of a cylindrical or conical face (a hole, a boss)",
  },
  twoPlanes: { refs: [PLANE, PLANE], fields: [], about: "where two planes meet, along n1 x n2 (Front and Right give the Z axis)" },
  pointNormal: { refs: [POINT, PLANE], fields: [], about: "through a point, square to a plane (along its normal)" },
};

export const def: FeatureDef<AxisFeature> = {
  op: "axis",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "mode", "refs", "flip"]);
    if (raw.mode === undefined) {
      c.fail("mode", `needed: ${AXIS_MODES.map((m) => `"${m}"`).join(", ")}`);
      return null;
    }
    const mode = x.oneOf(raw, "mode", "", AXIS_MODES);
    if (!mode) return null;
    const refs = checkModeRefs(raw, c, x, "axis", mode, AXIS_MODE_SPECS);
    const flip = x.bool(raw, "flip", "");
    if (c.errors.length || !refs) return null;
    return { id: raw.id as string, op: "axis", mode, refs, ...(flip ? { flip } : {}) };
  },
  datumRefs: (raw) => datumRefsAt(raw, "refs"),
  askFrom: (f, target, k) => askFromRefs(f, target, k, "axis"),
  reference: `## axis
{ "id": "axis_1", "op": "axis", "mode": "cylinder", "refs": [{ "face": { "type": "cylindrical", "radius": 3.3, "pick": "all" } }] }
A reference axis: an endless line, no body. Use it wherever an axis is needed by reference ({ "datum": "axis_1" }): a
revolve, a circular pattern, a plane at an angle, a point where it crosses a plane. It follows what it was made from.
"flip": true reverses its direction. "mode" (needed) and what each takes:
${AXIS_MODES.map((m) => `  "${m}": ${AXIS_MODE_SPECS[m].about}; refs: ${modeTakes(AXIS_MODE_SPECS[m])}`).join("\n")}
Two parallel planes have no line in common: that axis fails and says so.
`,
};
