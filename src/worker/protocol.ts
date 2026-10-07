// Messages between the UI thread and the kernel worker. OCCT shapes never
// cross this boundary: the worker sends meshes, measurements and STEP text.

import type { KernelMethod } from "../ask/kernel";
import type { EdgeInfo, FaceInfo, FeatureStatus, Measurements, MeshData, SketchOverlay } from "../kernel";

export type KernelRequest =
  | { id: number; type: "rebuild"; doc: unknown }
  | { id: number; type: "exportStep"; doc: unknown }
  /** A KernelPort call (src/ask/kernel.ts), for the right-click ask. */
  | { id: number; type: "port"; method: KernelMethod; args: unknown[] };

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
}

export type KernelResponse =
  | { id: 0; type: "ready"; loadMs: number }
  | { id: 0; type: "fatal"; message: string }
  | { id: number; type: "rebuilt"; view: RebuildView; ms: number }
  | { id: number; type: "step"; ok: true; name: string; text: string }
  | { id: number; type: "step"; ok: false; errors: string[] }
  | { id: number; type: "port"; result: unknown }
  | { id: number; type: "error"; message: string };
