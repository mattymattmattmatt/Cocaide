// Phase P wave 3B: fill, curve-driven and table patterns, coordinate systems
// (as references, in table patterns and moves), with counts and volumes
// worked out by hand.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { csysFrame, csysPart } from "../src/features/datum";
import { curveDistances } from "../src/features/curvePattern/doc";
import { parseTable } from "../src/features/tablePattern/doc";
import { fillPlaces, roundFootprint } from "../src/features/fillPattern/layout";
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
const hole = (id: string, at: [number, number], d = 6) => ({ id, op: "hole", face: TOP, center: at, diameter: d, depth: "through" });

function built(doc: RawDocument) {
  const r = rebuild(doc, oc);
  try {
    const m = r.measurements;
    return {
      errors: r.errors,
      volume: m?.volume ?? 0,
      holes: (m?.holes ?? []).map((h) => [r3(h.axisPoint[0]), r3(h.axisPoint[1])]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      records: r.holes,
      datums: r.datums,
    };
  } finally {
    r.dispose();
  }
}

describe("coordinate system", () => {
  it("frames: x along X, y made square to it, z = x × y", () => {
    const f = csysFrame([1, 2, 3], [2, 0, 0], [1, 1, 0])!;
    expect(f.x).toEqual([1, 0, 0]);
    expect(f.y).toEqual([0, 1, 0]);
    expect(f.z).toEqual([0, 0, 1]);
    expect(csysFrame([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBeNull();
    // Its parts: YZ is the plane with normal X and x along Y; Z an axis; origin a point.
    expect(csysPart(f, "YZ")).toEqual({ kind: "plane", origin: [1, 2, 3], normal: [1, 0, 0], xDir: [0, 1, 0] });
    expect(csysPart(f, undefined, "axis")).toEqual({ kind: "axis", origin: [1, 2, 3], direction: [0, 0, 1] });
    expect(csysPart(f, undefined, "point")).toEqual({ kind: "point", at: [1, 2, 3] });
  });

  it("builds from a vertex and edges, and is listed with the datums", () => {
    const doc = plate({
      id: "cs1",
      op: "coordinateSystem",
      origin: { edge: { type: "edge", kind: "line", direction: [1, 0, 0], pick: "all", near: [0, -30, 10] }, at: "start" },
      x: { datum: "Y" },
      y: { datum: "Z" },
    });
    const b = built(doc);
    expect(b.errors).toEqual([]);
    const d = b.datums.cs1;
    expect(d.kind).toBe("frame");
    if (d.kind !== "frame") return;
    expect(d.x).toEqual([0, 1, 0]);
    expect(d.y).toEqual([0, 0, 1]);
    // z = Y × Z = X.
    expect(d.z).toEqual([1, 0, 0]);
  });

  it("refuses a part on something that is not a coordinate system, and an unknown part", () => {
    const errs = allErrors(validateDocument(plate({ id: "p", op: "plane", mode: "offset", refs: [{ datum: "Top", part: "XY" }], distance: 5 })));
    expect(errs.some((e) => e.includes("only a coordinate system has parts"))).toBe(true);
    const errs2 = allErrors(validateDocument(plate({ id: "cs1", op: "coordinateSystem" }, { id: "p", op: "plane", mode: "offset", refs: [{ datum: "cs1", part: "XZ" }], distance: 5 })));
    expect(errs2.some((e) => e.includes('"XY", "YZ", "ZX"'))).toBe(true);
    // Its X axis where a plane is needed: refused by kind.
    const errs3 = allErrors(validateDocument(plate({ id: "cs1", op: "coordinateSystem" }, { id: "p", op: "plane", mode: "offset", refs: [{ datum: "cs1", part: "X" }], distance: 5 })));
    expect(errs3.some((e) => e.includes("an axis, but a plane is needed"))).toBe(true);
  });

  it("serves as a plane: an offset plane from its YZ, and a sketch on its XY", () => {
    const doc = plate(
      { id: "cs1", op: "coordinateSystem", origin: { point: [10, 0, 10] } },
      { id: "p", op: "plane", mode: "offset", refs: [{ datum: "cs1", part: "YZ" }], distance: 5 },
      // A boss sketched on cs1's XY (the plate's top, origin moved to x 10): a 10 x 10 square at [0, 0] in it.
      { id: "s2", op: "sketch", plane: { type: "ref", ref: { datum: "cs1" } }, entities: [{ id: "q", type: "rect", center: [0, 0], w: 10, h: 10 }] },
      { id: "e2", op: "extrude", sketch: "s2", distance: 5 },
    );
    const b = built(doc);
    expect(b.errors).toEqual([]);
    const p = b.datums.p;
    expect(p.kind === "plane" && p.origin[0]).toBeCloseTo(15, 9);
    expect(b.volume).toBeCloseTo(PLATE + 10 * 10 * 5, 6);
  });

  it("moves a body from one coordinate system to another", () => {
    const doc = plate(
      { id: "cs1", op: "coordinateSystem" },
      // cs2: at [0, 0, 50], turned a quarter about Z (its X is the world's Y).
      { id: "cs2", op: "coordinateSystem", origin: { point: [0, 0, 50] }, x: { datum: "Y" }, y: { point: [-10, 0, 50] } },
      { id: "m", op: "move", bodies: ["main"], fromSystem: { datum: "cs1" }, toSystem: { datum: "cs2" } },
    );
    const r = rebuild(doc, oc);
    try {
      expect(r.errors).toEqual([]);
      const box = r.measurements!.boundingBox!;
      // The plate's 100 along X now runs along Y, raised 50.
      expect(r3(box.size[0])).toBe(60);
      expect(r3(box.size[1])).toBe(100);
      expect(r3(box.min[2])).toBe(50);
    } finally {
      r.dispose();
    }
  });
});

describe("table pattern", () => {
  it("reads pasted CSV", () => {
    expect(parseTable("x, y\n0, 0\n20\t5\n-3 4.5 label\n")).toEqual([
      [0, 0],
      [20, 5],
      [-3, 4.5],
    ]);
    expect(parseTable("1, 2\nfoo")).toMatch(/line 2/);
  });

  it("copies a hole to positions in a coordinate system", () => {
    const doc = plate(
      hole("h1", [-40, -20]),
      { id: "cs1", op: "coordinateSystem", origin: { point: [-40, -20, 10] } },
      { id: "tp", op: "tablePattern", feature: "h1", system: { datum: "cs1" }, positions: [[0, 0], [20, 0], [0, 30], [70, 40]] },
    );
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 4 * cyl(6, T), 6);
    expect(b.holes).toEqual([
      [-40, -20],
      [-40, 10],
      [-20, -20],
      [30, 20],
    ]);
    expect(b.records[0].copies).toBe(3);
  });

  it("skips by number and follows a turned coordinate system", () => {
    const doc = plate(
      hole("h1", [0, 0]),
      // X along the world's Y: the table's x runs up the plate.
      { id: "cs1", op: "coordinateSystem", origin: { point: [0, 0, 10] }, x: { datum: "Y" }, y: { point: [-10, 0, 10] } },
      { id: "tp", op: "tablePattern", feature: "h1", system: { datum: "cs1" }, positions: [[0, 0], [20, 0], [0, 20]], skip: [3] },
    );
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.holes).toEqual([
      [0, 0],
      [0, 20],
    ]);
  });
});

describe("curve-driven pattern", () => {
  it("shares a curve out evenly, or by a spacing", () => {
    expect(curveDistances(100, false, 5)).toEqual([25, 50, 75, 100]);
    expect(curveDistances(100, true, 4)).toEqual([25, 50, 75]);
    expect(curveDistances(100, false, 3, 30)).toEqual([30, 60]);
    expect(curveDistances(100, false, 5, 30)).toMatch(/120 mm of curve/);
  });

  it("puts holes along an arc", () => {
    const doc = plate(
      // A half circle of radius 20 about the origin on the top; it starts at its lower-x end, [-20, 0].
      { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] }, entities: [{ id: "a", type: "arc", center: [0, 0], start: [20, 0], end: [-20, 0] }] },
      hole("h1", [-20, 0]),
      { id: "cp", op: "curvePattern", feature: "h1", path: { sketch: "s2" }, count: 5 },
    );
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 5 * cyl(6, T), 6);
    const s = r3(20 * Math.SQRT1_2);
    expect(b.holes).toEqual([
      [-20, 0],
      [-s, s],
      [0, 20],
      [s, s],
      [20, 0],
    ]);
  });

  it("turns a boss with the curve, or keeps it square", () => {
    // A half circle of radius 20 about [0, 25], from [-20, 25] (its start) over the top [0, 45] to [20, 25]. The seed:
    // a bar 2 wide, 10 long along the curve's start tangent (+Y), 3 high on the top face.
    const bars = (orientation?: string) =>
      plate(
        { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] }, entities: [{ id: "a", type: "arc", center: [0, 25], start: [20, 25], end: [-20, 25] }] },
        { id: "s3", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] }, entities: [{ id: "q", type: "rect", center: [-20, 25], w: 2, h: 10 }] },
        { id: "b1", op: "extrude", sketch: "s3", distance: 3 },
        { id: "cp", op: "curvePattern", feature: "b1", path: { sketch: "s2" }, count: 3, ...(orientation ? { orientation } : {}) },
      );
    const top = (orientation?: string) => {
      const r = rebuild(bars(orientation), oc);
      try {
        expect(r.errors).toEqual([]);
        return r.measurements!.boundingBox!.max[1];
      } finally {
        r.dispose();
      }
    };
    // Turned, the middle copy lies along the tangent at the top (+X): 2 deep about y 45, so the part reaches y 46.
    expect(top()).toBeCloseTo(46, 6);
    // Fixed, it stays 10 long along Y about [0, 45]: the part reaches y 50.
    expect(top("fixed")).toBeCloseTo(50, 6);
  });

  it("follows model edges", () => {
    // A blind hole 5 deep at the back top corner, repeated along the back BOTTOM edge (uncut): start, middle, end.
    const doc = plate(
      { id: "h1", op: "hole", face: TOP, center: [-50, 30], diameter: 4, depth: 5 },
      { id: "cp", op: "curvePattern", feature: "h1", path: { edges: [{ type: "edge", kind: "line", direction: [1, 0, 0], pick: "all", near: [0, 30, 0] }] }, count: 3 },
    );
    const b = built(doc);
    expect(b.errors).toEqual([]);
    // Two quarter holes at the corners and a half one in the middle.
    expect(b.volume).toBeCloseTo(PLATE - (0.25 + 0.5 + 0.25) * cyl(4, 5), 4);
  });
});

