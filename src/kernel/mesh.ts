// Tessellation for the viewport. The mesh is a view of the B-rep, never the
// other way round.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import { len3, sub3 } from "../geom/vec";
import { boundingBoxOf } from "./measure";
import { type OC, scoped } from "./oc";

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Index ranges per B-rep face, in TopExp_Explorer order (same order as FaceInfo.index). */
  faceRanges: { start: number; count: number }[];
  /** B-rep edges as line-segment pairs (x0 y0 z0 x1 y1 z1 ...). */
  edges: Float32Array;
  /** Segment ranges per B-rep edge, in unique-edge explorer order (same order as EdgeInfo.index). */
  edgeRanges: { start: number; count: number }[];
}

export function tessellate(oc: OC, shape: TopoDS_Shape): MeshData {
  const diag = scoped((s) => {
    const bb = boundingBoxOf(oc, s, shape);
    return bb ? len3(sub3(bb.max, bb.min)) : 1;
  });
  const tolerance = Math.max(1e-3, diag * 5e-4);
  const angular = 0.1;

  const raw = oc.ReplicadMeshExtractor.extract(shape, tolerance, angular, false);
  let positions: Float32Array, normals: Float32Array, indices: Uint32Array, groups: Int32Array;
  try {
    // Views are taken after extraction: the call may have grown wasm memory.
    const buffer = oc.wasmMemory.buffer as ArrayBuffer;
    positions = new Float32Array(buffer, raw.getVerticesPtr(), raw.getVerticesSize()).slice();
    normals = new Float32Array(buffer, raw.getNormalsPtr(), raw.getNormalsSize()).slice();
    indices = new Uint32Array(buffer, raw.getTrianglesPtr(), raw.getTrianglesSize()).slice();
    groups = new Int32Array(buffer, raw.getFaceGroupsPtr(), raw.getFaceGroupsSize()).slice();
  } finally {
    raw.delete();
  }
  const faceRanges: MeshData["faceRanges"] = [];
  for (let i = 0; i < groups.length; i += 3) faceRanges.push({ start: groups[i], count: groups[i + 1] });

  const rawEdges = oc.ReplicadEdgeMeshExtractor.extract(shape, tolerance, angular);
  let points: Float32Array, edgeGroups: Int32Array;
  try {
    const buffer = oc.wasmMemory.buffer as ArrayBuffer;
    points = new Float32Array(buffer, rawEdges.getLinesPtr(), rawEdges.getLinesSize()).slice();
    edgeGroups = new Int32Array(buffer, rawEdges.getEdgeGroupsPtr(), rawEdges.getEdgeGroupsSize()).slice();
  } finally {
    rawEdges.delete();
  }
  // Each edge group is a polyline (start and count in points); expand to segment pairs.
  const segments: number[] = [];
  const edgeRanges: MeshData["edgeRanges"] = [];
  for (let g = 0; g < edgeGroups.length; g += 3) {
    const start = edgeGroups[g];
    const count = edgeGroups[g + 1];
    const first = segments.length / 6;
    for (let i = start; i < start + count - 1; i++) {
      for (let k = 0; k < 3; k++) segments.push(points[3 * i + k]);
      for (let k = 0; k < 3; k++) segments.push(points[3 * (i + 1) + k]);
    }
    edgeRanges.push({ start: first, count: segments.length / 6 - first });
  }
  return { positions, normals, indices, faceRanges, edges: new Float32Array(segments), edgeRanges };
}
