// point: a reference point (DESIGN §2.2), fixed or made from other geometry;
// it makes no body. Planes and axes through points, and sketches, use it by
// { "datum": "<id>" }; it follows what it was made from.

import type { DatumRef, FeatureBase, Vec3 } from "../../doc/types";
import { askFromRefs, checkModeRefs, datumRefsAt, modeTakes, type ModeSpec } from "../datum";
import type { FeatureDef } from "../defs";

export const POINT_MODES = ["coords", "center", "intersection", "onEdge"] as const;
export type PointMode = (typeof POINT_MODES)[number];

export interface PointFeature extends FeatureBase {
  op: "point";
  mode: PointMode;
  refs: DatumRef[];
  /** coords: where it is. */
  at?: Vec3;
  /** onEdge: where along the edge, 0 (its start) to 1 (its end). Default 0.5, its middle. */
  t?: number;
}

export const POINT_MODE_SPECS: Readonly<Record<PointMode, ModeSpec>> = {
  coords: { refs: [], fields: ["at"], about: "at fixed coordinates `at` [x, y, z]" },
  center: {
    refs: [{ what: "a circular edge (its centre) or a face (its centre of area)", forms: ["edge", "face"], wholeEdge: true }],
    fields: [],
    about: "the centre of a circular edge, or of a face",
  },
  intersection: {
    refs: [
      { what: "an axis (a straight edge, an axis feature, X, Y or Z)", kinds: ["axis"] },
      { what: "a plane it crosses", kinds: ["plane"] },
    ],
    fields: [],
    about: "where an axis crosses a plane",
  },
  onEdge: {
    refs: [{ what: "an edge", forms: ["edge"], wholeEdge: true }],
    fields: ["t"],
    about: "on an edge, at `t` along it (0 its start, 1 its end; default 0.5, its middle)",
  },
};

export const def: FeatureDef<PointFeature> = {
  op: "point",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "mode", "refs", "at", "t"]);
    if (raw.mode === undefined) {
      c.fail("mode", `needed: ${POINT_MODES.map((m) => `"${m}"`).join(", ")}`);
      return null;
    }
    const mode = x.oneOf(raw, "mode", "", POINT_MODES);
    if (!mode) return null;
    const refs = checkModeRefs(raw, c, x, "point", mode, POINT_MODE_SPECS);
    let at: Vec3 | undefined;
    if (mode === "coords") {
      if (raw.at === undefined) c.fail("at", "needed: the point's [x, y, z] in mm");
      else at = c.vec3(raw, "at", "");
    }
    let t: number | undefined;
    if (mode === "onEdge" && raw.t !== undefined) {
      t = c.num(raw, "t", "", {});
      if (t !== undefined && (t < 0 || t > 1)) c.fail("t", `must be from 0 (the edge's start) to 1 (its end) (got ${t})`);
    }
    if (c.errors.length || !refs) return null;
    return { id: raw.id as string, op: "point", mode, refs, ...(at ? { at } : {}), ...(t !== undefined ? { t } : {}) };
  },
  datumRefs: (raw) => datumRefsAt(raw, "refs"),
  measurementKeys: ["at", "t"],
  askFrom: (f, target, k) => askFromRefs(f, target, k, "point"),
  reference: `## point
{ "id": "point_1", "op": "point", "mode": "center", "refs": [{ "edge": { "type": "edge", "kind": "circle", "radius": 3.3, "pick": "all", "near": [30,0,6] } }] }
A reference point, no body: use it wherever a point is needed by reference ({ "datum": "point_1" }): a plane through
three points or parallel to a plane through it, an axis through it. It follows what it was made from.
"mode" (needed) and what each takes:
${POINT_MODES.map((m) => `  "${m}": ${POINT_MODE_SPECS[m].about}; refs: ${modeTakes(POINT_MODE_SPECS[m])}`).join("\n")}
  { "id": "p0", "op": "point", "mode": "coords", "at": [10, 0, 25] }
An axis parallel to the plane never crosses it: that point fails and says so.
`,
};
