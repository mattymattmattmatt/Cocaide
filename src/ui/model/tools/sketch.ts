// Sketch: on a default plane, a plane feature, or the one flat face
// selected, by reference, so the sketch follows what it stands on (a sketch
// on a face moves when an earlier feature moves the face). It sits left of
// the CommandManager's tabs, always shown, as SOLIDWORKS keeps it at hand:
// with a plane or a flat face selected it sketches there straight away;
// otherwise its dropdown offers the planes.

import type { PlaneSpec } from "../../../doc/types";
import { faceSelectorFor } from "../../../kernel/synthesize";
import type { IconName } from "../../icons";
import { round9 } from "../names";
import { datumKindOf } from "../selection";
import type { ToolCtx, ToolDef } from "../ToolContext";

/** The default planes (Z up), as the Sketch menu and the empty-space menu offer them: by reference. */
export const PLANES: [string, PlaneSpec][] = [
  ["Top (XY)", { type: "ref", ref: { datum: "Top" } }],
  ["Front (XZ)", { type: "ref", ref: { datum: "Front" } }],
  ["Right (YZ)", { type: "ref", ref: { datum: "Right" } }],
];

const PLANE_ICON: Record<string, IconName> = { Top: "top", Front: "front", Right: "right" };

/** A sketch plane on a plane by id: a default one or a plane feature. */
export const onPlane = (id: string): PlaneSpec => ({ type: "ref", ref: { datum: id } });

/**
 * A sketch plane on the face at `index` in the last rebuild: by reference to
 * it (a selector), so the sketch follows the face; written out only if no
 * selector can pin the face down. Null when it is not flat.
 */
export function facePlaneSpec(ctx: ToolCtx, index: number): PlaneSpec | null {
  const f = ctx.view?.faces[index];
  if (f?.type !== "plane" || !f.normal) return null;
  const s = faceSelectorFor(ctx.view!.faces, index);
  if (s.ok) return { type: "ref", ref: { face: s.selector } };
  const n = f.normal.map(round9) as [number, number, number];
  return { type: "datum", normal: n, origin: n.map((c) => round9(c * (f.offset ?? 0))) as [number, number, number] };
}

/** A sketch on the one selected flat face, or a notice to pick one. */
export function sketchOnFace(ctx: ToolCtx): void {
  const plane = ctx.selection.faces.length === 1 ? facePlaneSpec(ctx, ctx.selection.faces[0]) : null;
  if (!plane) return ctx.notice("Click a flat face first, then Sketch → On the selected face.");
  ctx.startSketch(plane);
}

/** The plane features of the document, in order. */
const planeFeatures = (ctx: ToolCtx) => ctx.features.filter((f) => f.op === "plane").map((f) => String(f.id));

/**
 * What the selection says to sketch on, as SOLIDWORKS reads it: one plane
 * picked (in the view or the tree), else one flat face, else the plane
 * feature selected in the tree; null when nothing says.
 */
export function sketchTarget(ctx: ToolCtx): { plane: PlaneSpec; what: string } | null {
  const sel = ctx.selection;
  const datums = sel.datums ?? [];
  const others = sel.faces.length + sel.edges.length + (sel.vertices?.length ?? 0);
  const isPlane = (id: string) => (datumKindOf(id, ctx.view?.datums ?? {}) ?? (ctx.features.find((f) => f.id === id)?.op === "plane" ? "plane" : undefined)) === "plane";
  if (datums.length === 1 && others === 0 && isPlane(datums[0])) return { plane: onPlane(datums[0]), what: datums[0] };
  if (sel.faces.length === 1 && others === 1 && datums.length === 0) {
    const plane = facePlaneSpec(ctx, sel.faces[0]);
    if (plane) return { plane, what: "the selected face" };
  }
  if (others + datums.length === 0 && ctx.selected?.op === "plane") return { plane: onPlane(String(ctx.selected.id)), what: String(ctx.selected.id) };
  return null;
}

const sketch: ToolDef = {
  id: "tool.sketch",
  label: "Sketch",
  icon: "sketch",
  tab: "pinned",
  title: "Start a sketch on a plane or a flat face (select one first to sketch on it straight away)",
  testId: "tool-sketch",
  // A key, the shortcut bar, Enter or the button with a plane or face selected: there; else on Top.
  run: (ctx) => ctx.startSketch(sketchTarget(ctx)?.plane ?? PLANES[0][1]),
  direct: (ctx) => {
    const t = sketchTarget(ctx);
    return t ? `Sketch on ${t.what} (Esc first to choose a plane)` : undefined;
  },
  items: (ctx) => [
    ...PLANES.map(([label, plane]) => {
      const name = label.split(" ")[0];
      return { label, icon: PLANE_ICON[name], testId: `plane-${name.toLowerCase()}`, run: (c: ToolCtx) => c.startSketch(plane) };
    }),
    ...planeFeatures(ctx).map((id) => ({ label: id, icon: "plane" as IconName, hint: "A plane feature", testId: `plane-${id}`, run: (c: ToolCtx) => c.startSketch(onPlane(id)) })),
    {
      label: "On the selected face",
      icon: "select",
      hint: "Click a flat face first",
      testId: "plane-selected-face",
      disabled: !(ctx.selection.faces.length === 1 && ctx.view?.faces[ctx.selection.faces[0]]?.type === "plane"),
      run: (c: ToolCtx) => c.sketchOnFace(),
    },
  ],
  contextOn: "face",
  contextLabel: "Sketch on this face",
  contextTestId: "ctx-sketch-face",
  contextWhen: (ctx, t) => t.kind === "face" && ctx.view?.faces[t.index]?.type === "plane",
  contextItems: (ctx, t) =>
    t.kind === "datum" && (datumKindOf(t.id, ctx.view?.datums ?? {}) ?? (ctx.features.find((f) => f.id === t.id)?.op === "plane" ? "plane" : undefined)) === "plane"
      ? [{ label: "Sketch on this plane", icon: "sketch", testId: "ctx-sketch-plane", run: (c: ToolCtx) => c.startSketch(onPlane(t.id)) }]
      : [],
};

export const tools: ToolDef[] = [sketch];
