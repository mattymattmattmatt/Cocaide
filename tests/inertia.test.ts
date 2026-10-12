// Mass properties arithmetic (src/geom/inertia.ts), checked against the
// written-out formulas: a box's moments, the parallel axis theorem, the
// tensor read back from moments about six axes, principal moments.

import { describe, expect, it } from "vitest";
import { boxInertia, combine, inertiaOf, momentAbout, principal, shifted, tensorFromMoments, tensorOf, type Mat3, type MassBody } from "../src/geom/inertia";
import type { Vec3 } from "../src/doc/types";

const close = (a: number, b: number, rel = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)));

/** A 100 × 60 × 8 steel plate (7850 kg/m³): m = 100·60·8 mm³ · 7.85e-6 kg/mm³ = 0.3768 kg. */
const plate = (centre: Vec3 = [0, 0, 4], size: Vec3 = [100, 60, 8], name = "plate"): MassBody => {
  const volume = size[0] * size[1] * size[2];
  const mass = volume * 7850e-9;
  return { name, volume, area: 2 * (size[0] * size[1] + size[0] * size[2] + size[1] * size[2]), densityKgPerM3: 7850, material: "Steel", mass, centre, inertia: boxInertia(mass, size) };
};

describe("box formulas", () => {
  it("Ixx = m(b² + c²)/12 and so on, no products", () => {
    const i = boxInertia(0.3768, [100, 60, 8]);
    close(i.ixx, (0.3768 * (60 * 60 + 8 * 8)) / 12); // 115.0496
    close(i.iyy, (0.3768 * (100 * 100 + 8 * 8)) / 12); // 316.0096
    close(i.izz, (0.3768 * (100 * 100 + 60 * 60)) / 12); // 427.04
    expect([i.pxy, i.pxz, i.pyz]).toEqual([0, 0, 0]);
  });
});

describe("tensor from six moments", () => {
  it("reads back a tensor with products exactly", () => {
    const t: Mat3 = [
      [10, -2, 1],
      [-2, 20, -3],
      [1, -3, 30],
    ];
    const m = {
      x: momentAbout(t, [1, 0, 0]),
      y: momentAbout(t, [0, 1, 0]),
      z: momentAbout(t, [0, 0, 1]),
      xy: momentAbout(t, [1, 1, 0]),
      xz: momentAbout(t, [1, 0, 1]),
      yz: momentAbout(t, [0, 1, 1]),
    };
    const back = tensorFromMoments(m);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) close(back[r][c], t[r][c]);
    // Products of inertia are the negated off-diagonal entries: Pxy = 2, Pxz = −1, Pyz = 3.
    const i = inertiaOf(back);
    close(i.pxy, 2);
    close(i.pxz, -1);
    close(i.pyz, 3);
    expect(tensorOf(i)).toEqual(back);
  });
});

describe("parallel axes and combining bodies", () => {
  it("shifted: I + m(|d|²E − d·dᵀ)", () => {
    const t = tensorOf(boxInertia(2, [10, 20, 30]));
    const s = shifted(t, 2, [3, 4, 0]);
    close(s[0][0], t[0][0] + 2 * 16); // about X: d⊥² = y² + z² = 16
    close(s[1][1], t[1][1] + 2 * 9);
    close(s[2][2], t[2][2] + 2 * 25);
    close(s[0][1], -2 * 12); // −m·dx·dy
  });

  it("two plates stacked are one 100 × 60 × 16 box about the common centre", () => {
    const a = plate([0, 0, 4], [100, 60, 8], "a");
    const b = plate([0, 0, 12], [100, 60, 8], "b");
    const total = combine([a, b])!;
    close(total.mass, 2 * a.mass);
    close(total.volume, 96000);
    expect(total.centre).toEqual([0, 0, 8]);
    const box = boxInertia(total.mass, [100, 60, 16]);
    close(total.inertia.ixx, box.ixx);
    close(total.inertia.iyy, box.iyy);
    close(total.inertia.izz, box.izz);
    close(total.densityKgPerM3, 7850);
    expect(total.material).toBe("Steel");
  });

  it("weights the centre by mass, so a heavy body pulls it its way", () => {
    const steel = plate([0, 0, 0], [10, 10, 10], "steel");
    const light = { ...plate([20, 0, 0], [10, 10, 10], "alu"), mass: steel.mass / 3, densityKgPerM3: 7850 / 3, material: "Aluminium" };
    const total = combine([steel, light])!;
    close(total.centre[0], (20 * (1 / 3)) / (1 + 1 / 3)); // 5 mm
    expect(total.material).toBe("Steel, Aluminium");
  });

  it("none is null", () => {
    expect(combine([])).toBeNull();
  });
});

describe("principal moments", () => {
  it("of a box are its three moments, ascending, along X, Y and Z", () => {
    const i = boxInertia(1, [100, 60, 8]);
    const p = principal(tensorOf(i));
    close(p.moments[0], i.ixx);
    close(p.moments[1], i.iyy);
    close(p.moments[2], i.izz);
    expect(p.axes[0].map((x) => Math.round(x * 1e9) / 1e9 + 0)).toEqual([1, 0, 0]);
    expect(p.axes[2].map((x) => Math.round(x * 1e9) / 1e9 + 0)).toEqual([0, 0, 1]);
  });

  it("of a tensor with products: eigenvalues of [[2,1,0],[1,2,0],[0,0,5]] are 1, 3, 5", () => {
    const p = principal([
      [2, 1, 0],
      [1, 2, 0],
      [0, 0, 5],
    ]);
    close(p.moments[0], 1, 1e-12);
    close(p.moments[1], 3, 1e-12);
    close(p.moments[2], 5, 1e-12);
    const s = Math.SQRT1_2;
    close(Math.abs(p.axes[0][0]), s, 1e-9);
    close(Math.abs(p.axes[0][1]), s, 1e-9);
  });
});
