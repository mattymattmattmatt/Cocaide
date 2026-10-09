// Extrude and Cut: the selected (or latest) sketch pushed out of the sketch
// plane, or into the part.

import { DEFAULT_BODY, type DatumPlane, type Vec3 } from "../../../doc/types";
import { planeFrame } from "../../../geom/frame";
import { dot3 } from "../../../geom/vec";
import { nextBodyName } from "../names";
import type { Raw, ToolCtx, ToolDef } from "../ToolContext";

/** The new extrude or cut, on the sketch a sketch tool uses. */
export function extrudeFeature(ctx: ToolCtx, op: "extrude" | "cut"): Raw | string {
  const sk = ctx.sketchFor();
  if (!ctx.doc || !sk) return `Make a sketch first, then ${op === "cut" ? "Cut" : "Extrude"}.`;
  const plane = sk.plane as DatumPlane;
  const feature: Raw = { id: ctx.nextId(op), op, sketch: sk.id, distance: op === "cut" ? 5 : 10 };
  // Where new material goes: the one body there is, or, in a part of several, a new body.
  const bodies = ctx.bodies();
  if (op === "extrude" && bodies.length === 1 && bodies[0] !== DEFAULT_BODY) feature.body = bodies[0];
  if (op === "extrude" && bodies.length > 1) feature.newBody = nextBodyName(bodies);
  // (A sketch placed on a reference has no normal of its own here: its cut goes the sketch's way.)
  if (op === "cut" && ctx.view?.measurements?.boundingBox && Array.isArray(plane?.normal)) {
    // Cut toward the material: if nothing of the part lies in front of the sketch plane, cut backwards.
    const { min, max } = ctx.view.measurements.boundingBox;
    const n = planeFrame(plane.normal, plane.origin).z;
    let far = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c: Vec3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
      far = Math.max(far, dot3(n, c) - dot3(n, plane.origin));
    }
    if (far <= 1e-6) feature.direction = n.map((c) => -c);
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
