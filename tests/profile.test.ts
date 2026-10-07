import { describe, expect, it } from "vitest";
import type { SketchEntity } from "../src/doc/types";
import { checkConstraints } from "../src/geom/constraints";
import { planeFrame, to3D } from "../src/geom/frame";
import { buildProfile } from "../src/geom/profile";

const ok = (entities: SketchEntity[]) => {
  const r = buildProfile(entities);
  if (!r.ok) throw new Error(r.error);
  return r;
};
const fail = (entities: SketchEntity[]) => {
  const r = buildProfile(entities);
  if (r.ok) throw new Error("expected a profile error");
  return r.error;
};

describe("profiles", () => {
  it("makes a rect with a circular hole into one region with one hole", () => {
    const r = ok([
      { id: "r", type: "rect", center: [0, 0], w: 80, h: 40 },
      { id: "c", type: "circle", center: [30, 0], radius: 3.3 },
    ]);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].holes).toHaveLength(1);
    expect(r.regions[0].outer.area).toBeGreaterThan(0);
    expect(r.regions[0].holes[0].area).toBeLessThan(0);
    expect(r.area).toBeCloseTo(3200 - Math.PI * 3.3 ** 2, 9);
  });

  it("treats a loop inside a hole as an island", () => {
    const r = ok([
      { id: "outer", type: "circle", center: [0, 0], radius: 30 },
      { id: "hole", type: "circle", center: [0, 0], radius: 20 },
      { id: "island", type: "circle", center: [0, 0], radius: 10 },
    ]);
    expect(r.regions).toHaveLength(2);
    expect(r.area).toBeCloseTo(Math.PI * (900 - 400 + 100), 9);
  });

  it("chains lines and arcs given in any order and direction", () => {
    const r = ok([
      { id: "a1", type: "arc", center: [10, 5], start: [10, 0], end: [10, 10] }, // right cap, CCW
      { id: "top", type: "line", start: [-10, 10], end: [10, 10] }, // reversed relative to the loop
      { id: "bottom", type: "line", start: [-10, 0], end: [10, 0] },
      { id: "a2", type: "arc", center: [-10, 5], start: [-10, 0], end: [-10, 10], clockwise: true },
    ]);
    expect(r.regions).toHaveLength(1);
    expect(r.area).toBeCloseTo(20 * 10 + Math.PI * 25, 9);
  });

  it("matches a slot's area", () => {
    const r = ok([{ id: "s", type: "slot", center1: [0, 0], center2: [17, 9], width: 6 }]);
    expect(r.area).toBeCloseTo(Math.hypot(17, 9) * 6 + Math.PI * 9, 9);
  });

  it("ignores construction geometry", () => {
    const r = ok([
      { id: "r", type: "rect", center: [0, 0], w: 10, h: 10 },
      { id: "cl", type: "line", start: [-20, 0], end: [20, 0], construction: true },
    ]);
    expect(r.area).toBeCloseTo(100, 9);
  });

  it("refuses crossing loops", () => {
    expect(
      fail([
        { id: "a", type: "rect", center: [0, 0], w: 10, h: 10 },
        { id: "b", type: "circle", center: [5, 0], radius: 2 },
      ]),
    ).toMatch(/^"a" and "b" intersect at \[5, [-\d.]+\]; profiles must not cross or touch$/);
  });

  it("refuses a circle that touches a rect edge", () => {
    expect(
      fail([
        { id: "a", type: "rect", center: [0, 0], w: 10, h: 10 },
        { id: "b", type: "circle", center: [3, 0], radius: 2 },
      ]),
    ).toBe('"a" and "b" intersect at [5, 0]; profiles must not cross or touch');
  });

  it("refuses a T-junction", () => {
    expect(
      fail([
        { id: "a", type: "line", start: [0, 0], end: [10, 0] },
        { id: "b", type: "line", start: [10, 0], end: [10, 10] },
        { id: "c", type: "line", start: [10, 10], end: [0, 0] },
        { id: "d", type: "line", start: [10, 0], end: [20, 0] },
      ]),
    ).toMatch(/meet at \[10, 0\]; each profile vertex must join exactly two entities/);
  });

  it("refuses a self-crossing bow tie", () => {
    expect(
      fail([
        { id: "a", type: "line", start: [0, 0], end: [10, 10] },
        { id: "b", type: "line", start: [10, 10], end: [10, 0] },
        { id: "c", type: "line", start: [10, 0], end: [0, 10] },
        { id: "d", type: "line", start: [0, 10], end: [0, 0] },
      ]),
    ).toBe('"a" and "c" intersect at [5, 5]; profiles must not cross or touch');
  });

  it("refuses an arc whose end is off its circle", () => {
    expect(fail([{ id: "a", type: "arc", center: [0, 0], start: [10, 0], end: [0, 11] }])).toBe(
      'arc "a": start is 10 from center but end is 11; both must be on one circle',
    );
  });
});

describe("constraints are checked against the geometry", () => {
  const entities: SketchEntity[] = [
    { id: "l1", type: "line", start: [0, 0], end: [30, 0] },
    { id: "l2", type: "line", start: [30, 0], end: [30, 30] },
    { id: "c", type: "circle", center: [10, 10], radius: 4 },
    { id: "a", type: "arc", center: [0, 0], start: [4, 0], end: [0, 4] },
  ];

  it("passes when every constraint holds", () => {
    expect(
      checkConstraints(entities, [
        { type: "horizontal", entity: "l1" },
        { type: "vertical", entity: "l2" },
        { type: "coincident", points: ["l1.end", "l2.start"] },
        { type: "distance", entity: "l1", value: 30 },
        { type: "distanceY", points: ["l2.start", "l2.end"], value: 30 },
        { type: "radius", entity: "c", value: 4 },
        { type: "equal", entities: ["l1", "l2"] },
        { type: "equal", entities: ["c", "a"] },
      ]),
    ).toEqual([]);
  });

  it("reports the measured value when one does not", () => {
    expect(checkConstraints(entities, [{ type: "distance", entity: "l1", value: 25 }])).toEqual([
      "constraint 0 (distance l1 = 25) is not satisfied: geometry gives 30, constraint says 25",
    ]);
  });
});

describe("plane frames", () => {
  it("uses global X and Y on the XY plane", () => {
    expect(to3D(planeFrame([0, 0, 1], [0, 0, 5]), [30, 2])).toEqual([30, 2, 5]);
  });

  it("is right-handed for every axis plane", () => {
    for (const n of [[1, 0, 0], [0, 1, 0], [0, 0, -1], [0.3, -0.4, 0.5]] as const) {
      const f = planeFrame([...n], [0, 0, 0]);
      const cross = [
        f.x[1] * f.y[2] - f.x[2] * f.y[1],
        f.x[2] * f.y[0] - f.x[0] * f.y[2],
        f.x[0] * f.y[1] - f.x[1] * f.y[0],
      ];
      cross.forEach((v, i) => expect(v).toBeCloseTo(f.z[i], 12));
    }
  });
});
