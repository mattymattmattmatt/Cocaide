// Sweep, Swept cut and Helix (a spring or a coil), in the Sweep menu; Loft
// and Lofted cut in the Loft menu (shape group); Rib (dress group). Each
// works out what to use from the selection and the sketches no feature uses
// yet, as a CAD feature panel fills itself from a preselection,
// then opens Properties to change it:
//   - Sweep: the path is the selected sketch when it is a chain of lines and
//     arcs, else the newest unused such sketch, else model edges selected in
//     the view; the profile is the selected (or newest unused) closed
//     sketch, else a round section (a circle sweep: a pipe, a wire). Edges
//     picked in the view win over a path sketch that is not selected. With
//     only closed sketches, two of them are a profile swept round the longer
//     (an O-ring round a ring), and a lone one is the path of a round section
//     (an O-ring groove, as a swept cut).
//   - Helix: a coil about the selected axis, cylinder or circular edge (its
//     radius taken from it), else about Z; a round wire, or the selected
//     closed sketch swept along it.
//   - Loft: the unused sketches that can be sections, in order; with fewer
//     than two, the newest two (Properties reorders, adds and removes them).
//   - Rib: the selected (or newest unused) sketch that is one open chain.

import type { SketchEntity } from "../../../doc/types";
import { references } from "../../../doc/commands";
import { chainLength, sketchChain } from "../../../features/sweep/chain";
import { entitiesOf, isOpenChain, sketchUse, type SketchUse } from "../../../features/sweep/fields";
import { edgesSelectorFor } from "../../../kernel/synthesize";
import { refFromSelection } from "../../props/datumRef";
import { nextBodyName } from "../names";
import type { Raw, ToolCtx, ToolDef, ToolMenuDef } from "../ToolContext";

const SWEEP_MENU: ToolMenuDef = {
  id: "sweep",
  label: "Sweep",
  icon: "sweep",
  title: "Carry a profile along a path, or a round wire along a helix: add material, or cut it away",
  testId: "tool-sweep-menu",
};

const LOFT_MENU: ToolMenuDef = {
  id: "loft",
  label: "Loft",
  icon: "loft",
  title: "A solid through profiles sketched on several planes: add material, or cut it away",
  testId: "tool-loft-menu",
};

/** A sketch, what it can be used as, and whether a later feature already uses it. */
interface SketchInfo {
  f: Raw;
  id: string;
  use: SketchUse;
  open: boolean;
  used: boolean;
}

/** The document's sketches, oldest first. */
export function sketchInfos(resolved: Raw[]): SketchInfo[] {
  const used = new Set(resolved.flatMap((g) => (g.op === "sketch" ? [] : references(g))));
  return resolved
    .filter((g) => g.op === "sketch")
    .map((f) => {
      const entities = entitiesOf(f);
      return { f, id: String(f.id), use: sketchUse(entities), open: isOpenChain(entities), used: used.has(String(f.id)) };
    });
}

/** The selected sketch first (if it qualifies), then the unused ones, newest first. */
function candidates(ctx: ToolCtx, ok: (s: SketchInfo) => boolean, not: (string | undefined)[] = []): SketchInfo[] {
  const all = sketchInfos(ctx.resolved).filter((s) => ok(s) && !not.includes(s.id));
  const picked = ctx.selected?.op === "sketch" ? all.find((s) => s.id === ctx.selected!.id) : undefined;
  return [...(picked ? [picked] : []), ...all.filter((s) => !s.used && s !== picked).reverse()];
}

/** A round number near a twentieth of the path's length, for a new circle sweep's diameter. */
function diameterFor(length: number): number {
  const d = length / 20;
  if (!Number.isFinite(d) || d <= 0) return 5;
  const step = d >= 10 ? 5 : d >= 2 ? 1 : 0.5;
  return Math.max(step, Math.round(d / step) * step);
}

/** New material in a part of several bodies starts a body of its own; a cut needs a body. */
function withOperation(ctx: ToolCtx, f: Raw, cut: boolean, verb: string): Raw | string {
  const bodies = ctx.bodies();
  if (cut) {
    if (bodies.length === 0) return `A ${verb} needs a solid to cut: make one first.`;
    return { ...f, operation: "remove" };
  }
  return bodies.length > 1 ? { ...f, newBody: nextBodyName(bodies) } : f;
}

