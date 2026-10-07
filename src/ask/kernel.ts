// What the right-click ask needs from the kernel, as an async interface. In
// the browser it is served by the kernel worker; in Node (tests) by
// LocalKernel directly. Both run the same code (LocalKernel).

import type { EdgeInfo, FaceInfo, FeatureStatus, Measurements } from "../kernel";
import { measurementSummary, newFailures, selectOn, shotOf, topologyOf, type ShotOptions } from "../kernel/inspect";
import { rebuild, type RebuildResult } from "../kernel/rebuild";
import type { OC } from "../kernel/oc";
import { encodePNG } from "../render/png";

export interface CheckResult {
  ok: boolean;
  name: string;
  errors: string[];
  features: FeatureStatus[];
  measurements: Measurements | null;
}

export interface PartTopology {
  faces: FaceInfo[];
  edges: EdgeInfo[];
  /** Per face: the feature that first made it. */
  faceOrigins: (string | null)[];
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

export interface KernelPort {
  check(doc: unknown): Promise<CheckResult>;
  topology(doc: unknown): Promise<PartTopology | null>;
  select(doc: unknown, selector: unknown): Promise<SelectResult>;
  screenshot(doc: unknown, opts: ShotOptions): Promise<Shot>;
}

export type KernelMethod = keyof KernelPort;

export { measurementSummary, newFailures };

/** The port, served in-process from an OCCT instance. Keeps the last rebuild. */
export class LocalKernel implements KernelPort {
  private last: { key: string; provenance: boolean; result: RebuildResult } | null = null;

  constructor(private readonly oc: () => OC) {}

  /** Drops the cached rebuild (before the kernel is recycled). */
  reset() {
    this.last?.result.dispose();
    this.last = null;
  }

  private built(doc: unknown, provenance = false): RebuildResult {
    const key = JSON.stringify(doc);
    if (this.last && this.last.key === key && (this.last.provenance || !provenance)) return this.last.result;
    this.reset();
    const result = rebuild(doc, this.oc(), { provenance });
    this.last = { key, provenance, result };
    return result;
  }

  async check(doc: unknown): Promise<CheckResult> {
    const r = this.built(doc);
    return { ok: r.ok, name: r.name, errors: r.errors, features: r.features, measurements: r.measurements };
  }

  async topology(doc: unknown): Promise<PartTopology | null> {
    const r = this.built(doc, true);
    if (!r.solid) return null;
    return { ...topologyOf(this.oc(), r.solid), faceOrigins: r.faceOrigins ?? [] };
  }

  async select(doc: unknown, selector: unknown): Promise<SelectResult> {
    const r = this.built(doc);
    if (!r.solid) return { ok: false, error: "there is no solid yet" };
    const picked = selectOn(this.oc(), r.solid, selector, "selector");
    if (typeof picked === "string") return { ok: false, error: picked };
    return picked.faces
      ? { ok: true, kind: "faces", indices: picked.faces.map((f) => f.index), faces: picked.faces }
      : { ok: true, kind: "edges", indices: picked.edges.map((e) => e.index), edges: picked.edges };
  }

  async screenshot(doc: unknown, opts: ShotOptions): Promise<Shot> {
    const r = this.built(doc);
    if (!r.solid) throw new Error("there is no solid to show");
    const img = shotOf(this.oc(), r.solid, opts);
    return { png: await encodePNG(img), width: img.width, height: img.height };
  }
}
