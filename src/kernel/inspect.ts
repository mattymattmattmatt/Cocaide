// Read-only questions about a rebuilt part, shared by every kernel host: the
// MCP session (Node), the right-click ask in the browser (kernel worker) and
// tests. Plain data in, plain data out.

import type { EdgeSelector, FaceSelector } from "../doc/types";
import { Checker, isObject, validateEdgeSelector, validateFaceSelector } from "../doc/validate";
import { render, type Camera, type Image } from "../render/raster";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Measurements } from "./measure";
import { tessellate } from "./mesh";
import { scoped, type OC } from "./oc";
import type { FeatureStatus } from "./rebuild";
import { selectEdges, selectFaces } from "./selectors";
import { describeEdges, describeFaces, type EdgeInfo, type FaceInfo } from "./topology";

export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6 + 0;
}

/** A face as the agent sees it. */
export function faceSummary(f: FaceInfo): Record<string, unknown> {
  const out: Record<string, unknown> = { type: f.type, area: round6(f.area), centroid: f.centroid.map(round6) };
  if (f.normal) out.normal = f.normal.map(round6);
  if (f.offset !== undefined) out.offset = round6(f.offset);
  if (f.cylinder) {
    out.radius = round6(f.cylinder.radius);
    out.axis = f.cylinder.axis.map(round6);
    out.concave = f.cylinder.concave;
  }
  return out;
}

/** An edge as the agent sees it. */
export function edgeSummary(e: EdgeInfo): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: e.kind, length: round6(e.length), start: e.start.map(round6), end: e.end.map(round6) };
  if (e.radius !== undefined) out.radius = round6(e.radius);
  if (e.center) out.center = e.center.map(round6);
  return out;
}

/** The whole-part numbers an agent needs, rounded. */
export function measurementSummary(m: Measurements): Record<string, unknown> {
  return {
    units: "mm",
    volume: round6(m.volume),
    surfaceArea: round6(m.surfaceArea),
    boundingBox: m.boundingBox && { min: m.boundingBox.min.map(round6), max: m.boundingBox.max.map(round6), size: m.boundingBox.size.map(round6) },
    mass: { kg: round6(m.mass.kg), material: m.mass.material },
    holeCount: m.holeCount,
    holeDiameters: m.holeDiameters.map(round6),
    solids: m.solids,
    faces: m.faces,
  };
}

interface Built {
  features: FeatureStatus[];
  errors: string[];
}

/** Features that fail after an edit but did not before it (new ones included), and new header errors. */
export function newFailures(before: Built, after: Built): string[] {
  const failedBefore = new Set(before.features.filter((f) => !f.ok).map((f) => f.id));
  const out = after.features.filter((f) => !f.ok && !failedBefore.has(f.id)).map((f) => f.error ?? `${f.id}: failed`);
  const featureErrors = new Set(after.features.flatMap((f) => (f.error ? f.error.split("\n") : [])));
  const headerBefore = new Set(before.errors);
  for (const e of after.errors) if (!featureErrors.has(e) && !headerBefore.has(e)) out.push(e);
  return out;
}

export type Picked = { faces: FaceInfo[]; edges?: undefined } | { edges: EdgeInfo[]; faces?: undefined };

/** Runs a face or edge selector (raw JSON, validated here) on a solid. */
export function selectOn(oc: OC, solid: TopoDS_Shape, selector: unknown, tool: string): Picked | string {
  const c = new Checker(tool);
  const isEdge = isObject(selector) && selector.type === "edge";
  const sel = isEdge ? validateEdgeSelector(selector, "selector", c) : validateFaceSelector(selector, "selector", c);
  if (!sel || c.errors.length) return c.errors.join("; ") || `${tool}: selector: not a selector`;
  return scoped((s) => {
    const faces = describeFaces(oc, s, solid);
    if (!isEdge) return { faces: selectFaces(faces.infos, sel as FaceSelector).matches };
    const edges = describeEdges(oc, s, solid, faces.faces).infos;
    const r = selectEdges(edges, faces.infos, sel as EdgeSelector, "selector");
    if (r.error) return `${tool}: ${r.error}`;
    return { edges: r.matches };
  });
}

/** Faces and edges of a solid, as plain data. */
export function topologyOf(oc: OC, solid: TopoDS_Shape): { faces: FaceInfo[]; edges: EdgeInfo[] } {
  return scoped((s) => {
    const f = describeFaces(oc, s, solid);
    return { faces: f.infos, edges: describeEdges(oc, s, solid, f.faces).infos };
  });
}

export interface ShotOptions {
  camera: Camera;
  width?: number;
  height?: number;
  highlightFaces?: number[];
  highlightEdges?: number[];
  hiddenEdges?: boolean;
  /** Zoom to the highlighted faces and edges instead of the whole part. */
  frame?: boolean;
}

/** A shaded view of the solid. Highlighted faces are also outlined over everything, so a hidden or edge-on face still shows. */
export function shotOf(oc: OC, solid: TopoDS_Shape, opts: ShotOptions): Image {
  const { edges } = topologyOf(oc, solid);
  let highlightEdges = opts.highlightEdges;
  if (opts.highlightFaces?.length) {
    const set = new Set(opts.highlightFaces);
    highlightEdges = [...(highlightEdges ?? []), ...edges.filter((e) => !e.seam && e.faces.some((f) => set.has(f))).map((e) => e.index)];
  }
  return render(tessellate(oc, solid), {
    camera: opts.camera,
    width: opts.width,
    height: opts.height,
    highlightFaces: opts.highlightFaces,
    highlightEdges,
    hiddenEdges: opts.hiddenEdges,
    skipEdges: edges.filter((e) => e.seam).map((e) => e.index),
    frame: opts.frame ? { faces: opts.highlightFaces, edges: opts.highlightEdges } : undefined,
  });
}
