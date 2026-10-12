// loft (Phase O wave 4, DESIGN §2.6): a solid through sketch profiles in
// order: ruled or smooth, closed into a ring, to a point, holes lofted too,
// and the operations. Volumes by hand:
//   - ruled between parallel similar sections (a frustum): h/3·(A1 + A2 + √(A1·A2));
//   - to a point (a pyramid): A·h/3;
//   - a square ring of 8 sections round a circle of radius 30: about Pappus,
//     area x 2π·30.
// Plus the loops' alignment (pure): same way round, nearest start.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { alignLoops, loopCentroid, loopStart, startToward, type PlacedLoop } from "../src/features/loft/align";
import { planeFrame } from "../src/geom/frame";
import { buildProfile, type Loop } from "../src/geom/profile";
import { loadOC, rebuild, type OC } from "../src/kernel";

type Raw = Record<string, unknown>;
const PI = Math.PI;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const sketch = (id: string, plane: unknown, entities: Raw[]): Raw => ({ id, op: "sketch", plane, entities, constraints: [] });
const doc = (...features: Raw[]): RawDocument => ({ version: 1, units: "mm", name: "loft test", features });
const errorsOf = (d: unknown) => allErrors(validateDocument(d));
/** A plane 30 above Top (a Wave 1 plane feature) and a sketch on it. */
const PLANE = { id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 30 };
const onPlane = (id: string, entities: Raw[]) => sketch(id, { type: "ref", ref: { datum: "plane_1" } }, entities);
const BIG = sketch("s1", TOP, [{ id: "r1", type: "rect", center: [0, 0], w: 20, h: 20 }]);
const SMALL = onPlane("s2", [{ id: "r2", type: "rect", center: [0, 0], w: 10, h: 10 }]);
const frustum = (h: number, a1: number, a2: number) => (h / 3) * (a1 + a2 + Math.sqrt(a1 * a2));

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
      bodies: (m?.bodies ?? []).map((b) => b.name),
    };
  } finally {
    r.dispose();
  }
}

const loopOf = (e: Raw): Loop => {
  const p = buildProfile([e as never]);
  if (!p.ok) throw new Error(p.error);
  return p.regions[0].outer;
};

describe("loft: lining the loops up (pure)", () => {
  it("starts a loop at the corner pointing the way the previous one starts; a circle at that point", () => {
    const square = loopOf({ id: "r", type: "rect", center: [0, 0], w: 10, h: 10 });
    expect(startToward(square, [1, 1]).segs[0].a).toEqual([5, 5]);
    expect(startToward(square, [-1, -0.9]).segs[0].a).toEqual([-5, -5]);
    const circle = loopOf({ id: "c", type: "circle", center: [2, 0], radius: 4 });
    expect(startToward(circle, [0, 1]).segs[0].a.map(r6)).toEqual([2, 4]);
    expect(loopCentroid(square).map(r6)).toEqual([0, 0]);
    expect(loopCentroid(circle).map(r6)).toEqual([2, 0]);
  });

  it("turns a loop on a plane facing back so every loop runs the same way round along the loft", () => {
    const a: PlacedLoop = { frame: planeFrame([0, 0, 1], [0, 0, 0]), loop: loopOf({ id: "r", type: "rect", center: [0, 0], w: 10, h: 10 }) };
    // The same square 30 up, on a plane facing down (its sketch x is world X, its y world -Y).
    const back: PlacedLoop = { frame: planeFrame([0, 0, -1], [0, 0, 30]), loop: loopOf({ id: "r", type: "rect", center: [0, 0], w: 10, h: 10 }) };
    const [, b2] = alignLoops([a, back]) as PlacedLoop[];
    expect(b2.loop.area).toBeLessThan(0); // reversed in its own frame: counter-clockwise seen from +Z
    expect(loopStart(b2).map(r6)).toEqual([...loopStart(a).slice(0, 2).map(r6), 30]);
  });
});

describe("loft: validation", () => {
  const bad = (f: Raw) => errorsOf(doc(BIG, PLANE, SMALL, { id: "lo", op: "loft", ...f }));
  it("needs 2 or more different sketches; closed needs 3", () => {
    expect(bad({ profiles: ["s1", "s2"] })).toEqual([]);
    expect(bad({ profiles: ["s1"] })).toEqual(["lo: profiles: a loft passes through 2 or more sketches (got 1)"]);
    expect(bad({ profiles: "s1" })).toEqual(['lo: profiles: must be a list of 2 or more sketch ids, in the order the loft passes through them (got "s1")']);
    expect(bad({ profiles: ["s1", "s1"] })).toEqual(['lo: profiles[1]: "s1" is listed twice: each sketch is one section']);
    expect(bad({ profiles: ["s1", "nope"] })[0]).toMatch(/^lo: profiles\[1\]: /);
    expect(bad({ profiles: ["s1", "s2"], closed: true })).toEqual(["lo: closed: a closed loft goes round through 3 or more sections and back to the first"]);
    expect(bad({ profiles: ["s1", "s2"], twist: 1 })).toEqual(['lo: unknown field "twist" (allowed: id, op, profiles, ruled, closed, operation, body, bodies, newBody)']);
  });
});

