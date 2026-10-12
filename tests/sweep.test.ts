// sweep (Phase O wave 4, DESIGN §2.6): a profile (a sketch's closed profile,
// or a circle of a diameter) carried along a path (a chain in another sketch,
// model edges, or an exact helix); twist, fixed orientation, and the
// operations. Volumes worked out by hand:
//   - along a straight or smoothly curved path, a profile square to the path
//     sweeps area x path length (Pappus for each arc);
//   - round a sharp corner the profile turns about the corner: the two legs'
//     cylinders overlap in a quarter of a Steinmetz bicylinder (4r³/3) and the
//     outside gains a quarter ball (πr³/3);
//   - a spring of wire diameter d: π/4·d² x the helix length, turns x
//     sqrt((2πR)² + pitch²) (a tube about any smooth curve);
//   - a fixed (sliding) profile sweeps area x how far the path moves along the
//     profile's normal.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { SketchEntity } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { chainLength, chainSmooth, ChainError, reverseChain, sketchChain, startOnPlane } from "../src/features/sweep/chain";
import { axisFrame, endRadius, helixLength, helixNumbers, helixPoint } from "../src/features/sweep/helix";
import { planeFrame } from "../src/geom/frame";
import { loadOC, rebuild, type OC } from "../src/kernel";

type Raw = Record<string, unknown>;
const PI = Math.PI;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
/** Front: sketch x = world X, sketch y = world Z. */
const FRONT = { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] };
const sketch = (id: string, plane: unknown, entities: Raw[]): Raw => ({ id, op: "sketch", plane, entities, constraints: [] });
const doc = (...features: Raw[]): RawDocument => ({ version: 1, units: "mm", name: "sweep test", features });
const errorsOf = (d: unknown) => allErrors(validateDocument(d));

/** A path up the Z axis, 100 long, drawn on Front. */
const UP = sketch("path", FRONT, [{ id: "l1", type: "line", start: [0, 0], end: [0, 100] }]);
const DISC = sketch("prof", TOP, [{ id: "c1", type: "circle", center: [0, 0], radius: 5 }]);

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
      solids: m?.solids ?? 0,
      box: m?.boundingBox ? { min: m.boundingBox.min.map(r6), max: m.boundingBox.max.map(r6) } : null,
      bodies: (m?.bodies ?? []).map((b) => b.name),
    };
  } finally {
    r.dispose();
  }
}

// ------------------------------------------------------------ pure parts

