// The sketch tool registry (Phase O): every drawing tool builds plain lines,
// arcs, circles and points held in shape by relations, so the result trims,
// fillets and dimensions like anything else and keeps its shape under a drag
// with only its natural degrees of freedom left; the clicks' snaps become
// relations; and the registry's commands, icons and test ids hang together.

import { describe, expect, it } from "vitest";
import type { Constraint, LineEntity, SketchEntity, Vec2 } from "../src/doc/types";
import { checkConstraints } from "../src/geom/constraints";
import { buildProfile } from "../src/geom/profile";
import { sketchStatus, solveSketch, wouldOverDefine } from "../src/geom/solver";
import { ICON_NAMES } from "../src/ui/icons";
import { COMMANDS } from "../src/ui/input";
import { flyoutChoice, remember } from "../src/ui/sketcher/tools/memory";
import { polygonCorners } from "../src/ui/sketcher/tools/polygon";
import { clickRelations, idMaker, optionValues, place, previewOf, SKETCH_TOOLS, snapClick, toolbarEntries, toolByName, type Placement } from "../src/ui/sketcher/tools/run";
import type { Click, ToolOptions } from "../src/ui/sketcher/tools/types";

const at = (...pts: Vec2[]): Click[] => pts.map((p) => ({ p, ref: null }));
const tool = (name: string) => {
  const def = toolByName(name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
};

/** Places a tool's clicks on an empty sketch (or the given one), as the canvas would. */
function draw(name: string, clicks: Click[], options: ToolOptions = {}, entities: SketchEntity[] = [], trail?: Vec2[]): Placement {
  const made = place(tool(name), clicks, options, { entities, trail });
  if (!made) throw new Error(`${name} made nothing`);
  return made;
}

/** Coordinates to 9 decimals, so built geometry compares exactly with what the formulas say. */
function tidy<T>(x: T): T {
  return JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "number" ? Math.round(v * 1e9) / 1e9 + 0 : v)));
}

/** The shape's own relations hold, none repeats another, and this many degrees of freedom are left. */
function expectSound(made: Placement, dof: number, base: SketchEntity[] = [], baseRelations: Constraint[] = []) {
  const entities = [...base, ...made.entities];
  const relations = [...baseRelations, ...made.relations];
  expect(checkConstraints(entities, relations)).toEqual([]);
  relations.forEach((k, i) => expect(wouldOverDefine(entities, relations.filter((_, j) => j !== i), k), JSON.stringify(k)).toBe(false));
  expect(sketchStatus(entities, relations).dof).toBe(dof);
}

/** Drags a handle and checks every relation still holds; returns the moved geometry. */
function dragged(made: Placement, handle: string, from: Vec2, to: Vec2, extra: Constraint[] = []): SketchEntity[] {
  const relations = [...made.relations, ...extra];
  const r = solveSketch(made.entities, relations, { drag: [{ handle, from, to }] });
  if (!r.ok) throw new Error(r.error);
  expect(checkConstraints(r.entities, relations)).toEqual([]);
  return r.entities;
}

/** The profile's area; it must be one. */
function area(es: SketchEntity[]): number {
  const r = buildProfile(es);
  if (!r.ok) throw new Error(r.error);
  return r.area;
}

const lines = (es: SketchEntity[]) => es.filter((e): e is LineEntity => e.type === "line" && !e.construction);
const len = (l: LineEntity) => Math.hypot(l.end[0] - l.start[0], l.end[1] - l.start[1]);
const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

