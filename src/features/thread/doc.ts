// thread: an ISO metric thread on a cylindrical face: external on a shaft,
// internal in a hole (the face says which). Cosmetic by default (modelled:
// false): nothing is cut; the 3D view draws the usual band and a drawing
// calls it out ("M10×1.5 - 6g ⌴20") as it does a tapped hole. Modelled
// (modelled: true): the thread's groove is swept along the exact helix and cut
// from the body, trimmed to the length, with a 45° run-out chamfer at the
// start if asked. The size comes from the face (a shaft of the size's major
// diameter, a hole of its tap drill) unless given; the pitch is the size's
// coarse one unless given.

import type { FaceSelector, FeatureBase } from "../../doc/types";
import type { FeatureDef } from "../defs";
import { HOLE_SIZES } from "../hole/standards";

export interface ThreadFeature extends FeatureBase {
  op: "thread";
  /** The cylindrical face: a shaft (external thread) or a hole's wall (internal). */
  face: FaceSelector;
  /** "M10": ISO metric, M3 to M24. Default: the size the face fits. */
  size?: string;
  /** mm per turn. Default the size's coarse pitch. */
  pitch?: number;
  /** How far it runs from its start, mm. Default the whole face. */
  length?: number;
  /** Start from the face's other end (default: its end furthest along the face's axis turned to point up, +Z, else +Y, else +X). */
  reverse?: boolean;
  /** Cut the thread (true), or show and call it out only (false, the default). */
  modelled?: boolean;
  /** Modelled: a 45° chamfer at the start, down to the minor diameter (a shaft) or out to the major (a hole). */
  chamfer?: boolean;
  /** A left-hand thread (called out "LH"). */
  leftHanded?: boolean;
}

export const def: FeatureDef<ThreadFeature> = {
  op: "thread",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "face", "size", "pitch", "length", "reverse", "modelled", "chamfer", "leftHanded"]);
    const face = raw.face === undefined ? (c.fail("face", "needed: the cylindrical face (a shaft or a hole's wall) the thread is on"), null) : x.faceSelector(raw.face, "face");
    let size: string | undefined;
    if (raw.size !== undefined) {
      if (typeof raw.size !== "string" || !HOLE_SIZES.includes(raw.size)) c.fail("size", `must be an ISO metric size: ${HOLE_SIZES.join(", ")} (got ${x.describe(raw.size)})`);
      else size = raw.size;
    }
    const pitch = raw.pitch === undefined ? undefined : c.num(raw, "pitch", "", { positive: true });
    const length = raw.length === undefined ? undefined : c.num(raw, "length", "", { positive: true });
    const reverse = x.bool(raw, "reverse", "");
    const modelled = x.bool(raw, "modelled", "");
    const chamfer = x.bool(raw, "chamfer", "");
    const leftHanded = x.bool(raw, "leftHanded", "");
    if (chamfer && !modelled) c.fail("chamfer", 'goes with "modelled": true (a cosmetic thread cuts nothing)');
    if (c.errors.length || !face) return null;
    return {
      id: raw.id as string,
      op: "thread",
      face,
      ...(size ? { size } : {}),
      ...(pitch !== undefined ? { pitch } : {}),
      ...(length !== undefined ? { length } : {}),
      ...(reverse ? { reverse } : {}),
      ...(modelled ? { modelled } : {}),
      ...(chamfer ? { chamfer } : {}),
      ...(leftHanded ? { leftHanded } : {}),
    };
  },
  selectors: (f) => [{ path: "face", face: f.face }],
  measurementKeys: ["length", "pitch"],
  reference: `## thread
{ "id": "thread_1", "op": "thread", "face": { "type": "cylindrical", "radius": 5, "pick": "largest" }, "length": 20 }
{ "id": "thread_2", "op": "thread", "face": <a hole's wall>, "size": "M10", "modelled": true, "chamfer": true }
An ISO metric thread on a cylindrical face: external on a shaft, internal in a hole's wall (the face tells which).
"size": "M3" ... "M24" (default: the size the face fits: a shaft of its major diameter, a hole of its tap drill,
within 0.25 mm). "pitch": default the size's coarse pitch (M10: 1.5). "length": from the start, mm (default the whole
face). It starts at the face's end furthest along +Z (else +Y, else +X); "reverse": true, the other end.
"modelled": false (default) is a cosmetic thread: nothing is cut, the 3D view shows the band and drawings call it
out like a tapped hole ("M10×1.5 - 6g ⌴20" outside, "- 6H" inside). "modelled": true cuts the ISO 68-1 basic profile
along the exact helix (volume removed = length / pitch × 2π ∫ ρ w(ρ) dρ of the groove, e.g. M10×1.5 on a Ø10 shaft:
about 13.4 mm³ per mm of length); "chamfer": true adds a 45° run-out chamfer at the start; "leftHanded": true.
A long fine modelled thread rebuilds slowly (each turn is swept): keep it cosmetic unless the shape matters.
`,
};
