// What the right-click ask needs from the kernel, as an async interface. In
// the browser it is served by the kernel worker; in Node (tests) by
// LocalKernel directly. Both run the same code (LocalKernel).

import { projectAllViews, type AssemblyPartInfo } from "../kernel/assemblyViews";
import { geometryKey } from "../doc/drawing";
import type { SketchEntity } from "../doc/types";
import type { Datum } from "../features/datum";
import type { EdgeInfo, FaceInfo, FeatureStatus, Measurements } from "../kernel";
import { specKey, type KeyCache, type ProjectedView, type ViewSpec } from "../kernel/drawingViews";
import { measurementSummary, newFailures, selectOn, shotData, shotOf, topologyOf, type ShotOptions } from "../kernel/inspect";
import { rebuild, type HoleRecord, type RebuildResult } from "../kernel/rebuild";
import { inspectQuery, type InspectQuery, type InspectResult } from "../kernel/agentQueries";
import { flatQuery, type FlatQuery, type FlatResult } from "../kernel/flat";
import type { OC } from "../kernel/oc";
import { encodePNG } from "../render/png";

export interface CheckResult {
  ok: boolean;
  name: string;
  errors: string[];
  features: FeatureStatus[];
  measurements: Measurements | null;
  /** The plane, axis and point features that built, by id: where each is now. */
  datums?: Record<string, Datum>;
  /**
   * The sketches that reference the model, by id: their entities as the
   * rebuild solved them (references projected where the model is now, and
   * what is tied to them moved with them). The document keeps the numbers it
   * was given; these are where the geometry is.
   */
  solvedSketches?: Record<string, SketchEntity[]>;
}

export interface PartTopology {
  faces: FaceInfo[];
  edges: EdgeInfo[];
  /** Per face: the feature that first made it. */
  faceOrigins: (string | null)[];
  holes?: { diameter: number; thread?: { major: number; designation: string } }[];
}

export type SelectResult =
  | { ok: true; kind: "faces"; indices: number[]; faces: FaceInfo[] }
  | { ok: true; kind: "edges"; indices: number[]; edges: EdgeInfo[] }
  | { ok: false; error: string };

export interface Shot {
  png: Uint8Array;
  width: number;
  height: number;
}

/** What a drawing needs from the rebuild: the views, and where the holes were drilled. */
export interface DrawingGeometry {
  views: ProjectedView[];
  holes: HoleRecord[];
  /** The assembly's parts as the BOM lists them (mass, material, name), by part key: when a view shows the assembly. */
  assemblyParts?: Record<string, AssemblyPartInfo>;
}

export interface KernelPort {
  check(doc: unknown): Promise<CheckResult>;
  topology(doc: unknown): Promise<PartTopology | null>;
  select(doc: unknown, selector: unknown): Promise<SelectResult>;
  screenshot(doc: unknown, opts: ShotOptions): Promise<Shot>;
  /**
   * The part projected for a drawing's views (src/kernel/drawingViews.ts ViewSpec: a look, or a frame from a
   * parent, a section, broken-out sections, bodies, shading). A view made from another comes after it. Each
   * view is kept per rebuild: the same spec again is not projected again. Null when nothing built.
   */
  project(doc: unknown, views: ViewSpec[]): Promise<DrawingGeometry | null>;
  /** The AI tools' other questions: closest points, sketch frames, mass (src/kernel/agentQueries.ts). */
  inspect(doc: unknown, query: InspectQuery): Promise<InspectResult>;
  /** Flat outlines for DXF: a planar face's, or every flat plate's (src/kernel/flat.ts). */
  flat(doc: unknown, query: FlatQuery): Promise<FlatResult>;
}

export type { InspectQuery, InspectResult };
export type { FlatQuery, FlatResult };

export type KernelMethod = keyof KernelPort;

export { measurementSummary, newFailures };

/** The port, served in-process from an OCCT instance. Keeps the last rebuild. */
export class LocalKernel implements KernelPort {
  private last: { key: string; provenance: boolean; result: RebuildResult } | null = null;
  /** The last rebuild's views, by spec (and their parents'): a sheet edit doesn't project the part again. */
  private projections = new Map<string, ProjectedView>();
  /** The assembly's parts' info (mass, material, name), by the assembly's key. */
  private assemblyParts = new Map<string, Record<string, AssemblyPartInfo>>();
  /** The last rebuild's bodies' keyed edges. */
  private keys: KeyCache = new Map();

  constructor(private readonly oc: () => OC) {}

  /** Drops the cached rebuild (before the kernel is recycled). */
  reset() {
    this.last?.result.dispose();
    this.last = null;
    this.projections.clear();
    this.assemblyParts.clear();
    this.keys = new Map();
  }

  /** The rebuild of the document, kept until the next one (the worker shares it). */
  built(doc: unknown, provenance = false): RebuildResult {
    // The drawing doesn't change the part: a sheet edit reuses the rebuild.
    const key = geometryKey(doc);
    if (this.last && this.last.key === key && (this.last.provenance || !provenance)) return this.last.result;
    this.reset();
    const result = rebuild(doc, this.oc(), { provenance });
    this.last = { key, provenance, result };
    return result;
  }

  async check(doc: unknown): Promise<CheckResult> {
    const r = this.built(doc);
    const solved = r.sketches.filter((k) => k.ok && k.entities.some((e) => e.ref));
    return {
      ok: r.ok,
      name: r.name,
      errors: r.errors,
      features: r.features,
      measurements: r.measurements,
      datums: r.datums,
      ...(solved.length ? { solvedSketches: Object.fromEntries(solved.map((k) => [k.id, k.entities])) } : {}),
    };
  }