describe("degrees of freedom: what each shape can still do", () => {
  it.each([
    ["line", at([0, 0], [30, 10]), {}, 4],
    ["centerline", at([0, 0], [30, 10]), {}, 4],
    ["midpoint-line", at([5, 5], [30, 10]), {}, 4],
    ["rect", at([-30, -10], [20, 15]), {}, 4],
    ["rect-center", at([3, 4], [20, 15]), {}, 4],
    ["rect3", at([0, 0], [30, 10], [20, 30]), {}, 5],
    ["parallelogram", at([0, 0], [30, 5], [40, 25]), {}, 6],
    ["polygon", at([1, 2], [21, 7]), { sides: 6 }, 4],
    ["polygon", at([1, 2], [21, 7]), { sides: 5, mode: "circumscribed" }, 4],
    ["polygon", at([1, 2], [21, 7]), { sides: 8, mode: "circumscribed" }, 4],
    ["polygon", at([1, 2], [21, 7]), { sides: 3 }, 4],
    ["polygon", at([1, 2], [21, 7]), { sides: 40 }, 4],
    ["circle", at([0, 0], [10, 0]), {}, 3],
    ["circle3", at([0, 0], [10, 3], [4, 12]), {}, 3],
    ["arc", at([0, 0], [10, 0], [0, 10]), {}, 5],
    ["arc3", at([0, 0], [20, 0], [10, 6]), {}, 5],
    ["slot", at([0, 0], [30, 10], [10, 12]), {}, 5],
    ["slot", at([0, 0], [30, 10], [10, 12]), { length: "overall" }, 5],
    ["slot-center", at([0, 0], [30, 10], [10, 12]), {}, 5],
    ["point", at([3, 4]), {}, 2],
  ] as [string, Click[], ToolOptions, number][])("%s leaves %#", (name, clicks, options, dof) => {
    expectSound(draw(name, clicks, options), dof);
  });

  it("a tangent arc off a line adds 2 to the line's 4: where it ends (the bend follows)", () => {
    const base: SketchEntity[] = [{ id: "l1", type: "line", start: [0, 0], end: [10, 0] }];
    const made = draw("tangent-arc", [{ p: [10, 0], ref: "l1.end" }, { p: [20, 10], ref: null }], {}, base);
    const all = [...made.relations, ...made.inferred];
    expectSound({ ...made, relations: all }, 4 + 2, base);
  });
});

describe("Line ▾", () => {
  it("a line runs from click to click and carries on from its end", () => {
    const made = draw("line", at([0, 0], [30, 10]));
    expect(made.entities).toEqual([{ id: "l1", type: "line", start: [0, 0], end: [30, 10] }]);
    expect(made.relations).toEqual([]);
    expect(made.inferred).toEqual([]);
    expect(made.first).toBe("l1.start");
    expect(made.next).toEqual({ p: [30, 10], ref: "l1.end" });
  });

  it("a level or plumb line says so; one drawn on from a point is coincident with it", () => {
    expect(draw("line", at([0, 0], [30, 0])).inferred).toEqual([{ type: "horizontal", entity: "l1" }]);
    expect(draw("line", at([5, 0], [5, 20])).inferred).toEqual([{ type: "vertical", entity: "l1" }]);
    const base: SketchEntity[] = [{ id: "l1", type: "line", start: [0, 0], end: [10, 0] }];
    const made = draw("line", [{ p: [10, 0], ref: "l1.end" }, { p: [10, 15], ref: null, orient: "vertical" }], {}, base);
    expect(made.entities[0].id).toBe("l2");
    expect(made.inferred).toEqual([
      { type: "coincident", points: ["l2.start", "l1.end"] },
      { type: "vertical", entity: "l2" },
    ]);
  });

  it("a centreline is a construction line", () => {
    expect(draw("centerline", at([0, 0], [0, 40])).entities).toEqual([{ id: "l1", type: "line", start: [0, 0], end: [0, 40], construction: true }]);
  });

  it("a midpoint line runs the same length both ways from its first click; clicked on a point, that point is its midpoint", () => {
    const made = draw("midpoint-line", at([5, 5], [30, 10]));
    // The far end mirrors the second click through the first: 2 x [5,5] - [30,10].
    expect(made.entities).toEqual([{ id: "l1", type: "line", start: [-20, 0], end: [30, 10] }]);
    const onOrigin = draw("midpoint-line", [{ p: [0, 0], ref: "origin" }, { p: [20, 0], ref: null }]);
    expect(onOrigin.inferred).toEqual([
      { type: "midpoint", point: "origin", entity: "l1" },
      { type: "horizontal", entity: "l1" },
    ]);
    // Midpoint at the origin and level: only its length is left.
    expectSound({ ...onOrigin, relations: onOrigin.inferred }, 1);
  });

  it("makes nothing of two clicks in one place", () => {
    expect(place(tool("line"), at([1, 1], [1, 1]), {}, { entities: [] })).toBeNull();
    expect(place(tool("midpoint-line"), at([1, 1], [1, 1]), {}, { entities: [] })).toBeNull();
  });
});

