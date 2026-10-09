// The feature-op registry, kernel layer: how a registry op builds. Its
// <op>/kernel.ts exports `kernel: KernelOp<XFeature>`, listed in
// kernelIndex.ts; rebuild() runs it with a RebuildCtx, the rebuild's state
// and tools, when the feature's turn comes. Imported only by the kernel.
//
// A KernelOp builds inside its own scoped((s) => ...) and finishes through
// ctx.commit, which checks every changed body is still material, copies the
// shapes out of the scope and records face provenance: a feature is applied
// whole or not at all. It fails by throwing OpError with a message that says
// what to fix; the rebuild prefixes it with the feature id and carries on.

import type { gp_Trsf, TopoDS_Shape } from "replicad-opencascadejs";
import type { SketchFeature } from "../doc/types";
import type { ValidationResult } from "../doc/validate";
import type { DescribedPart } from "../kernel/bodies";
import type { OC, Scope } from "../kernel/oc";
import { OpError, type SketchProfile } from "../kernel/ops";
import type { HoleRecord, MemberLine, RebuildOptions, Seed } from "../kernel/rebuild";
import type { Datum } from "./datum";
import { KERNEL_DEFS } from "./kernelIndex";

/** The holes drilled so far, and the bodies each is in: a drawing calls them out, so ops that move or copy bodies keep them in step. */
export interface HoleLedger {
  /** A hole drilled into these bodies. */
  record(h: HoleRecord, bodies: Iterable<string>): void;
  /** The holes in any of these bodies (the records themselves: change them in place when the bodies move or scale). */
  inBodies(names: readonly string[]): HoleRecord[];
  /** The bodies a hole is in. */
  bodiesOf(h: HoleRecord): ReadonlySet<string>;
  /** The holes a feature drilled. */
  ofFeature(id: string): HoleRecord[];
  /** These bodies were copied (body -> its copy): each hole in them is there twice as often. */
  copied(map: Map<string, string>): void;
  /** The holes in any of `from` are in `to` too (a body merged into another, or split off it). */
  alsoIn(from: readonly string[], to: string): void;
  /** These bodies are gone: a hole is gone with the last body it was in. */
  gone(names: readonly string[]): void;
}

/** The bodies that are members (lengths of stock), with the line each is measured along: the cut list. */
export interface MemberLedger {
  get(body: string): MemberLine | undefined;
  set(body: string, line: MemberLine): void;
  /** A copy of a member body (`to`), its line carried by the same transforms. */
  copy(s: Scope, from: string, to: string, steps: gp_Trsf[], id?: string): void;
  /** The body is no longer a length of stock (combined, scaled, deleted). */
  drop(body: string): void;
}

/** One instance of a pattern-like op: a label for messages ("instance 3") and its transform. */
export interface Instance {
  label: string;
  trsf: gp_Trsf;
}

/** What rebuild() gives a registry op: the part as it stands at the feature's place in the history, and how to change it. */
export interface RebuildCtx {
  oc: OC;
  /** The validated document (its features, weldment profiles, nodes, parameters). */
  v: ValidationResult;
  opts: RebuildOptions;
  /** The bodies so far, by name, in the order they were made. Change them only through commit. */
  bodies: ReadonlyMap<string, TopoDS_Shape>;
  /** A body, or OpError naming the bodies there are. */
  need(name: string): TopoDS_Shape;
  /** The listed bodies (each must exist), or every body when the list is null or absent. */
  targets(listed?: readonly string[] | null): [string, TopoDS_Shape][];
  /**
   * Replaces or adds the changed bodies and deletes `removed`, all or none.
   * Each changed body must still hold a solid with volume. The shapes may
   * belong to the caller's scope: commit copies them out. Call it once, last.
   */
  commit(changed: Map<string, TopoDS_Shape>, removed?: string[]): void;
  /** Every face and edge of the part (or faces only), labelled with its body, for selectFaces / selectEdges. Tracked in `s`. */
  part(s: Scope, withEdges?: boolean): DescribedPart;
  /** The listed bodies (default: all) as one shape, a compound when several; null with none. Tracked in `s`. */
  shapeOf(s: Scope, names?: readonly string[]): TopoDS_Shape | null;
  /**
   * Each earlier sketch's profile: its resolved plane frame, its closed
   * regions, `open` when it has none; null when the sketch failed or is
   * suppressed. An open sketch (a sweep path, a rib line) still has its frame.
   */
  profiles: ReadonlyMap<string, SketchProfile | null>;
  /** A sketch's closed profile for this op, or OpError: "sketch "s1" failed, so there is no profile to revolve", "... has no closed profile to revolve: profile is open at ...". */
  profile(sketch: string, verb: string): SketchProfile;
  /** A sketch's typed feature (entities and constraints, expressions resolved): for ops that read its curves (paths, rib lines). Its frame is profiles.get(id).frame. */
  sketch(id: string): SketchFeature | undefined;
  /** `sketch "s1" is suppressed` or `sketch "s1" failed`, for messages. */
  missing(id: string, what: string): string;
  /** The seed an earlier patternable feature left (its tool and where it went), for pattern-like ops. */
  seed(id: string): Seed | undefined;
  /**
   * Leaves this feature's tool for patterns and mirrors of it (its def says
   * patternable). Call inside the scope the tool lives in: the tool is copied
   * out, and dropped again if the feature fails afterwards.
   */
  setSeed(id: string, seed: Seed): void;
  /**
   * A seed applied once per instance: added to the body it went into, as new
   * bodies (nameOf(k) for the k-th copy), or cut from the bodies it cut. Every
   * copy must add or remove material. Returns [changed] for commit(...).
   */
  repeat(s: Scope, instances: Instance[], seed: Seed, nameOf: (k: number) => string, what?: string): [Map<string, TopoDS_Shape>];
  holes: HoleLedger;
  members: MemberLedger;
  /**
   * Reference geometry made so far, by feature id: plane, axis and point ops
   * put what they make here; resolveDatum (src/kernel/datum.ts) reads it for
   * { "datum": id } references.
   */
  datums: Map<string, Datum>;
}

/** The registry entry of one op, kernel side. */
export interface KernelOp<F extends { id: string; op: string } = any> {
  op: F["op"];
  /** Builds the feature (validated, expressions resolved, not suppressed), or throws OpError. */
  run(ctx: RebuildCtx, f: F): void;
}

/** Every registry op's kernel, by op. */
export const KERNEL_OPS: Readonly<Record<string, KernelOp>> = Object.fromEntries(KERNEL_DEFS.map((k) => [k.op, k]));

/** The kernel of a registry op, if it has one. */
export function kernelOf(op: string): KernelOp | undefined {
  return Object.hasOwn(KERNEL_OPS, op) ? KERNEL_OPS[op] : undefined;
}

/** Builds a registry op, or fails clearly when it validates but nothing can build it. */
export function runKernelOp(ctx: RebuildCtx, f: { id: string; op: string }): void {
  const k = kernelOf(f.op);
  if (!k) throw new OpError(`op "${f.op}" has no kernel operation: the document accepts it, but nothing builds it yet (src/features/${f.op}/kernel.ts, listed in kernelIndex.ts)`);
  k.run(ctx, f);
}
