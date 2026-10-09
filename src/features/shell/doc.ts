// shell: hollows a body to a wall thickness (DESIGN §2.6). The faces listed
// are removed (open, as a box with its top taken off); none removed gives a
// closed hollow body. The wall goes inward by default, or outward (the body
// as it is becomes the cavity).

import type { FaceSelector, FeatureBase } from "../../doc/types";
import type { FeatureDef } from "../defs";

export interface ShellFeature extends FeatureBase {
  op: "shell";
  /** The faces removed (open). Empty: a closed hollow body. */
  faces: FaceSelector[];
  /** The wall thickness (mm). */
  thickness: number;
  /** The wall outside the body as it is, instead of inside it. */
  outward?: boolean;
  /** The body hollowed. Default: the body the faces are on, else the part's only body. */
  body?: string;
}

export const def: FeatureDef<ShellFeature> = {
  op: "shell",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "faces", "thickness", "outward", "body"]);
    const faces = raw.faces === undefined ? [] : x.faceSelectors(raw.faces, "faces", { allowEmpty: true });
    const thickness = c.num(raw, "thickness", "", { positive: true });
    const outward = x.bool(raw, "outward", "");
    const body = raw.body === undefined ? undefined : x.bodyName(raw.body, "body");
    if (c.errors.length || !faces || thickness === undefined) return null;
    return { id: raw.id as string, op: "shell", faces, thickness, ...(outward ? { outward } : {}), ...(body !== undefined ? { body } : {}) };
  },
  bodies: {
    needs: (f) => (f.body !== undefined ? [["body", f.body]] : []),
  },
  selectors: (f) => f.faces.map((face, i) => ({ path: `faces[${i}]`, face, many: true })),
  onlyBodies: (raw, inScope) => raw.body !== undefined && inScope(raw.body),
  measurementKeys: ["thickness"],
  reference: `## shell
{ "id": "shell_1", "op": "shell", "faces": [{ "type": "planar", "normal": [0, 0, 1], "pick": "largest" }], "thickness": 2 }
Hollows a body, leaving walls "thickness" mm thick. "faces": the faces removed, so the shell is open there (a box with
its top face listed becomes a tray); each selector may pick several faces ("pick": "all"); [] or no "faces" leaves a
closed hollow body (a void inside, walls all round). "outward": true puts the walls outside the body as it is (the body
becomes the cavity) instead of inside it. "body": the body to hollow (default: the body the faces are on, else the only
body). Walls thicker than the part allows fail and say how thin they must be.
`,
};