/** The new sweep (or swept cut) from the selection and the sketches, or what to do first. */
export function sweepFeature(ctx: ToolCtx, cut: boolean): Raw | string {
  if (!ctx.doc) return "Fix the document first.";
  const id = ctx.nextId(cut ? "sweep_cut" : "sweep");
  const verb = cut ? "swept cut" : "sweep";
  let path: Raw | undefined;
  let length = 100;
  // Edges picked in the view are what the user means, unless a path sketch is the selected feature.
  const pickedEdges = ctx.selection.edges.length > 0 && !!ctx.view;
  const pathSketch = candidates(ctx, (s) => s.use === "path" && s.open).find((s) => !pickedEdges || s.id === ctx.selected?.id);
  if (pathSketch) {
    path = { sketch: pathSketch.id };
    length = chainLength(sketchChain(entitiesOf(pathSketch.f), "a path"));
  } else if (pickedEdges && ctx.view) {
    const s = edgesSelectorFor(ctx.view.edges, ctx.view.faces, ctx.selection.edges);
    if (!s.ok) return s.error;
    path = { edges: Array.isArray(s.selector) ? s.selector : [s.selector] };
    length = ctx.selection.edges.reduce((t, i) => t + (ctx.view!.edges[i]?.length ?? 0), 0);
  }
  const profile = candidates(ctx, (s) => s.use === "profile", [pathSketch?.id])[0];
  if (!path) {
    // Only closed sketches. Two of them: the longer one closed chain is the path (an O-ring's ring), the other the
    // profile swept round it; one: it is the path of a round section.
    const closed = candidates(ctx, (s) => s.use === "profile");
    if (closed.length === 0) return `Sketch the path (a chain of lines and arcs) and the profile on a plane across its start, or select model edges, then ${cut ? "Swept cut" : "Sweep"}.`;
    const loopLength = (s: SketchInfo) => {
      try {
        return chainLength(sketchChain(entitiesOf(s.f) as SketchEntity[], "a path"));
      } catch {
        return null;
      }
    };
    const pair = closed.slice(0, 2);
    const lengths = pair.map(loopLength);
    if (pair.length === 2 && (lengths[0] !== null || lengths[1] !== null)) {
      const k = lengths[1] !== null && (lengths[0] === null || lengths[1] > lengths[0]) ? 1 : 0;
      return withOperation(ctx, { id, op: "sweep", profile: pair[1 - k].id, path: { sketch: pair[k].id } }, cut, verb);
    }
    const ring = closed[0];
    if (lengths[0] === null) return `Sketch "${ring.id}" is not one closed chain to sweep round: sketch the path (a chain of lines and arcs), then ${cut ? "Swept cut" : "Sweep"}.`;
    return withOperation(ctx, { id, op: "sweep", circle: { diameter: diameterFor(lengths[0]) }, path: { sketch: ring.id } }, cut, verb);
  }
  const shape = profile ? { profile: profile.id } : { circle: { diameter: diameterFor(length) } };
  return withOperation(ctx, { id, op: "sweep", ...shape, path }, cut, verb);
}

/** The new helix sweep (a spring, a coil) about the selected axis, cylinder or circular edge, or Z. */
export function helixFeature(ctx: ToolCtx): Raw | string {
  if (!ctx.doc) return "Fix the document first.";
  const { selection, view } = ctx;
  let axis: Raw = { datum: "Z" };
  let radius = 10;
  if (view && (selection.edges.length + selection.faces.length + (selection.datums?.length ?? 0) > 0)) {
    const r = refFromSelection(selection, view, ["axis"], ctx.resolved);
    if (!r.ok) return `${r.error.replace(/,? then Use selected\.?$/, "")}: select an axis, a cylinder or a circular edge to wind about (or nothing, for the Z axis), then Helix.`;
    axis = r.ref as Raw;
    const face = selection.faces.length === 1 ? view.faces[selection.faces[0]] : undefined;
    const edge = selection.edges.length === 1 ? view.edges[selection.edges[0]] : undefined;
    // Wind round the outside of a boss, inside a hole.
    if (face?.cylinder) radius = face.cylinder.radius;
    else if (edge?.kind === "circle" && edge.radius) radius = edge.radius;
  }
  const profile = candidates(ctx, (s) => s.use === "profile")[0];
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const wire = Math.max(0.5, round(radius / 5));
  const helix = { axis, radius: round(radius), pitch: profile ? 5 : Math.max(5, round(wire * 2.5)), turns: 4 };
  const shape = ctx.selected?.op === "sketch" && profile?.id === ctx.selected.id ? { profile: profile.id } : { circle: { diameter: wire } };
  const f: Raw = { id: ctx.nextId("helix"), op: "sweep", ...shape, path: { helix } };
  // A coil round a part is a part of its own (choose "add" in Properties to join them).
  const bodies = ctx.bodies();
  return bodies.length > 0 ? { ...f, newBody: nextBodyName(bodies) } : f;
}

