// Wave 5: patterns and mirrors of several features at once, instances
// skipped by number, directions and axes taken from the model (an edge, a
// face's normal, a cylinder's axis), a circular pattern over part of a turn,
// a mirror about a face, and the sketch-driven pattern (copies at a sketch's
// points, or at a table of positions).

import { beforeAll, describe, expect, it } from "vitest";
import { apply, references, renamedBodies, type RawDocument } from "../src/doc/commands";
import { scopeFor } from "../src/ask/packet";
import { allErrors, validateDocument } from "../src/doc/validate";
import { holeText } from "../src/drafting/compose";
import { loadOC, rebuild, type OC } from "../src/kernel";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const W = 100;
const D = 60;
const T = 10;
const PLATE = W * D * T;
const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const cyl = (d: number, h: number) => Math.PI * (d / 2) ** 2 * h;
const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0;

/** A 100 x 60 plate, 10 thick (x -50..50, y -30..30, z 0..10), and features after it. */
function plate(...more: Record<string, unknown>[]): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "plate",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: W, h: D }] },
      { id: "e1", op: "extrude", sketch: "s1", distance: T },
      ...more,
    ],
  };
}

/** A hole Ø6 through at a point of the top face. */
const hole = (id: string, at: [number, number], d = 6) => ({ id, op: "hole", face: TOP, center: at, diameter: d, depth: "through" });
/** A 6 x 6 square boss 5 high on the top face, its own sketch. */
function boss(id: string, at: [number, number]): Record<string, unknown>[] {
  return [
    { id: `${id}_s`, op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, T] }, entities: [{ id: "q", type: "rect", center: at, w: 6, h: 6 }] },
    { id, op: "extrude", sketch: `${id}_s`, distance: 5 },
  ];
}
const BOSS = 6 * 6 * 5;

const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));

