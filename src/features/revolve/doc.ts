// revolve: a sketch's profile turned about an axis (DESIGN §2.6). The axis is
// a line of the sketch itself ({ "line": "<entity id>" }, usually a
// centreline) or any reference axis (a default axis, an axis feature, a
// straight model edge, a cylinder's axis). One direction, two directions, or
// split evenly about the sketch plane (midplane). A thin revolve thickens an
// open chain (or the profile's loops) into a wall first. The operation fields
// make it a new body, add to one, cut (a revolved cut) or intersect.

import type { DatumRef, FeatureBase } from "../../doc/types";
import { datumRefsAt } from "../datum";
import type { FeatureDef } from "../defs";
import { OPERATION_KEYS, operationBodies, operationBodyFromId, operationOnlyBodies, validateOperation, type OperationFields } from "../operation";

export const THIN_SIDES = ["outside", "inside", "mid"] as const;

/** The revolve's axis: a line of its sketch (construction or not), or a reference axis. */
export type RevolveAxis = { line: string } | DatumRef;

export interface RevolveFeature extends FeatureBase, OperationFields {
  op: "revolve";
  /** The sketch whose profile turns. */
  sketch: string;
  axis: RevolveAxis;
  /** Degrees, over 0 up to 360 (default 360: all the way round). With midplane, the total, half each way. */
  angle?: number;
  /** Degrees the other way from the sketch plane (a second direction); angle + angle2 at most 360. */
  angle2?: number;
  /** Split the angle evenly about the sketch plane. */
  midplane?: boolean;
  /** Turn the other way about the axis. */
  reverse?: boolean;
  /** A thin feature: the profile thickened into a wall first (an open chain may be used). */
  thin?: { thickness: number; side?: (typeof THIN_SIDES)[number] };
}

/** Is this revolve axis a line of the sketch? */
export function isLineAxis(a: unknown): a is { line: string } {
  return typeof a === "object" && a !== null && !Array.isArray(a) && "line" in a;
}

export const def: FeatureDef<RevolveFeature> = {
  op: "revolve",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "sketch", "axis", "angle", "angle2", "midplane", "reverse", "thin", ...OPERATION_KEYS]);
    const sketch = x.sketch(raw.sketch, "sketch");
    let axis: RevolveAxis | null = null;
    if (raw.axis === undefined) c.fail("axis", 'needed: a line of the sketch ({ "line": "<entity id>" }, a centreline say) or a reference axis ({ "datum": "Y" }, an axis feature, a straight edge)');
    else if (isLineAxis(raw.axis)) {
      c.keys(raw.axis as Record<string, unknown>, "axis", ["line"]);
      const line = (raw.axis as { line: unknown }).line;
      if (typeof line !== "string" || line === "") c.fail("axis.line", `must be the id of a line in the sketch (got ${x.describe(line)})`);
      else axis = { line };
    } else axis = x.datumRef(raw.axis, "axis", "axis");
    const angle = raw.angle === undefined ? undefined : degrees(raw, "angle", c, x);
    const angle2 = raw.angle2 === undefined ? undefined : c.num(raw, "angle2", "", { nonNegative: true });
    const midplane = x.bool(raw, "midplane", "");
    const reverse = x.bool(raw, "reverse", "");
    if (midplane && raw.angle2 !== undefined) c.fail("angle2", 'turns the other way from the sketch plane; with "midplane" (the angle split evenly both ways) leave it out');
    if (angle2 !== undefined && (angle ?? 360) + angle2 > 360 + 1e-9) c.fail("angle2", `angle + angle2 is ${(angle ?? 360) + angle2}°: together they can turn at most 360°`);
    let thin: RevolveFeature["thin"];
    if (raw.thin !== undefined) {
      if (!x.isObject(raw.thin)) c.fail("thin", `must be { "thickness": <mm>, "side": "outside" | "inside" | "mid" } (got ${x.describe(raw.thin)})`);
      else {
        c.keys(raw.thin, "thin", ["thickness", "side"]);
        const thickness = c.num(raw.thin, "thickness", "thin", { positive: true });
        const side = raw.thin.side === undefined ? undefined : x.oneOf(raw.thin, "side", "thin", THIN_SIDES);
        if (thickness !== undefined) thin = { thickness, ...(side ? { side } : {}) };
      }
    }
    const operation = validateOperation(raw, c, x);
    if (c.errors.length || !sketch || !axis || !operation) return null;
    return {
      id: raw.id as string,
      op: "revolve",
      sketch,
      axis,
      ...(angle !== undefined ? { angle } : {}),
      ...(angle2 !== undefined ? { angle2 } : {}),
      ...(midplane ? { midplane } : {}),
      ...(reverse ? { reverse } : {}),
      ...(thin ? { thin } : {}),
      ...operation,
    };
  },
  references: (raw) => (typeof raw.sketch === "string" ? [raw.sketch] : []),
  // A sketch line axis is no reference geometry; a reference axis is.
  datumRefs: (raw) => (isLineAxis(raw.axis) ? [] : datumRefsAt(raw, "axis")),
  bodies: operationBodies<RevolveFeature>(),
  onlyBodies: (raw, inScope) => operationOnlyBodies(raw, inScope),
  bodyFromId: operationBodyFromId,
  patternable: true,
  measurementKeys: ["angle", "angle2"],
  reference: `## revolve
{ "id": "revolve_1", "op": "revolve", "sketch": "sketch_1", "axis": { "line": "l5" }, "angle": 360 (optional) }
Turns a sketch's closed profile about an axis (Pappus: volume = angle in radians x profile area x the distance of the
profile's centroid from the axis). "axis" (needed): { "line": "<entity id>" } a line of that sketch, construction or not
(usually a centreline), or a reference axis: { "datum": "X" | "Y" | "Z" | "<axis feature>" }, { "edge": <straight
edge selector> }, { "face": <cylindrical face selector> } (its axis). A reference axis must lie in the sketch's plane.
The whole profile must be on one side of the axis (it may touch it: a half disc makes a ball).
"angle": degrees, over 0 up to 360 (default 360, all the way round), turning right-handed about the axis direction
(for a sketch line: from its start toward its end); "reverse": true turns the other way. "angle2": degrees the other
way from the sketch plane (two directions; angle + angle2 at most 360). "midplane": true splits "angle" evenly both ways.
"thin": { "thickness": mm, "side": "outside" (default) | "inside" | "mid" } thickens the profile into a wall first:
an open chain of lines and arcs (outside = away from the axis), or each closed loop (outside = away from what it encloses).
Operation fields: "operation": "new" | "add" | "remove" (a revolved cut) | "intersect" (default: add to the part's body
if there is one, else a new body); "body" (add/intersect: which), "bodies" (remove: only these), "newBody" (new: its
name). A pattern or mirror can repeat it ("feature": "revolve_1").
`,
};

/** An angle in degrees, over 0 up to 360. */
function degrees(raw: Record<string, unknown>, key: string, c: Parameters<FeatureDef["validate"]>[1], x: Parameters<FeatureDef["validate"]>[2]): number | undefined {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    c.fail(key, `must be a number of degrees (got ${x.describe(v)})`);
    return undefined;
  }
  if (v <= 0) {
    c.fail(key, `must be over 0° (got ${v}): a revolve needs an angle to turn through`);
    return undefined;
  }
  if (v > 360) {
    c.fail(key, `must be at most 360° (got ${v}): all the way round is 360`);
    return undefined;
  }
  return v;
}
