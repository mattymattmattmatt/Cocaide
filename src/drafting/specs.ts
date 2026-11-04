// What the kernel projects for a drawing (Phase Q): one ViewSpec per view
// that needs its own projection, parents first. A detail view has none: it
// is a part of its parent's projection, enlarged (`projectionOf`).

import { allViews, parseGeoRef, viewKind } from "../doc/drawing";
import type { Drawing, DrawingView } from "../doc/types";
import type { ViewSpec } from "../kernel/drawingViews";
import { frameFrom } from "./views";

/** The view whose projection a view draws: itself, or for a detail its nearest ancestor that is not a detail. */
export function projectionOf(views: Map<string, DrawingView>, id: string): string {
  let v = views.get(id);
  const seen = new Set<string>();
  while (v && viewKind(v) === "detail" && v.parent && !seen.has(v.id)) {
    seen.add(v.id);
    v = views.get(v.parent);
  }
  return v?.id ?? id;
}

/** The views in an order where each comes after its parent (a view whose parent is missing comes as it is). */
export function parentsFirst(views: DrawingView[]): DrawingView[] {
  const byId = new Map(views.map((v) => [v.id, v]));
  const out: DrawingView[] = [];
  const placed = new Set<string>();
  const visit = (v: DrawingView, path: Set<string>) => {
    if (placed.has(v.id) || path.has(v.id)) return;
    path.add(v.id);
    const p = v.parent ? byId.get(v.parent) : undefined;
    if (p) visit(p, path);
    placed.add(v.id);
    out.push(v);
  };
  for (const v of views) visit(v, new Set());
  return out;
}

/** The kernel's specs for every view of the drawing that has a projection of its own. */
export function viewSpecs(drawing: Drawing): ViewSpec[] {
  const views = allViews(drawing);
  const byId = new Map(views.map((v) => [v.id, v]));
  const projectionOfSheet = new Map<string, "third" | "first">();
  for (const s of drawing.sheets) for (const v of s.views) projectionOfSheet.set(v.id, s.projection);
  const out: ViewSpec[] = [];
  for (const v of parentsFirst(views)) {
    const kind = viewKind(v);
    if (kind === "detail") continue;
    const parent = v.parent ? projectionOf(byId, v.parent) : undefined;
    const common: Partial<ViewSpec> = {
      ...(v.bodies ? { bodies: v.bodies } : {}),
      ...(v.brokenOut?.length ? { brokenOut: v.brokenOut } : {}),
      ...(v.display === "shaded" || v.display === "shadedEdges" ? { shaded: true } : {}),
    };
    if (kind === "model") {
      if (v.orientation) out.push({ id: v.id, frame: { frame: frameFrom(v.orientation.eye, v.orientation.up ?? [0, 0, 1]) }, ...common });
      else out.push({ id: v.id, look: v.look ?? "front", ...common });
    } else if (!parent || !byId.has(parent)) {
      // Its parent is gone: the checks say so; nothing to project.
      continue;
    } else if (kind === "projected") {
      out.push({ id: v.id, frame: { parent, projected: v.direction ?? "right", projection: projectionOfSheet.get(v.id) ?? "third" }, ...common });
    } else if (kind === "section" && v.line && v.line.length >= 2) {
      out.push({
        id: v.id,
        frame: { parent, section: v.line, ...(v.flip ? { flip: true } : {}) },
        section: { line: v.line, ...(v.flip ? { flip: true } : {}), ...(v.half ? { half: true } : {}), ...(v.aligned ? { aligned: true } : {}), ...(v.depth !== undefined ? { depth: v.depth } : {}) },
        ...common,
      });
    } else if (kind === "auxiliary") {
      const g = parseGeoRef(v.edge);
      if (g && g.form === "e") out.push({ id: v.id, frame: { parent, auxiliary: g.key, ...(v.flip ? { flip: true } : {}) }, ...common });
    }
  }
  return out;
}
