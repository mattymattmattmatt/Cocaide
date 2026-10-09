// draft: tapers faces by an angle so the part comes out of a mould (DESIGN
// §2.6). The neutral plane is where the faces keep their size; they lean in
// as they go along the pull direction (the neutral plane's normal; for a face
// of the part, into the part from it), so the part narrows away from it.
// "flip" pulls the other way.

import type { DatumRef, FaceSelector, FeatureBase } from "../../doc/types";
import { datumRefsAt } from "../datum";
import type { FeatureDef } from "../defs";

export interface DraftFeature extends FeatureBase {
  op: "draft";
  /** The faces to taper (each selector may pick several). */
  faces: FaceSelector[];
  /** Where the faces keep their size: a plane-like reference (a default plane, a plane feature, a flat face). */
  neutral: DatumRef;
  /** Degrees, over 0 and under 90. */
  angle: number;
  /** Pull the other way: the faces lean out instead of in. */
  flip?: boolean;
}

export const def: FeatureDef<DraftFeature> = {
  op: "draft",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "faces", "neutral", "angle", "flip"]);
    const faces = x.faceSelectors(raw.faces, "faces");
    let neutral: DatumRef | null = null;
    if (raw.neutral === undefined) c.fail("neutral", 'needed: the plane the faces keep their size on, { "datum": "Top" }, a plane feature, or { "face": <flat face selector> } (the bottom face, say)');
    else neutral = x.datumRef(raw.neutral, "neutral", "plane");
    let angle: number | undefined;
    if (typeof raw.angle !== "number" || !Number.isFinite(raw.angle)) c.fail("angle", `must be a number of degrees (got ${x.describe(raw.angle)})`);
    else if (raw.angle <= 0 || raw.angle >= 90) c.fail("angle", `must be over 0° and under 90° (got ${raw.angle}); to lean the faces the other way, use "flip"`);
    else angle = raw.angle;
    const flip = x.bool(raw, "flip", "");
    if (c.errors.length || !faces || !neutral || angle === undefined) return null;
    return { id: raw.id as string, op: "draft", faces, neutral, angle, ...(flip ? { flip } : {}) };
  },
  datumRefs: (raw) => datumRefsAt(raw, "neutral"),
  selectors: (f) => f.faces.map((face, i) => ({ path: `faces[${i}]`, face, many: true })),
  onlyBodies: (raw, inScope) => Array.isArray(raw.faces) && raw.faces.length > 0 && raw.faces.every((s) => typeof s === "object" && s !== null && inScope((s as { body?: unknown }).body)),
  measurementKeys: ["angle"],
  reference: `## draft
{ "id": "draft_1", "op": "draft", "faces": [{ "type": "planar", "normal": [1, 0, 0], "pick": "all" }], "neutral": { "datum": "Top" }, "angle": 3 }
Tapers faces by "angle" degrees (over 0, under 90) so the part releases from a mould. "neutral" (a plane: { "datum":
"Top" }, a plane feature, or { "face": <flat face selector> }) is where the faces keep their size. The pull direction
is the neutral plane's normal (for a face of the part: into the part from that face), and the drafted faces lean
inward along it, so the part narrows away from the neutral plane; "flip": true pulls the other way (the faces lean
out). A box on Top with its four sides drafted narrows toward its top. "faces": the faces to taper (several selectors,
or one with "pick": "all"); faces on several bodies are drafted in each. A face parallel to the neutral plane has
nothing to taper and is refused; a face the kernel cannot draft is named in the error.
`,
};
