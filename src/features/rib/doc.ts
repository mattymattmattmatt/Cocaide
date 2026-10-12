// rib: a web of material from an open sketch line out to the body's walls
// (DESIGN §2.6): a gusset in a bracket's corner, a stiffener across a tray.
// The line is thickened (on both sides, or one) and the material reaches from
// it to the faces of the body it meets: in the sketch's plane ("parallel",
// the default: a gusset drawn on the bracket's middle plane), or straight out
// of the plane ("normal": a stiffener drawn on a tray's rim, standing down to
// the floor). It always adds to a body.

import type { FeatureBase } from "../../doc/types";
import type { FeatureDef } from "../defs";

export const RIB_SIDES = ["both", "left", "right"] as const;

export interface RibFeature extends FeatureBase {
  op: "rib";
  /** A sketch whose curves are one open chain of lines and arcs. */
  sketch: string;
  /** mm. */
  thickness: number;
  /** Where the thickness goes: centred ("both", the default), or one side. */
  side?: (typeof RIB_SIDES)[number];
  /** Reach straight out of the sketch's plane (thickness then across the line, in the plane), not along the plane. */
  normal?: boolean;
  /** Reach the other way. */
  flip?: boolean;
  /** The body it adds to (default: the only one). */
  body?: string;
}

export const def: FeatureDef<RibFeature> = {
  op: "rib",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "sketch", "thickness", "side", "normal", "flip", "body"]);
    const sketch = x.sketch(raw.sketch, "sketch");
    const thickness = c.num(raw, "thickness", "", { positive: true });
    const side = raw.side === undefined ? undefined : x.oneOf(raw, "side", "", RIB_SIDES);
    const normal = x.bool(raw, "normal", "");
    const flip = x.bool(raw, "flip", "");
    const body = raw.body === undefined ? undefined : x.bodyName(raw.body, "body");
    if (c.errors.length || !sketch || thickness === undefined) return null;
    return {
      id: raw.id as string,
      op: "rib",
      sketch,
      thickness,
      ...(side && side !== "both" ? { side } : {}),
      ...(normal ? { normal } : {}),
      ...(flip ? { flip } : {}),
      ...(body !== undefined ? { body } : {}),
    };
  },
  references: (raw) => (typeof raw.sketch === "string" ? [raw.sketch] : []),
  bodies: {
    needs: (f) => (f.body !== undefined ? [["body", f.body]] : []),
    problems(f, { names }): [string, string][] {
      if (f.body !== undefined) return [];
      if (names.size === 0) return [["sketch", "there is no body before the rib to stiffen: a rib reaches out to a body's walls"]];
      if (names.size > 1) return [["body", `the part has ${names.size} bodies (${[...names].join(", ")}); name the one the rib stiffens with "body"`]];
      return [];
    },
  },
  onlyBodies: (raw, inScope) => raw.body !== undefined && inScope(raw.body),
  patternable: true,
  measurementKeys: ["thickness"],
  reference: `## rib
{ "id": "rib_1", "op": "rib", "sketch": "sketch_3", "thickness": 4, "side": "both" (optional), "normal": false (optional), "flip": false (optional), "body": "main" (optional) }
A web of material from an OPEN chain of lines and arcs in "sketch" out to the faces of the body around it: a gusset in a
bracket's inside corner, a stiffener across a box or tray. The chain's end lines are extended until they meet the body,
so the line may stop short of the walls. Default (parallel to the sketch): draw the line on a plane through the middle
of where the rib goes (e.g. a bracket's mid plane); the rib fills the sketch's plane from the line to the body's walls
(a bracket gusset: triangle area x thickness) and is "thickness" thick across the plane: "side": "both" (default,
centred on the plane), "left" (on the side the sketch plane's normal points to) or "right" (behind it). "normal": true:
draw the line on a plane across the rib's top (e.g. a tray's rim); the rib stands straight out of the sketch's plane
down to the body's faces, "thickness" wide across the line: "both" centred, "left"/"right" of the line's direction (the
chain runs from its free end with the lowest coordinates). Which way it reaches is found for you: the side where the
body closes it in (every bit of it meets the body); "flip": true takes the other side. Volume added = the filled region
x thickness. "body": the body it adds to (needed when the part has several). A pattern or mirror can repeat it.
`,
};