  async topology(doc: unknown): Promise<PartTopology | null> {
    const r = this.built(doc, true);
    if (!r.solid) return null;
    const topo = topologyOf(this.oc(), r.solid, r.bodies);
    r.label(topo);
    const holes = (r as unknown as { holes?: PartTopology["holes"] }).holes;
    return { ...topo, faceOrigins: r.faceOrigins ?? [], ...(holes ? { holes } : {}) };
  }

  async select(doc: unknown, selector: unknown): Promise<SelectResult> {
    const r = this.built(doc);
    if (!r.solid) return { ok: false, error: "there is no solid yet" };
    const picked = selectOn(this.oc(), r.solid, selector, "selector", r.bodies, (topo) => r.label(topo));
    if (typeof picked === "string") return { ok: false, error: picked };
    return picked.faces
      ? { ok: true, kind: "faces", indices: picked.faces.map((f) => f.index), faces: picked.faces }
      : { ok: true, kind: "edges", indices: picked.edges.map((e) => e.index), edges: picked.edges };
  }

  async project(doc: unknown, views: ViewSpec[]): Promise<DrawingGeometry | null> {
    return this.projectNow(doc, views);
  }

  /** The views projected now (project, for a caller that can't wait): from the cache where nothing they show changed. */
  projectNow(doc: unknown, views: ViewSpec[]): DrawingGeometry | null {
    const r = this.built(doc);
    const assembled = views.some((v) => v.source);
    if (!r.solid && !assembled) return null;
    // A view's key is its spec and its parent's key: a view from a parent is projected again when the parent changes.
    // An assembly view's is the assembly too (the part's rebuild doesn't see it).
    const asmKey = assembled ? assemblyKey(doc) : "";
    const keyOf = new Map<string, string>();
    for (const v of views) {
      const parent = v.frame && "parent" in v.frame ? keyOf.get(v.frame.parent) : undefined;
      keyOf.set(v.id, `${specKey(v)}|${parent ?? ""}${v.source ? `|${asmKey}` : ""}`);
    }
    const known = new Map<string, ProjectedView>();
    for (const v of views) {
      const hit = this.projections.get(keyOf.get(v.id)!);
      if (hit) known.set(v.id, { ...hit, id: v.id });
    }
    // The assembly's views from the cache too, while the assembly, its parts' shapes and the views are as they were:
    // only the ones that changed are projected again (their parts' info is kept with the assembly's key).
    const fresh = views.filter((v) => !known.has(v.id));
    const cachedParts = assembled ? this.assemblyParts.get(asmKey) : undefined;
    const needParts = assembled && !cachedParts && !fresh.some((v) => v.source);
    const ask = needParts ? [...fresh, ...views.filter((v) => v.source && !fresh.includes(v)).slice(0, 1)] : fresh;
    const all = ask.length ? projectAllViews(this.oc(), doc as Record<string, unknown>, parentsOf(views, ask), r.solid ? { bodies: r.bodies, label: (topo) => r.label(topo) } : null, this.keys, known) : { views: [] as ProjectedView[] };
    for (const pv of all.views) known.set(pv.id, pv);
    const out = views.map((v) => known.get(v.id)).filter((x): x is ProjectedView => !!x);
    // Keep the newest few hundred; a long session of edits doesn't grow it without end.
    for (const pv of all.views) this.projections.set(keyOf.get(pv.id)!, pv);
    while (this.projections.size > 200) this.projections.delete(this.projections.keys().next().value!);
    const parts = "parts" in all && all.parts ? all.parts : cachedParts;
    if (assembled && parts) {
      this.assemblyParts.set(asmKey, parts);
      while (this.assemblyParts.size > 8) this.assemblyParts.delete(this.assemblyParts.keys().next().value!);
    }
    return { views: out, holes: r.holes, ...(parts ? { assemblyParts: parts } : {}) };
  }

  async inspect(doc: unknown, query: InspectQuery): Promise<InspectResult> {
    return inspectQuery(this.oc(), this.built(doc), doc, query);
  }

  async flat(doc: unknown, query: FlatQuery): Promise<FlatResult> {
    return flatQuery(this.oc(), this.built(doc), query);
  }

  async screenshot(doc: unknown, opts: ShotOptions): Promise<Shot> {
    const r = this.built(doc);
    if (!r.solid) throw new Error("there is no solid to show");
    const data = shotData(this.oc(), r, doc);
    const img = shotOf(this.oc(), r.solid, { ...opts, cached: data, faceColors: opts.faceColors ?? data.colors });
    return { png: await encodePNG(img), width: img.width, height: img.height };
  }
}

/**
 * What an assembly view depends on: the components and their places, the
 * explode, each part's shape (not its drawing or its notes) and the
 * document's own shape (the part "self" is it).
 */
function assemblyKey(doc: unknown): string {
  const d = doc as { assembly?: { parts?: Record<string, unknown> } & Record<string, unknown> };
  const asm = d.assembly;
  if (!asm) return "null";
  const parts = Object.fromEntries(Object.entries(asm.parts ?? {}).map(([k, p]) => [k, p && typeof p === "object" && "features" in (p as object) ? geometryKey(p) : p]));
  return JSON.stringify({ ...asm, parts, self: geometryKey(doc) });
}

/** The views asked for, with the parents they are projected from (a section or a projected view needs its parent's frame). */
function parentsOf(all: ViewSpec[], ask: ViewSpec[]): ViewSpec[] {
  const byId = new Map(all.map((v) => [v.id, v]));
  const out = new Set<ViewSpec>();
  const add = (v: ViewSpec | undefined) => {
    if (!v || out.has(v)) return;
    const parent = v.frame && "parent" in v.frame ? byId.get(v.frame.parent) : undefined;
    add(parent);
    out.add(v);
  };
  for (const v of ask) add(v);
  return all.filter((v) => out.has(v));
}
