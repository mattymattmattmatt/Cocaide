// Mirror entities (with the symmetric relation for lines, arcs and circles),
// linear and circular sketch patterns, move / copy / rotate / scale, and
// check sketch for feature (src/geom/sketchEdit): exact coordinates, the
// relations they leave, and that the one driving dimension moves them all.

import { describe, expect, it } from "vitest";
import type { Constraint, SketchEntity, Vec2 } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { removeEntities } from "../src/doc/sketch";
import { checkConstraints } from "../src/geom/constraints";
import { buildProfile } from "../src/geom/profile";
import { sketchDof, solveSketch, wouldOverDefine } from "../src/geom/solver";
import { mirrorEntities, reflectPoint } from "../src/geom/sketchEdit/mirror";
import { circularPattern, linearPattern, patternPlaces } from "../src/geom/sketchEdit/pattern";
import { angleBetween, transformEntities } from "../src/geom/sketchEdit/transform";
import { checkSketch, fixAll, fixProblem, problemSummary } from "../src/geom/sketchEdit/check";
import type { Edit, SketchState } from "../src/geom/sketchEdit/relations";

type Line = Extract<SketchEntity, { type: "line" }>;
type Arc = Extract<SketchEntity, { type: "arc" }>;
type Circle = Extract<SketchEntity, { type: "circle" }>;
const ok = (r: Edit | string): Edit => {
  if (typeof r === "string") throw new Error(r);
  return r;
};
const get = <T extends SketchEntity>(s: { entities: SketchEntity[] }, id: string) => s.entities.find((e) => e.id === id) as T;
const close = (a: number[], b: number[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));
};
/** Commits an edit as the sketcher does: its relations, then each soft one that adds something, solved. */
function commit(r: Edit): SketchState {
  const constraints = [...r.constraints];
  for (const k of r.soft ?? []) if (!wouldOverDefine(r.entities, constraints, k)) constraints.push(k);
  const s = solveSketch(r.entities, constraints);
  if (!s.ok) throw new Error(s.error);
  return { entities: s.entities, constraints };
}
const line = (id: string, start: Vec2, end: Vec2, extra: Partial<Line> = {}): SketchEntity => ({ id, type: "line", start, end, ...extra });