describe("Rectangle ▾", () => {
  const corners: Vec2[] = [
    [-30, -10],
    [20, -10],
    [20, 15],
    [-30, 15],
  ];
  const box = (ids: string[]) =>
    ids.map((id, i) => ({ id, type: "line", start: corners[i], end: corners[(i + 1) % 4] }));
  const joined = (ids: string[]): Constraint[] => ids.map((id, i) => ({ type: "coincident", points: [`${id}.end`, `${ids[(i + 1) % 4]}.start`] }));

  it("corner rectangle: four lines anticlockwise from the bottom left, joined, level and plumb", () => {
    const ids = ["l1", "l2", "l3", "l4"];
    for (const clicks of [at([-30, -10], [20, 15]), at([20, 15], [-30, -10]), at([-30, 15], [20, -10])]) {
      const made = draw("rect", clicks);
      expect(made.entities).toEqual(box(ids));
      expect(made.relations).toEqual([
        ...joined(ids),
        { type: "horizontal", entity: "l1" },
        { type: "vertical", entity: "l2" },
        { type: "horizontal", entity: "l3" },
        { type: "vertical", entity: "l4" },
      ]);
    }
    expect(buildProfile(draw("rect", at([-30, -10], [20, 15])).entities)).toMatchObject({ ok: true, area: 50 * 25 });
  });

  it("corner rectangle: a corner clicked on a point is coincident with it", () => {
    const made = draw("rect", [{ p: [0, 0], ref: "origin" }, { p: [20, 10], ref: null }]);
    expect(made.inferred).toEqual([{ type: "coincident", points: ["l1.start", "origin"] }]);
    // Pinned at a corner: width and height are left.
    expectSound({ ...made, relations: [...made.relations, ...made.inferred] }, 2);
  });

  it("corner rectangle keeps square under a corner drag, the opposite corner can stay", () => {
    const made = draw("rect", [{ p: [0, 0], ref: "origin" }, { p: [20, 10], ref: null }]);
    const moved = dragged(made, "l2.end", [20, 10], [35, 22], made.inferred);
    expect(tidy(lines(moved).map((l) => l.start))).toEqual([
      [0, 0],
      [35, 0],
      [35, 22],
      [0, 22],
    ]);
  });

  it("centre rectangle: four lines, two construction diagonals and a point at the middle of them", () => {
    const made = draw("rect-center", at([3, 4], [20, 15]));
    // Half sizes 17 and 11 about [3, 4].
    const c: Vec2[] = [
      [-14, -7],
      [20, -7],
      [20, 15],
      [-14, 15],
    ];
    expect(made.entities).toEqual([
      ...["l1", "l2", "l3", "l4"].map((id, i) => ({ id, type: "line", start: c[i], end: c[(i + 1) % 4] })),
      { id: "l5", type: "line", start: c[0], end: c[2], construction: true },
      { id: "l6", type: "line", start: c[1], end: c[3], construction: true },
      { id: "p1", type: "point", at: [3, 4] },
    ]);
    expect(made.relations.slice(8)).toEqual([
      { type: "coincident", points: ["l5.start", "l1.start"] },
      { type: "coincident", points: ["l5.end", "l3.start"] },
      { type: "coincident", points: ["l6.start", "l2.start"] },
      { type: "coincident", points: ["l6.end", "l4.start"] },
      { type: "midpoint", point: "p1.at", entity: "l5" },
    ]);
    expect(made.first).toBe("p1.at");
    // The diagonals are construction and the point is no profile: one region, 34 x 22.
    expect(buildProfile(made.entities)).toMatchObject({ ok: true, area: 34 * 22 });
  });

  it("centre rectangle on the origin stays centred there when a corner is dragged", () => {
    const made = draw("rect-center", [{ p: [0, 0], ref: "origin" }, { p: [20, 10], ref: null }]);
    expect(made.inferred).toEqual([{ type: "coincident", points: ["p1.at", "origin"] }]);
    const relations = [...made.relations, ...made.inferred];
    expectSound({ ...made, relations }, 2);
    const moved = dragged(made, "l3.start", [20, 10], [30, 25], made.inferred);
    const sides = lines(moved);
    // Symmetric about the origin: the corners are ±x, ±y.
    expect(near(sides[0].start, [-sides[2].start[0], -sides[2].start[1]])).toBe(true);
    expect(near(sides[1].start, [-sides[3].start[0], -sides[3].start[1]])).toBe(true);
    expect(sides[0].start[1]).toBeCloseTo(sides[1].start[1], 9);
  });

  it("3-point rectangle: the first side, then square across to the third click", () => {
    const made = draw("rect3", at([0, 0], [30, 0], [20, 10]));
    expect(made.entities).toEqual([
      { id: "l1", type: "line", start: [0, 0], end: [30, 0] },
      { id: "l2", type: "line", start: [30, 0], end: [30, 10] },
      { id: "l3", type: "line", start: [30, 10], end: [0, 10] },
      { id: "l4", type: "line", start: [0, 10], end: [0, 0] },
    ]);
    expect(made.relations.slice(4)).toEqual([
      { type: "perpendicular", entities: ["l1", "l2"] },
      { type: "parallel", entities: ["l1", "l3"] },
      { type: "parallel", entities: ["l2", "l4"] },
    ]);
    // Drawn level, it says so: no turn left.
    expect(made.inferred).toEqual([{ type: "horizontal", entity: "l1" }]);
  });

  it("3-point rectangle at an angle keeps square corners when dragged", () => {
    const made = draw("rect3", at([0, 0], [30, 10], [20, 30]));
    const moved = lines(dragged(made, "l2.start", [30, 10], [25, 25]));
    for (let i = 0; i < 4; i++) {
      const a = moved[i];
      const b = moved[(i + 1) % 4];
      const da = [a.end[0] - a.start[0], a.end[1] - a.start[1]];
      const db = [b.end[0] - b.start[0], b.end[1] - b.start[1]];
      expect((da[0] * db[0] + da[1] * db[1]) / (len(a) * len(b))).toBeCloseTo(0, 9);
    }
  });

  it("parallelogram: three corners; the fourth makes the opposite sides parallel", () => {
    const made = draw("parallelogram", at([0, 0], [30, 0], [40, 20]));
    // d = a + c - b.
    expect(made.entities.map((e) => (e as LineEntity).start)).toEqual([
      [0, 0],
      [30, 0],
      [40, 20],
      [10, 20],
    ]);
    expect(made.relations.slice(4)).toEqual([
      { type: "parallel", entities: ["l1", "l3"] },
      { type: "parallel", entities: ["l2", "l4"] },
    ]);
    expect(made.inferred).toEqual([{ type: "horizontal", entity: "l1" }]);
    expect(buildProfile(made.entities)).toMatchObject({ ok: true, area: 30 * 20 });
  });

  it("makes nothing flat", () => {
    expect(place(tool("rect"), at([0, 0], [10, 0]), {}, { entities: [] })).toBeNull();
    expect(place(tool("rect3"), at([0, 0], [10, 0], [20, 0]), {}, { entities: [] })).toBeNull();
    expect(place(tool("parallelogram"), at([0, 0], [10, 0], [20, 0]), {}, { entities: [] })).toBeNull();
  });
});

