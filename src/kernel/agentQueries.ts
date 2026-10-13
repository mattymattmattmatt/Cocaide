// Read-only questions the AI's tools ask of a rebuilt part that the other
// kernel queries do not answer: the closest points and the angle between two
// things, every sketch's resolved plane frame, and each body's mass
// properties. Plain data in, plain data out; served by LocalKernel.inspect
// (src/ask/kernel.ts) in Node and, through the worker's generic port, in the
// browser.

import type { Vec3 } from "../doc/types";
import { validateDocument } from "../doc/validate";
import type { Frame } from "../geom/frame";
import { massProperties, minDistance, type Closest, type MassProperties, type MeasureRef } from "./evaluate";
import type { OC } from "./oc";
import type { RebuildResult } from "./rebuild";

export type InspectQuery =
  /** The closest points between two things (faces and edges by their index in this rebuild). */
  | { kind: "distance"; a: MeasureRef; b: MeasureRef }
  /** Each sketch's plane as it resolved, whether it built, and why its curves are no closed profile. */
  | { kind: "sketchFrames" }
  /** Each body's volume, area, mass, centre of mass and inertia. */
  | { kind: "mass" };

export interface SketchFrameInfo {
  id: string;
  ok: boolean;
  frame: Frame;
  open?: string;
}

export type InspectResult =
  | { kind: "distance"; closest: Closest }
  | { kind: "sketchFrames"; sketches: SketchFrameInfo[] }
  | { kind: "mass"; mass: MassProperties };

/** Answers one query on a rebuild of `doc`. Throws an Error that says what is wrong. */
export function inspectQuery(oc: OC, built: RebuildResult, doc: unknown, q: InspectQuery): InspectResult {
  switch (q.kind) {
    case "distance":
      return { kind: "distance", closest: minDistance(oc, built.solid, q.a, q.b) };
    case "sketchFrames":
      return {
        kind: "sketchFrames",
        sketches: built.sketches.map((k) => ({ id: k.id, ok: k.ok, frame: copyFrame(k.frame), ...(k.open ? { open: k.open } : {}) })),
      };
    case "mass": {
      const v = validateDocument(doc);
      return { kind: "mass", mass: massProperties(oc, built.bodies, v.material, v.bodyMaterials) };
    }
  }
}

function copyFrame(f: Frame): Frame {
  const c = (v: Vec3): Vec3 => [v[0], v[1], v[2]];
  return { origin: c(f.origin), x: c(f.x), y: c(f.y), z: c(f.z) };
}