describe("mirror entities", () => {
  /** A half profile right of the Y axis: an L from (0, 0) out to (20, 0), up to (20, 10), a quarter arc and a circle, with a centreline on Y. */
  const half = (): SketchState => ({
    entities: [
      line("l1", [0, 0], [20, 0]),
      line("l2", [20, 0], [20, 10]),
      { id: "a1", type: "arc", center: [20, 20], start: [20, 10], end: [30, 20] },
      { id: "c1", type: "circle", center: [10, 5], radius: 2 },
      line("l3", [0, -5], [0, 30], { construction: true }),
      { id: "p1", type: "point", at: [5, 25] },
    ],
    constraints: [
      { type: "coincident", points: ["l1.end", "l2.start"] },
      { type: "coincident", points: ["l2.end", "a1.start"] },
      { type: "horizontal", entity: "l1" },
      { type: "vertical", entity: "l2" },
      { type: "radius", entity: "c1", value: 2 },
    ],
  });

  it("reflects points about any line", () => {
    close(reflectPoint([3, 1], [[0, 0], [1, 1]]), [1, 3]);
    close(reflectPoint([5, 2], [[0, -5], [0, 30]]), [-5, 2]);
  });

  it("copies about a centreline: exact mirror images, held by symmetric relations, ends on the line joined", () => {
    const r = ok(mirrorEntities(half(), ["l1", "l2", "a1", "c1", "p1"], "l3"));
    expect(r.made).toEqual(["l4", "l5", "a2", "c2", "p2"]);
    close([...get<Line>(r, "l4").start, ...get<Line>(r, "l4").end], [0, 0, -20, 0]);
    close([...get<Line>(r, "l5").start, ...get<Line>(r, "l5").end], [-20, 0, -20, 10]);
    // An arc reverses in a mirror: its image starts at the image of its end, and still turns anticlockwise.
    const a2 = get<Arc>(r, "a2");
    close([...a2.center, ...a2.start, ...a2.end], [-20, 20, -30, 20, -20, 10]);
    expect(a2.clockwise).toBeUndefined();
    close([...get<Circle>(r, "c2").center, get<Circle>(r, "c2").radius], [-10, 5, 2]);
    expect(r.constraints).toEqual(
      expect.arrayContaining([
        { type: "symmetric", entities: ["l1", "l4"], line: "l3" },
        { type: "symmetric", entities: ["a1", "a2"], line: "l3" },
        { type: "symmetric", entities: ["c1", "c2"], line: "l3" },
        { type: "symmetric", points: ["p1.at", "p2.at"], line: "l3" },
      ]),
    );
    // l1's start is on the centreline: its image's start lands on it and the two join.
    expect(r.soft).toEqual([{ type: "coincident", points: ["l1.start", "l4.start"] }]);
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
  });

  it("solves the symmetric relation: moving an original moves its image, and the image adds no freedom", () => {
    const base = half();
    const r = commit(ok(mirrorEntities(base, ["l1", "l2", "a1", "c1"], "l3")));
    expect(sketchDof(r.entities, r.constraints)).toBe(sketchDof(base.entities, base.constraints) - 1 /* l1.start now on the centreline */);
    // Drag l2 out to x = 25: l5 follows to x = −25; the circle's radius change follows too.
    const k = [...r.constraints, { type: "distance", points: ["l1.start", "l1.end"], value: 25 } as Constraint];
    const s = solveSketch(r.entities, k.map((c) => (c.type === "radius" ? { ...c, value: 3 } : c)));
    if (!s.ok) throw new Error(s.error);
    const l1 = get<Line>(s, "l1");
    const l4 = get<Line>(s, "l4");
    expect(l1.end[0] - l1.start[0]).toBeCloseTo(25, 6);
    const l3 = get<Line>(s, "l3");
    close(l4.end, reflectPoint(l1.end, [l3.start, l3.end]));
    expect(get<Circle>(s, "c2").radius).toBeCloseTo(3, 6);
    expect(checkConstraints(s.entities, k.map((c) => (c.type === "radius" ? { ...c, value: 3 } : c)))).toEqual([]);
  });

  it("mirrors about a sketch axis, and moves without copying: relations carried, an arc's ends renamed", () => {
    const r = ok(mirrorEntities(half(), ["l2", "a1"], "X", { copy: false }));
    close([...get<Line>(r, "l2").start, ...get<Line>(r, "l2").end], [20, 0, 20, -10]);
    const a1 = get<Arc>(r, "a1");
    close([...a1.center, ...a1.start, ...a1.end], [20, -20, 30, -20, 20, -10]);
    // l2's end met a1's start; a1's start is now its end: the relation follows.
    expect(r.constraints).toContainEqual({ type: "coincident", points: ["l2.end", "a1.end"] });
    expect(r.constraints).toContainEqual({ type: "vertical", entity: "l2" });
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
  });

  it("says what is wrong", () => {
    expect(mirrorEntities(half(), ["l1"], "c1")).toContain("mirror about a line");
    expect(mirrorEntities(half(), ["l3"], "l3")).toContain("pick the entities");
  });

  it("validates the symmetric relation for entities", () => {
    const doc = (k: unknown) => ({ errors: allErrors(validateDocument({
        version: 1,
        name: "t",
        units: "mm",
        features: [
          {
            id: "s1",
            op: "sketch",
            plane: { type: "datum", origin: [0, 0, 0], normal: [0, 0, 1] },
            entities: [line("l1", [1, 0], [1, 5]), line("l2", [-1, 0], [-1, 5]), { id: "c1", type: "circle", center: [2, 2], radius: 1 }],
            constraints: [k],
          },
        ],
      })) });
    expect(doc({ type: "symmetric", entities: ["l1", "l2"], line: "Y" }).errors).toEqual([]);
    expect(doc({ type: "symmetric", entities: ["l1", "c1"], line: "Y" }).errors.join()).toContain("a line mirrors a line");
    expect(doc({ type: "symmetric", entities: ["l1", "l2"], points: ["l1.start", "l2.start"], line: "Y" }).errors.join()).toContain("exactly one of");
    expect(doc({ type: "symmetric", entities: ["l1", "l2"], line: "l1" }).errors.join()).toContain("can't be one of the pair");
  });
});