describe("sweep: the path's chain (pure)", () => {
  const L = (id: string, a: [number, number], b: [number, number]): SketchEntity => ({ id, type: "line", start: a, end: b });

  it("joins lines and arcs end to end, from the free end with the lowest coordinates, whatever the drawing order", () => {
    const c = sketchChain([L("b", [10, 0], [10, 10]), L("a", [0, 0], [10, 0]), { id: "k", type: "line", start: [0, 5], end: [0, 9], construction: true }], "a sweep path");
    expect(c.closed).toBe(false);
    expect(c.segs.map((s) => [s.entity, s.a, s.b])).toEqual([
      ["a", [0, 0], [10, 0]],
      ["b", [10, 0], [10, 10]],
    ]);
    expect(chainLength(c)).toBe(20);
    expect(chainSmooth(c)).toBe(false);
    expect(reverseChain(c).segs.map((s) => s.entity)).toEqual(["b", "a"]);
  });

  it("takes a closed run, a circle or a rectangle as a closed chain", () => {
    expect(sketchChain([L("a", [0, 0], [10, 0]), L("b", [10, 0], [0, 10]), L("c", [0, 10], [0, 0])], "a sweep path").closed).toBe(true);
    const circle = sketchChain([{ id: "c1", type: "circle", center: [0, 0], radius: 20 }], "a sweep path");
    expect(circle.closed).toBe(true);
    expect(chainLength(circle)).toBeCloseTo(40 * PI, 9);
    expect(chainSmooth(circle)).toBe(true);
    expect(sketchChain([{ id: "r1", type: "rect", center: [0, 0], w: 10, h: 4 }], "a sweep path").segs).toHaveLength(4);
  });

  it("says what is wrong: nothing to follow, branches, two chains, a closed shape among others", () => {
    const err = (e: SketchEntity[], closedOk = true) => {
      try {
        sketchChain(e, "a sweep path", closedOk);
        return "";
      } catch (x) {
        expect(x).toBeInstanceOf(ChainError);
        return (x as Error).message;
      }
    };
    expect(err([{ id: "p", type: "point", at: [0, 0] }])).toBe("the sketch has no curves for a sweep path (construction lines and points do not count)");
    expect(err([L("a", [0, 0], [10, 0]), L("b", [10, 0], [10, 10]), L("c", [10, 0], [20, 0])])).toBe("three or more curves meet at [10, 0]: a sweep path follows one chain without branches");
    expect(err([L("a", [0, 0], [10, 0]), L("b", [20, 0], [30, 0])])).toBe("the curves make 2 separate chains: a sweep path follows one (join them end to end)");
    expect(err([{ id: "c1", type: "circle", center: [0, 0], radius: 2 }, L("a", [5, 0], [9, 0])])).toBe('"c1" is a closed shape and the sketch has other curves too: a sweep path follows one chain');
    expect(err([{ id: "c1", type: "circle", center: [0, 0], radius: 2 }], false)).toBe('"c1" is a closed shape: a rib needs an open chain of lines and arcs'.replace("a rib", "a sweep path"));
  });

  it("starts the path on the profile's plane: as drawn, reversed, or a closed chain split where it crosses", () => {
    const front = planeFrame([0, -1, 0], [0, 0, 0]);
    const top = { origin: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
    const up = sketchChain([L("a", [0, 0], [0, 100])], "a sweep path");
    expect(startOnPlane(up, front, top, [0, 0, 0]).segs[0].a).toEqual([0, 0]);
    const down = sketchChain([L("a", [0, 100], [0, 0])], "a sweep path"); // runs from its lower end anyway: [0, 0]
    expect(startOnPlane(down, front, { origin: [0, 0, 100], normal: [0, 0, 1] }, [0, 0, 100]).segs[0].a).toEqual([0, 100]);
    expect(() => startOnPlane(up, front, { origin: [0, 0, -5], normal: [0, 0, 1] }, [0, 0, -5])).toThrow(
      "the path must start on the profile's plane, but its ends are 5 mm and 105 mm from it: draw the path from a point of that plane (or the profile on a plane through the path's end)",
    );
    // A circle of radius 20 on Front, crossing Top (z = 0) at x = ±20: split at the one nearest the profile.
    const ring = sketchChain([{ id: "c1", type: "circle", center: [0, 0], radius: 20 }], "a sweep path");
    const split = startOnPlane(ring, front, top, [-20, 0, 0]);
    expect(split.segs[0].a.map(r6)).toEqual([-20, 0]);
    expect(chainLength(split)).toBeCloseTo(40 * PI, 9);
    // A rectangle crossing the plane mid-side: split there, still the whole length.
    const box = sketchChain([{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 20 }], "a sweep path");
    const cut = startOnPlane(box, front, top, [20, 0, 0]);
    expect(cut.segs[0].a.map(r6)).toEqual([20, 0]);
    expect(cut.segs).toHaveLength(5);
    expect(chainLength(cut)).toBeCloseTo(120, 9);
    expect(() => startOnPlane(up, planeFrame([0, 0, 1], [0, 0, 0]), top, [0, 0, 0])).toThrow("the path lies in the profile's plane");
  });
});

describe("sweep: the helix's numbers (pure)", () => {
  it("takes any two of pitch, turns and height", () => {
    expect(helixNumbers({ pitch: 5, turns: 4 })).toEqual({ pitch: 5, turns: 4, height: 20 });
    expect(helixNumbers({ pitch: 5, height: 20 })).toEqual({ pitch: 5, turns: 4, height: 20 });
    expect(helixNumbers({ turns: 4, height: 20 })).toEqual({ pitch: 5, turns: 4, height: 20 });
    expect(helixNumbers({ pitch: 5 })).toBe('give two of "pitch", "turns" and "height" (got only "pitch")');
    expect(helixNumbers({ pitch: 5, turns: 4, height: 20 })).toBe('give two of "pitch", "turns" and "height", not all three: the third follows from them');
  });

  it("places points on the helix: right-handed by default, starting on the axis frame's x", () => {
    const f = axisFrame([0, 0, 0], [0, 0, 1]);
    expect(helixPoint(f, 10, 5, 0).map(r6)).toEqual([10, 0, 0]);
    expect(helixPoint(f, 10, 5, 0.25).map(r6)).toEqual([0, 10, 1.25]);
    expect(helixPoint(f, 10, 5, 0.25, { leftHanded: true }).map(r6)).toEqual([0, -10, 1.25]);
    expect(helixPoint(axisFrame([0, 0, 0], [0, 0, 1], 90), 10, 5, 0).map(r6)).toEqual([0, 10, 0]);
    expect(endRadius(10, 15, 10)).toBeCloseTo(10 + 15 * Math.tan(PI / 18), 12);
    expect(helixLength(10, 5, 4)).toBeCloseTo(4 * Math.hypot(20 * PI, 5), 12);
  });
});

// ------------------------------------------------------------ validation

describe("sweep: validation", () => {
  const bad = (f: Raw) => errorsOf(doc(UP, DISC, { id: "sw", op: "sweep", ...f }));

  it("needs a profile or a circle (not both), and a path", () => {
    expect(bad({ profile: "prof", path: { sketch: "path" } })).toEqual([]);
    expect(bad({ circle: { diameter: 4 }, path: { sketch: "path" } })).toEqual([]);
    expect(bad({ path: { sketch: "path" } })).toEqual(['sw: needs a profile: "profile": "<sketch id>" (a closed profile), or "circle": { "diameter": <mm> } for a round tube along the path']);
    expect(bad({ profile: "prof", circle: { diameter: 4 }, path: { sketch: "path" } })).toEqual(['sw: give "profile" (a sketch) or "circle" (a diameter), not both']);
    expect(bad({ profile: "prof" })[0]).toMatch(/^sw: path: needed: what the profile follows/);
    expect(bad({ circle: { diameter: 4, inner: 4 }, path: { sketch: "path" } })).toEqual(["sw: circle.inner: the bore (4 mm) must be smaller than the diameter (4 mm)"]);
    expect(bad({ circle: { diameter: 4, wall: 1 }, path: { sketch: "path" } })).toEqual(['sw: circle: unknown field "wall" (allowed: diameter, inner)']);
    expect(bad({ profile: "prof", path: { sketch: "prof" } })).toEqual(['sw: path.sketch: is the profile\'s sketch too: the path is a chain in another sketch (or use "circle" and sweep a round section along "prof")']);
    expect(bad({ profile: "prof", path: { sketch: "path", edges: [] } })).toEqual(['sw: path: give one of "sketch", "edges" and "helix", not "sketch" and "edges"']);
  });

  it("checks the helix: an axis, a radius and two of pitch, turns and height; a taper that keeps a radius", () => {
    const helix = (h: Raw) => bad({ circle: { diameter: 2 }, path: { helix: { axis: { datum: "Z" }, radius: 10, ...h } } });
    expect(helix({ pitch: 5, turns: 4 })).toEqual([]);
    expect(helix({ pitch: 5 })).toEqual(['sw: path.helix: give two of "pitch", "turns" and "height" (got only "pitch")']);
    expect(helix({ pitch: 5, turns: 4, axis: { datum: "Top" } })[0]).toMatch(/^sw: path\.helix\.axis: .*Top/);
    expect(helix({ pitch: 5, turns: 4, taper: -45 })).toEqual(["sw: path.helix.taper: a -45° taper over 20 mm takes the radius below zero (it would be -10 mm at the end): make it gentler, or the helix shorter"]);
    expect(helix({ pitch: 5, turns: 4, taper: 85 })).toEqual(["sw: path.helix.taper: must be less than 80° either way (got 85)"]);
    expect(helix({ pitch: -5, turns: 4 })).toEqual(["sw: path.helix.pitch: must be greater than 0 (got -5)"]);
    expect(bad({ profile: "prof", path: { helix: { axis: { datum: "Z" }, radius: 10, pitch: 5, turns: 4, startAngle: 90 } } })).toEqual([
      "sw: path.helix.startAngle: a helix with a profile sketch starts at the profile; move the profile (or leave startAngle out)",
    ]);
  });

  it("refuses a twist with a fixed profile, and fields it does not know", () => {
    expect(bad({ profile: "prof", path: { sketch: "path" }, twist: 90, orientation: "fixed" })).toEqual([
      'sw: twist: a fixed profile keeps its orientation, so it cannot twist: use "orientation": "follow" (the default) to twist it',
    ]);
    expect(bad({ profile: "prof", path: { sketch: "path" }, scale: 2 })[0]).toBe(
      'sw: unknown field "scale" (allowed: id, op, profile, circle, path, twist, orientation, operation, body, bodies, newBody)',
    );
  });
});

// ------------------------------------------------------------ kernel

describe("sweep: along a sketch's path", () => {
  it("a 10 mm circle along a 100 mm line: π·5²·100, as a circle sweep and as a profile sketch", () => {
    for (const f of [{ circle: { diameter: 10 } }, { profile: "prof" }]) {
      const b = built(doc(UP, DISC, { id: "sw", op: "sweep", path: { sketch: "path" }, ...f }));
      expect(b.errors).toEqual([]);
      expect(b.volume).toBeCloseTo(PI * 25 * 100, 6);
      expect(b.box).toEqual({ min: [-5, -5, 0], max: [5, 5, 100] });
    }
  });

  it("runs the path from the end on the profile's plane, and says so when neither end is", () => {
    // The profile at the top (z = 100): the path runs downward from there.
    const high = sketch("prof", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 100] }, [{ id: "c1", type: "circle", center: [0, 0], radius: 5 }]);
    expect(built(doc(UP, high, { id: "sw", op: "sweep", profile: "prof", path: { sketch: "path" } })).volume).toBeCloseTo(PI * 25 * 100, 6);
    const off = sketch("prof", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 30] }, [{ id: "c1", type: "circle", center: [0, 0], radius: 5 }]);
    expect(built(doc(UP, off, { id: "sw", op: "sweep", profile: "prof", path: { sketch: "path" } })).errors).toEqual([
      'sw: path.sketch: sketch "path": the path must start on the profile\'s plane, but its ends are 30 mm and 70 mm from it: draw the path from a point of that plane (or the profile on a plane through the path\'s end)',
    ]);
    // A profile in a plane the path runs along.
    const side = sketch("prof", FRONT, [{ id: "c1", type: "circle", center: [20, 0], radius: 5 }]);
    expect(built(doc(UP, side, { id: "sw", op: "sweep", profile: "prof", path: { sketch: "path" } })).errors).toEqual([
      'sw: path.sketch: sketch "path": the path lies in the profile\'s plane: sketch the profile on a plane the path crosses (a plane normal to the path at its start, say)',
    ]);
  });

  it("an L path with a rounded corner: π·5² x its length (Pappus for the bend)", () => {
    // Up 80, a quarter turn of radius 20 to the right, then 80 along +X: 160 + 10π long.
    const path = sketch("path", FRONT, [
      { id: "l1", type: "line", start: [0, 0], end: [0, 80] },
      { id: "a1", type: "arc", center: [20, 80], start: [0, 80], end: [20, 100], clockwise: true },
      { id: "l2", type: "line", start: [20, 100], end: [100, 100] },
    ]);
    const b = built(doc(path, DISC, { id: "sw", op: "sweep", circle: { diameter: 10 }, path: { sketch: "path" } }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PI * 25 * (160 + 10 * PI), 4);
    expect(b.box).toEqual({ min: [-5, -5, 0], max: [100, 5, 105] });
  });

  it("an L path with a sharp corner: the profile turns about the corner", () => {
    const path = sketch("path", FRONT, [
      { id: "l1", type: "line", start: [0, 0], end: [0, 100] },
      { id: "l2", type: "line", start: [0, 100], end: [60, 100] },
    ]);
    const r = 5;
    const b = built(doc(path, DISC, { id: "sw", op: "sweep", profile: "prof", path: { sketch: "path" } }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PI * r * r * (100 + 60) - (4 * r ** 3) / 3 + (PI * r ** 3) / 3, 4);
  });

  it("a hollow pipe and a ring profile: the bore stays empty", () => {
    expect(built(doc(UP, DISC, { id: "sw", op: "sweep", circle: { diameter: 10, inner: 6 }, path: { sketch: "path" } })).volume).toBeCloseTo(PI * (25 - 9) * 100, 6);
    const ring = sketch("prof", TOP, [
      { id: "r1", type: "rect", center: [0, 0], w: 20, h: 20 },
      { id: "c1", type: "circle", center: [0, 0], radius: 4 },
    ]);
    expect(built(doc(UP, ring, { id: "sw", op: "sweep", profile: "prof", path: { sketch: "path" } })).volume).toBeCloseTo((400 - PI * 16) * 100, 6);
  });

  it("twists a square 45° along a line: the same volume, its corners turned out to 5√2", () => {
    const square = sketch("prof", TOP, [{ id: "r1", type: "rect", center: [0, 0], w: 10, h: 10 }]);
    const b = built(doc(UP, square, { id: "sw", op: "sweep", profile: "prof", path: { sketch: "path" }, twist: 45 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(100 * 100, 2);
    expect(b.box!.max[0]).toBeCloseTo(5 * Math.SQRT2, 3);
    // A twist along a path with a sharp corner is refused.
    const corner = sketch("path", FRONT, [
      { id: "l1", type: "line", start: [0, 0], end: [0, 50] },
      { id: "l2", type: "line", start: [0, 50], end: [50, 50] },
    ]);
    expect(built(doc(corner, square, { id: "sw", op: "sweep", profile: "prof", path: { sketch: "path" }, twist: 45 })).errors).toEqual([
      "sw: twist: the path has sharp corners, and a profile can twist only along a smooth path; round the corners (sketch fillets) or leave out the twist",
    ]);
  });

  it("a twist along an arc keeps the volume (Pappus)", () => {
    const arc = sketch("path", FRONT, [{ id: "a1", type: "arc", center: [50, 0], start: [0, 0], end: [50, 50], clockwise: true }]);
    const square = sketch("prof", TOP, [{ id: "r1", type: "rect", center: [0, 0], w: 10, h: 10 }]);
    const b = built(doc(arc, square, { id: "sw", op: "sweep", profile: "prof", path: { sketch: "path" }, twist: 90 }));
    expect(b.errors).toEqual([]);
    expect(b.volume / (100 * 25 * PI)).toBeCloseTo(1, 5);
  });

  it("fixed orientation slides the profile without turning it: area x the rise along its normal", () => {
    // A quarter arc from the origin up and over to [50, 0, 50]; a 10 x 10 square on Top.
    const arc = sketch("path", FRONT, [{ id: "a1", type: "arc", center: [50, 0], start: [0, 0], end: [50, 50], clockwise: true }]);
    const square = sketch("prof", TOP, [{ id: "r1", type: "rect", center: [0, 0], w: 10, h: 10 }]);
    const follow = built(doc(arc, square, { id: "sw", op: "sweep", profile: "prof", path: { sketch: "path" } }));
    expect(follow.volume).toBeCloseTo(100 * 25 * PI, 6); // 100 x a quarter of 2π·50
    expect(follow.box!.max.map((x) => Math.round(x * 1e3) / 1e3)).toEqual([50, 5, 55]);
    const fixed = built(doc(arc, square, { id: "sw", op: "sweep", profile: "prof", path: { sketch: "path" }, orientation: "fixed" }));
    expect(fixed.errors).toEqual([]);
    expect(fixed.volume).toBeCloseTo(100 * 50, 6);
    expect(fixed.box!.max.map((x) => Math.round(x * 1e3) / 1e3)).toEqual([55, 5, 50]);
  });
});

describe("sweep: along a helix (a spring)", () => {
  const spring = (h: Raw, f: Raw = {}): RawDocument =>
    doc({ id: "spring", op: "sweep", circle: { diameter: 2 }, path: { helix: { axis: { datum: "Z" }, radius: 10, ...h } }, ...f });
  const L = 4 * Math.hypot(2 * PI * 10, 5);

  it("wire Ø2 on a helix of radius 10, pitch 5, 4 turns: π·1² x 4·sqrt((2π·10)² + 5²)", () => {
    const b = built(spring({ pitch: 5, turns: 4 }));
    expect(b.errors).toEqual([]);
    expect(Math.abs(b.volume / (PI * L) - 1)).toBeLessThan(0.01);
    expect(b.volume / (PI * L)).toBeCloseTo(1, 5);
    // From z = -1 (the wire's half-thickness below the start) to 20 + 1.
    expect(b.box!.min[2]).toBeCloseTo(-1, 2);
    expect(b.box!.max[2]).toBeCloseTo(21, 2);
    expect(b.box!.max[0]).toBeCloseTo(11, 2);
  });

  it("height instead of turns, left-handed, or a start angle: the same wire", () => {
    for (const h of [{ pitch: 5, height: 20 }, { turns: 4, height: 20 }, { pitch: 5, turns: 4, leftHanded: true }, { pitch: 5, turns: 4, startAngle: 90 }]) {
      const b = built(spring(h));
      expect(b.errors).toEqual([]);
      expect(b.volume / (PI * L)).toBeCloseTo(1, 5);
    }
  });

  it("a tapered helix widens along the axis (a conical spring)", () => {
    const b = built(spring({ pitch: 5, turns: 3, taper: 10 }));
    expect(b.errors).toEqual([]);
    // Its last turn reaches out to 10 + 15·tan 10° (+ the wire's radius) at its end, on +X.
    expect(b.box!.max[0]).toBeCloseTo(endRadius(10, 15, 10) + 1, 1);
    expect(b.box!.min[0]).toBeGreaterThan(-(endRadius(10, 15, 10) + 1) - 1e-6);
    expect(b.volume).toBeGreaterThan(PI * 3 * Math.hypot(2 * PI * 10, 5));
  });

  it("refuses coils that run into each other", () => {
    expect(built(spring({ pitch: 1.5, turns: 4 })).errors).toEqual(["spring: path.helix: the coils run into each other: the circle spans 1.9994 mm along the axis but the pitch is only 1.5 mm; make the pitch larger or the diameter smaller"]);
    expect(built(spring({ pitch: 1.5, turns: 1 })).errors).toEqual([]);
  });

  it("a thread: a triangle sketched on Front beside the axis swept along the helix, the helix starting at it (Pappus ≈)", () => {
    // Triangle of base 2.4 (along Z) and height 1.5 (out along X) at x = 10: area 1.8, centroid at x = 10.5.
    const tooth = sketch("tooth", FRONT, [
      { id: "l1", type: "line", start: [10, -1.2], end: [11.5, 0] },
      { id: "l2", type: "line", start: [11.5, 0], end: [10, 1.2] },
      { id: "l3", type: "line", start: [10, 1.2], end: [10, -1.2] },
    ]);
    const b = built(doc(tooth, { id: "thread", op: "sweep", profile: "tooth", path: { helix: { axis: { datum: "Z" }, radius: 10, pitch: 5, turns: 3 } } }));
    expect(b.errors).toEqual([]);
    expect(b.volume / (1.8 * 2 * PI * (10 + 0.5) * 3)).toBeCloseTo(1, 4);
    expect(b.box!.min[2]).toBeCloseTo(-1.2, 3);
  });
});

describe("sweep: the operations and model edges", () => {
  // A cylinder of radius 20, 40 tall, on Top.
  const CYL = [sketch("base", TOP, [{ id: "c1", type: "circle", center: [0, 0], radius: 20 }]), { id: "cyl", op: "extrude", sketch: "base", distance: 40 }];

  it("a cut sweep: an O-ring groove round a cylinder (a closed path), half the tube inside", () => {
    const ring = sketch("ring", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 20] }, [{ id: "c2", type: "circle", center: [0, 0], radius: 20 }]);
    const b = built(doc(...CYL, ring, { id: "groove", op: "sweep", circle: { diameter: 4 }, path: { sketch: "ring" }, operation: "remove" }));
    expect(b.errors).toEqual([]);
    // The half disc inside (area 2π, centroid 8/(3π) in from r = 20) turned all the way round.
    expect(b.volume).toBeCloseTo(PI * 400 * 40 - 2 * PI * (20 - 8 / (3 * PI)) * 2 * PI, 3);
  });

  it("a profile sketch swept round a closed path starts where the path crosses its plane", () => {
    // A 4 x 4 square on Front at x = 20..24, z = 18..22, round a circle of radius 22 at z = 20: Pappus 16 x 2π·22.
    const ring = sketch("ring", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 20] }, [{ id: "c2", type: "circle", center: [0, 0], radius: 22 }]);
    const sq = sketch("sq", FRONT, [{ id: "r1", type: "rect", center: [22, 20], w: 4, h: 4 }]);
    const b = built(doc(ring, sq, { id: "torus", op: "sweep", profile: "sq", path: { sketch: "ring" } }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(16 * 2 * PI * 22, 4);
  });

  it("along model edges: one straight edge, then two meeting at a corner, as new bodies", () => {
    const BOX = [sketch("base", TOP, [{ id: "r1", type: "rect", center: [20, 10], w: 40, h: 20 }]), { id: "box", op: "extrude", sketch: "base", distance: 10 }];
    const along = (edges: Raw[]) => ({ id: "wire", op: "sweep", circle: { diameter: 4 }, path: { edges }, operation: "new" });
    const xEdge = { type: "edge", direction: [1, 0, 0], near: [20, 0, 10], pick: "all" };
    const yEdge = { type: "edge", direction: [0, 1, 0], near: [0, 10, 10], pick: "all" };
    const one = built(doc(...BOX, along([xEdge])));
    expect(one.errors).toEqual([]);
    expect(one.bodies).toEqual(["main", "wire"]);
    expect(one.volume).toBeCloseTo(40 * 20 * 10 + PI * 4 * 40, 6);
    const two = built(doc(...BOX, along([xEdge, yEdge])));
    expect(two.errors).toEqual([]);
    const r = 2;
    expect(two.volume).toBeCloseTo(40 * 20 * 10 + PI * r * r * 60 - (4 * r ** 3) / 3 + (PI * r ** 3) / 3, 4);
    const apart = built(doc(...BOX, along([xEdge, { type: "edge", direction: [1, 0, 0], near: [20, 20, 0], pick: "all" }])));
    expect(apart.errors).toEqual(["wire: path.edges: the edges do not join end to end into one chain (1 of them are apart from the rest); pick edges that follow on from each other"]);
  });

  it("adds to the body by default, and leaves a seed a pattern can repeat", () => {
    const b = built(
      doc(...CYL, sketch("p", FRONT, [{ id: "l1", type: "line", start: [0, 40], end: [0, 60] }]), sketch("d", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 40] }, [{ id: "c", type: "circle", center: [0, 0], radius: 3 }]), {
        id: "boss",
        op: "sweep",
        profile: "d",
        path: { sketch: "p" },
      }),
    );
    expect(b.errors).toEqual([]);
    expect(b.bodies).toEqual(["main"]);
    expect(b.volume).toBeCloseTo(PI * 400 * 40 + PI * 9 * 20, 6);
  });
});
