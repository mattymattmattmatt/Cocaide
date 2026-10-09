// Revolve and Revolved cut, in the Revolve menu: the selected (or latest)
// sketch turned about an axis found for it. An axis or a straight edge
// selected in the view wins; else a centreline of the sketch that has the
// whole profile on one side of it; else the one line drawn apart from the
// profile; else it asks for one. The new feature's properties open, where
// the axis, angle and the rest can be changed.

import type { SketchEntity } from "../../../doc/types";
import { axisCrossing, openChain, regionSegs, type Line2 } from "../../../features/revolve/band";
import { buildProfile } from "../../../geom/profile";
import { refFromSelection } from "../../props/datumRef";
import { nextBodyName } from "../names";
import type { Raw, ToolCtx, ToolDef, ToolMenuDef } from "../ToolContext";

const REVOLVE_MENU: ToolMenuDef = {
  id: "revolve",
  label: "Revolve",
  icon: "revolve",
  title: "Turn a sketch's profile about an axis: add material, or cut it away",
  testId: "tool-revolve-menu",
};

type Line = Extract<SketchEntity, { type: "line" }>;

const lineAxis = (l: Line): Line2 | null => {
  const d: [number, number] = [l.end[0] - l.start[0], l.end[1] - l.start[1]];
  const len = Math.hypot(d[0], d[1]);
  return len > 1e-9 ? { p: l.start, u: [d[0] / len, d[1] / len] } : null;
};

/**
 * The line of the sketch to turn about, or why there is none to choose: a
 * construction line (a centreline) with the whole profile on one side of it;
 * else a line drawn apart from the profile (the profile closes without it)
 * with the profile on one side.
 */
export function sketchAxisLine(entities: readonly SketchEntity[]): { line: string } | string {
  const lines = entities.filter((e): e is Line => e.type === "line");
  const profile = buildProfile(entities as SketchEntity[]);
  const clear = (l: Line, regions: Parameters<typeof regionSegs>[0]) => {
    const axis = lineAxis(l);
    return !!axis && (regions.length === 0 || axisCrossing(regionSegs(regions), axis) === null);
  };
  for (const l of lines.filter((x) => x.construction)) {
    if (clear(l, profile.ok ? profile.regions : [])) return { line: l.id };
  }
  for (const l of lines.filter((x) => !x.construction)) {
    const without = buildProfile(entities.filter((e) => e.id !== l.id) as SketchEntity[]);
    if (without.ok && without.regions.length > 0 && clear(l, without.regions)) return { line: l.id };
  }
  if (lines.some((l) => l.construction)) return "Every centreline of the sketch runs through the profile: draw one beside it (Shift+L), or select an axis or a straight edge, then Revolve.";
  return "Draw a centreline in the sketch to turn about (Shift+L), or select an axis or a straight edge, then Revolve.";
}

/** The new revolve (or revolved cut) of the sketch a sketch tool uses, or what to do first. */
export function revolveFeature(ctx: ToolCtx, cut: boolean): Raw | string {
  const sk = ctx.sketchFor();
  const verb = cut ? "Revolved cut" : "Revolve";
  if (!ctx.doc || !sk) return `Make a sketch with a profile and a centreline first, then ${verb}.`;
  const bodies = ctx.bodies();
  if (cut && bodies.length === 0) return "A revolved cut needs a solid to cut: make one first.";
  // An axis or straight edge picked in the view is the axis meant.
  const { selection } = ctx;
  let axis: Raw | undefined;
  if (selection.edges.length + (selection.datums?.length ?? 0) + (selection.vertices?.length ?? 0) > 0 || selection.faces.length === 1) {
    const r = refFromSelection(selection, ctx.view, ["axis"], ctx.resolved);
    if (r.ok) axis = r.ref as Raw;
  }
  if (!axis) {
    const found = sketchAxisLine((Array.isArray(sk.entities) ? sk.entities : []) as SketchEntity[]);
    if (typeof found === "string") return found;
    axis = found;
  }
  const feature: Raw = { id: ctx.nextId(cut ? "revolve_cut" : "revolve"), op: "revolve", sketch: sk.id, axis };
  // An open chain cannot turn into a solid: as SOLIDWORKS offers, it becomes a thin revolve (a 2 mm wall).
  if (openProfile((Array.isArray(sk.entities) ? sk.entities : []) as SketchEntity[], axis)) feature.thin = { thickness: 2 };
  if (cut) feature.operation = "remove";
  // In a part of several bodies, new material starts a body of its own (choose another in Properties).
  else if (bodies.length > 1) feature.newBody = nextBodyName(bodies);
  return feature;
}

/**
 * Is the sketch's profile one open chain of lines and arcs (no closed region,
 * once a line of the sketch used as the axis is left out)? Then only a thin
 * revolve can turn it.
 */
export function openProfile(entities: readonly SketchEntity[], axis: Raw): boolean {
  const skip = typeof axis.line === "string" && !entities.find((e) => e.id === axis.line)?.construction ? axis.line : undefined;
  const rest = entities.filter((e) => e.id !== skip) as SketchEntity[];
  const profile = buildProfile(rest);
  if (profile.ok && profile.regions.length > 0) return false;
  try {
    return openChain(rest).length > 0;
  } catch {
    return false; // not one open chain either: the revolve says what is wrong
  }
}

const run = (cut: boolean) => (ctx: ToolCtx) => {
  const f = revolveFeature(ctx, cut);
  if (typeof f === "string") return ctx.notice(f);
  ctx.create(f);
  if (f.thin) ctx.notice("The profile is open, so it turns as a thin wall (2 mm): change the wall in Properties.", "info");
};

export const tools: ToolDef[] = [
  {
    id: "tool.revolve",
    label: "Revolve",
    icon: "revolve",
    tab: "features",
    group: "shape",
    menu: REVOLVE_MENU,
    title: "Add material: turn the selected (or latest) sketch about its centreline",
    hint: "Turn a profile about an axis",
    testId: "tool-revolve",
    run: run(false),
  },
  {
    id: "tool.revolveCut",
    label: "Revolved cut",
    icon: "revolveCut",
    tab: "features",
    group: "shape",
    menu: REVOLVE_MENU,
    title: "Remove material: turn the selected (or latest) sketch about its centreline, cutting",
    hint: "Cut by turning a profile",
    testId: "tool-revolve-cut",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "A revolved cut needs a solid to cut" : undefined),
    run: run(true),
  },
];
