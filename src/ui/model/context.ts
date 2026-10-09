// Building the ToolCtx: App hands over its state and its actions; the members
// derived from them (new ids, the bodies, the body a body tool works on, the
// sketch a sketch tool uses, a sketch on the selected face) are worked out
// here, the same way for the app and for the tests.

import { nextId } from "../../doc/commands";
import { validateDocument } from "../../doc/validate";
import type { ToolCtx } from "./ToolContext";
import { sketchOnFace } from "./tools/sketch";

/** What App knows: the document, the rebuild, the selections, the library. */
export type ToolState = Pick<ToolCtx, "doc" | "view" | "selection" | "selected" | "resolved" | "features" | "library">;

/** What App does for a tool. */
export type ToolActions = Pick<ToolCtx, "run" | "create" | "replace" | "notice" | "clearNotice" | "startSketch" | "setSelection" | "selectFeature" | "setRightTab">;

export function makeToolCtx(state: ToolState, actions: ToolActions): ToolCtx {
  const { doc, view, selection, selected, resolved } = state;
  const ctx: ToolCtx = {
    ...state,
    ...actions,
    nextId: (prefix) => nextId(doc, prefix),
    bodies: () => (doc ? validateDocument(doc).bodies : []),
    pickedBody: () => (selection.faces.length ? view?.faces[selection.faces[0]]?.body : undefined) ?? view?.bodies.at(-1)?.name,
    sketchFor: () => (selected?.op === "sketch" ? selected : [...resolved].reverse().find((f) => f.op === "sketch")),
    sketchOnFace: () => sketchOnFace(ctx),
  };
  return ctx;
}