describe("linear sketch pattern", () => {
  const seed = (): SketchState => ({
    entities: [{ id: "c1", type: "circle", center: [10, 10], radius: 3 }],
    constraints: [{ type: "diameter", entity: "c1", value: 6 }],
  });

  it("copies a circle along x: exact places, equal to the seed, one spacing dimension; a skipped place has no copy", () => {
    const r = ok(linearPattern(seed(), ["c1"], { count: 4, spacing: 15, angle: 0, skip: [3] }));
    const circles = r.entities.filter((e): e is Circle => e.type === "circle");
    expect(circles.map((c) => c.center)).toEqual([[10, 10], [25, 10], [55, 10]]);
    expect(circles.every((c) => c.radius === 3)).toBe(true);
    expect(r.constraints).toEqual(expect.arrayContaining([{ type: "equal", entities: ["c2", "c1"] }, { type: "equal", entities: ["c3", "c1"] }]));
    const spacing = r.constraints.filter((k) => k.type === "distance");
    expect(spacing).toHaveLength(1);
    expect(spacing[0]).toMatchObject({ value: 15 });
    expect(r.constraints).toContainEqual({ type: "horizontal", entity: (spacing[0] as { entity: string }).entity });
    const s = commit(r);
    expect(checkConstraints(s.entities, s.constraints)).toEqual([]);
    // The pattern adds no freedom beyond the seed's (its position, 2): the chain, the copies and their places are all held.
    expect(sketchDof(s.entities, s.constraints)).toBe(2);
    // Editing the spacing moves every copy.
    const k = s.constraints.map((c) => (c === spacing[0] ? { ...c, value: 20 } : c)) as Constraint[];
    const moved = solveSketch(s.entities, k);
    if (!moved.ok) throw new Error(moved.error);
    const c1 = get<Circle>(moved, "c1").center;
    close([...get<Circle>(moved, "c2").center, ...get<Circle>(moved, "c3").center], [c1[0] + 20, c1[1], c1[0] + 60, c1[1]]);
  });

  it("runs at an angle, with an angle dimension to the X axis", () => {
    const r = ok(linearPattern(seed(), ["c1"], { count: 3, spacing: 10, angle: 30 }));
    close(get<Circle>(r, "c3").center, [10 + 20 * Math.cos(Math.PI / 6), 10 + 20 * Math.sin(Math.PI / 6)]);
    expect(r.constraints.find((k) => k.type === "angle")).toMatchObject({ value: 30 });
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    close(patternPlaces(seed(), ["c1"], "linear", { count: 3, spacing: 10, angle: 90 }).flatMap((p) => p.at), [10, 20, 10, 30]);
  });

  it("copies a joined pair of lines with their own relations, each line parallel and equal to its seed", () => {
    const s: SketchState = {
      entities: [line("l1", [0, 0], [5, 0]), line("l2", [5, 0], [5, 5])],
      constraints: [{ type: "coincident", points: ["l1.end", "l2.start"] }, { type: "perpendicular", entities: ["l1", "l2"] }],
    };
    const r = ok(linearPattern(s, ["l1", "l2"], { count: 2, spacing: 10, angle: 90 }));
    close([...get<Line>(r, "l3").start, ...get<Line>(r, "l4").end], [0, 10, 5, 15]);
    expect(r.soft).toEqual(expect.arrayContaining([{ type: "coincident", points: ["l3.end", "l4.start"] }, { type: "parallel", entities: ["l3", "l1"] }]));
    const done = commit(r);
    expect(checkConstraints(done.entities, done.constraints)).toEqual([]);
  });

  it("refuses what makes no pattern", () => {
    expect(linearPattern(seed(), ["c1"], { count: 1, spacing: 10, angle: 0 })).toContain("2 instances");
    expect(linearPattern(seed(), ["c1"], { count: 3, spacing: 0, angle: 0 })).toContain("spacing");
    expect(linearPattern(seed(), ["c1"], { count: 2, spacing: 5, angle: 0, skip: [2] })).toContain("skipped");
  });
});

