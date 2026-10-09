// Sketch: on a default plane, or on the one flat face selected. It sits left
// of the CommandManager's tabs, always shown, as SOLIDWORKS keeps it at hand.

import type { DatumPlane, Vec3 } from "../../../doc/types";
import type { IconName } from "../../icons";
import { round9 } from "../names";
import type { ToolCtx, ToolDef } from "../ToolContext";

/** The default planes (Z up), as the Sketch menu and the empty-space menu offer them. */
export const PLANES: [string, DatumPlane][] = [
  ["Top (XY)", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }],
  ["Front (XZ)", { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] }],
  ["Right (YZ)", { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] }],
];

const PLANE_ICON: Record<string, IconName> = { Top: "top", Front: "front", Right: "right" };

/** A sketch on the one selected flat face: its plane, through the face. */
export function sketchOnFace(ctx: ToolCtx): void {
  const f = ctx.view?.faces[ctx.selection.faces[0]];
  if (ctx.selection.faces.length !== 1 || f?.type !== "plane" || !f.normal) {
    return ctx.notice("Click a flat face first, then Sketch → On selected face.");
  }
  const n = f.normal.map(round9) as Vec3;
  ctx.startSketch({ type: "datum", normal: n, origin: n.map((c) => round9(c * (f.offset ?? 0))) as Vec3 });
}

const sketch: ToolDef = {
  id: "tool.sketch",
  label: "Sketch",
  icon: "sketch",
  tab: "pinned",
  title: "Start a sketch on a plane or a flat face",
  testId: "tool-sketch",
  // A key, the shortcut bar or Enter: on the selected face, else on Top.
  run: (ctx) => (ctx.selection.faces.length === 1 ? ctx.sketchOnFace() : ctx.startSketch(PLANES[0][1])),
  items: (ctx) => [
    ...PLANES.map(([label, plane]) => {
      const name = label.split(" ")[0];
      return { label, icon: PLANE_ICON[name], testId: `plane-${name.toLowerCase()}`, run: (c: ToolCtx) => c.startSketch(plane) };
    }),
    { label: "On selected face", icon: "select", hint: "Click a flat face first", disabled: ctx.selection.faces.length !== 1, run: (c: ToolCtx) => c.sketchOnFace() },
  ],
  contextOn: "face",
  contextLabel: "Sketch on this face",
  contextTestId: "ctx-sketch-face",
  contextWhen: (ctx, t) => t.kind === "face" && ctx.view?.faces[t.index]?.type === "plane",
};

export const tools: ToolDef[] = [sketch];
