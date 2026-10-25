// Messages between the UI thread and the kernel worker. OCCT shapes never
// cross this boundary: the worker sends meshes, measurements and STEP text.

import type { KernelMethod } from "../ask/kernel";
import type { EdgeInfo, FaceInfo, FeatureStatus, Measurements, MeshData, SketchOverlay } from "../kernel";
import type { BodyRange } from "../kernel/bodies";
import type { Datum } from "../features/datum";
import type { Closest, MassProperties, MeasureRef } from "../kernel/evaluate";

export type KernelRequest =
  /** With `session`: also the session preview for that feature (the client already holds the part before it when `have` is its key). */
  | { id: number; type: "rebuild"; doc: unknown; session?: { feature: string; have?: string } }
  | { id: number; type: "exportStep"; doc: unknown }
  /** The part as it stands before a feature (the sketch being edited): what that sketch sees and may reference. */
  | { id: number; type: "before"; doc: unknown; feature: string }
  /** A KernelPort call (src/ask/kernel.ts), for the right-click ask. */
  | { id: number; type: "port"; method: KernelMethod; args: unknown[] }
  /** Measure or Mass Properties on the rebuild of `doc` (the one on screen: the worker keeps it). */
  | { id: number; type: "evaluate"; doc: unknown; query: EvaluateQuery };

/** What the Evaluate tools ask the kernel. */
export type EvaluateQuery = { kind: "distance"; a: MeasureRef; b: MeasureRef } | { kind: "mass" };

export type EvaluateResult = { kind: "distance"; closest: Closest } | { kind: "mass"; mass: MassProperties };

export interface RebuildView {
  ok: boolean;
  name: string;
  errors: string[];
  features: FeatureStatus[];
  sketches: SketchOverlay[];
  measurements: Measurements | null;
  mesh: MeshData | null;
  /** B-rep faces and edges of the result, indexed like the mesh ranges. Plain data: picking and selector synthesis use them. */
  faces: FaceInfo[];
  edges: EdgeInfo[];
  /** The bodies, in order, with their face and edge index ranges. With more than one, faces and edges carry their body's name. */
  bodies: BodyRange[];
  /** The plane, axis and point features that built, by id, in order: where each is now (the viewport draws and picks them). */
  datums: Record<string, Datum>;
}

/**
 * A feature session's preview (Phase P): the part as it stands before the
 * feature (what the view shows and picks on while the feature is open), and
 * the material the feature adds and removes there, meshed.
 */
export interface SessionPreview {
  feature: string;
  /** Names the part before the feature: the same key, the same part (the client keeps it, and says so with `have`). */
  beforeKey: string;
  /** The part before the feature; left out when the client said it holds this key already. */
  before?: RebuildView;
  /** The material it adds and removes (null: none, or it failed). */
  added: MeshData | null;
  removed: MeshData | null;
  addedVolume: number;
  removedVolume: number;
  /** Did the feature build (in the part as far as it)? Its error when not. */
  ok: boolean;
  error?: string;
}

export type KernelResponse =
  | { id: 0; type: "ready"; loadMs: number }
  | { id: 0; type: "fatal"; message: string }
  | { id: number; type: "rebuilt"; view: RebuildView; ms: number; session?: SessionPreview }
  /** A rebuild skipped because a newer one was already waiting: only the newest is worth building. */
  | { id: number; type: "superseded" }
  | { id: number; type: "before"; view: RebuildView }
  | { id: number; type: "step"; ok: true; name: string; text: string }
  | { id: number; type: "step"; ok: false; errors: string[] }
  | { id: number; type: "port"; result: unknown }
  | { id: number; type: "evaluated"; result: EvaluateResult }
  | { id: number; type: "error"; message: string };
