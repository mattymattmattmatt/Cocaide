// VR's ray tree finds the same nearest triangle as testing every one, skips hidden triangles, and is quick.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { RayIndex } from "../src/ui/vr/rayIndex";

function soup(n: number, seed = 1) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const g = new THREE.BufferGeometry();
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = [rnd() * 5000, rnd() * 5000, rnd() * 3000];
    for (let v = 0; v < 3; v++) pos.push(c[0] + rnd() * 300, c[1] + rnd() * 300, c[2] + rnd() * 300);
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex([...Array(n * 3).keys()]);
  return { g, pos: new Float32Array(pos), index: new Uint32Array([...Array(n * 3).keys()]), rnd };
}

describe("the VR ray tree", () => {
  it("finds the nearest triangle three's raycast does, for many rays", () => {
    const { g, pos, index, rnd } = soup(4000);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const tree = new RayIndex(pos, index);
    let hits = 0;
    for (let k = 0; k < 300; k++) {
      const o = new THREE.Vector3(rnd() * 8000, rnd() * 8000, rnd() * 5000);
      const d = new THREE.Vector3(rnd(), rnd(), rnd()).normalize();
      const want = new THREE.Raycaster(o, d, 0, 20000).intersectObject(mesh, false)[0];
      const got = tree.cast([o.x, o.y, o.z], [d.x, d.y, d.z], 20000);
      expect(got?.tri ?? null).toBe(want?.faceIndex ?? null);
      if (want) {
        hits++;
        expect(got!.t).toBeCloseTo(want.distance, 3);
      }
    }
    expect(hits).toBeGreaterThan(30);
  });
  it("skips hidden triangles, and is far quicker than testing every one", () => {
    const { pos, index } = soup(1);
    const tree = new RayIndex(pos, index);
    const c = [pos[0] / 3 + pos[3] / 3 + pos[6] / 3, pos[1] / 3 + pos[4] / 3 + pos[7] / 3, pos[2] / 3 + pos[5] / 3 + pos[8] / 3];
    const o: [number, number, number] = [c[0], c[1], c[2] + 1000];
    expect(tree.cast(o, [0, 0, -1], 5000)?.tri).toBe(0);
    expect(tree.cast(o, [0, 0, -1], 5000, new Uint8Array([1]))).toBeNull();
    const big = soup(200000, 7);
    const t0 = performance.now();
    const bigTree = new RayIndex(big.pos, big.index);
    const built = performance.now() - t0;
    const t1 = performance.now();
    for (let k = 0; k < 600; k++) bigTree.cast([big.rnd() * 6000, big.rnd() * 6000, 4000], [big.rnd() * 0.3, big.rnd() * 0.3, -1], 10000);
    const per = (performance.now() - t1) / 600;
    expect(built).toBeLessThan(3000);
    expect(per).toBeLessThan(1);
  });
});