describe("Polygon", () => {
  const S3 = Math.sqrt(3);

  it("inscribed hexagon: the corners on a construction circle, equal sides, the lowest level side level", () => {
    const made = draw("polygon", at([0, 0], [10, 0]), { sides: 6 });
    // Corners every 60° from the click, radius 10.
    const c: Vec2[] = [0, 1, 2, 3, 4, 5].map((k) => [10 * Math.cos((k * Math.PI) / 3), 10 * Math.sin((k * Math.PI) / 3)]);
    expect(tidy(made.entities)).toEqual(
      tidy([
        ...c.map((p, i) => ({ id: `l${i + 1}`, type: "line", start: p, end: c[(i + 1) % 6] })),
        { id: "c1", type: "circle", center: [0, 0], radius: 10, construction: true },
      ]),
    );
    expect(made.relations.slice(6)).toEqual([
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ type: "pointOn", point: `l${i}.start`, entity: "c1" })),
      ...[2, 3, 4, 5, 6].map((i) => ({ type: "equal", entities: ["l1", `l${i}`] })),
    ]);
    expect(made.inferred).toEqual([{ type: "horizontal", entity: "l5" }]);
    // Area of a regular hexagon: 3√3/2 · r².
    expect(area(made.entities)).toBeCloseTo((3 * S3 * 100) / 2, 9);
    // Level, it can still move and grow: 3 degrees of freedom.
    expectSound({ ...made, relations: [...made.relations, ...made.inferred] }, 3);
  });

  it("circumscribed: the sides touch the circle clicked; the corners are further out", () => {
    const made = draw("polygon", at([0, 0], [10, 0]), { sides: 6, mode: "circumscribed" });
    const circles = made.entities.filter((e) => e.type === "circle");
    // Across flats 20, so the corners are at 10 / cos 30°.
    expect(tidy(circles)).toEqual(
      tidy([
        { id: "c1", type: "circle", center: [0, 0], radius: 10, construction: true },
        { id: "c2", type: "circle", center: [0, 0], radius: 20 / S3, construction: true },
      ]),
    );
    expect(made.relations).toContainEqual({ type: "concentric", entities: ["c1", "c2"] });
    expect(made.relations).toContainEqual({ type: "tangent", entities: ["l1", "c1"] });
    // Its first side is plumb at x = 10; the leftmost plumb side is held plumb.
    expect(tidy((made.entities[0] as LineEntity).start)).toEqual(tidy([10, -10 / S3]));
    expect(made.inferred).toEqual([{ type: "vertical", entity: "l4" }]);
    // Hexagon across flats f: (√3/2) f².
    expect(area(made.entities)).toBeCloseTo((S3 / 2) * 400, 9);
  });

  it("stays regular when a corner is dragged", () => {
    const made = draw("polygon", at([5, 5], [15, 7]), { sides: 5 });
    const moved = lines(dragged(made, "l3.start", (made.entities[2] as LineEntity).start, [0, 20]));
    const l0 = len(moved[0]);
    for (const l of moved) expect(len(l)).toBeCloseTo(l0, 9);
  });

  it("on the origin with a side level, a corner dragged anywhere resizes it: the corner goes as near the pointer as it can", () => {
    const made = draw("polygon", [{ p: [0, 0], ref: "origin" }, { p: [20, 0], ref: null }], { sides: 6 });
    // The corner clicked can only move along the x axis now (the size is all that is left).
    const relations = [...made.relations, ...made.inferred];
    expect(sketchStatus(made.entities, relations).dof).toBe(1);
    const moved = lines(dragged(made, "l1.start", [20, 0], [25, 10], made.inferred));
    expect(moved[0].start[0]).toBeCloseTo(25, 5);
    expect(moved[0].start[1]).toBeCloseTo(0, 9);
    const side = len(moved[0]);
    expect(side).toBeCloseTo(25, 5);
    for (const l of moved) expect(len(l)).toBeCloseTo(side, 9);
  });

  it("takes 3 to 40 sides; anything else is pulled back in", () => {
    const def = tool("polygon");
    expect(optionValues(def, {})).toEqual({ sides: 6, mode: "inscribed" });
    expect(optionValues(def, { sides: 2, mode: "x" })).toEqual({ sides: 3, mode: "inscribed" });
    expect(optionValues(def, { sides: 99.4, mode: "circumscribed" })).toEqual({ sides: 40, mode: "circumscribed" });
    expect(optionValues(def, { sides: 7.6 })).toEqual({ sides: 8, mode: "inscribed" });
    expect(polygonCorners([0, 0], [10, 0], { sides: 40 })).toHaveLength(40);
  });

  it("snaps a side level when the pointer is close, and says so", () => {
    const def = tool("polygon");
    const tilt = (2 * Math.PI) / 180;
    const s = snapClick(def, [[0, 0]], [10 * Math.cos(tilt), 10 * Math.sin(tilt)], { entities: [], tol: 1, grid: null, options: { sides: 6 } });
    expect(tidy(s)).toEqual({ p: [10, 0], ref: null, orient: "horizontal" });
    // Far from any level turn, the pointer stays where it is (off the grid).
    const free = snapClick(def, [[0, 0]], [10 * Math.cos(0.26), 10 * Math.sin(0.26)], { entities: [], tol: 1, grid: null, options: { sides: 6 } });
    expect(free.orient).toBeUndefined();
  });
});

