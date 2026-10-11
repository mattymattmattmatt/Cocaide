// Extrude and cut end conditions (Phase O wave 3B, DESIGN §2.6 "Upgrades to
// existing ops"): up to next, up to a face (flat or curved, a plane feature),
// up to a vertex, offset from a face, through all both ways; a second
// direction; a start offset or another start plane; draft; thin walls from
// open or closed sketches; intersect; picked regions; flip side to cut.
// Volumes are worked out by hand in the comments.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { complementRegions, openOutside, pickRegions, thinRegions, areaOf } from "../src/features/extrude/regions";
import { openChain } from "../src/features/revolve/band";
import { buildProfile, type Region } from "../src/geom/profile";
import { loadOC, rebuild, type OC } from "../src/kernel";

type Raw = Record<string, unknown>;
const PI = Math.PI;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const tan = (deg: number) => Math.tan((deg * PI) / 180);

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const sketch = (id: string, entities: Raw[], plane: Raw = TOP): Raw => ({ id, op: "sketch", plane, entities, constraints: [] });
const rect = (id: string, w: number, h: number, center: [number, number] = [0, 0]): Raw => ({ id, type: "rect", center, w, h });
const circle = (id: string, r: number, center: [number, number] = [0, 0]): Raw => ({ id, type: "circle", center, radius: r });
const line = (id: string, start: [number, number], end: [number, number]): Raw => ({ id, type: "line", start, end });
const onPlane = (id: string) => ({ type: "ref", ref: { datum: id } });
const offsetPlane = (id: string, distance: number): Raw => ({ id, op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance });
const doc = (...features: Raw[]): RawDocument => ({ version: 1, units: "mm", name: "extrude plus", features });
const errorsOf = (d: unknown) => allErrors(validateDocument(d));

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(d: unknown) {
  const r = rebuild(d, oc);
  try {
    const m = r.measurements;
    return {
      errors: r.errors,
      volume: m?.volume ?? 0,
      box: m?.boundingBox ? { min: m.boundingBox.min.map(r6), max: m.boundingBox.max.map(r6) } : null,
      solids: m?.solids ?? 0,
    };
  } finally {
    r.dispose();
  }
}

/** The part builds without errors; its volume. */
function volume(d: unknown): number {
  const b = built(d);
  expect(b.errors).toEqual([]);
  return b.volume;
}

// A 10 x 10 square on Top, centred on the origin.
const SQ = sketch("s1", [rect("r1", 10, 10)]);
const ext = (f: Raw = {}): Raw => ({ id: "ext_1", op: "extrude", sketch: "s1", ...f });