/** The new loft (or lofted cut) through the unused sections, or the newest two; or what to do first. */
export function loftFeature(ctx: ToolCtx, cut: boolean): Raw | string {
  if (!ctx.doc) return "Fix the document first.";
  const infos = sketchInfos(ctx.resolved).filter((s) => s.use === "profile" || s.use === "point");
  let sections = infos.filter((s) => !s.used);
  if (ctx.selected?.op === "sketch" && !sections.some((s) => s.id === ctx.selected!.id)) {
    const picked = infos.find((s) => s.id === ctx.selected!.id);
    if (picked) sections = [...sections, picked].sort((a, b) => infos.indexOf(a) - infos.indexOf(b));
  }
  if (sections.length < 2) sections = infos.filter((s) => s.use === "profile").slice(-2);
  if (sections.length < 2) return `Sketch two or more profiles on different planes (a plane feature offset from Top, say), then ${cut ? "Lofted cut" : "Loft"}.`;
  // A point can only be an end.
  const points = sections.filter((s) => s.use === "point");
  if (points.length > 2 || points.some((p) => p !== sections[0] && p !== sections[sections.length - 1])) sections = sections.filter((s) => s.use === "profile");
  if (sections.length < 2) return "A loft needs two or more closed profiles (a sketch with just a point may only end it).";
  return withOperation(ctx, { id: ctx.nextId(cut ? "loft_cut" : "loft"), op: "loft", profiles: sections.map((s) => s.id) }, cut, cut ? "lofted cut" : "loft");
}

/** The new rib on the selected (or newest unused) open sketch, or what to do first. */
export function ribFeature(ctx: ToolCtx): Raw | string {
  if (!ctx.doc) return "Fix the document first.";
  const bodies = ctx.bodies();
  if (bodies.length === 0) return "A rib stiffens a solid: make the part first, then sketch the rib's line across it.";
  const sketch = candidates(ctx, (s) => s.open)[0];
  if (!sketch) return "Sketch the rib's line (an open line or chain) on a plane through the part, e.g. a bracket's middle plane, then Rib.";
  const f: Raw = { id: ctx.nextId("rib"), op: "rib", sketch: sketch.id, thickness: 3 };
  return bodies.length > 1 ? { ...f, body: ctx.pickedBody() ?? bodies[bodies.length - 1] } : f;
}

const run = (make: (ctx: ToolCtx) => Raw | string) => (ctx: ToolCtx) => {
  const f = make(ctx);
  if (typeof f === "string") return ctx.notice(f);
  ctx.create(f);
};

const noBody = (ctx: ToolCtx) => (ctx.view && ctx.view.bodies.length === 0 ? "needs a solid to cut" : undefined);

export const tools: ToolDef[] = [
  {
    id: "tool.sweep",
    label: "Sweep",
    icon: "sweep",
    tab: "features",
    group: "shape",
    menu: SWEEP_MENU,
    title: "Add material: carry the profile sketch (or a round section) along the path sketch or the selected edges",
    hint: "A profile along a path",
    testId: "tool-sweep",
    run: run((c) => sweepFeature(c, false)),
  },
  {
    id: "tool.sweepCut",
    label: "Swept cut",
    icon: "sweepCut",
    tab: "features",
    group: "shape",
    menu: SWEEP_MENU,
    title: "Remove material: carry a profile (or a round section) along a path, cutting a groove",
    hint: "Cut a groove along a path",
    testId: "tool-sweep-cut",
    disabled: (ctx) => (noBody(ctx) ? "A swept cut needs a solid to cut" : undefined),
    run: run((c) => sweepFeature(c, true)),
  },
  {
    id: "tool.helix",
    label: "Helix (spring)",
    icon: "helix",
    tab: "features",
    group: "shape",
    menu: SWEEP_MENU,
    title: "A spring or coil: a round wire (or the selected profile) along a helix about the selected axis, cylinder or circular edge, or about Z",
    hint: "A wire wound along a helix",
    testId: "tool-helix",
    run: run(helixFeature),
  },
  {
    id: "tool.loft",
    label: "Loft",
    icon: "loft",
    tab: "features",
    group: "shape",
    menu: LOFT_MENU,
    title: "Add material: a solid through the profiles sketched on several planes, in order",
    hint: "Through profiles in order",
    testId: "tool-loft",
    run: run((c) => loftFeature(c, false)),
  },
  {
    id: "tool.loftCut",
    label: "Lofted cut",
    icon: "loftCut",
    tab: "features",
    group: "shape",
    menu: LOFT_MENU,
    title: "Remove material: cut a solid lofted through the profiles in order",
    hint: "Cut through profiles",
    testId: "tool-loft-cut",
    disabled: (ctx) => (noBody(ctx) ? "A lofted cut needs a solid to cut" : undefined),
    run: run((c) => loftFeature(c, true)),
  },
  {
    id: "tool.rib",
    label: "Rib",
    icon: "rib",
    tab: "features",
    group: "dress",
    title: "Stiffen the part: a web from the selected (or latest) open sketch line out to the walls around it",
    testId: "tool-rib",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "A rib stiffens a solid: make one first" : undefined),
    run: run(ribFeature),
  },
];
