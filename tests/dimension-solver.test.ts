// Wave 4B solver work: the new dimension types and relations (arc length,
// min/max to circles, line-to-line, linear diameter, angle to an axis,
// intersection, coradial), driven dimensions that never move geometry,
// redundancy and the smallest conflicting set, and Fully Define.

import { describe, expect, it } from "vitest";
import type { ArcEntity, Constraint, SketchEntity, Vec2 } from "../src/doc/types";
import { arcLength, checkConstraints, measureConstraint } from "../src/geom/constraints";
import { fullyDefine } from "../src/geom/fullyDefine";
import { conflictSet, rankTracker, redundantConstraints, sketchDof, sketchStatus, solveSketch, wouldOverDefine } from "../src/geom/solver";
import { place, toolByName } from "../src/ui/sketcher/tools/run";

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, type: "line", start, end });
const circle = (id: string, center: Vec2, radius: number): SketchEntity => ({ id, type: "circle", center, radius });
const point = (id: string, at: Vec2): SketchEntity => ({ id, type: "point", at });

function solved(entities: SketchEntity[], constraints: Constraint[]): SketchEntity[] {
  const r = solveSketch(entities, constraints);
  if (!r.ok) throw new Error(r.error);
  expect(checkConstraints(r.entities, constraints)).toEqual([]);
  return r.entities;
}
const get = <T extends SketchEntity["type"]>(es: SketchEntity[], id: string) => es.find((e) => e.id === id) as Extract<SketchEntity, { type: T }>;

describe("arc length", () => {
  const arc: ArcEntity = { id: "a1", type: "arc", center: [0, 0], start: [10, 0], end: [0, 10] };
  it("measures radius times sweep, the way the arc runs", () => {
    expect(arcLength(arc)).toBeCloseTo((Math.PI / 2) * 10, 12);
    expect(arcLength({ ...arc, clockwise: true })).toBeCloseTo((3 * Math.PI / 2) * 10, 12);
  });

  it("drives the sweep with the centre, radius and start held", () => {
    const ks: Constraint[] = [
      { type: "fix", point: "a1.center" },
      { type: "fix", point: "a1.start" },
      { type: "arcLength", entity: "a1", value: 20 },
    ];
    const a = get<"arc">(solved([arc], ks), "a1");
    // 20 mm on a 10 mm radius is 2 radians from +X.
    expect(a.end[0]).toBeCloseTo(10 * Math.cos(2), 7);
    expect(a.end[1]).toBeCloseTo(10 * Math.sin(2), 7);
    expect(sketchDof([arc], ks)).toBe(0);
  });
});

describe("distances to circles: centre, min and max", () => {
  const base = [circle("c1", [30, 0], 5)];
  const held: Constraint[] = [
    { type: "radius", entity: "c1", value: 5 },
    { type: "horizontal", points: ["origin", "c1.center"] },
  ];
  it("min measures to the near side, max to the far side", () => {
    const k = (condition: "min" | "max", value: number): Constraint => ({ type: "distance", points: ["origin", "c1.center"], condition, value });
    expect(measureConstraint(base, k("min", 0)).actual).toBe(25);
    expect(measureConstraint(base, k("max", 0)).actual).toBe(35);
    expect(get<"circle">(solved(base, [...held, k("min", 20)]), "c1").center[0]).toBeCloseTo(25, 9);
    expect(get<"circle">(solved(base, [...held, k("max", 50)]), "c1").center[0]).toBeCloseTo(45, 9);
  });

  it("works for horizontal and vertical distances, and for a point's distance from a line", () => {
    const x: Constraint = { type: "distanceX", points: ["origin", "c1.center"], condition: "max", value: 40 };
    expect(get<"circle">(solved(base, [...held, x]), "c1").center[0]).toBeCloseTo(35, 9);
    const toAxis: Constraint = { type: "distance", point: "c1.center", line: "Y", condition: "min", value: 10 };
    expect(get<"circle">(solved(base, [...held, toAxis]), "c1").center[0]).toBeCloseTo(15, 9);
  });
});

