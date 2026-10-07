// Messages between the UI thread and the kernel worker. OCCT shapes never
// cross this boundary: the worker sends meshes, measurements and STEP text.

import type { FeatureStatus, Measurements, MeshData, SketchOverlay } from "../kernel";
import type { Vec3 } from "../doc/types";

export type KernelRequest =
  | { id: number; type: "rebuild"; doc: unknown }
  | { id: number; type: "exportStep"; doc: unknown };

/** What the viewport shows when hovering a face. */
export interface FaceSummary {
  type: "plane" | "cylinder" | "cone" | "other";
  area: number;
  normal?: Vec3;
  offset?: number;
  radius?: number;
  concave?: boolean;
}

export interface RebuildView {
  ok: boolean;
  name: string;
  errors: string[];
  features: FeatureStatus[];
  sketches: SketchOverlay[];
  measurements: Measurements | null;
  mesh: MeshData | null;
  faces: FaceSummary[];
}

export type KernelResponse =
  | { id: 0; type: "ready"; loadMs: number }
  | { id: 0; type: "fatal"; message: string }
  | { id: number; type: "rebuilt"; view: RebuildView; ms: number }
  | { id: number; type: "step"; ok: true; name: string; text: string }
  | { id: number; type: "step"; ok: false; errors: string[] }
  | { id: number; type: "error"; message: string };
