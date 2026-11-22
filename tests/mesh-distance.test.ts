// Measuring in an assembly: the closest points between picked faces and edges, from the view's mesh.
import { describe, expect, it } from "vitest";
import type { MeshData } from "../src/kernel/mesh";
import { closestOnTriangle, closestSegSeg, meshClosest } from "../src/ui/evaluate/meshDistance";

type V = [number, number, number];
/** A mesh of square faces (two triangles each) and segments. */
function meshOf(squares: V[][], segs: [V, V][]): MeshData {
  const pos: number[] = [];
  const idx: number[] = [];
  const faceRanges: { start: number; count: number }[] = [];
  for (const q of squares) {
    const b = pos.length / 3;
    for (const p of q) pos.push(...p);
    faceRanges.push({ start: idx.length, count: 6 });
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const edges: number[] = [];
  const edgeRanges: { start: number; count: number }[] = [];
  segs.forEach(([a, b], k) => { edges.push(...a, ...b); edgeRanges.push({ start: k, count: 1 }); });
  return { positions: new Float32Array(pos), normals: new Float32Array(pos.length), indices: new Uint32Array(idx), faceRanges, edges: new Float32Array(edges), edgeRanges };
}

describe("closest points from the mesh", () => {
  it("points to a triangle, segment to segment", () => {
    const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
    near(closestOnTriangle([0.2, 0.2, 5], [[0, 0, 0], [1, 0, 0], [0, 1, 0]]), [0.2, 0.2, 0]);
    near(closestOnTriangle([2, 2, 0], [[0, 0, 0], [1, 0, 0], [0, 1, 0]]), [0.5, 0.5, 0]);
    const [p, q] = closestSegSeg([[0, 0, 0], [10, 0, 0]], [[5, -5, 3], [5, 5, 3]]);
    expect([p, q]).toEqual([[5, 0, 0], [5, 0, 3]]);
  });

  it("two facing plates 50 apart, offset sideways; a face and an edge; touching faces are 0", () => {
    const m = meshOf(
      [
        [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]],
        [[60, 40, 50], [160, 40, 50], [160, 140, 50], [60, 140, 50]],
        [[100, 0, 0], [200, 0, 0], [200, 0, 80], [100, 0, 80]],
      ],
      [[[-30, 50, 20], [-30, 50, 90]]],
    );
    const c = meshClosest(m, { kind: "face", index: 0 }, { kind: "face", index: 1 })!;
    expect(c.distance).toBeCloseTo(50, 6);
    expect(c.a[2]).toBeCloseTo(0, 6);
    expect(c.b[2]).toBeCloseTo(50, 6);
    const e = meshClosest(m, { kind: "edge", index: 0 }, { kind: "face", index: 0 })!;
    expect(e.distance).toBeCloseTo(Math.hypot(30, 20), 4);
    expect(meshClosest(m, { kind: "face", index: 0 }, { kind: "face", index: 2 })!.distance).toBeCloseTo(0, 6);
    expect(meshClosest(m, { kind: "face", index: 9 }, { kind: "face", index: 0 })).toBeNull();
  });
});