describe("line-to-line distance, linear diameter and angle to an axis", () => {
  it("holds two lines a parallel distance apart", () => {
    const es = [line("l1", [0, 0], [10, 0]), line("l2", [0, 5], [10, 5])];
    const ks: Constraint[] = [{ type: "fix", entity: "l1" }, { type: "horizontal", entity: "l2" }, { type: "distance", lines: ["l1", "l2"], value: 8 }];
    const l2 = get<"line">(solved(es, ks), "l2");
    expect(l2.start[1]).toBeCloseTo(8, 9);
    expect(l2.end[1]).toBeCloseTo(8, 9);
  });

  it("measures from a sketch axis too", () => {
    const es = [line("l2", [0, 5], [10, 5])];
    const ks: Constraint[] = [{ type: "horizontal", entity: "l2" }, { type: "distance", lines: ["X", "l2"], value: 12 }];
    expect(get<"line">(solved(es, ks), "l2").start[1]).toBeCloseTo(12, 9);
  });

  it("a doubled distance is the diameter across a centreline", () => {
    const es = [point("p1", [5, 3])];
    const k: Constraint = { type: "distance", point: "p1.at", line: "Y", doubled: true, value: 20 };
    expect(measureConstraint(es, { ...k, value: 0 }).actual).toBe(10);
    expect(get<"point">(solved(es, [k, { type: "fix", point: "p1.at" } as Constraint].slice(0, 1)), "p1").at[0]).toBeCloseTo(10, 9);
  });

  it("dimensions a line's angle to the X axis", () => {
    const es = [line("l1", [0, 0], [10, 10])];
    const ks: Constraint[] = [{ type: "fix", point: "l1.start" }, { type: "distance", entity: "l1", value: 10 }, { type: "angle", entities: ["l1", "X"], value: 30 }];
    const l = get<"line">(solved(es, ks), "l1");
    expect(l.end[0]).toBeCloseTo(10 * Math.cos(Math.PI / 6), 7);
    expect(l.end[1]).toBeCloseTo(5, 7);
  });
});

describe("intersection and coradial", () => {
  it("puts a point where two lines cross", () => {
    const es = [line("l1", [0, 0], [10, 10]), line("l2", [0, 10], [10, 0]), point("p1", [3, 4])];
    const ks: Constraint[] = [{ type: "fix", entity: "l1" }, { type: "fix", entity: "l2" }, { type: "intersection", point: "p1.at", entities: ["l1", "l2"] }];
    const p = get<"point">(solved(es, ks), "p1");
    expect(p.at[0]).toBeCloseTo(5, 9);
    expect(p.at[1]).toBeCloseTo(5, 9);
    expect(sketchDof(es, ks)).toBe(0);
  });

  it("makes two circles one: same centre, same radius", () => {
    const es = [circle("c1", [0, 0], 10), circle("c2", [1, 1], 8)];
    const ks: Constraint[] = [{ type: "fix", entity: "c1" }, { type: "coradial", entities: ["c1", "c2"] }];
    const c2 = get<"circle">(solved(es, ks), "c2");
    expect(c2.center[0]).toBeCloseTo(0, 9);
    expect(c2.radius).toBeCloseTo(10, 9);
    expect(sketchDof(es, ks)).toBe(0);
  });
});

describe("driven dimensions", () => {
  it("never move geometry, never count, never over-define", () => {
    const es = [line("l1", [0, 0], [10, 0])];
    const fixed: Constraint[] = [{ type: "fix", entity: "l1" }];
    const driven: Constraint = { type: "distance", entity: "l1", value: 99, driven: true };
    const r = solveSketch(es, [...fixed, driven]);
    expect(r.ok && r.entities).toEqual(es);
    expect(checkConstraints(es, [...fixed, driven])).toEqual([]);
    expect(sketchDof(es, [driven])).toBe(4);
    expect(wouldOverDefine(es, fixed, driven)).toBe(true); // as a driving one it would; the sketcher then offers driven
    expect(redundantConstraints(es, [...fixed, driven])).toEqual([false, false]);
    expect(conflictSet(es, [...fixed, driven])).toEqual([]);
  });
});

describe("over-definition: redundancy and the smallest conflicting set", () => {
  const es = [line("l1", [0, 0], [10, 0])];
  it("flags a constraint that repeats others", () => {
    const ks: Constraint[] = [{ type: "horizontal", entity: "l1" }, { type: "distance", entity: "l1", value: 10 }, { type: "distanceX", entity: "l1", value: 10 }];
    expect(redundantConstraints(es, ks)).toEqual([false, false, true]);
    // On a level line its length and its width are one and the same thing: those two alone repeat each other.
    expect(conflictSet(es, ks)).toEqual([1, 2]);
  });

  it("finds the few that conflict among many that don't", () => {
    const ks: Constraint[] = [
      { type: "coincident", points: ["l1.start", "origin"] },
      { type: "horizontal", entity: "l1" },
      { type: "distance", entity: "l1", value: 10 },
      { type: "distanceX", points: ["origin", "l1.end"], value: 12 },
    ];
    // The line can't be 10 long and end 12 along while it starts at the origin, level or not: the level relation is not to blame.
    expect(solveSketch(es, ks).ok).toBe(false);
    expect(conflictSet(es, ks)).toEqual([0, 2, 3]);
    // At 11 along it can, by tilting: nothing conflicts.
    expect(conflictSet(es, [ks[0], ks[2], { ...ks[3], value: 8 } as Constraint])).toEqual([]);
    const extra: Constraint[] = [...ks.slice(0, 3), { type: "fix", point: "l1.start" }];
    // The fix repeats the coincidence with the origin.
    expect(conflictSet(es, extra)).toEqual([0, 3]);
  });

  it("drawing tools make no redundant relations", () => {
    for (const [name, clicks] of [
      ["rect", [[0, 0], [20, 10]]],
      ["rect-center", [[0, 0], [20, 10]]],
      ["polygon", [[0, 0], [10, 0]]],
      ["slot", [[0, 0], [20, 0], [20, 5]]],
      ["parallelogram", [[0, 0], [20, 0], [25, 10]]],
    ] as [string, Vec2[]][]) {
      const made = place(toolByName(name)!, clicks.map((p) => ({ p, ref: null })), {}, { entities: [] })!;
      expect(redundantConstraints(made.entities, made.relations).some(Boolean), name).toBe(false);
    }
  });

  it("a rank tracker answers without changing", () => {
    const t = rankTracker(es, []);
    expect(t.dof()).toBe(4);
    expect(t.gain({ type: "coincident", points: ["l1.start", "origin"] })).toBe(2);
    expect(t.dof()).toBe(4);
    t.add({ type: "horizontal", entity: "l1" });
    expect(t.gain({ type: "horizontal", entity: "l1" })).toBe(0);
    expect(t.dof()).toBe(3);
  });
});

