// Hole (the Hole Wizard): drilled where a flat face was clicked, square to
// it, or at every point of the sketch selected in the tree. A new hole takes
// its size, type, fit and depth from the hole before it (the wizard
// remembers), so a row of M6 counterbores is click, Hole, click, Hole.

import { rememberedHole } from "../../../features/hole/wizard";
import { facePlaneFrame, to2D } from "../../../geom/frame";
import { faceSelectorFor } from "../../../kernel/synthesize";
import { round3 } from "../names";
import type { Raw, ToolCtx, ToolDef } from "../ToolContext";

/** A sketch with point entities (where holes can go), or undefined. */
function pointSketch(f: Raw | undefined): Raw | undefined {
  return f?.op === "sketch" && Array.isArray(f.entities) && (f.entities as Raw[]).some((e) => e.type === "point") ? f : undefined;
}

/** The face a sketch stands on, when it is placed on a face with no offset: the holes at its points drill into that face. */
function sketchFace(sketch: Raw): unknown {
  const plane = sketch.plane as { type?: unknown; ref?: { face?: unknown }; offset?: unknown } | undefined;
  return plane?.type === "ref" && plane.ref?.face && !plane.offset ? plane.ref.face : undefined;
}

/**
 * The new hole: at every point of the sketch selected in the tree (on the
 * face clicked, or the face the sketch is on, else from the sketch's plane),
 * or at the clicked point of the one selected flat face; or what to click first.
 */
export function holeFeature(ctx: ToolCtx): Raw | string {
  const { view, selection } = ctx;
  if (!ctx.doc) return "Click a flat face where the hole goes, then Hole.";
  const remembered = rememberedHole(ctx.features);
  const sketch = pointSketch(ctx.selected);
  if (sketch) {
    let face: unknown = sketchFace(sketch);
    const clicked = view && selection.faces.length === 1 ? view.faces[selection.faces[0]] : undefined;
    if (clicked?.type === "plane") {
      const s = faceSelectorFor(view!.faces, selection.faces[0]);
      if (s.ok) face = s.selector;
    }
    return { id: ctx.nextId("hole"), op: "hole", ...(face ? { face } : {}), points: String(sketch.id), ...remembered };
  }
  const f = view?.faces[selection.faces[0]];
  if (!view || selection.faces.length !== 1 || !f || !selection.point) return "Click a flat face where the hole goes, then Hole.";
  const s = faceSelectorFor(view.faces, selection.faces[0]);
  if (!s.ok || f.type !== "plane") return s.ok ? "A hole needs a flat face." : s.error;
  const frame = facePlaneFrame(f.normal!, f.point!);
  const c = to2D(frame, selection.point).map(round3) as [number, number];
  // In a part of several bodies, the hole drills the body that was clicked.
  return { id: ctx.nextId("hole"), op: "hole", face: s.selector, center: c, ...remembered, ...(f.body ? { bodies: [f.body] } : {}) };
}

export const tools: ToolDef[] = [
  {
    id: "tool.hole",
    label: "Hole",
    icon: "hole",
    tab: "features",
    group: "dress",
    title: "Hole Wizard: click a flat face where the hole goes (or select a sketch of points in the tree), then Hole",
    testId: "tool-hole",
    run: (ctx) => {
      const f = holeFeature(ctx);
      if (typeof f === "string") ctx.notice(f);
      else ctx.create(f);
    },
    contextOn: "face",
    contextLabel: "Hole here",
    contextWhen: (ctx, t) => t.kind === "face" && ctx.view?.faces[t.index]?.type === "plane",
  },
];
