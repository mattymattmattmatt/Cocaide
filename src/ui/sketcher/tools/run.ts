// Running a sketch tool, the same way for every tool in the registry: where a
// click lands (on a point, a line's middle, a curve, level or plumb with the
// click before, the grid), the preview, and the shape a tool's clicks make,
// with each click's inference turned into a relation. Pure: SketchCanvas
// calls it on every pointer event, and the unit tests drive tools through it
// exactly as clicks would.

import type { Constraint, SketchEntity, Vec2 } from "../../../doc/types";
import { inferOrientation, inferPoint } from "../draft";
import { SKETCH_TOOLS } from "./index";
import { asConstruction } from "./shapes";
import type { Click, ClickRole, FlyoutDef, IdMaker, SketchToolDef, ToolContext, ToolOptions } from "./types";

export { SKETCH_TOOLS };

export function toolByName(name: string, tools: SketchToolDef[] = SKETCH_TOOLS): SketchToolDef | undefined {
  return tools.find((t) => t.name === name);
}

/** One place on the toolbar: a tool's own button, or a flyout of the tools that share one. */
export type SketchToolbarEntry = { kind: "tool"; tool: SketchToolDef } | { kind: "flyout"; flyout: FlyoutDef; tools: SketchToolDef[] };

/** The toolbar's buttons in registry order; tools that share a flyout become one where the first of them is. */
export function toolbarEntries(tools: SketchToolDef[] = SKETCH_TOOLS): SketchToolbarEntry[] {
  const out: SketchToolbarEntry[] = [];
  for (const t of tools) {
    const shared = t.flyout ? out.find((e): e is Extract<SketchToolbarEntry, { kind: "flyout" }> => e.kind === "flyout" && e.flyout.id === t.flyout!.id) : undefined;
    if (shared) shared.tools.push(t);
    else out.push(t.flyout ? { kind: "flyout", flyout: t.flyout, tools: [t] } : { kind: "tool", tool: t });
  }
  return out;
}

/** A tool's options: each one stored if it is valid, else its default. Numbers are clamped (and rounded where whole). */
export function optionValues(def: SketchToolDef, stored: ToolOptions = {}): ToolOptions {
  const out: ToolOptions = {};
  for (const o of def.options ?? []) {
    const v = stored[o.key];
    if (o.kind === "number") {
      const n = typeof v === "number" && Number.isFinite(v) ? v : o.default;
      const clamped = Math.min(o.max, Math.max(o.min, n));
      out[o.key] = o.integer ? Math.round(clamped) : clamped;
    } else {
      out[o.key] = typeof v === "string" && o.choices.some((c) => c.value === v) ? v : o.default;
    }
  }
  return out;
}