describe("circular sketch pattern", () => {
  it("puts six circles round the origin: 60° apart, spokes equal, chords equal, one angle dimension", () => {
    const s: SketchState = { entities: [{ id: "c1", type: "circle", center: [20, 0], radius: 2 }], constraints: [] };
    const r = ok(circularPattern(s, ["c1"], { count: 6, center: "origin", total: 360 }));
    const centres = r.entities.filter((e): e is Circle => e.type === "circle").map((c) => c.center);
    expect(centres).toHaveLength(6);
    centres.forEach((c, k) => close(c, [20 * Math.cos((k * Math.PI) / 3), 20 * Math.sin((k * Math.PI) / 3)]));
    const angles = r.constraints.filter((k) => k.type === "angle");
    expect(angles).toEqual([expect.objectContaining({ value: 60 })]);
    const done = commit(r);
    expect(checkConstraints(done.entities, done.constraints)).toEqual([]);
    // Editing the angle to 45° turns every copy: the sixth goes to 225°.
    const k = done.constraints.map((c) => (c.type === "angle" ? { ...c, value: 45 } : c)) as Constraint[];
    const turned = solveSketch(done.entities, k);
    if (!turned.ok) throw new Error(turned.error);
    // The seed may turn with the solve (nothing holds its angle): the sixth is 225° on from wherever it went, at the same radius.
    const all = turned.entities.filter((e): e is Circle => e.type === "circle");
    const seedAt = Math.atan2(all[0].center[1], all[0].center[0]);
    const rr = Math.hypot(...all[0].center);
    close(all[5].center, [rr * Math.cos(seedAt + (5 * Math.PI) / 4), rr * Math.sin(seedAt + (5 * Math.PI) / 4)]);
  });

  it("spans a partial angle with the ends included, skips, and refuses a seed on the centre", () => {
    const s: SketchState = { entities: [{ id: "p1", type: "point", at: [0, 10] }, { id: "c1", type: "circle", center: [10, 0], radius: 1 }], constraints: [] };
    const r = ok(circularPattern(s, ["c1"], { count: 4, center: "p1.at", total: 90, skip: [2] }));
    const centres = r.entities.filter((e): e is Circle => e.type === "circle").map((c) => c.center);
    const d = Math.hypot(10, 10);
    const a0 = Math.atan2(-10, 10);
    expect(centres).toHaveLength(3);
    close(centres[1], [d * Math.cos(a0 + Math.PI / 3), 10 + d * Math.sin(a0 + Math.PI / 3)]);
    close(centres[2], [d * Math.cos(a0 + Math.PI / 2), 10 + d * Math.sin(a0 + Math.PI / 2)]);
    expect(checkConstraints(commit(r).entities, commit(r).constraints)).toEqual([]);
    expect(circularPattern(s, ["p1"], { count: 3, center: "p1.at", total: 360 })).toContain("on the centre");
  });
});

describe("move, copy, rotate and scale", () => {
  const box = (): SketchState => ({
    entities: [line("l1", [0, 0], [10, 0]), line("l2", [10, 0], [10, 5]), line("l9", [30, 0], [40, 0])],
    constraints: [
      { type: "coincident", points: ["l1.end", "l2.start"] },
      { type: "horizontal", entity: "l1" },
      { type: "distance", entity: "l1", value: 10 },
      { type: "coincident", points: ["l1.start", "origin"] },
      { type: "coincident", points: ["l2.end", "l9.start"] }, // (does not hold: dropped by nothing until something moves)
    ],
  });

  it("moves: what held the picked entities to the rest goes unless kept", () => {
    const r = ok(transformEntities(box(), ["l1", "l2"], { kind: "move", by: [5, 5] }));
    close([...get<Line>(r, "l1").start, ...get<Line>(r, "l2").end], [5, 5, 15, 10]);
    expect(r.constraints).toContainEqual({ type: "distance", entity: "l1", value: 10 });
    expect(r.constraints).not.toContainEqual({ type: "coincident", points: ["l1.start", "origin"] });
    const kept = ok(transformEntities(box(), ["l1", "l2"], { kind: "move", by: [5, 5] }, { keepRelations: true }));
    expect(kept.constraints).toContainEqual({ type: "coincident", points: ["l1.start", "origin"] });
  });

  it("copies: new entities with their own relations, none to the rest; several copies step on", () => {
    const r = ok(transformEntities(box(), ["l1", "l2"], { kind: "move", by: [0, 20] }, { copy: true, count: 2 }));
    expect(r.made).toEqual(["l3", "l4", "l5", "l6"]);
    close([...get<Line>(r, "l5").start, ...get<Line>(r, "l6").end], [0, 40, 10, 45]);
    expect(r.constraints).toEqual(expect.arrayContaining([{ type: "coincident", points: ["l3.end", "l4.start"] }, { type: "distance", entity: "l5", value: 10 }, { type: "horizontal", entity: "l5" }]));
    expect(r.constraints.filter((k) => JSON.stringify(k).includes("origin"))).toHaveLength(1);
  });

  it("rotates about a point: level and plumb go, lengths stay", () => {
    const r = ok(transformEntities(box(), ["l1", "l2"], { kind: "rotate", center: [0, 0], angle: 90 }));
    close([...get<Line>(r, "l1").end, ...get<Line>(r, "l2").end], [0, 10, -5, 10]);
    const r30 = ok(transformEntities(box(), ["l1"], { kind: "rotate", center: [0, 0], angle: 30 }));
    expect(r30.constraints).not.toContainEqual({ type: "horizontal", entity: "l1" });
    expect(r30.constraints).toContainEqual({ type: "distance", entity: "l1", value: 10 });
    expect(angleBetween([0, 0], [1, 0], [0, 1])).toBeCloseTo(90, 9);
    expect(angleBetween([0, 0], [1, 0], [0, -1])).toBeCloseTo(-90, 9);
  });

  it("scales about a point: the picked lengths and their dimensions scale", () => {
    const r = ok(transformEntities(box(), ["l1", "l2"], { kind: "scale", center: [0, 0], factor: 2 }));
    close([...get<Line>(r, "l2").start, ...get<Line>(r, "l2").end], [20, 0, 20, 10]);
    expect(r.constraints).toContainEqual({ type: "distance", entity: "l1", value: 20 });
    expect(checkConstraints(r.entities, r.constraints.filter((k) => k.type !== "coincident" || !k.points.includes("l9.start")))).toEqual([]);
  });
});

