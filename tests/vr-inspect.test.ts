import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { scaledAbout, scaleText, startScale, twoHandPose, type HeldPose } from "../src/ui/vr/inspect";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const pose = (): HeldPose => ({ pos: v(0, 1.2, -0.5), quat: new THREE.Quaternion(), scale: 1 });
const near = (a: THREE.Vector3, b: THREE.Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-9);

describe("holding a part in VR", () => {
  it("two hands spread twice as far: twice the size, about their middle", () => {
    const p = twoHandPose(v(-0.1, 1.2, -0.5), v(0.1, 1.2, -0.5), pose(), v(-0.2, 1.2, -0.5), v(0.2, 1.2, -0.5));
    expect(p.scale).toBeCloseTo(2);
    near(p.pos, v(0, 1.2, -0.5));
    // A point 10 cm right of the middle is now 20 cm right of it.
    const corner = v(0.1, 0, 0).multiplyScalar(p.scale).applyQuaternion(p.quat).add(p.pos);
    near(corner, v(0.2, 1.2, -0.5));
  });
  it("two hands moved together carry it; turned about their middle, they turn it", () => {
    const moved = twoHandPose(v(-0.1, 1.2, -0.5), v(0.1, 1.2, -0.5), pose(), v(0.2, 1.2, -0.5), v(0.4, 1.2, -0.5));
    expect(moved.scale).toBeCloseTo(1);
    near(moved.pos, v(0.3, 1.2, -0.5));
    // A quarter turn about the vertical: the right hand comes towards you.
    const turned = twoHandPose(v(-0.1, 1.2, -0.5), v(0.1, 1.2, -0.5), pose(), v(0, 1.2, -0.6), v(0, 1.2, -0.4));
    const x = v(1, 0, 0).applyQuaternion(turned.quat);
    near(x, v(0, 0, 1));
  });
  it("keeps the scale within limits, scales about a point, says how big it is", () => {
    expect(twoHandPose(v(0, 0, 0), v(0.1, 0, 0), pose(), v(0, 0, 0), v(100, 0, 0)).scale).toBe(50);
    expect(twoHandPose(v(0, 0, 0), v(1, 0, 0), pose(), v(0, 0, 0), v(0.0001, 0, 0)).scale).toBe(0.02);
    const big = { ...pose(), scale: 3 };
    const back = scaledAbout(big, v(0, 1.5, -0.5), 1);
    expect(back.scale).toBe(1);
    near(back.pos, v(0, 1.5 + (1.2 - 1.5) / 3, -0.5));
    expect(startScale(300)).toBe(1);
    expect(startScale(1200)).toBe(1);
    expect(startScale(5000)).toBeCloseTo(0.2);
    expect([scaleText(1), scaleText(2.54), scaleText(12.4), scaleText(0.25), scaleText(0.04)]).toEqual(["1:1", "×2.5", "×12", "1:4", "1:25"]);
  });
});