describe("fully define", () => {
  /** Adds what Fully Define proposes; checks nothing moved and nothing is left free. */
  function check(entities: SketchEntity[], constraints: Constraint[] = [], opts = {}) {
    const r = fullyDefine(entities, constraints, opts);
    const all = [...constraints, ...r.add];
    expect(r.dof).toBe(0);
    expect(sketchStatus(entities, all).dof).toBe(0);
    // Measured from the geometry: it all holds as it is.
    expect(checkConstraints(entities, all)).toEqual([]);
    const s = solveSketch(entities, all);
    if (!s.ok) throw new Error(s.error);
    // Nothing moved (values are kept to a billionth of a mm).
    const nums = (es: SketchEntity[]) => JSON.stringify(es).match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
    nums(s.entities).forEach((v, i) => expect(Math.abs(v - nums(entities)[i])).toBeLessThan(1e-8));
    expect(redundantConstraints(entities, all).some(Boolean)).toBe(false);
    return r.add;
  }

  it("defines a closed rectangle of lines: level and plumb relations, two sizes, one corner placed", () => {
    const made = place(toolByName("rect")!, [{ p: [10, 5], ref: null }, { p: [50, 25], ref: null }], {}, { entities: [] })!;
    const add = check(made.entities, made.relations);
    expect(add).toEqual([
      { type: "distance", entity: "l1", value: 40 },
      { type: "distance", entity: "l2", value: 20 },
      { type: "distanceX", points: ["origin", "l1.start"], value: 10 },
      { type: "distanceY", points: ["origin", "l1.start"], value: 5 },
    ]);
  });

  it("adds relations the geometry already has, then dimensions from the origin", () => {
    const es = [line("l1", [0, 0], [30, 0]), line("l2", [30, 0], [30, 20]), circle("c1", [15, 10], 4)];
    const add = check(es);
    expect(add).toContainEqual({ type: "horizontal", entity: "l1" });
    expect(add).toContainEqual({ type: "vertical", entity: "l2" });
    expect(add).toContainEqual({ type: "coincident", points: ["origin", "l1.start"] });
    expect(add).toContainEqual({ type: "coincident", points: ["l1.end", "l2.start"] });
    expect(add).toContainEqual({ type: "diameter", entity: "c1", value: 8 });
  });

  it("measures from a chosen datum point", () => {
    const es = [line("l1", [5, 5], [25, 5]), circle("c1", [15, 15], 3)];
    const add = check(es, [], { datum: "l1.start" });
    expect(add).toContainEqual({ type: "distanceX", points: ["origin", "l1.start"], value: 5 });
    expect(add).toContainEqual({ type: "distanceX", points: ["l1.start", "c1.center"], value: 10 });
    expect(add).toContainEqual({ type: "distanceY", points: ["l1.start", "c1.center"], value: 10 });
  });

  it("defines arcs, slanted lines, points and a slot (held where no dimension reaches)", () => {
    const es: SketchEntity[] = [
      { id: "a1", type: "arc", center: [0, 0], start: [10, 0], end: [0, 10] },
      line("l1", [20, 0], [30, 7]),
      point("p1", [-5, 12]),
      { id: "s1", type: "slot", center1: [0, -20], center2: [20, -20], width: 6 },
    ];
    check(es);
  });

  it("leaves a fully defined sketch alone, and an empty one", () => {
    expect(fullyDefine([], [])).toEqual({ add: [], dof: 0 });
    const es = [circle("c1", [0, 0], 5)];
    const ks: Constraint[] = [{ type: "coincident", points: ["c1.center", "origin"] }, { type: "radius", entity: "c1", value: 5 }];
    expect(fullyDefine(es, ks)).toEqual({ add: [], dof: 0 });
  });
});