describe("extrude end conditions: validation", () => {
  const bad = (f: Raw, ...before: Raw[]) => errorsOf(doc(...before, SQ, ext(f)));

  it("takes the new end conditions with what each needs, and nothing it does not", () => {
    expect(bad({ extent: "upToNext" })).toEqual([]);
    expect(bad({ extent: "throughAllBoth" })).toEqual([]);
    expect(bad({ extent: "upToFace", upTo: { datum: "Top" } })).toEqual([]);
    expect(bad({ extent: "upToVertex", upTo: { point: [0, 0, 5] } })).toEqual([]);
    expect(bad({ extent: "offsetFromFace", upTo: { datum: "Top" }, offset: 2 })).toEqual([]);
    expect(bad({ extent: "upToFace" })).toEqual(['ext_1: upTo: needed: the face or plane to go up to ({ "face": <selector> }, { "datum": "Top" or a plane feature })']);
    expect(bad({ extent: "upToVertex", upTo: { datum: "Top" } })[0]).toMatch(/^ext_1: upTo: Top is a plane, but a point is needed here/);
    expect(bad({ extent: "upToFace", upTo: { datum: "X" } })[0]).toMatch(/^ext_1: upTo: X is an axis, but a plane is needed here/);
    expect(bad({ extent: "upToNext", distance: 3 })).toEqual(["ext_1: distance: must be omitted when extent is upToNext"]);
    expect(bad({ distance: 5, upTo: { datum: "Top" } })).toEqual(["ext_1: upTo: must be omitted when extent is blind"]);
    expect(bad({ distance: 5, offset: 2 })).toEqual(["ext_1: offset: goes with extent offsetFromFace (got extent blind)"]);
    expect(bad({ extent: "sideways" })).toEqual([
      'ext_1: extent: must be "blind", "midplane", "throughAll", "throughAllBoth", "upToNext", "upToFace", "upToVertex" or "offsetFromFace" (got "sideways")',
    ]);
  });

  it("a second direction has its own end condition, and none with midplane", () => {
    expect(bad({ distance: 5, direction2: { extent: "blind", distance: 3 } })).toEqual([]);
    expect(bad({ distance: 5, direction2: { extent: "upToNext" } })).toEqual([]);
    expect(bad({ distance: 5, direction2: { extent: "blind" } })).toEqual(["ext_1: direction2.distance: must be a number (got nothing)"]);
    expect(bad({ distance: 5, direction2: { extent: "midplane", distance: 2 } })[0]).toMatch(/^ext_1: direction2.extent: must be "blind", "throughAll"/);
    expect(bad({ extent: "midplane", distance: 5, direction2: { extent: "blind", distance: 3 } })).toEqual(["ext_1: direction2: extent midplane already goes both ways from the sketch: leave direction2 out"]);
    expect(bad({ distance: 5, direction2: { extent: "blind", distance: 3, twist: 1 } })).toEqual(['ext_1: direction2: unknown field "twist" (allowed: extent, distance, upTo, offset, draft)']);
  });

  it("checks the start, draft, thin, regions, intersect and flip side", () => {
    expect(bad({ distance: 5, startOffset: 2 })).toEqual([]);
    expect(bad({ distance: 5, from: { point: [0, 0, 3] } })).toEqual([]);
    expect(bad({ distance: 5, from: { datum: "Z" } })[0]).toMatch(/^ext_1: from: Z is an axis/);
    expect(bad({ distance: 5, startOffset: 2, from: { datum: "Top" } })).toEqual(["ext_1: from: give startOffset (from the sketch plane) or from (a plane, flat face or point), not both"]);
    expect(bad({ distance: 5, draft: { angle: 5, outward: true } })).toEqual([]);
    expect(bad({ distance: 5, draft: { angle: 90 } })).toEqual(["ext_1: draft.angle: must be under 90 degrees (got 90)"]);
    expect(bad({ distance: 5, draft: 5 })).toEqual(['ext_1: draft: must be { "angle": <degrees>, "outward"?: true } (got 5)']);
    expect(bad({ distance: 5, thin: { thickness: 2, side: "mid" } })).toEqual([]);
    expect(bad({ distance: 5, thin: { thickness: 2, side: "middle" } })).toEqual(['ext_1: thin.side: must be "outside", "inside" or "mid" (got "middle")']);
    expect(bad({ distance: 5, thin: { thickness: 2 }, draft: { angle: 3 } })).toEqual(["ext_1: draft: a thin feature has no draft here: leave draft out, or make it a solid extrude"]);
    expect(bad({ distance: 5, regions: [[1, 2]] })).toEqual([]);
    expect(bad({ distance: 5, regions: [] })[0]).toMatch(/^ext_1: regions: must be a list of points/);
    expect(bad({ distance: 5, regions: [[1, 2, 3]] })).toEqual(["ext_1: regions[0]: must be a point [x, y] in the sketch (got [1,2,3])"]);
    expect(bad({ distance: 5, intersect: true, newBody: "b" })[0]).toMatch(/^ext_1: intersect: keeps the overlap/);
    // An intersect keeps the overlap with a body there is: with none before it, it says so.
    expect(bad({ distance: 5, intersect: true })).toEqual(['ext_1: intersect: no body "main" before this feature (no bodies yet)']);
    expect(errorsOf(doc(SQ, ext({ distance: 5 }), { id: "cut_1", op: "cut", sketch: "s1", distance: 2, flipSide: true }))).toEqual([]);
    expect(bad({ distance: 5, flipSide: true })[0]).toMatch(/^ext_1: unknown field "flipSide"/);
  });

  it("names the up-to plane feature as a reference: it cannot be deleted from under the extrude", () => {
    const d = doc(offsetPlane("plane_1", 10), SQ, ext({ extent: "upToFace", upTo: { datum: "plane_1" } }));
    expect(errorsOf(d)).toEqual([]);
    expect(errorsOf(doc(SQ, ext({ extent: "upToFace", upTo: { datum: "plane_1" } })))[0]).toMatch(/plane_1" is not a feature before this one/);
  });
});

describe("extrude end conditions: volumes", () => {
  it("blind is as before: 10 x 10 x 5 = 500", () => {
    expect(volume(doc(SQ, ext({ distance: 5 })))).toBeCloseTo(500, 6);
  });

  it("up to a plane feature parallel to the sketch: 10 x 10 x 7 = 700", () => {
    expect(volume(doc(offsetPlane("plane_1", 7), SQ, ext({ extent: "upToFace", upTo: { datum: "plane_1" } })))).toBeCloseTo(700, 6);
  });

  it("up to a slanted plane: z = 10 + x over x, y in -5..5 is 10 x 100 = 1000, and the end face slants", () => {
    const slant = { id: "plane_1", op: "plane", mode: "threePoints", refs: [{ point: [0, 0, 10] }, { point: [1, 0, 11] }, { point: [0, 1, 10] }] };
    const b = built(doc(slant, SQ, ext({ extent: "upToFace", upTo: { datum: "plane_1" } })));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(1000, 6);
    expect(b.box).toEqual({ min: [-5, -5, 0], max: [5, 5, 15] });
  });

  it("up to a vertex: the plane through it parallel to the sketch, 10 x 10 x 12 = 1200", () => {
    expect(volume(doc(SQ, ext({ extent: "upToVertex", upTo: { point: [50, -50, 12] } })))).toBeCloseTo(1200, 6);
  });

  it("offset from a face: short of it, or past it with a negative offset", () => {
    const at = (offset: number) => doc(offsetPlane("plane_1", 10), SQ, ext({ extent: "offsetFromFace", upTo: { datum: "plane_1" }, offset }));
    expect(volume(at(3))).toBeCloseTo(700, 6);
    expect(volume(at(-2))).toBeCloseTo(1200, 6);
  });

  it("says when the face is behind the start, or across the profile", () => {
    const behind = built(doc(offsetPlane("plane_1", -4), SQ, ext({ extent: "upToFace", upTo: { datum: "plane_1" } })));
    expect(behind.errors).toEqual(["ext_1: plane_1 is behind the start in direction +Z: it must lie wholly ahead of where the extrude starts (reverse the direction?)"]);
    const across = { id: "plane_1", op: "plane", mode: "threePoints", refs: [{ point: [0, 0, 0] }, { point: [1, 0, 1] }, { point: [0, 1, 0] }] };
    expect(built(doc(across, SQ, ext({ extent: "upToFace", upTo: { datum: "plane_1" } }))).errors).toEqual([
      "ext_1: plane_1 is across the profile in direction +Z: it must lie wholly ahead of where the extrude starts",
    ]);
  });

  // A 40 x 40 x 30 block, z 0..30, with a 20 wide, 10 high tunnel through it along Y at z 10..20: 48000 - 8000 = 40000.
  const BLOCK = [
    sketch("s_block", [rect("rb", 40, 40)]),
    { id: "block", op: "extrude", sketch: "s_block", distance: 30 },
    sketch("s_tunnel", [rect("rt", 20, 10, [0, 15])], { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] }),
    { id: "tunnel", op: "cut", sketch: "s_tunnel", extent: "throughAllBoth" },
  ];

  it("through all, both ways: the tunnel goes right through, 40000 left", () => {
    expect(volume(doc(...BLOCK))).toBeCloseTo(40000, 6);
  });

  it("a cut up to next stops where the material ends (the tunnel's roof); through all goes on through the floor", () => {
    const top = [offsetPlane("plane_30", 30), sketch("s_top", [rect("r", 10, 10)], onPlane("plane_30"))];
    const cut = (f: Raw) => doc(...BLOCK, ...top, { id: "cut_1", op: "cut", sketch: "s_top", direction: [0, 0, -1], ...f });
    expect(volume(cut({ extent: "upToNext" }))).toBeCloseTo(40000 - 1000, 6);
    expect(volume(cut({ extent: "throughAll" }))).toBeCloseTo(40000 - 2000, 6);
  });

  it("a boss up to next fills the gap to the part; a cut up to next from above the part crosses the gap first", () => {
    const above = [offsetPlane("plane_40", 40), sketch("s_up", [rect("r", 10, 10)], onPlane("plane_40"))];
    expect(volume(doc(...BLOCK, ...above, { id: "boss", op: "extrude", sketch: "s_up", direction: [0, 0, -1], extent: "upToNext" }))).toBeCloseTo(41000, 6);
    expect(volume(doc(...BLOCK, ...above, { id: "cut_1", op: "cut", sketch: "s_up", direction: [0, 0, -1], extent: "upToNext" }))).toBeCloseTo(39000, 6);
  });

  it("a boss up to next that misses the part says so", () => {
    const above = [offsetPlane("plane_40", 40), sketch("s_up", [rect("r", 10, 10, [100, 0])], onPlane("plane_40"))];
    expect(built(doc(...BLOCK, ...above, { id: "boss", op: "extrude", sketch: "s_up", direction: [0, 0, -1], extent: "upToNext" })).errors).toEqual([
      "boss: up to next: the profile does not meet the part all round in direction -Z: part of it would run on forever; use up to face or through all",
    ]);
  });

  it("up to a curved face: a 10 x 4 boss from z = 0 up to the underside of a radius 10 cylinder at z = 30", () => {
    // Under the cylinder (axis along X at z = 30) the boss reaches z = 30 - sqrt(100 - y²): over |y| <= 2,
    // ∫ sqrt(100 - y²) dy = 2·sqrt(96) + 100·asin(0.2), so the boss is 10 · (30·4 - that).
    const RIGHT = { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] };
    const boss = 10 * (120 - (2 * Math.sqrt(96) + 100 * Math.asin(0.2)));
    const d = doc(
      sketch("s_cyl", [circle("c", 10, [0, 30])], RIGHT),
      { id: "cyl", op: "extrude", sketch: "s_cyl", extent: "midplane", distance: 40 },
      sketch("s1", [rect("r1", 10, 4)]),
      { id: "boss", op: "extrude", sketch: "s1", extent: "upToFace", upTo: { face: { type: "cylindrical", radius: 10, pick: "largest" } } },
    );
    expect(volume(d)).toBeCloseTo(PI * 100 * 40 + boss, 4);
  });

  it("a second direction: 5 one way and 3 the other, z = -3..5", () => {
    const b = built(doc(SQ, ext({ distance: 5, direction2: { extent: "blind", distance: 3 } })));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(800, 6);
    expect(b.box).toEqual({ min: [-5, -5, -3], max: [5, 5, 5] });
  });

  it("starts at an offset of the sketch plane, or at a plane or point", () => {
    const b = built(doc(SQ, ext({ distance: 5, startOffset: 2 })));
    expect(b.volume).toBeCloseTo(500, 6);
    expect(b.box).toEqual({ min: [-5, -5, 2], max: [5, 5, 7] });
    expect(built(doc(SQ, ext({ distance: 5, from: { point: [7, 7, 4] } }))).box).toEqual({ min: [-5, -5, 4], max: [5, 5, 9] });
    // From a slanted plane z = 4 + x/2: the start slants, the blind end (5 along Z from it) slants with it.
    const slant = { id: "plane_1", op: "plane", mode: "threePoints", refs: [{ point: [0, 0, 4] }, { point: [2, 0, 5] }, { point: [0, 1, 4] }] };
    const s = built(doc(slant, SQ, ext({ distance: 5, from: { datum: "plane_1" } })));
    expect(s.errors).toEqual([]);
    expect(s.volume).toBeCloseTo(500, 6);
    expect(s.box).toEqual({ min: [-5, -5, 1.5], max: [5, 5, 11.5] });
  });

  it("draft tapers the sides: a square frustum h/3 (A1 + A2 + sqrt(A1 A2)), inward or outward", () => {
    const frustum = (side2: number) => (10 / 3) * (100 + side2 * side2 + 10 * side2);
    expect(volume(doc(SQ, ext({ distance: 10, draft: { angle: 5 } })))).toBeCloseTo(frustum(10 - 20 * tan(5)), 5);
    expect(volume(doc(SQ, ext({ distance: 10, draft: { angle: 5, outward: true } })))).toBeCloseTo(frustum(10 + 20 * tan(5)), 5);
  });

  it("draft on a circle is a cone frustum πh/3 (R² + Rr + r²); on midplane both halves taper from the middle", () => {
    const cone = (h: number, R: number, r: number) => ((PI * h) / 3) * (R * R + R * r + r * r);
    const disc = sketch("s1", [circle("c1", 5)]);
    expect(volume(doc(disc, ext({ distance: 10, draft: { angle: 10 } })))).toBeCloseTo(cone(10, 5, 5 - 10 * tan(10)), 4);
    expect(volume(doc(disc, ext({ extent: "midplane", distance: 10, draft: { angle: 10 } })))).toBeCloseTo(2 * cone(5, 5, 5 - 5 * tan(10)), 4);
    // Direction 2 with its own draft: 5 up straight, 4 down tapering 10° outward.
    expect(volume(doc(disc, ext({ distance: 5, direction2: { extent: "blind", distance: 4, draft: { angle: 10, outward: true } } })))).toBeCloseTo(
      PI * 25 * 5 + cone(4, 5, 5 + 4 * tan(10)),
      4,
    );
  });

  it("thin from an open L: the wall on its outside, inside or both sides", () => {
    // Lines (0,0)-(20,0)-(20,10); 2 thick, 5 high. Outside (the convex side): [0,22]x[-2,0] + [20,22]x[0,10] = 44 + 20.
    const L = sketch("s1", [line("l1", [0, 0], [20, 0]), line("l2", [20, 0], [20, 10])]);
    const thin = (side?: string) => doc(L, ext({ distance: 5, thin: { thickness: 2, ...(side ? { side } : {}) } }));
    expect(volume(thin())).toBeCloseTo(64 * 5, 6);
    expect(volume(thin("inside"))).toBeCloseTo((40 + 16) * 5, 6);
    expect(volume(thin("mid"))).toBeCloseTo((42 + 18) * 5, 6);
    // Without thin, an open sketch has nothing to extrude, and says what to do.
    expect(built(doc(L, ext({ distance: 5 }))).errors[0]).toMatch(/has no closed profile to extrude: .*make it a thin feature/);
  });

  it("thin from a closed square makes a tube: 24² - 20² or 20² - 16², 10 high", () => {
    const sq = sketch("s1", [rect("r1", 20, 20)]);
    expect(volume(doc(sq, ext({ distance: 10, thin: { thickness: 2 } })))).toBeCloseTo(176 * 10, 6);
    expect(volume(doc(sq, ext({ distance: 10, thin: { thickness: 2, side: "inside" } })))).toBeCloseTo(144 * 10, 6);
  });

  it("intersect keeps only the overlap with the body", () => {
    const d = doc(sketch("s0", [rect("r0", 20, 20)]), { id: "base", op: "extrude", sketch: "s0", distance: 20 }, SQ, ext({ distance: 30, intersect: true }));
    expect(volume(d)).toBeCloseTo(10 * 10 * 20, 6);
    // It leaves no tool to repeat.
    const pattern = { id: "p", op: "linearPattern", feature: "ext_1", direction: [1, 0, 0], spacing: 30, count: 2 };
    expect(built({ ...d, features: [...d.features, pattern] }).errors).toEqual([
      'p: "ext_1" is an intersecting extrude: it keeps an overlap and adds no tool to repeat; pattern the bodies instead',
    ]);
  });

  it("picked regions: the ring, the disc, or both, of one sketch", () => {
    const s = sketch("s1", [rect("r1", 20, 20), circle("c1", 5)]);
    const at = (regions: number[][]) => volume(doc(s, ext({ distance: 10, regions })));
    expect(at([[8, 8]])).toBeCloseTo((400 - 25 * PI) * 10, 6);
    expect(at([[0, 0]])).toBeCloseTo(25 * PI * 10, 6);
    expect(at([[0, 0], [8, 8], [9, -9]])).toBeCloseTo(4000, 6);
    expect(built(doc(s, ext({ distance: 10, regions: [[30, 0]] }))).errors).toEqual(["ext_1: regions[0]: [30, 0] is outside every closed loop of the sketch"]);
    // The same sketch drives a second feature: the plate (the whole sketch is the ring), then a shorter boss in its hole.
    const two = doc(s, ext({ distance: 10 }), { id: "boss", op: "extrude", sketch: "s1", distance: 4, regions: [[0, 0]] });
    expect(volume(two)).toBeCloseTo((400 - 25 * PI) * 10 + 25 * PI * 4, 6);
  });

  it("flip side to cut keeps what is inside the profile", () => {
    const d = doc(sketch("s0", [rect("r0", 20, 20)]), { id: "base", op: "extrude", sketch: "s0", distance: 10 }, sketch("s1", [circle("c1", 5)]), {
      id: "cut_1",
      op: "cut",
      sketch: "s1",
      distance: 6,
      flipSide: true,
    });
    // Outside the disc, 6 deep from the bottom, is gone: 25π·10 + (400 - 25π)·4 is left.
    expect(volume(d)).toBeCloseTo(25 * PI * 10 + (400 - 25 * PI) * 4, 6);
  });

  it("patterns repeat an up-to extrude's tool", () => {
    const d = doc(offsetPlane("plane_1", 7), SQ, ext({ extent: "upToFace", upTo: { datum: "plane_1" } }), { id: "p", op: "linearPattern", feature: "ext_1", direction: [1, 0, 0], spacing: 20, count: 3 });
    expect(volume(d)).toBeCloseTo(2100, 6);
  });
});