describe("fill pattern", () => {
  it("lays out a square grid inside the margin", () => {
    const square = [
      [
        [-50, -30],
        [50, -30],
        [50, 30],
        [-50, 30],
        [-50, -30],
      ] as [number, number][],
    ];
    const places = fillPlaces({ layout: "square", spacing: 20, margin: 5 }, [-40, -20], roundFootprint(3), square);
    expect(places).not.toBeTypeOf("string");
    expect((places as unknown[]).length).toBe(14);
    const stag = fillPlaces({ layout: "staggered", spacing: 20, margin: 5 }, [-40, -20], roundFootprint(3), square);
    expect((stag as unknown[]).length).toBe(13);
    // Rings about the centre: radius 20 holds floor(2π·20/20) = 6, all inside; radius 40 holds 12, of which those
    // at 0°, ±30°, 180°, 180° ± 30° fit (y = ±20 + 3.03 + 2 < 30); radius 60 none.
    const rings = fillPlaces({ layout: "circular", spacing: 20, margin: 2 }, [0, 0], roundFootprint(3), square);
    expect((rings as unknown[]).length).toBe(12);
  });

  it("fills a plate's top face with holes", () => {
    const doc = plate(hole("h1", [-40, -20]), { id: "fp", op: "fillPattern", feature: "h1", face: TOP, spacing: 20, margin: 5 });
    const b = built(doc);
    expect(b.errors).toEqual([]);
    // x -40 .. 40 (5) by y -20 .. 20 (3): 15 holes.
    expect(b.holes.length).toBe(15);
    expect(b.volume).toBeCloseTo(PLATE - 15 * cyl(6, T), 6);
  });

  it("skips instances and keeps clear of a hole in the face", () => {
    const doc = plate(
      { id: "big", op: "hole", face: TOP, center: [0, 0], diameter: 20, depth: "through" },
      hole("h1", [-40, -20]),
      { id: "fp", op: "fillPattern", feature: "h1", face: TOP, spacing: 20, margin: 2, skip: [2] },
    );
    const b = built(doc);
    expect(b.errors).toEqual([]);
    // The big hole takes the [0, 0] place (and its neighbours at 20 are clear: 20 - 10 - 3.03 > 2); instance 2 is skipped.
    expect(b.holes.length).toBe(1 + 15 - 1 - 1);
  });
});
