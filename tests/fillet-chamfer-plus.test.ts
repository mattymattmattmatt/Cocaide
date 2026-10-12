// Fillet and chamfer upgrades (Phase O wave 3B): a radius that varies along
// each edge, several radius sets in one fillet, edges by face and by the
// feature that made them, per-edge failure messages; chamfers by two
// distances (with the face that takes the first, and flip) and by a distance
// and an angle. A constant fillet of radius r along a straight edge of length
// L between square faces removes (1 - π/4)·r²·L; a chamfer of legs a and b,
// a·b·L/2.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { apply } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { describeFaces, loadOC, rebuild, scoped, type OC } from "../src/kernel";

type Raw = Record<string, unknown>;
const PI = Math.PI;
const CORNER = 1 - PI / 4;
const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const doc = (...features: Raw[]): RawDocument => ({ version: 1, units: "mm", name: "edges plus", features });
const errorsOf = (d: unknown) => allErrors(validateDocument(d));

// A 20 mm cube: x, y in -10..10, z in 0..20.
const CUBE = [
  { id: "s1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 20, h: 20 }], constraints: [] },
  { id: "ext_1", op: "extrude", sketch: "s1", distance: 20 },
];
const BOX = 8000;
const vertical = (x: number, y: number) => ({ type: "edge", direction: [0, 0, 1], near: [x, y, 10], pick: "all" });
const TOP_FRONT = { type: "edge", direction: [1, 0, 0], near: [0, -10, 20], pick: "all" };
const topFace = { type: "planar", normal: [0, 0, 1], pick: "largest" };

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(d: unknown) {
  const r = rebuild(d, oc);
  try {
    const up = r.solid ? scoped((s) => describeFaces(oc, s, r.solid!).infos.filter((f) => f.type === "plane" && f.normal![2] > 1 - 1e-9).map((f) => f.area)) : [];
    return { errors: r.errors, volume: r.measurements?.volume ?? 0, up };
  } finally {
    r.dispose();
  }
}

function removed(...features: Raw[]): number {
  const b = built(doc(...CUBE, ...features));
  expect(b.errors).toEqual([]);
  return BOX - b.volume;
}

describe("fillet and chamfer: validation", () => {
  const bad = (f: Raw) => errorsOf(doc(...CUBE, f));

  it("a fillet takes radius2, sets, faces and features", () => {
    expect(bad({ id: "f", op: "fillet", edges: vertical(10, 10), radius: 2, radius2: 4 })).toEqual([]);
    expect(bad({ id: "f", op: "fillet", sets: [{ edges: vertical(10, 10), radius: 1 }] })).toEqual([]);
    expect(bad({ id: "f", op: "fillet", faces: [topFace], radius: 1 })).toEqual([]);
    expect(bad({ id: "f", op: "fillet", features: ["ext_1"], radius: 1 })).toEqual([]);
    expect(bad({ id: "f", op: "fillet", radius: 1 })).toEqual(['f: edges: needed: the edges to treat (an edge selector or a list), or "faces" (every edge of them), or "features" (the edges they made)']);
    expect(bad({ id: "f", op: "fillet", features: ["s1"], radius: 1 })).toEqual(['f: features[0]: "s1" is a sketch: it makes no faces (name the feature that made the edges)']);
    expect(bad({ id: "f", op: "fillet", features: ["later"], radius: 1 })).toEqual(['f: features[0]: "later" is not a feature before this one']);
    expect(bad({ id: "f", op: "fillet", sets: [{ edges: vertical(10, 10) }] })).toEqual(["f: sets[0].radius: must be a number (got nothing)"]);
    expect(bad({ id: "f", op: "fillet", sets: [{ edges: vertical(10, 10), radius: 1 }], radius2: 3 })).toEqual(["f: radius2: goes with radius: give both, or put them in sets"]);
    expect(bad({ id: "f", op: "fillet", edges: vertical(10, 10), radius: 1, twist: 1 })).toEqual(['f: unknown field "twist" (allowed: id, op, edges, radius, faces, features, radius2, sets)']);
  });

  it("a chamfer takes two distances or a distance and an angle, and flip with either", () => {
    expect(bad({ id: "c", op: "chamfer", edges: TOP_FRONT, distance: 2, distance2: 5, flip: true })).toEqual([]);
    expect(bad({ id: "c", op: "chamfer", edges: TOP_FRONT, distance: 2, angle: 30 })).toEqual([]);
    expect(bad({ id: "c", op: "chamfer", edges: TOP_FRONT, distance: 2, distance2: 5, angle: 30 })).toEqual(["c: give distance2 (two distances) or angle (a distance and an angle), not both"]);
    expect(bad({ id: "c", op: "chamfer", edges: TOP_FRONT, distance: 2, angle: 90 })).toEqual(["c: angle: must be under 90 degrees (got 90); 45 is the same as equal distances"]);
    expect(bad({ id: "c", op: "chamfer", edges: TOP_FRONT, distance: 2, flip: true })).toEqual([
      "c: flip: swaps which face takes the distance: it goes with distance2 or angle (an equal chamfer is the same either way)",
    ]);
  });

  it("the feature a fillet takes edges from is a reference: it cannot be deleted or renamed under it", () => {
    const d = doc(...CUBE, { id: "f", op: "fillet", features: ["ext_1"], radius: 1 });
    expect(apply(d, { type: "deleteFeature", id: "ext_1" })).toEqual({ ok: false, error: "deleteFeature: ext_1 is used by f; delete or change it first" });
  });

  it("body renames reach a fillet's sets and faces", () => {
    const d = doc(...CUBE, { id: "f", op: "fillet", faces: [{ ...topFace, body: "main" }], radius: 1, sets: [{ edges: { ...vertical(10, 10), body: "main" }, radius: 2 }] });
    const r = apply(d, { type: "renameBody", from: "main", to: "cube" });
    expect(r.ok).toBe(true);
    const f = (r as { doc: RawDocument }).doc.features[2] as Raw;
    expect((f.faces as Raw[])[0].body).toBe("cube");
    expect(((f.sets as Raw[])[0].edges as Raw).body).toBe("cube");
  });
});

describe("fillet and chamfer: volumes", () => {
  it("a constant fillet is (1 - π/4) r² L", () => {
    expect(removed({ id: "f", op: "fillet", edges: vertical(10, 10), radius: 2 })).toBeCloseTo(CORNER * 4 * 20, 6);
  });

  it("a radius from 2 to 4 along the edge removes more than 2 all along and less than 4 all along", () => {
    const v = removed({ id: "f", op: "fillet", edges: vertical(10, 10), radius: 2, radius2: 4 });
    expect(v).toBeGreaterThan(CORNER * 4 * 20 + 1);
    expect(v).toBeLessThan(CORNER * 16 * 20 - 1);
    // Equal radii are a constant fillet.
    expect(removed({ id: "f", op: "fillet", edges: vertical(10, 10), radius: 2, radius2: 2 })).toBeCloseTo(CORNER * 4 * 20, 6);
  });

  it("radius sets: 1 on one edge and 2 on another, in one feature", () => {
    expect(removed({ id: "f", op: "fillet", edges: vertical(10, 10), radius: 1, sets: [{ edges: vertical(-10, -10), radius: 2 }] })).toBeCloseTo(CORNER * (1 + 4) * 20, 6);
    expect(removed({ id: "f", op: "fillet", sets: [{ edges: vertical(10, 10), radius: 1 }, { edges: vertical(-10, -10), radius: 2 }] })).toBeCloseTo(CORNER * 5 * 20, 6);
    expect(built(doc(...CUBE, { id: "f", op: "fillet", edges: vertical(10, 10), radius: 1, sets: [{ edges: vertical(10, 10), radius: 2 }] })).errors[0]).toMatch(
      /^f: the edge \(straight, [+-]Z, length 20, at \[10, 10, 10\]\) is in the feature's own edges and in sets\[0\]: give each edge one radius$/,
    );
  });

  it("by face: every edge of the top face, the same as the edges on it", () => {
    const byFace = removed({ id: "f", op: "fillet", faces: [topFace], radius: 1 });
    expect(byFace).toBeCloseTo(removed({ id: "f", op: "fillet", edges: { type: "edge", onFace: topFace, pick: "all" }, radius: 1 }), 6);
    expect(byFace).toBeGreaterThan(0);
  });

  it("by feature: the edges a boss made (its sides, its top and where it meets the plate)", () => {
    const plate = [
      { id: "s1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 40 }], constraints: [] },
      { id: "plate", op: "extrude", sketch: "s1", distance: 5 },
      { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 5] }, entities: [{ id: "r2", type: "rect", center: [0, 0], w: 10, h: 10 }], constraints: [] },
      { id: "boss", op: "extrude", sketch: "s2", distance: 10 },
    ];
    const side = (n: [number, number, number]) => ({ type: "planar", normal: n, offset: 5, pick: "all" });
    const faces = [{ type: "planar", normal: [0, 0, 1], offset: 15, pick: "all" }, side([1, 0, 0]), side([-1, 0, 0]), side([0, 1, 0]), side([0, -1, 0])];
    const a = built(doc(...plate, { id: "f", op: "fillet", features: ["boss"], radius: 1 }));
    const b = built(doc(...plate, { id: "f", op: "fillet", faces, radius: 1 }));
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(a.volume).toBeCloseTo(b.volume, 6);
    // 40·40·5 + 10·10·10, rounded: the concave edges at the plate add, the convex ones remove; not the same as none.
    expect(Math.abs(a.volume - 9000)).toBeGreaterThan(0.1);
  });

  it("a radius too large for a face says which edge and how wide the face is", () => {
    const plate = [
      { id: "s1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 20, h: 20 }], constraints: [] },
      { id: "plate", op: "extrude", sketch: "s1", distance: 3 },
    ];
    const one = built(doc(...plate, { id: "f", op: "fillet", edges: { type: "edge", direction: [1, 0, 0], near: [0, -10, 3], pick: "all" }, radius: 4 }));
    expect(one.errors).toHaveLength(1);
    expect(one.errors[0]).toMatch(/^f: edge 1 \(straight, [+-]X, length 20, at \[0, -10, 3\]\): radius 4 is too large for the 3 mm face beside it$/);
    // Of several edges, only the ones that fail are named.
    const two = built(doc(...plate, { id: "f", op: "fillet", edges: [{ type: "edge", direction: [1, 0, 0], near: [0, -10, 3], pick: "all" }, { type: "edge", direction: [0, 0, 1], near: [10, 10, 1.5], pick: "all" }], radius: 4 }));
    expect(two.errors).toHaveLength(1);
    expect(two.errors[0]).toMatch(/^f: edge \d of 2 \(straight, [+-]X, length 20, at \[0, -10, 3\]\): radius 4 is too large for the 3 mm face beside it$/);
  });

  it("a chamfer of two distances: a·b·L/2, the first distance on the face facing up, flip swaps them", () => {
    const top = (f: Raw) => {
      const b = built(doc(...CUBE, f));
      expect(b.errors).toEqual([]);
      return { removed: BOX - b.volume, top: Math.max(...b.up) };
    };
    expect(top({ id: "c", op: "chamfer", edges: TOP_FRONT, distance: 2, distance2: 5 })).toEqual({ removed: expect.closeTo(0.5 * 2 * 5 * 20, 6), top: expect.closeTo(400 - 2 * 20, 6) });
    expect(top({ id: "c", op: "chamfer", edges: TOP_FRONT, distance: 2, distance2: 5, flip: true })).toEqual({ removed: expect.closeTo(0.5 * 2 * 5 * 20, 6), top: expect.closeTo(400 - 5 * 20, 6) });
    // Equal distances, as before.
    expect(removed({ id: "c", op: "chamfer", edges: TOP_FRONT, distance: 2 })).toBeCloseTo(0.5 * 2 * 2 * 20, 6);
  });

  it("a distance and an angle: the other leg is distance·tan(angle)", () => {
    const t30 = Math.tan(PI / 6);
    expect(removed({ id: "c", op: "chamfer", edges: TOP_FRONT, distance: 2, angle: 30 })).toBeCloseTo(0.5 * 2 * 2 * t30 * 20, 6);
    // On the top face the 2 mm leg; flipped, on the front face: the top loses 2·tan 30° instead.
    const b = built(doc(...CUBE, { id: "c", op: "chamfer", edges: TOP_FRONT, distance: 2, angle: 30, flip: true }));
    expect(Math.max(...b.up)).toBeCloseTo(400 - 2 * t30 * 20, 6);
  });
});
