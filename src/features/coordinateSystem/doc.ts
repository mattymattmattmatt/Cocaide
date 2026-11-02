// coordinateSystem: a reference coordinate system (no body): an origin and
// three right-handed axes, made from other reference geometry so it follows
// the model. X comes from `x` (an edge's or axis's direction, a face's or
// plane's normal, or toward a point from the origin), Y from `y` laid square
// to X, Z = X × Y. As a reference it is one of its parts: { "datum": "cs1",
// "part": "XY" } its XY plane, "X" an axis, "origin" its origin (CsysPart);
// with no part, its XY plane, Z axis or origin, whichever is needed. Table
// patterns place copies in it, Mass properties reports relative to it, and
// Move moves bodies from one to another.

import type { DatumRef, FeatureBase } from "../../doc/types";
import { datumRefsAt } from "../datum";
import type { FeatureDef } from "../defs";

export interface CoordinateSystemFeature extends FeatureBase {
  op: "coordinateSystem";
  /** Where its origin is: a point-like reference. Default the Origin. */
  origin?: DatumRef;
  /** Its X direction: an axis or straight edge (its direction), a plane or flat face (its normal), or a point (from the origin toward it). Default X. */
  x?: DatumRef;
  /** Its Y direction the same way, laid square to X. Default Y (Z then X, when X runs along Y). */
  y?: DatumRef;
  /** Turn X (or Y) the other way; Z follows by the right-hand rule. */
  reverseX?: boolean;
  reverseY?: boolean;
}

export const def: FeatureDef<CoordinateSystemFeature> = {
  op: "coordinateSystem",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "origin", "x", "y", "reverseX", "reverseY"]);
    const origin = raw.origin === undefined ? undefined : x.datumRef(raw.origin, "origin", "point");
    const xr = raw.x === undefined ? undefined : x.datumRef(raw.x, "x", ["axis", "plane", "point"]);
    const yr = raw.y === undefined ? undefined : x.datumRef(raw.y, "y", ["axis", "plane", "point"]);
    const reverseX = x.bool(raw, "reverseX", "");
    const reverseY = x.bool(raw, "reverseY", "");
    if (c.errors.length || origin === null || xr === null || yr === null) return null;
    return {
      id: raw.id as string,
      op: "coordinateSystem",
      ...(origin ? { origin } : {}),
      ...(xr ? { x: xr } : {}),
      ...(yr ? { y: yr } : {}),
      ...(reverseX ? { reverseX } : {}),
      ...(reverseY ? { reverseY } : {}),
    };
  },
  datumRefs: (raw) => datumRefsAt(raw, "origin", "x", "y"),
  reference: `## coordinateSystem
{ "id": "cs1", "op": "coordinateSystem", "origin": { "edge": <selector>, "at": "start" }, "x": { "edge": <selector> }, "y": { "datum": "Z" } }
A reference coordinate system, no body: an origin and three right-handed axes that follow what they are made from.
"origin": a point-like reference (default { "datum": "Origin" }): a vertex ({ "edge", "at" }), a point feature,
{ "point": [x, y, z] }, a circular edge's centre. "x": its X direction: an axis or a straight edge (its direction),
a plane or flat face (its normal), or a point (from the origin toward it); default { "datum": "X" }. "y": its Y the
same way, made square to X (default { "datum": "Y" }). Z = X × Y. "reverseX" / "reverseY": true turns that axis round.
Use it as a reference with a part: { "datum": "cs1", "part": "XY" } (also "YZ", "ZX": planes, normals Z, X, Y),
"X" / "Y" / "Z" (axes through its origin), "origin" (a point). Without "part" it is its XY plane where a plane is
needed, its Z axis where an axis is, its origin where a point is. A sketch on { "type": "ref", "ref": { "datum": "cs1" } }
is drawn in its XY plane (sketch x along its X). tablePattern places copies at [x, y] in it; Mass properties can
report relative to it; move { "fromSystem": "cs1", "toSystem": "cs2" } moves bodies from one to the other.
`,
};