function built(doc: RawDocument) {
  const r = rebuild(doc, oc);
  try {
    const m = r.measurements;
    return {
      errors: r.errors,
      volume: m?.volume ?? 0,
      holes: (m?.holes ?? []).map((h) => [r3(h.axisPoint[0]), r3(h.axisPoint[1])]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      records: r.holes,
      bodies: (m?.bodies ?? []).map((b) => [b.name, r3(b.volume)]),
      box: (name: string) => m?.bodies.find((b) => b.name === name)?.boundingBox,
    };
  } finally {
    r.dispose();
  }
}

describe("linear pattern: several features, instances skipped", () => {
  it("repeats two features the same way", () => {
    const doc = plate(hole("h1", [-40, -20]), ...boss("b1", [-40, 10]), { id: "lp", op: "linearPattern", features: ["h1", "b1"], direction: [1, 0, 0], spacing: 20, count: 4 });
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 4 * cyl(6, T) + 4 * BOSS, 6);
    expect(b.holes).toEqual([
      [-40, -20],
      [-20, -20],
      [0, -20],
      [20, -20],
    ]);
  });

  it("skips instances by number: the original is 1", () => {
    const doc = plate(hole("h1", [-40, -20]), ...boss("b1", [-40, 10]), { id: "lp", op: "linearPattern", features: ["h1", "b1"], direction: [1, 0, 0], spacing: 20, count: 4, skip: [3] });
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 3 * cyl(6, T) + 3 * BOSS, 6);
    expect(b.holes.map((h) => h[0])).toEqual([-40, -20, 20]);
    // The callout counts what was made: 3 of them.
    expect(holeText(b.records[0])).toEqual(["3× Ø6 THRU"]);
  });

  it("numbers a grid row by row: 1 + i + j * count", () => {
    // 3 along X, 2 along Y: numbers 1 2 3 on the first row, 4 5 6 on the second. Skip 5: the middle of the second row.
    const doc = plate(hole("h1", [-20, -10]), { id: "lp", op: "linearPattern", feature: "h1", direction: [1, 0, 0], spacing: 20, count: 3, direction2: [0, 1, 0], spacing2: 20, count2: 2, skip: [5] });
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.holes).toEqual([
      [-20, -10],
      [-20, 10],
      [0, -10],
      [20, -10],
      [20, 10],
    ]);
  });

  it("takes its direction from an edge, or a face's normal, and turns it round with reverse", () => {
    // The plate's long top edge at the back runs along X; its +Y side face's normal points along +Y.
    const edge = { edge: { type: "edge", kind: "line", direction: [1, 0, 0], onFace: TOP, near: [0, 30, 10], pick: "all" } };
    // The edge's own sense (as the kernel stores it) decides the way; reverse goes the other way. Exactly one lands on the plate.
    const runs = [false, true].map((reverse) => built(plate(hole("h1", [-40, 0]), { id: "lp", op: "linearPattern", feature: "h1", along: edge, reverse, spacing: 25, count: 3 })));
    expect(runs.filter((b) => b.errors.length === 0)).toHaveLength(1);
    expect(runs.find((b) => b.errors.length === 0)!.holes.map((h) => h[0])).toEqual([-40, -15, 10]);
    expect(runs.find((b) => b.errors.length > 0)!.errors).toEqual(["lp: instance 2 (offset [-25, 0, 0]) removes no material"]);
    const byFace = built(plate(hole("h1", [0, -25]), { id: "lp", op: "linearPattern", feature: "h1", along: { face: { type: "planar", normal: [0, 1, 0], pick: "largest" } }, spacing: 25, count: 3 }));
    expect(byFace.errors).toEqual([]);
    expect(byFace.holes).toEqual([
      [0, -25],
      [0, 0],
      [0, 25],
    ]);
    const flipped = built(plate(hole("h1", [0, 25]), { id: "lp", op: "linearPattern", feature: "h1", along: { face: { type: "planar", normal: [0, 1, 0], pick: "largest" } }, reverse: true, spacing: 25, count: 3 }));
    expect(flipped.holes).toEqual([
      [0, -25],
      [0, 0],
      [0, 25],
    ]);
    // A point is no direction.
    expect(built(plate(hole("h1", [0, 0]), { id: "lp", op: "linearPattern", feature: "h1", along: { point: [1, 2, 3] }, spacing: 25, count: 3 })).errors.length).toBe(1);
  });

  it("validates the new fields strictly", () => {
    const lp = (f: Record<string, unknown>) => errorsOf(plate(hole("h1", [0, 0]), hole("h2", [10, 0]), { id: "lp", op: "linearPattern", feature: "h1", direction: [1, 0, 0], spacing: 10, count: 3, ...f }));
    expect(lp({ skip: [1] })).toEqual(["lp: skip[0]: instance 1 is the original feature: it can't be skipped"]);
    expect(lp({ skip: [4] })).toEqual(["lp: skip[0]: must be an instance number from 2 to 3 (got 4)"]);
    expect(lp({ skip: [2, 2] })).toEqual(["lp: skip[1]: skips instance 2 twice"]);
    expect(lp({ skip: [2, 3] })).toEqual(["lp: skip: skips every copy (2 of them): nothing would be left to make"]);
    expect(lp({ skip: 2 })).toEqual(["lp: skip: must be a list of instance numbers (the original is 1) (got 2)"]);
    expect(lp({ features: ["h1", "h2"] })).toEqual(['lp: give "feature" (one) or "features" (several), not both']);
    expect(lp({ feature: undefined, features: ["h1", "h1"] })).toEqual(['lp: features: lists "h1" twice']);
    expect(lp({ feature: undefined, features: [] })).toEqual(["lp: features: must be a list of earlier features' ids, at least one (got [])"]);
    expect(lp({ feature: undefined, features: ["h1", "s1"] })).toEqual(['lp: features[1]: "s1" is a sketch; a pattern repeats an extrude, cut or hole']);
    expect(lp({ along: { datum: "X" } })).toEqual(["lp: give direction (written out) or along (from the model), not both"]);
    expect(lp({ direction: undefined, along: { datum: "Origin" } })).toEqual(["lp: along: Origin is a point, but an axis or a plane is needed here"]);
    expect(lp({ direction: undefined, along: { datum: "X" } })).toEqual([]);
    expect(lp({ spacing2: 10, count2: 2 })).toEqual(["lp: a second direction needs direction2 (or along2), spacing2 and count2 together"]);
    expect(lp({ along2: { datum: "Y" }, spacing2: 10, count2: 2, skip: [6] })).toEqual([]);
    expect(lp({ skip: [7] , along2: { datum: "Y" }, spacing2: 10, count2: 2 })).toEqual(["lp: skip[0]: must be an instance number from 2 to 6 (got 7)"]);
  });
});

