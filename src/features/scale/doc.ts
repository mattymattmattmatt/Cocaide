// scale: makes bodies bigger or smaller by one factor in every direction,
// about the origin or each body's own centroid (DESIGN §2.6). The registry's
// first op: the document side (validation, bodies, the agent's reference).

import type { FeatureBase } from "../../doc/types";
import type { FeatureDef } from "../defs";

export const SCALE_ABOUT = ["origin", "centroid"] as const;

export interface ScaleFeature extends FeatureBase {
  op: "scale";
  /** The bodies to scale. Default: every body. */
  bodies?: string[];
  /** Over 0: 2 doubles every length (8 times the volume), 0.5 halves them. */
  factor: number;
  /** The fixed point: the origin (default), or each body's own centroid, which stays put. */
  about?: (typeof SCALE_ABOUT)[number];
}

export const def: FeatureDef<ScaleFeature> = {
  op: "scale",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "bodies", "factor", "about"]);
    const factor = c.num(raw, "factor", "", { positive: true });
    const about = raw.about === undefined ? undefined : x.oneOf(raw, "about", "", SCALE_ABOUT);
    const bodies = raw.bodies === undefined ? undefined : x.bodyList(raw.bodies, "bodies");
    if (c.errors.length > 0 || factor === undefined) return null;
    return {
      id: raw.id as string,
      op: "scale",
      ...(bodies ? { bodies } : {}),
      factor,
      ...(about ? { about } : {}),
    };
  },
  bodies: {
    needs: (f) => (f.bodies ?? []).map((b, i) => [`bodies[${i}]`, b]),
  },
  onlyBodies: (raw, inScope) => Array.isArray(raw.bodies) && raw.bodies.length > 0 && raw.bodies.every(inScope),
  measurementKeys: ["factor"],
  reference: `## scale
{ "id": "scale_1", "op": "scale", "factor": 2, "bodies": ["base"] (optional: default every body), "about": "origin" | "centroid" (optional, default "origin") }
Makes bodies bigger or smaller by one factor in every direction (over 0: 2 doubles every length and makes the volume
8 times as large; 0.5 halves the lengths). "centroid" scales each body about its own centre of volume, which stays
where it is; "origin" scales about [0,0,0]. Holes in a scaled body scale with it; a scaled member is no longer stock.
`,
};