describe("Circle ▾ and Arc ▾", () => {
  it("circle: the centre, then a point on it; a point clicked goes on the circle", () => {
    const made = draw("circle", [{ p: [0, 0], ref: "origin" }, { p: [10, 0], ref: "l1.end" }], {}, [{ id: "l1", type: "line", start: [20, 0], end: [10, 0] }]);
    expect(made.entities).toEqual([{ id: "c1", type: "circle", center: [0, 0], radius: 10 }]);
    expect(made.inferred).toEqual([
      { type: "coincident", points: ["c1.center", "origin"] },
      { type: "pointOn", point: "l1.end", entity: "c1" },
    ]);
  });

  it("perimeter circle: through three points", () => {
    const made = draw("circle3", at([10, 0], [0, 10], [-10, 0]));
    expect(tidy(made.entities)).toEqual([{ id: "c1", type: "circle", center: [0, 0], radius: 10 }]);
    expect(place(tool("circle3"), at([0, 0], [10, 0], [20, 0]), {}, { entities: [] })).toBeNull();
  });

  it("centrepoint arc: turns the way the pointer swept", () => {
    expect(tidy(draw("arc", at([0, 0], [10, 0], [0, 10])).entities)).toEqual([{ id: "a1", type: "arc", center: [0, 0], start: [10, 0], end: [0, 10] }]);
    // Swept the long way round, clockwise: [10,0] down through [0,-10] and [-10,0] to [0,10].
    const cw = draw("arc", at([0, 0], [10, 0], [0, 10]), {}, [], [[0, -10], [-10, 0]]);
    expect(tidy(cw.entities)).toEqual([{ id: "a1", type: "arc", center: [0, 0], start: [10, 0], end: [0, 10], clockwise: true }]);
    // The end lands on the circle through the start, in the direction clicked.
    expect(tidy((draw("arc", at([0, 0], [10, 0], [0, 3])).entities[0] as { end: Vec2 }).end)).toEqual([0, 10]);
  });

  it("3-point arc: the ends, then a point it passes through", () => {
    const made = draw("arc3", at([0, 0], [20, 0], [10, 6]));
    // Centre on x = 10 with 10² + y² = (6 − y)²: y = −64/12; radius 6 + 64/12.
    expect(tidy(made.entities)).toEqual(tidy([{ id: "a1", type: "arc", center: [10, -64 / 12], start: [0, 0], end: [20, 0], clockwise: true }]));
    expect(made.relations).toEqual([]);
    const under = draw("arc3", at([0, 0], [20, 0], [10, -6]));
    expect((under.entities[0] as { clockwise?: boolean }).clockwise).toBeUndefined();
  });

  it("tangent arc: from a line's end, carrying on, coincident and tangent", () => {
    const base: SketchEntity[] = [{ id: "l1", type: "line", start: [0, 0], end: [10, 0] }];
    const made = draw("tangent-arc", [{ p: [10, 0], ref: "l1.end" }, { p: [20, 10], ref: null }], {}, base);
    // Quarter circle: centre straight above the line's end, radius |pe|² / 2k = 200 / 20.
    expect(tidy(made.entities)).toEqual([{ id: "a1", type: "arc", center: [10, 10], start: [10, 0], end: [20, 10] }]);
    expect(made.relations).toEqual([{ type: "tangent", entities: ["a1", "l1"] }]);
    expect(made.inferred).toEqual([{ type: "coincident", points: ["a1.start", "l1.end"] }]);
    expect(made.next).toEqual({ p: [20, 10], ref: "a1.end" });
    // Heading back first turns it the other way: back along the line, then up to [0, 10].
    const back = draw("tangent-arc", [{ p: [10, 0], ref: "l1.end" }, { p: [0, 10], ref: null }], {}, base, [[8, 0.5]]);
    expect(tidy(back.entities)).toEqual([{ id: "a1", type: "arc", center: [10, 10], start: [10, 0], end: [0, 10], clockwise: true }]);
    expect(checkConstraints([...base, ...back.entities], [...back.relations, ...back.inferred])).toEqual([]);
  });

  it("tangent arc: only from an end, and on from an arc's end the way it turns", () => {
    const def = tool("tangent-arc");
    expect(def.accept!({ p: [5, 5], ref: null }, 0, { entities: [] })).toMatch(/starts at the end of a line or arc/);
    const base: SketchEntity[] = [{ id: "a1", type: "arc", center: [0, 0], start: [10, 0], end: [0, 10] }];
    expect(def.accept!({ p: [0, 10], ref: "a1.end" }, 0, { entities: base })).toBeNull();
    // Leaving [0,10] going −x (anticlockwise), to [-10, 0]: the same circle, on round.
    const made = draw("tangent-arc", [{ p: [0, 10], ref: "a1.end" }, { p: [-10, 0], ref: null }], {}, base);
    expect(tidy(made.entities)).toEqual([{ id: "a2", type: "arc", center: [0, 0], start: [0, 10], end: [-10, 0] }]);
  });
});

