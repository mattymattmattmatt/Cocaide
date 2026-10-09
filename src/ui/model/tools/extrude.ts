// Extrude and Cut: the selected (or latest) sketch pushed out of the sketch
// plane, or into the part.

import { DEFAULT_BODY, type Vec3 } from "../../../doc/types";
import { dot3 } from "../../../geom/vec";
import { nextBodyName } from "../names";
import { sketchFrameIn } from "../sketchPlane";
import type { Raw, ToolCtx, ToolDef } from "../ToolContext";

/** The new extrude or cut, on the sketch a sketch tool uses. */
export function extrudeFeature(ctx: ToolCtx, op: "extrude" | "cut"): Raw | string {
  const sk = ctx.sketchFor();
  if (!ctx.doc || !sk) return `Make a sketch first, then ${op === "cut" ? "Cut" : "Extrude"}.`;
  const feature: Raw = { id: ctx.nextId(op), op, sketch: sk.id, distance: op === "cut" ? 5 : 10 };
  // Where new material goes: the one body there is, or, in a part of several, a new body.
  const bodies = ctx.bodies();
  if (op === "extrude" && bodies.length === 1 && bodies[0] !== DEFAULT_BODY) feature.body = bodies[0];
  if (op === "extrude" && bodies.length > 1) feature.newBody = nextBodyName(bodies);
  // Where the sketch is: as the last rebuild placed it (a sketch on a face or a plane feature is where that is now).
  const frame = sketchFrameIn(sk, ctx.view);
  if (op === "cut" && ctx.view?.measurements?.boundingBox && typeof frame !== "string") {
    // Cut toward the material: if nothing of the part lies in front of the sketch plane, cut backwards.
    const { min, max } = ctx.view.measurements.boundingBox;
    const n = frame.z;
    let far = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c: Vec3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
      far = Math.max(far, dot3(n, c) - dot3(n, frame.origin));
    }
    if (far <= 1e-6) feature.direction = n.map((c) => -c + 0);
  }
  return feature;
}

const run = (op: "extrude" | "cut") => (ctx: ToolCtx) => {
  const f = extrudeFeature(ctx, op);
  if (typeof f === "string") ctx.notice(f);
  else ctx.create(f);
};

export const tools: ToolDef[] = [
  {
    id: "tool.extrude",
    label: "Extrude",
    icon: "extrude",
    tab: "features",
    group: "shape",
    title: "Add material: push the selected (or latest) sketch out",
    testId: "tool-extrude",
    run: run("extrude"),
  },
  {
    id: "tool.cut",
    label: "Cut",
    icon: "cut",
    tab: "features",
    group: "shape",
    title: "Remove material: cut the selected (or latest) sketch in",
    testId: "tool-cut",
    run: run("cut"),
  },
];