describe("circular pattern: part of a turn, an axis from the model", () => {
  /** A Ø20 boss 10 high in the middle of the plate, and a hole beside it. */
  const hub = [
    { id: "hub_s", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, T] }, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 10 }] },
    { id: "hub", op: "extrude", sketch: "hub_s", distance: 10 },
  ];

  it("spans 180° with equal spacing: the last lands on the end", () => {
    const b = built(plate(hole("h1", [20, 0]), { id: "cp", op: "circularPattern", feature: "h1", axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: 3, angle: 180 }));
    expect(b.errors).toEqual([]);
    // 0°, 90°, 180° about Z, radius 20.
    expect(b.holes).toEqual([
      [-20, 0],
      [0, 20],
      [20, 0],
    ]);
    expect(b.volume).toBeCloseTo(PLATE - 3 * cyl(6, T), 6);
  });

  it("takes its axis from a cylindrical face or a datum axis, turns the other way with reverse, and skips", () => {
    const axisRef = { ref: { face: { type: "cylindrical", radius: 10, pick: "largest" } } };
    const b = built(plate(...hub, hole("h1", [20, 0]), { id: "cp", op: "circularPattern", feature: "h1", axis: axisRef, count: 4 }));
    expect(b.errors).toEqual([]);
    expect(b.holes).toEqual([
      [-20, 0],
      [0, -20],
      [0, 20],
      [20, 0],
    ]);
    // Half a turn the other way, 3 instances, the middle one skipped.
    const rev = built(plate(...hub, hole("h1", [20, 0]), { id: "cp", op: "circularPattern", feature: "h1", axis: { ref: { datum: "Z" } }, count: 3, angle: 180, reverse: true, skip: [2] }));
    expect(rev.errors).toEqual([]);
    expect(rev.holes).toEqual([
      [-20, 0],
      [20, 0],
    ]);
    expect(errorsOf(plate(hole("h1", [20, 0]), { id: "cp", op: "circularPattern", feature: "h1", axis: { ref: { datum: "Top" } }, count: 3 }))).toEqual([
      "cp: axis.ref: Top is a plane, but an axis is needed here",
    ]);
  });

  it("repeats several features", () => {
    const b = built(plate(hole("h1", [20, 0]), ...boss("b1", [0, 20]), { id: "cp", op: "circularPattern", features: ["h1", "b1"], axis: { ref: { datum: "Z" } }, count: 4 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 4 * cyl(6, T) + 4 * BOSS, 6);
  });
});

describe("mirror: several features, about a face", () => {
  it("mirrors two features about a plane", () => {
    const b = built(plate(hole("h1", [-30, -10]), ...boss("b1", [-30, 15]), { id: "m", op: "mirror", plane: { type: "ref", ref: { datum: "Right" } }, features: ["h1", "b1"] }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 2 * cyl(6, T) + 2 * BOSS, 6);
    expect(b.holes).toEqual([
      [-30, -10],
      [30, -10],
    ]);
    expect(holeText(b.records[0])).toEqual(["2× Ø6 THRU"]);
  });

  it("mirrors about a face picked on the model, and follows the face when it moves", () => {
    // A tab at the plate's right end (its own body, x 50..60); mirrored about the plate's left face.
    const tab = [
      { id: "tab_s", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "q", type: "rect", center: [55, 0], w: 10, h: 20 }] },
      { id: "tab", op: "extrude", sketch: "tab_s", distance: T, newBody: "tab" },
    ];
    const left = { type: "planar", normal: [-1, 0, 0], pick: "largest", body: "main" };
    const m = { id: "m", op: "mirror", plane: { type: "ref", ref: { face: left } }, feature: "tab" };
    const b = built(plate(...tab, m));
    expect(b.errors).toEqual([]);
    expect(b.bodies).toEqual([
      ["main", PLATE],
      ["tab", 2000],
      ["tab_mirror", 2000],
    ]);
    expect(b.box("tab_mirror")!.min[0]).toBeCloseTo(-160, 6);
    // The plate 20 longer to the left: its left face at x = -70, the mirrored tab at -200..-190.
    const longer = plate(...tab, m);
    (longer.features[0] as { entities: Record<string, unknown>[] }).entities[0] = { id: "r", type: "rect", center: [-10, 0], w: W + 20, h: D };
    expect(built(longer).box("tab_mirror")!.min[0]).toBeCloseTo(-200, 6);
  });

  it("names one mirrored body per seed that starts one; newBody only when there is one", () => {
    const two = [
      { id: "a_s", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "q", type: "rect", center: [60, 0], w: 10, h: 10 }] },
      { id: "a", op: "extrude", sketch: "a_s", distance: 5, newBody: "a" },
      { id: "b_s", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "q", type: "rect", center: [80, 0], w: 10, h: 10 }] },
      { id: "b", op: "extrude", sketch: "b_s", distance: 5, newBody: "b" },
    ];
    const v = validateDocument(plate(...two, { id: "m", op: "mirror", plane: { type: "ref", ref: { datum: "Right" } }, features: ["a", "b"] }));
    expect(v.bodies).toEqual(["main", "a", "b", "a_mirror", "b_mirror"]);
    expect(errorsOf(plate(...two, { id: "m", op: "mirror", plane: { type: "ref", ref: { datum: "Right" } }, features: ["a", "b"], newBody: "x" }))).toEqual([
      "m: newBody: names one new body, but 2 of the features start bodies of their own: each mirror is <body>_mirror",
    ]);
    expect(errorsOf(plate(hole("h1", [0, 0]), { id: "m", op: "mirror", plane: { type: "ref", ref: { datum: "Right" } }, features: ["h1"], bodies: ["main"] }))).toEqual([
      'm: mirrors either "features" or a list of "bodies"',
    ]);
  });
});

