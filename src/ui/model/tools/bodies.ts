// The multibody tools (Phase M): combine, split, move/copy and delete bodies.
// Each works on the body of the face clicked last, else the newest body.

import { round3 } from "../names";
import type { Raw, ToolCtx, ToolDef } from "../ToolContext";

/** A body's bounding box from the last rebuild (the part's, when the body has none of its own). */
export function bodyBox(ctx: ToolCtx, name: string) {
  return ctx.view?.measurements?.bodies.find((b) => b.name === name)?.boundingBox ?? ctx.view?.measurements?.boundingBox ?? null;
}

/** A plane square to X through x: where Mirror and Split cut by default. */
export const yzPlane = (x: number) => ({ type: "datum", normal: [1, 0, 0], origin: [round3(x), 0, 0] });

/** How many bodies the last rebuild made. */
const bodyCount = (ctx: ToolCtx) => ctx.view?.bodies.length ?? 0;

/** Deletes a body (the clicked one, or one named by the Bodies panel). A part's only body stays. */
export function deleteBody(ctx: ToolCtx, name = ctx.pickedBody()): void {
  if (!ctx.doc || !name) return;
  if (bodyCount(ctx) < 2) return ctx.notice("A part's only body can't be deleted.");
  ctx.create({ id: ctx.nextId("delete"), op: "deleteBody", bodies: [name] });
}

function combine(ctx: ToolCtx): Raw | string {
  const names = ctx.view?.bodies.map((b) => b.name) ?? [];
  if (!ctx.doc || names.length < 2) return "Combine needs two bodies or more.";
  // The clicked face's body goes into the first other body; change either in Properties.
  const picked = ctx.selection.faces.length ? ctx.view?.faces[ctx.selection.faces[0]]?.body : undefined;
  const tool = picked ?? names[1];
  const target = names.find((n) => n !== tool)!;
  return { id: ctx.nextId("combine"), op: "combine", operation: "add", target, tools: [tool] };
}

function split(ctx: ToolCtx): Raw | string {
  const body = ctx.pickedBody();
  const box = body ? bodyBox(ctx, body) : null;
  if (!ctx.doc || !body || !box) return "Split needs a body: click one, then Split.";
  return { id: ctx.nextId("split"), op: "split", body, plane: yzPlane((box.min[0] + box.max[0]) / 2) };
}

function move(ctx: ToolCtx): Raw | string {
  const body = ctx.pickedBody();
  const box = body ? bodyBox(ctx, body) : null;
  if (!ctx.doc || !body || !box) return "Move/Copy needs a body: click one, then Move/Copy.";
  return { id: ctx.nextId("move"), op: "move", bodies: [body], translate: [round3(box.size[0] + 20), 0, 0], copy: true };
}

const make = (build: (ctx: ToolCtx) => Raw | string) => (ctx: ToolCtx) => {
  const f = build(ctx);
  if (typeof f === "string") ctx.notice(f);
  else ctx.create(f);
};

export const tools: ToolDef[] = [
  {
    id: "tool.combine",
    label: "Combine",
    icon: "combine",
    tab: "bodies",
    group: "bodies",
    title: "Join, subtract or intersect bodies",
    testId: "tool-combine",
    disabled: (ctx) => (bodyCount(ctx) < 2 ? "Combine needs two or more bodies" : undefined),
    run: make(combine),
  },
  {
    id: "tool.split",
    label: "Split",
    icon: "split",
    tab: "bodies",
    group: "bodies",
    title: "Cut the clicked body in two with a plane",
    testId: "tool-split",
    run: make(split),
  },
  {
    id: "tool.move",
    label: "Move",
    icon: "move",
    tab: "bodies",
    group: "bodies",
    title: "Move, turn or copy the clicked body",
    testId: "tool-move",
    run: make(move),
  },
  {
    id: "tool.deleteBody",
    label: "Delete body",
    icon: "deleteBody",
    tab: "bodies",
    group: "bodies",
    title: "Delete the clicked body, or keep only some",
    testId: "tool-delete-body",
    disabled: (ctx) => (bodyCount(ctx) < 2 ? "A part needs at least one body" : undefined),
    run: (ctx) => deleteBody(ctx),
  },
];
