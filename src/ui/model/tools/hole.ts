// Hole (the Hole Wizard): drilled where a flat face was clicked, square to
// it, or at every point of the sketch selected in the tree. A new hole takes
// its size, type, fit and depth from the hole before it (the wizard
// remembers), so a row of M6 counterbores is click, Hole, click, Hole.

import { rememberedHole } from "../../../features/hole/wizard";
import { facePlaneFrame, to2D } from "../../../geom/frame";
import type { FaceSelector } from "../../../doc/types";
import { selectFaces } from "../../../kernel/selectors";
import { faceSelectorFor } from "../../../kernel/synthesize";
import { round3 } from "../names";
import { faceWidth, holeSizeFor } from "../smartDefaults";
import { recalled } from "../toolMemory";
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
 * What a new hole is: like the part's last hole (the wizard remembers); else
 * the size, type and fit used last in this browser; else the largest of
 * M3–M12 that sits on the face with a margin (`face`: its index), through.
 */
export function newHoleKind(ctx: ToolCtx, face?: number): Raw {
  if (ctx.features.some((g) => g.op === "hole")) return rememberedHole(ctx.features);
  const out: Raw = { depth: "through" };
  const size = recalled(ctx.memory, "hole", "size");
  if (typeof size === "string") {
    out.size = size;
    for (const k of ["kind", "fit"]) {
      const v = recalled(ctx.memory, "hole", k);
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  out.size = ctx.view && face !== undefined ? holeSizeFor(faceWidth(ctx.view, face)) : "M5";
  return out;
}

/** A new hole with no face clicked yet: its session opens with its position waiting for a click on a flat face. */
export function holeDraft(ctx: ToolCtx): Raw {
  return { id: ctx.nextId("hole"), op: "hole", ...newHoleKind(ctx) };
}

/**
 * Command-first, a new hole's size settles with the face clicked for it: with
 * no hole in the part and none used in this browser to copy, the largest of
 * M3–M12 that sits on that face (as selection-first has it), unless the user
 * chose a size meanwhile (it is no longer `start`).
 */
export function holeComplete(ctx: ToolCtx, start: unknown): (f: Raw) => Raw {
  const copied = ctx.features.some((g) => g.op === "hole") || typeof recalled(ctx.memory, "hole", "size") === "string";
  return (f) => {
    const view = ctx.view;
    if (copied || !view || f.size !== start || !f.face || typeof f.face !== "object") return f;
    const face = selectFaces(view.faces, f.face as FaceSelector).matches[0];
    return face ? { ...f, size: holeSizeFor(faceWidth(view, face.index)) } : f;
  };
}

/**
 * The new hole: at every point of the sketch selected in the tree (on the
 * face clicked, or the face the sketch is on, else from the sketch's plane),
 * or at the clicked point of the one selected flat face; or what to click first.
 */
export function holeFeature(ctx: ToolCtx): Raw | string {
  const { view, selection } = ctx;
  if (!ctx.doc) return "Click a flat face where the hole goes, then Hole.";
  const remembered = newHoleKind(ctx, selection.faces.length === 1 ? selection.faces[0] : undefined);
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
      if (typeof f !== "string") return ctx.create(f);
      // Command-first: open it, and the next click on a flat face places it.
      if (ctx.draft && ctx.view && ctx.view.bodies.length && ctx.selection.faces.length === 0) {
        const draft = holeDraft(ctx);
        return ctx.draft(draft, { active: "position", complete: holeComplete(ctx, draft.size) });
      }
      ctx.notice(f);
    },
    contextOn: "face",
    contextLabel: "Hole here",
    contextWhen: (ctx, t) => t.kind === "face" && ctx.view?.faces[t.index]?.type === "plane",
  },
];