describe("check sketch for feature", () => {
  it("finds an open chain's ends, a crossing and a near miss, in words", () => {
    const c = checkSketch([line("l1", [0, 0], [10, 0]), line("l2", [10, 0], [10, 10]), line("l3", [5, -5], [5, 5]), line("l4", [10.02, 10], [0, 10])]);
    const texts = c.problems.map((p) => p.text);
    expect(texts).toContain("open at l1's start");
    expect(texts).toContain("l1 and l3 cross");
    expect(texts.some((t) => t.startsWith("l2's end and l4's start nearly meet"))).toBe(true);
    expect(problemSummary(c)).toMatch(/\(and \d+ more\)$/);
  });

  it("shades the closed rings even while something else is wrong, and a clean profile's regions", () => {
    const square = [line("l1", [0, 0], [10, 0]), line("l2", [10, 0], [10, 10]), line("l3", [10, 10], [0, 10]), line("l4", [0, 10], [0, 0])];
    const stray = line("l5", [20, 0], [30, 0]);
    const c = checkSketch([...square, stray, { id: "c1", type: "circle", center: [50, 0], radius: 2 }]);
    expect(c.loops).toHaveLength(2);
    expect(c.problems.map((p) => p.kind)).toEqual(["open", "open"]);
    expect(checkSketch(square).loops).toHaveLength(1);
    expect(checkSketch(square).problems).toEqual([]);
    // Construction geometry and points are no part of it.
    expect(checkSketch([...square, line("l6", [0, 0], [10, 10], { construction: true }), { id: "p1", type: "point", at: [3, 3] }]).problems).toEqual([]);
  });

  it("fixes in one click: merges ends that nearly meet, deletes zero-length and duplicate entities", () => {
    const state: SketchState = {
      entities: [line("l1", [0, 0], [10, 0]), line("l2", [10.01, 0], [10, 10]), line("l3", [3, 3], [3, 3]), line("l4", [10, 0], [0, 0]), line("l5", [10, 10], [0, 0])],
      constraints: [{ type: "horizontal", entity: "l3" }],
    };
    const c = checkSketch(state.entities);
    expect(c.problems.find((p) => p.kind === "zero")).toMatchObject({ text: "l3 has no length", fix: "Delete l3" });
    expect(c.problems.find((p) => p.kind === "duplicate")).toMatchObject({ text: "l4 lies on top of l1", fix: "Delete l4" });
    const gap = c.problems.find((p) => p.kind === "gap")!;
    const merged = fixProblem(state, gap)!;
    expect(merged.constraints).toContainEqual({ type: "coincident", points: gap.refs });
    expect(checkConstraints(merged.entities, merged.constraints.filter((k) => k.type === "coincident"))).toEqual([]);
    const all = fixAll(state)!;
    expect(all.entities.map((e) => e.id)).toEqual(["l1", "l2", "l5"]);
    expect(all.constraints).not.toContainEqual({ type: "horizontal", entity: "l3" });
    expect(checkSketch(all.entities).problems).toEqual([]);
    expect(buildProfile(all.entities).ok).toBe(true);
  });
});

describe("deleting offsets", () => {
  it("drops only the pairs of an offset relation that name a deleted entity", () => {
    const k: Constraint = { type: "offset", entities: ["l1", "l2"], offsets: ["l3", "l4"], value: 2 };
    expect(removeEntities([], [k], ["l3"]).constraints).toEqual([{ type: "offset", entities: ["l2"], offsets: ["l4"], value: 2 }]);
    expect(removeEntities([], [k], ["l3", "l2"]).constraints).toEqual([]);
  });
});
