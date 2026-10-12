// Trim ▾: Trim (click a piece: it goes back to the nearest crossings; drag
// across pieces: each one crossed goes, a power trim), Extend
// (click near an end: it grows to the next entity it meets) and Split
// (click a point on an entity: it becomes two, joined there). Each acts on
// the click; the pointer shows what it would do first.

import { editableAt, extended, extendAt, powerTrim, splitAt, trimAt, trimPreview } from "../../../geom/sketchEdit/trim";
import { curvesOf, distanceTo, footOn } from "../../../geom/sketchEdit/curve";
import type { FlyoutDef } from "../tools/types";
import type { EditToolDef } from "./types";

const TRIM: FlyoutDef = { id: "trim", label: "Trim" };

export const tools: EditToolDef[] = [
  {
    id: "sketch.trim",
    name: "trim",
    label: "Trim",
    icon: "trim",
    title: "Trim: click a piece of a line, arc or circle to cut it back to where others cross it; or drag across pieces to trim each one crossed",
    flyout: TRIM,
    kind: "click",
    prompt: () => "Click a piece to trim it, or drag across pieces to trim each one",
    click: (state, _picks, input) => {
      const id = editableAt(state.entities, input.p, input.tol);
      if (!id) return { message: "click on a line, arc or circle: the piece under the pointer is trimmed" };
      return { edit: trimAt(state, id, input.p) };
    },
    drag: (state, path) => {
      const r = powerTrim(state, path);
      return r.trimmed.length ? r : null;
    },
    preview: (state, _picks, _options, hover) => {
      if (!hover) return {};
      const id = editableAt(state.entities, hover.p, hover.tol);
      const piece = id ? trimPreview(state, id, hover.p) : null;
      return piece ? { remove: [piece] } : {};
    },
  },
  {
    id: "sketch.extend",
    name: "extend",
    label: "Extend",
    icon: "extend",
    title: "Extend: click near the end of a line or arc: it grows to the next entity it meets",
    flyout: TRIM,
    kind: "click",
    prompt: () => "Click near the end of a line or arc to extend it",
    click: (state, _picks, input) => {
      const id = editableAt(state.entities, input.p, input.tol);
      if (!id) return { message: "click near the end of a line or arc" };
      return { edit: extendAt(state, id, input.p) };
    },
    preview: (state, _picks, _options, hover) => {
      if (!hover) return {};
      const id = editableAt(state.entities, hover.p, hover.tol);
      const e = id ? extended(state, id, hover.p) : null;
      return e ? { add: [{ ...e, id: "extend-preview" }] } : {};
    },
  },
  {
    id: "sketch.split",
    name: "split",
    label: "Split",
    icon: "splitEntity",
    title: "Split entities: click a point on a line, arc or circle: it becomes two pieces, joined there",
    flyout: TRIM,
    kind: "click",
    prompt: () => "Click where to split a line, arc or circle",
    click: (state, _picks, input) => {
      const id = editableAt(state.entities, input.p, input.tol);
      if (!id) return { message: "click on a line, arc or circle where it should split" };
      const e = state.entities.find((x) => x.id === id)!;
      // Split exactly on it: the nearest point of the curve under the pointer.
      const curves = curvesOf(e);
      const c = curves.reduce((best, x) => (distanceTo(x, input.p) < distanceTo(best, input.p) ? x : best), curves[0]);
      return { edit: splitAt(state, id, c ? footOn(c, input.p) : input.p) };
    },
    preview: (state, _picks, _options, hover) => {
      if (!hover) return {};
      const id = editableAt(state.entities, hover.p, hover.tol);
      if (!id) return {};
      const curves = curvesOf(state.entities.find((x) => x.id === id)!);
      const c = curves.reduce((best, x) => (distanceTo(x, hover.p) < distanceTo(best, hover.p) ? x : best), curves[0]);
      return c ? { marks: [{ at: footOn(c, hover.p) }] } : {};
    },
  },
];