describe("Slot ▾", () => {
  it("straight slot: two lines and two arcs round a construction centreline", () => {
    const made = draw("slot", at([0, 0], [30, 0], [10, 5]));
    expect(made.entities).toEqual([
      { id: "l1", type: "line", start: [0, -5], end: [30, -5] },
      { id: "a1", type: "arc", center: [30, 0], start: [30, -5], end: [30, 5] },
      { id: "l2", type: "line", start: [30, 5], end: [0, 5] },
      { id: "a2", type: "arc", center: [0, 0], start: [0, 5], end: [0, -5] },
      { id: "l3", type: "line", start: [0, 0], end: [30, 0], construction: true },
    ]);
    expect(made.relations).toEqual([
      { type: "coincident", points: ["l1.end", "a1.start"] },
      { type: "coincident", points: ["a1.end", "l2.start"] },
      { type: "coincident", points: ["l2.end", "a2.start"] },
      { type: "coincident", points: ["a2.end", "l1.start"] },
      { type: "coincident", points: ["a1.center", "l3.end"] },
      { type: "coincident", points: ["a2.center", "l3.start"] },
      { type: "tangent", entities: ["l1", "a1"] },
      { type: "tangent", entities: ["l1", "a2"] },
      { type: "tangent", entities: ["l2", "a1"] },
      { type: "tangent", entities: ["l2", "a2"] },
      { type: "equal", entities: ["a1", "a2"] },
    ]);
    expect(made.inferred).toEqual([{ type: "horizontal", entity: "l3" }]);
    // 30 x 10 between the arcs, and a full circle of radius 5 from the two ends.
    expect(area(made.entities)).toBeCloseTo(300 + Math.PI * 25, 9);
  });

  it("overall length: the clicks are the slot's ends, not its arc centres", () => {
    const made = draw("slot", at([0, 0], [30, 0], [10, 5]), { length: "overall" });
    expect(made.entities[4]).toEqual({ id: "l3", type: "line", start: [5, 0], end: [25, 0], construction: true });
    expect(area(made.entities)).toBeCloseTo(200 + Math.PI * 25, 9);
    // Shorter than it is wide: nothing.
    expect(place(tool("slot"), at([0, 0], [8, 0], [4, 5]), { length: "overall" }, { entities: [] })).toBeNull();
  });

  it("keeps its shape when an arc centre is dragged", () => {
    const made = draw("slot", at([0, 0], [30, 0], [10, 5]));
    const moved = dragged(made, "l3.end", [30, 0], [40, 20]);
    const [l1, a1, l2, a2, l3] = moved as [LineEntity, { center: Vec2; start: Vec2 }, LineEntity, { center: Vec2; start: Vec2 }, LineEntity];
    const r = (a: { center: Vec2; start: Vec2 }) => Math.hypot(a.start[0] - a.center[0], a.start[1] - a.center[1]);
    // Still a slot: equal ends, sides as long as the centreline and a diameter apart.
    expect(near(l3.end, [40, 20])).toBe(true);
    expect(r(a1)).toBeCloseTo(r(a2), 6);
    expect(len(l1)).toBeCloseTo(len(l3), 6);
    expect(len(l2)).toBeCloseTo(len(l3), 6);
    expect(Math.hypot(l1.start[0] - l2.end[0], l1.start[1] - l2.end[1])).toBeCloseTo(2 * r(a1), 6);
  });

  it("centrepoint slot: from a point at its middle, the same both ways", () => {
    const made = draw("slot-center", [{ p: [0, 0], ref: "origin" }, { p: [15, 0], ref: null }, { p: [5, 5], ref: null }]);
    expect(made.entities[4]).toEqual({ id: "l3", type: "line", start: [-15, 0], end: [15, 0], construction: true });
    expect(made.entities[5]).toEqual({ id: "p1", type: "point", at: [0, 0] });
    expect(made.relations.at(-1)).toEqual({ type: "midpoint", point: "p1.at", entity: "l3" });
    expect(made.inferred).toEqual([
      { type: "coincident", points: ["p1.at", "origin"] },
      { type: "horizontal", entity: "l3" },
    ]);
    // Centred and level: its length and width are left.
    expectSound({ ...made, relations: [...made.relations, ...made.inferred] }, 2);
  });
});