describe("copies of a seed that starts a body", () => {
  /** A 4 x 4 x 4 cube as its own body, at x = 60 (off the plate). */
  const cube = [
    { id: "c_s", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "q", type: "rect", center: [60, 0], w: 4, h: 4 }] },
    { id: "cube", op: "extrude", sketch: "c_s", distance: 4, newBody: "cube" },
  ];

  it("names each copy by its instance number, so skipping one does not rename the others", () => {
    const v = validateDocument(plate(...cube, { id: "lp", op: "linearPattern", feature: "cube", direction: [1, 0, 0], spacing: 10, count: 4, skip: [2] }));
    expect(v.bodies).toEqual(["main", "cube", "cube_3", "cube_4"]);
    const b = built(plate(...cube, { id: "lp", op: "linearPattern", feature: "cube", direction: [1, 0, 0], spacing: 10, count: 4, skip: [2] }));
    expect(b.errors).toEqual([]);
    expect(b.bodies.map((x) => x[0])).toEqual(["main", "cube", "cube_3", "cube_4"]);
    expect(b.box("cube_4")!.min[0]).toBeCloseTo(88, 6);
  });

  it("renaming the body renames its copies; the pattern counts as using each of its seeds", () => {
    const doc = plate(...cube, hole("h1", [0, 0]), { id: "lp", op: "linearPattern", features: ["cube", "h1"], direction: [1, 0, 0], spacing: 10, count: 3 });
    expect(references(doc.features.at(-1)!)).toEqual(["cube", "h1"]);
    expect([...renamedBodies(doc.features, "cube", "block")]).toEqual([
      ["cube", "block"],
      ["cube_2", "block_2"],
      ["cube_3", "block_3"],
    ]);
    const r = apply(doc, { type: "renameBody", from: "cube", to: "block" });
    expect(r.ok && validateDocument(r.doc).bodies).toEqual(["main", "block", "block_2", "block_3"]);
    expect(apply(doc, { type: "deleteFeature", id: "h1" })).toEqual({ ok: false, error: "deleteFeature: h1 is used by lp; delete or change it first" });
  });

  it("a body scope covers a pattern only when it covers every seed", () => {
    const doc = plate(hole("h1", [0, 0]), { ...hole("h2", [10, 0]), bodies: ["main"] }, { id: "lp", op: "linearPattern", features: ["h2"], direction: [1, 0, 0], spacing: 10, count: 2 });
    expect(scopeFor(doc, { kind: "body", name: "main" })).toContain("lp");
  });
});