/** Fresh ids beside the sketch's: l1, l2, … the first free of each prefix, never one handed out twice. */
export function idMaker(entities: { id: string }[]): IdMaker {
  const used = new Set(entities.map((e) => e.id));
  return (prefix) => {
    for (let n = 1; ; n++) {
      const id = `${prefix}${n}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
}

/** Ids for a preview's entities: never a real entity's, so nothing mistakes the rubber band for the sketch. */
export function previewIds(): IdMaker {
  let n = 0;
  return (prefix) => `preview-${prefix}${++n}`;
}

export interface SnapContext {
  entities: SketchEntity[];
  /** How near counts, in mm (a few pixels at the current zoom). */
  tol: number;
  /** The grid step, or null when the grid is off. */
  grid: number | null;
  options: ToolOptions;
  /**
   * The model's edges in the sketch, as stand-in entities ("@e12"): a click
   * snaps to their ends, middles, centres and onto them too, and the relation
   * it infers names the stand-in (the sketcher turns it into a reference).
   */
  model?: SketchEntity[];
}

/**
 * Where a click lands, as SOLIDWORKS infers it: on an end, centre, sketch
 * point or the origin; on a model vertex or centre; on a line's middle; on a
 * line, circle or arc (the sketch's, then the model's); the tool's own
 * inference (a polygon side level); level with or plumb above the click it is
 * drawn from; else the grid.
 */
export function snapClick(def: SketchToolDef, pts: Vec2[], p: Vec2, ctx: SnapContext): Click {
  const sketch = inferPoint(ctx.entities, p, ctx.tol);
  const model = ctx.model?.length && !sketch?.ref ? inferPoint(ctx.model, p, ctx.tol) : null;
  const inferred = sketch?.ref ? sketch : model?.ref && model.ref !== "origin" ? model : (sketch ?? model);
  if (inferred) return inferred;
  const own = def.snap?.(pts, p, ctx.tol, ctx.options);
  if (own) return { p: own.p, ref: null, ...(own.orient ? { orient: own.orient } : {}) };
  const grid = (x: number) => (ctx.grid ? roundTo(x, ctx.grid) : x);
  const from = def.alignTo?.(pts);
  const o = from ? inferOrientation(from, p, ctx.tol * 0.7) : null;
  if (o && from) return { p: o.type === "horizontal" ? [grid(p[0]), from[1]] : [from[0], grid(p[1])], ref: null, orient: o.type };
  return { p: [grid(p[0]), grid(p[1])], ref: null };
}

export function roundTo(x: number, step: number): number {
  const r = Math.round(x / step) * step;
  return Math.round(r * 1e9) / 1e9;
}

/**
 * The relations the clicks inferred, by what the new geometry has at each:
 * its point there goes coincident with the point snapped to, or on the curve
 * (or at the middle of the line) it landed on; a curve through a snapped
 * point gets the point on it; a line whose middle was clicked on a point gets
 * that point as its midpoint.
 */
export function clickRelations(roles: ClickRole[], clicks: Click[]): Constraint[] {
  const out: Constraint[] = [];
  clicks.forEach((c, i) => {
    const role = roles[i];
    if (!role) return;
    if ("point" in role) {
      if (c.ref) out.push({ type: "coincident", points: [role.point, c.ref] });
      else if (c.on) out.push({ type: c.on.type, point: role.point, entity: c.on.entity });
    } else if ("on" in role) {
      if (c.ref) out.push({ type: "pointOn", point: c.ref, entity: role.on });
    } else if (c.ref) {
      out.push({ type: "midpoint", point: c.ref, entity: role.middle });
    }
  });
  return out;
}

/** What placing a tool's last click makes. */
export interface Placement {
  entities: SketchEntity[];
  /** The shape's own relations: always kept. */
  relations: Constraint[];
  /** What the clicks inferred, then the tool's own inferences: each kept only where it adds something. */
  inferred: Constraint[];
  /** A chain tool's next start. */
  next?: Click;
  /** The point at the first click: where a chain started, so clicking it again closes the chain. */
  first: string | null;
}

/** The shape from every click, with the relations that hold it and the ones its clicks inferred; null when it makes nothing. */
export function place(def: SketchToolDef, clicks: Click[], options: ToolOptions, ctx: ToolContext, construction = false): Placement | null {
  const built = def.build(clicks, optionValues(def, options), idMaker(ctx.entities), ctx);
  if (!built) return null;
  const role = built.roles[0];
  return {
    entities: construction ? asConstruction(built.entities) : built.entities,
    relations: built.relations,
    inferred: [...clickRelations(built.roles, clicks), ...(built.inferred ?? [])],
    next: built.next,
    first: role && "point" in role ? role.point : null,
  };
}

/** The rubber band for the clicks so far, the pointer's snapped place last. */
export function previewOf(def: SketchToolDef, clicks: Click[], options: ToolOptions, ctx: ToolContext, construction = false): SketchEntity[] {
  const values = optionValues(def, options);
  const ids = previewIds();
  const shapes = def.preview ? def.preview(clicks, values, ids, ctx) : clicks.length === def.clicks ? (def.build(clicks, values, ids, ctx)?.entities ?? []) : [];
  return construction ? asConstruction(shapes) : shapes;
}