describe("extrude regions, pure", () => {
  const regionsOf = (entities: Raw[]): Region[] => {
    const p = buildProfile(entities as never);
    if (!p.ok) throw new Error(p.error);
    return p.regions;
  };

  it("picks the innermost loop around a point, less the loops inside it", () => {
    const rs = regionsOf([rect("r", 20, 20), circle("c", 5), circle("c2", 2)]);
    // Square ⊃ disc 5 ⊃ disc 2: depths 0, 1, 2.
    expect(areaOf(pickRegions(rs, [[8, 8]]))).toBeCloseTo(400 - 25 * PI, 9);
    expect(areaOf(pickRegions(rs, [[3.5, 0]]))).toBeCloseTo(25 * PI - 4 * PI, 9);
    expect(areaOf(pickRegions(rs, [[0, 0]]))).toBeCloseTo(4 * PI, 9);
    expect(() => pickRegions(rs, [[10, 0]])).toThrow("regions[0]: [10, 0] is on the sketch's lines: give a point inside the region");
  });

  it("the complement in a rectangle turns the nesting inside out", () => {
    const rs = regionsOf([rect("r", 20, 20), circle("c", 5)]);
    expect(areaOf(complementRegions(rs, [-20, -20], [20, 20]))).toBeCloseTo(1600 - 400 + 25 * PI, 9);
  });

  it("an open chain's outside is its convex side; a straight line's is its left", () => {
    expect(openOutside(openChain([line("a", [0, 0], [20, 0]), line("b", [20, 0], [20, 10])] as never))).toBe(-1);
    expect(openOutside(openChain([line("a", [0, 0], [20, 0])] as never))).toBe(1);
    // A single straight line, 2 thick: a 20 x 2 band either way.
    expect(areaOf(thinRegions([], [line("a", [0, 0], [20, 0])] as never, 2))).toBeCloseTo(40, 9);
  });
});
