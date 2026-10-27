// dome: a dome of height h on a flat face, added to its body (or, reversed,
// sunk into it as a dish). On a round face it is exact: a spherical cap
// (volume π h (3a² + h²) / 6 for a face of radius a) or half an ellipsoid
// ("elliptical", (2/3) π a² h), whose side stands square to the face where it
// meets it, so it runs on smoothly from a cylinder's side. On any other face
// the face's outline is lofted up through shrinking copies along the same
// curve to a point at the top.

import type { FaceSelector, FeatureBase } from "../../doc/types";
import type { FeatureDef } from "../defs";

export const DOME_SHAPES = ["spherical", "elliptical"] as const;
export type DomeShape = (typeof DOME_SHAPES)[number];

export interface DomeFeature extends FeatureBase {
  op: "dome";
  /** The flat face it stands on. */
  face: FaceSelector;
  /** How high its top is above the face, mm. */
  height: number;
  /** "spherical" (default): a cap of a sphere; "elliptical": half an ellipsoid, meeting square-sided faces smoothly. */
  shape?: DomeShape;
  /** Into the body instead (a dish). */
  reverse?: boolean;
}

/** The volume of a dome on a round face of radius a. */
export function domeVolume(shape: DomeShape, a: number, h: number): number {
  return shape === "elliptical" ? (2 / 3) * Math.PI * a * a * h : (Math.PI * h * (3 * a * a + h * h)) / 6;
}

export const def: FeatureDef<DomeFeature> = {
  op: "dome",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "face", "height", "shape", "reverse"]);
    const face = raw.face === undefined ? (c.fail("face", "needed: the flat face the dome stands on"), null) : x.faceSelector(raw.face, "face");
    const height = c.num(raw, "height", "", { positive: true });
    const shape = raw.shape === undefined ? undefined : x.oneOf(raw, "shape", "", DOME_SHAPES);
    const reverse = x.bool(raw, "reverse", "");
    if (c.errors.length || !face || height === undefined) return null;
    return { id: raw.id as string, op: "dome", face, height, ...(shape ? { shape } : {}), ...(reverse ? { reverse } : {}) };
  },
  selectors: (f) => [{ path: "face", face: f.face }],
  measurementKeys: ["height"],
  reference: `## dome
{ "id": "dome_1", "op": "dome", "face": { "type": "planar", "normal": [0, 0, 1], "pick": "largest" }, "height": 8 }
A dome on a flat face, added to the face's body ("reverse": true sinks it in: a dish). "height": mm from the face to
its top. "shape": "spherical" (default: a cap of a sphere; on a round face of radius a its volume is
π h (3a² + h²) / 6; h = a is a hemisphere) or "elliptical" (half an ellipsoid, (2/3) π a² h, its side square to the
face where they meet, so it runs on smoothly from a cylinder's side). On a face that is not round the outline is
lofted up through shrinking copies to a point (elliptical: about (2/3) × area × h).
`,
};