describe("Point", () => {
  it("a point where clicked; on a line's middle it is that line's midpoint", () => {
    expect(draw("point", at([3, 4])).entities).toEqual([{ id: "p1", type: "point", at: [3, 4] }]);
    const base: SketchEntity[] = [{ id: "l1", type: "line", start: [0, 0], end: [10, 0] }];
    const made = draw("point", [{ p: [5, 0], ref: null, on: { type: "midpoint", entity: "l1" } }], {}, base);
    expect(made.inferred).toEqual([{ type: "midpoint", point: "p1.at", entity: "l1" }]);
  });

  it("adds nothing on a sketch point (a double-click lands twice), but sits on a line's end", () => {
    const base: SketchEntity[] = [
      { id: "p1", type: "point", at: [3, 4] },
      { id: "l1", type: "line", start: [0, 0], end: [10, 0] },
    ];
    expect(place(tool("point"), [{ p: [3, 4], ref: "p1.at" }], {}, { entities: base })).toBeNull();
    expect(draw("point", [{ p: [10, 0], ref: "l1.end" }], {}, base).inferred).toEqual([{ type: "coincident", points: ["p2.at", "l1.end"] }]);
  });

  it("never turns construction", () => {
    expect(place(tool("point"), at([1, 1]), {}, { entities: [] }, true)!.entities).toEqual([{ id: "p1", type: "point", at: [1, 1] }]);
    expect(place(tool("rect-center"), at([0, 0], [5, 5]), {}, { entities: [] }, true)!.entities.every((e) => e.type === "point" || e.construction)).toBe(true);
  });
});