describe("loft: kernel", () => {
  it("a ruled loft between two parallel squares on offset planes is a frustum: h/3·(A1 + A2 + √(A1·A2))", () => {
    for (const ruled of [true, false]) {
      const b = built(doc(BIG, PLANE, SMALL, { id: "lo", op: "loft", profiles: ["s1", "s2"], ...(ruled ? { ruled } : {}) }));
      expect(b.errors).toEqual([]);
      // Two sections: the smooth blend is the same straight frustum.
      expect(b.volume).toBeCloseTo(frustum(30, 400, 100), 6);
      expect(b.box).toEqual({ min: [-10, -10, 0], max: [10, 10, 30] });
    }
  });

  it("is not twisted by drawing order: the small square drawn as four lines from another corner, the other way round", () => {
    const lines = onPlane("s2", [
      { id: "l1", type: "line", start: [5, 5], end: [5, -5] },
      { id: "l2", type: "line", start: [5, -5], end: [-5, -5] },
      { id: "l3", type: "line", start: [-5, -5], end: [-5, 5] },
      { id: "l4", type: "line", start: [-5, 5], end: [5, 5] },
    ]);
    const b = built(doc(BIG, PLANE, lines, { id: "lo", op: "loft", profiles: ["s1", "s2"], ruled: true }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(frustum(30, 400, 100), 6);
  });

  it("square to circle: a valid solid between the two prisms' volumes", () => {
    const circle = onPlane("s2", [{ id: "c1", type: "circle", center: [0, 0], radius: 8 }]);
    const b = built(doc(BIG, PLANE, circle, { id: "lo", op: "loft", profiles: ["s1", "s2"] }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeGreaterThan(PI * 64 * 30);
    expect(b.volume).toBeLessThan(400 * 30);
    expect(b.box).toEqual({ min: [-10, -10, 0], max: [10, 10, 30] });
  });

  it("comes to a point: a sketch with one point at the end makes a pyramid, A·h/3", () => {
    const apex = onPlane("s2", [{ id: "p1", type: "point", at: [0, 0] }]);
    const b = built(doc(BIG, PLANE, apex, { id: "lo", op: "loft", profiles: ["s1", "s2"], ruled: true }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo((400 * 30) / 3, 6);
    const middle = built(doc(BIG, PLANE, apex, onPlane("s3", [{ id: "r3", type: "rect", center: [0, 0], w: 4, h: 4 }]), { id: "lo", op: "loft", profiles: ["s1", "s2", "s3"] }));
    expect(middle.errors).toEqual(['lo: profiles[1]: sketch "s2" is a point: a loft can come to a point only at its first or last section']);
  });

  it("lofts holes through when every section has one", () => {
    const ringA = sketch("s1", TOP, [
      { id: "r1", type: "rect", center: [0, 0], w: 20, h: 20 },
      { id: "h1", type: "rect", center: [0, 0], w: 10, h: 10 },
    ]);
    const ringB = onPlane("s2", [
      { id: "r2", type: "rect", center: [0, 0], w: 10, h: 10 },
      { id: "h2", type: "rect", center: [0, 0], w: 4, h: 4 },
    ]);
    const b = built(doc(ringA, PLANE, ringB, { id: "lo", op: "loft", profiles: ["s1", "s2"], ruled: true }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(frustum(30, 400, 100) - frustum(30, 100, 16), 6);
    expect(built(doc(ringA, PLANE, SMALL, { id: "lo", op: "loft", profiles: ["s1", "s2"] })).errors).toEqual([
      "lo: profiles: the sections have 1, 0 holes: to loft holes every section needs the same number (loft the outer shape, then cut the holes with a loft or extrude of their own)",
    ]);
  });

  it("says why a sketch is no section: two regions, or an open chain", () => {
    const two = onPlane("s2", [
      { id: "c1", type: "circle", center: [-5, 0], radius: 2 },
      { id: "c2", type: "circle", center: [5, 0], radius: 2 },
    ]);
    expect(built(doc(BIG, PLANE, two, { id: "lo", op: "loft", profiles: ["s1", "s2"] })).errors).toEqual([
      'lo: profiles[1]: sketch "s2" has 2 separate regions: a loft passes through one region in each sketch (split it into sketches, or loft each separately)',
    ]);
    const open = onPlane("s2", [{ id: "l1", type: "line", start: [0, 0], end: [5, 0] }]);
    expect(built(doc(BIG, PLANE, open, { id: "lo", op: "loft", profiles: ["s1", "s2"] })).errors[0]).toMatch(/^lo: profiles\[1\]: sketch "s2" has no closed profile to loft through: profile is open at/);
  });

  it("a closed loft round a ring of 8 square sections: about Pappus, 100 x 2π·30", () => {
    const sections: Raw[] = [];
    for (let k = 0; k < 8; k++) {
      const t = (2 * PI * k) / 8;
      // A plane through the Z axis, its sketch x outward (cos t, sin t), its sketch y down (-Z).
      const plane = { type: "datum", origin: [0, 0, 0], normal: [-Math.sin(t), Math.cos(t), 0], xDir: [Math.cos(t), Math.sin(t), 0] };
      sections.push(sketch(`q${k}`, plane, [{ id: "r", type: "rect", center: [30, 0], w: 10, h: 10 }]));
    }
    const b = built(doc(...sections, { id: "ring", op: "loft", profiles: sections.map((x) => x.id), closed: true }));
    expect(b.errors).toEqual([]);
    expect(b.volume / (100 * 2 * PI * 30)).toBeCloseTo(1, 2);
  });

  it("a lofted cut: a tapered pocket out of a block", () => {
    const block = [sketch("b", TOP, [{ id: "rb", type: "rect", center: [0, 0], w: 40, h: 40 }]), { id: "blk", op: "extrude", sketch: "b", distance: 30 }];
    const b = built(doc(...block, BIG, PLANE, SMALL, { id: "pocket", op: "loft", profiles: ["s1", "s2"], ruled: true, operation: "remove" }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(1600 * 30 - frustum(30, 400, 100), 6);
    expect(b.bodies).toEqual(["main"]);
  });
});