describe("sketch-driven pattern", () => {
  /** A sketch on the top face with points: the seed's place first. */
  const pts = (at: [number, number][]) => ({ id: "pts", op: "sketch", plane: { type: "ref", ref: { face: TOP } }, entities: at.map((p, i) => ({ id: `p${i + 1}`, type: "point", at: p })) });

  it("copies a hole to every other point of the sketch", () => {
    const b = built(plate(hole("h1", [-40, -20]), pts([[-40, -20], [-10, 5], [25, -15], [40, 20]]), { id: "sp", op: "sketchPattern", feature: "h1", sketch: "pts" }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 4 * cyl(6, T), 6);
    expect(b.holes).toEqual([
      [-40, -20],
      [-10, 5],
      [25, -15],
      [40, 20],
    ]);
    expect(holeText(b.records[0])).toEqual(["4× Ø6 THRU"]);
  });

  it("moves from `from` when the seed is not at the first point; skips by number; copies several features", () => {
    // The seed hole at [0, 0], not one of the points: every point gets a copy (instances 2, 3, 4), and 3 is skipped.
    const b = built(plate(hole("h1", [0, 0]), ...boss("b1", [0, 20]), pts([[-30, 0], [30, 0], [0, -20]]), { id: "sp", op: "sketchPattern", features: ["h1", "b1"], sketch: "pts", from: [0, 0], skip: [3] }));
    expect(b.errors).toEqual([]);
    expect(b.holes).toEqual([
      [-30, 0],
      [0, -20],
      [0, 0],
    ]);
    expect(b.volume).toBeCloseTo(PLATE - 3 * cyl(6, T) + 3 * BOSS, 6);
  });

  it("takes a table of positions instead of the sketch's points", () => {
    const b = built(plate(hole("h1", [0, 0]), pts([[0, 0]]), { id: "sp", op: "sketchPattern", feature: "h1", sketch: "pts", positions: [[0, 0], [20, 0], [20, 20]] }));
    expect(b.errors).toEqual([]);
    expect(b.holes).toEqual([
      [0, 0],
      [20, 0],
      [20, 20],
    ]);
  });

  it("follows the points when the sketch changes", () => {
    const doc = plate(hole("h1", [-40, -20]), pts([[-40, -20], [0, 0]]), { id: "sp", op: "sketchPattern", feature: "h1", sketch: "pts" });
    const moved = apply(doc, { type: "updateEntity", sketch: "pts", id: "p2", patch: { at: [20, 10] } });
    if (!moved.ok) throw new Error(moved.error);
    expect(built(moved.doc).holes).toEqual([
      [-40, -20],
      [20, 10],
    ]);
  });

  it("validates strictly", () => {
    const sp = (f: Record<string, unknown>, sketch: Record<string, unknown> = pts([[0, 0], [10, 0]])) =>
      errorsOf(plate(hole("h1", [0, 0]), sketch, { id: "sp", op: "sketchPattern", feature: "h1", sketch: "pts", ...f }));
    expect(sp({})).toEqual([]);
    expect(sp({ sketch: "e1" })).toEqual(['sp: sketch: "e1" is an extrude, not a sketch']);
    expect(sp({ feature: "s1" })).toEqual(['sp: feature: "s1" is a sketch; a pattern repeats an extrude, cut or hole']);
    expect(sp({}, pts([]))).toEqual(['sp: sketch: sketch "pts" has no points: put a point (the Point tool) where each copy goes, or list "positions"']);
    expect(sp({}, pts([[0, 0]]))).toEqual(["sp: sketch: every place is where the seed is: there is nowhere to copy it to"]);
    expect(sp({ skip: [2] })).toEqual(["sp: skip: skips every copy (1 of them): nothing would be left to make"]);
    expect(sp({ positions: [] })).toEqual(["sp: positions: must be a list of [x, y] places in the sketch's plane, at least one (got [])"]);
    expect(sp({ from: [1] })).toEqual(["sp: from: must be an array of 2 numbers (got [1])"]);
    expect(sp({ spacing: 3 })).toEqual(['sp: unknown field "spacing" (allowed: id, op, feature, features, sketch, from, positions, skip)']);
    // It uses its sketch and its seeds.
    const doc = plate(hole("h1", [0, 0]), pts([[0, 0], [10, 0]]), { id: "sp", op: "sketchPattern", feature: "h1", sketch: "pts" });
    expect(references(doc.features.at(-1)!)).toEqual(["pts", "h1"]);
  });

  it("names copies of a body-starting seed by instance number", () => {
    const cube = [
      { id: "c_s", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "q", type: "rect", center: [70, 0], w: 4, h: 4 }] },
      { id: "cube", op: "extrude", sketch: "c_s", distance: 4, newBody: "cube" },
      { id: "pts", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: [{ id: "p1", type: "point", at: [70, 0] }, { id: "p2", type: "point", at: [80, 0] }, { id: "p3", type: "point", at: [90, 0] }] },
    ];
    const doc = plate(...cube, { id: "sp", op: "sketchPattern", feature: "cube", sketch: "pts" });
    expect(validateDocument(doc).bodies).toEqual(["main", "cube", "cube_2", "cube_3"]);
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.box("cube_3")!.min[0]).toBeCloseTo(88, 6);
  });
});