describe("running tools", () => {
  it("new ids never take one the sketch has", () => {
    const ids = idMaker([{ id: "l1" }, { id: "l3" }, { id: "p1" }]);
    expect([ids("l"), ids("l"), ids("l"), ids("p"), ids("c")]).toEqual(["l2", "l4", "l5", "p2", "c1"]);
  });

  it("turns each click's snap into a relation by what the shape has there", () => {
    const clicks: Click[] = [
      { p: [0, 0], ref: "origin" },
      { p: [5, 0], ref: null, on: { type: "pointOn", entity: "l9" } },
      { p: [1, 1], ref: "c1.center" },
      { p: [2, 2], ref: "l7.end" },
      { p: [3, 3], ref: null },
    ];
    expect(clickRelations([{ point: "l1.start" }, { point: "l1.end" }, { on: "c2" }, { middle: "l2" }, { point: "l3.end" }], clicks)).toEqual([
      { type: "coincident", points: ["l1.start", "origin"] },
      { type: "pointOn", point: "l1.end", entity: "l9" },
      { type: "pointOn", point: "c1.center", entity: "c2" },
      { type: "midpoint", point: "l7.end", entity: "l2" },
    ]);
  });

  it("snaps a line's end level with its start, onto points, and to the grid", () => {
    const def = tool("line");
    const ctx = { entities: [] as SketchEntity[], tol: 1, grid: 1, options: {} };
    expect(snapClick(def, [[0, 0]], [30.2, 0.4], ctx)).toEqual({ p: [30, 0], ref: null, orient: "horizontal" });
    expect(snapClick(def, [[0, 0]], [12.3, 20.6], ctx)).toEqual({ p: [12, 21], ref: null });
    expect(snapClick(def, [], [0.3, -0.2], ctx)).toEqual({ p: [0, 0], ref: "origin" });
    const base: SketchEntity[] = [{ id: "p1", type: "point", at: [7, 7] }];
    expect(snapClick(def, [], [7.2, 6.9], { ...ctx, entities: base })).toEqual({ p: [7, 7], ref: "p1.at" });
  });

  it("previews the rubber band: the first side of a 3-point rectangle, the whole slot once its width is in", () => {
    expect(previewOf(tool("rect3"), at([0, 0], [10, 0]), {}, { entities: [] })).toHaveLength(1);
    expect(previewOf(tool("slot"), at([0, 0], [30, 0], [10, 5]), {}, { entities: [] })).toHaveLength(5);
    // Preview ids never clash with the sketch's.
    expect(previewOf(tool("rect"), at([0, 0], [10, 10]), {}, { entities: [] }).every((e) => e.id.startsWith("preview-"))).toBe(true);
  });
});

describe("the registry", () => {
  it("each tool is a live command with an icon, and its prompts match its clicks", () => {
    const names = new Set<string>();
    for (const t of SKETCH_TOOLS) {
      const cmd = COMMANDS.find((c) => c.id === t.id);
      expect(cmd, t.id).toBeDefined();
      expect(cmd!.planned, t.id).toBeUndefined();
      expect(cmd!.group).toBe("Sketch");
      expect(ICON_NAMES, t.name).toContain(t.icon);
      expect(t.prompts, t.name).toHaveLength(t.clicks);
      expect(names.has(t.name), t.name).toBe(false);
      names.add(t.name);
    }
  });

  it("keeps the first tools' test ids, and groups the toolbar into SOLIDWORKS's flyouts", () => {
    for (const n of ["line", "rect", "circle", "arc", "slot"]) expect(toolByName(n)?.id).toBe(`sketch.${n}`);
    expect(toolbarEntries().map((e) => (e.kind === "flyout" ? `${e.flyout.label}: ${e.tools.map((t) => t.name).join(" ")}` : e.tool.name))).toEqual([
      "Line: line centerline midpoint-line",
      "Rectangle: rect rect-center rect3 parallelogram",
      "Circle: circle circle3",
      "Arc: arc tangent-arc arc3",
      "Slot: slot slot-center",
      "polygon",
      "point",
    ]);
  });

  it("a flyout shows the tool used from it last", () => {
    const empty = { flyouts: {}, options: {} };
    expect(flyoutChoice(empty, "rect", SKETCH_TOOLS).name).toBe("rect");
    const m = remember(empty, tool("rect3"));
    expect(flyoutChoice(m, "rect", SKETCH_TOOLS).name).toBe("rect3");
    expect(flyoutChoice({ flyouts: { rect: "gone" }, options: {} }, "rect", SKETCH_TOOLS).name).toBe("rect");
    expect(remember(m, tool("point"))).toEqual(m);
  });
});
