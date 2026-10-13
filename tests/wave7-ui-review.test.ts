// Wave 7 review: pure UI fixes, each from a reproduced finding.
// - a grid pattern's skipped instance stays the same [i, j] when a count changes;
// - a sketch-driven pattern's skipped copy follows its place when the table changes;
// - Mass Properties never shows "-0" for round-off below its digits.

import { describe, expect, it } from "vitest";
import { countPatch, patternRows } from "../src/features/linearPattern/instances";
import { followedSkips, keptSkips } from "../src/features/sketchPattern/ui";
import { massLines, num } from "../src/ui/evaluate/EvaluatePanels";

type Raw = Record<string, unknown>;
const grid = (f: Raw): Raw => ({ op: "linearPattern", feature: "e1", direction: [1, 0, 0], spacing: 10, count: 3, direction2: [0, 1, 0], spacing2: 10, count2: 2, ...f });
const skippedPlaces = (f: Raw) => patternRows(f).filter((r) => r.skipped).map((r) => r.label.split(" ").slice(1).join(" "));

describe("grid pattern: a skipped instance keeps its place when a count changes", () => {
  it("count 3 → 4: [2, 2] (5) is still skipped, as 6", () => {
    const f = grid({ skip: [5] });
    expect(skippedPlaces(f)).toEqual(["[2, 2]"]);
    const patch = countPatch(f, "count", 4);
    expect(patch).toEqual({ count: 4, skip: [6] });
    expect(skippedPlaces({ ...f, ...patch })).toEqual(["[2, 2]"]);
  });

  it("count 3 → 2: [3, 1] (3) is gone, so nothing is skipped; [2, 2] (5) becomes 4", () => {
    expect(countPatch(grid({ skip: [3] }), "count", 2)).toEqual({ count: 2, skip: null });
    const f = grid({ skip: [5] });
    const patch = countPatch(f, "count", 2);
    expect(patch).toEqual({ count: 2, skip: [4] });
    expect(skippedPlaces({ ...f, ...patch })).toEqual(["[2, 2]"]);
  });

  it("count2 changes keep the numbers of the rows that stay, and drop the rows that go", () => {
    expect(countPatch(grid({ skip: [2, 5] }), "count2", 3)).toEqual({ count2: 3, skip: [2, 5] });
    expect(countPatch(grid({ skip: [2, 5], count2: 3 }), "count2", 1)).toEqual({ count2: 1, skip: [2] });
  });

  it("a one-way pattern and a circular one number in a line: the numbers stay", () => {
    expect(countPatch({ op: "linearPattern", count: 4, skip: [3] }, "count", 6)).toEqual({ count: 6, skip: [3] });
    expect(countPatch({ op: "circularPattern", count: 6, skip: [5] }, "count", 4)).toEqual({ count: 4, skip: null });
  });
});

describe("sketch-driven pattern: a skipped copy follows its place", () => {
  type V = [number, number];
  const table: V[] = [[30, 0], [-30, 0], [0, 10], [30, 20]];
  const from: V = [-30, 0];

  it("removing position 1 ([30, 0]) keeps [0, 10] skipped: it is copy 2 now", () => {
    // Copies before: 2 at [30, 0], 3 at [0, 10], 4 at [30, 20]; skip 3 is [0, 10].
    const after = table.filter((_, k) => k !== 0);
    const patch = followedSkips({ skip: [3] }, { places: table, from }, { places: after, from }, (r) => (r === 0 ? null : r - 1));
    expect(patch).toEqual({ skip: [2] });
  });

  it("removing the skipped place itself drops the skip", () => {
    const after = table.filter((_, k) => k !== 2);
    expect(followedSkips({ skip: [3] }, { places: table, from }, { places: after, from }, (r) => (r < 2 ? r : r === 2 ? null : r - 1))).toEqual({ skip: null });
  });

  it("adding a position or editing one leaves the skips as they are", () => {
    expect(followedSkips({ skip: [3] }, { places: table, from }, { places: [...table, [60, 20]], from }, (r) => r)).toEqual({});
    const moved = table.map((p, k): V => (k === 3 ? [40, 20] : p));
    expect(followedSkips({ skip: [4] }, { places: table, from }, { places: moved, from }, (r) => r)).toEqual({});
  });

  it("switching to the sketch's points: the skip goes with the point at its place", () => {
    const points: V[] = [[-30, 0], [30, 20], [0, 10]];
    const row = (i: number) => {
      const k = points.findIndex((q) => q[0] === table[i][0] && q[1] === table[i][1]);
      return k < 0 ? null : k;
    };
    // Seed at the first point, [-30, 0]: copies 2 at [30, 20], 3 at [0, 10].
    expect(followedSkips({ skip: [3] }, { places: table, from }, { places: points, from: undefined }, row)).toEqual({}); // still 3: nothing to change
    expect(followedSkips({ skip: [4] }, { places: table, from }, { places: points, from: undefined }, row)).toEqual({ skip: [2] });
  });

  it("keptSkips still drops instances past the last", () => {
    expect(keptSkips({ skip: [2, 4] }, 2)).toEqual({ skip: [2] });
  });
});

describe("Mass Properties numbers", () => {
  it("round-off below the shown digits reads 0, not -0", () => {
    expect(num(-1e-12)).toBe("0");
    expect(num(-0)).toBe("0");
    expect(num(-0.0004)).toBe("0");
    expect(num(-0.0006)).toBe("-0.001");
    expect(num(3.62712)).toBe("3.627");
    expect(num(1234567.891, 1)).toBe("1,234,567.9");
  });

  it("the products line and what Copy all puts on the clipboard", () => {
    const body = { name: "b", volume: 1, area: 1, densityKgPerM3: 7850, material: "Steel", mass: 1, centre: [0, 0, 0] as [number, number, number], inertia: { ixx: 10, iyy: 10, izz: 5, pxy: -2e-13, pxz: -0, pyz: 3.627 } };
    const products = massLines(body).find(([, , key]) => key === "products")!;
    expect(products[1]).toBe("0, 0, 3.627 kg·mm²");
  });
});
