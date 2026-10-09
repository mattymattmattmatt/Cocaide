// revolve (Phase O wave 2, DESIGN §2.6): a sketch's profile turned about a
// line of the sketch or a reference axis; one direction, two, or split about
// the sketch plane; thin (an open chain thickened into a wall); and the
// operations (new, add, revolved cut, intersect). Volumes by Pappus: a region
// of area A whose centroid is r from the axis, turned through θ radians,
// sweeps θ·r·A.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { awayFromAxis, axisCrossing, closedBand, offsetChain, openBand, openChain, regionsArea } from "../src/features/revolve/band";
import { buildProfile } from "../src/geom/profile";
import { loadOC, rebuild, type OC } from "../src/kernel";

type Raw = Record<string, unknown>;
const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket"); // 80 x 40 x 6 plate on z = 0..6, centred; a 6.6 hole through at [30, 0]
const PLATE = 80 * 40 * 6;
const HOLE = Math.PI * 3.3 ** 2 * 6;
const PI = Math.PI;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

/** A part from one sketch on Top (XY: sketch x = X, sketch y = Y) and the features after it. */
const part = (entities: Raw[], ...features: Raw[]): RawDocument => ({
  version: 1,
  units: "mm",
  name: "revolve test",
  features: [{ id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities, constraints: [] }, ...features],
});
const add = (doc: RawDocument, ...f: Raw[]): RawDocument => ({ ...doc, features: [...doc.features, ...f] });
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));

// A 10 x 20 rectangle at x = 10..20, y = 0..20, and a centreline on the Y axis: A = 200, centroid 15 from the axis.
const RECT = { id: "r1", type: "rect", center: [15, 10], w: 10, h: 20 };
const CENTERLINE = { id: "c1", type: "line", start: [0, 0], end: [0, 30], construction: true };
const revolve = (f: Raw = {}): Raw => ({ id: "rev_1", op: "revolve", sketch: "s1", axis: { line: "c1" }, ...f });

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(doc: unknown) {
  const r = rebuild(doc, oc);
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

describe("revolve: validation", () => {
  const bad = (f: Raw) => errorsOf(part([RECT, CENTERLINE], { id: "rev_1", op: "revolve", sketch: "s1", ...f }));

  it("needs a sketch and an axis, and nothing it does not know", () => {
    expect(bad({ axis: { line: "c1" } })).toEqual([]);
    expect(bad({})).toEqual(['rev_1: axis: needed: a line of the sketch ({ "line": "<entity id>" }, a centreline say) or a reference axis ({ "datum": "Y" }, an axis feature, a straight edge)']);
    expect(bad({ axis: { line: "c1" }, sketch: "nope" })[0]).toMatch(/^rev_1: sketch: /);
    expect(bad({ axis: { line: "c1" }, twist: 3 })).toEqual([
      'rev_1: unknown field "twist" (allowed: id, op, sketch, axis, angle, angle2, midplane, reverse, thin, operation, body, bodies, newBody)',
    ]);
    expect(bad({ axis: { line: "" } })).toEqual(['rev_1: axis.line: must be the id of a line in the sketch (got "")']);
    expect(bad({ axis: { line: "c1", at: 2 } })).toEqual(['rev_1: axis: unknown field "at" (allowed: line)']);
  });

  it("takes a reference axis, and refuses a plane where an axis is needed", () => {
    expect(bad({ axis: { datum: "Y" } })).toEqual([]);
    expect(bad({ axis: { datum: "Top" } })[0]).toMatch(/^rev_1: axis: .*Top/);
  });

  it("refuses a zero angle, more than a full turn, and angle2 with midplane", () => {
    expect(bad({ axis: { line: "c1" }, angle: 0 })).toEqual(["rev_1: angle: must be over 0° (got 0): a revolve needs an angle to turn through"]);
    expect(bad({ axis: { line: "c1" }, angle: 400 })).toEqual(["rev_1: angle: must be at most 360° (got 400): all the way round is 360"]);
    expect(bad({ axis: { line: "c1" }, angle: 300, angle2: 90 })).toEqual(["rev_1: angle2: angle + angle2 is 390°: together they can turn at most 360°"]);
    expect(bad({ axis: { line: "c1" }, angle: 90, angle2: 10, midplane: true })).toEqual([
      'rev_1: angle2: turns the other way from the sketch plane; with "midplane" (the angle split evenly both ways) leave it out',
    ]);
    expect(bad({ axis: { line: "c1" }, angle2: -5 })).toEqual(["rev_1: angle2: must not be negative (got -5)"]);
  });

  it("checks the thin wall and the operation fields", () => {
    expect(bad({ axis: { line: "c1" }, thin: { thickness: 0 } })).toEqual(["rev_1: thin.thickness: must be greater than 0 (got 0)"]);
    expect(bad({ axis: { line: "c1" }, thin: { thickness: 2, side: "left" } })).toEqual(['rev_1: thin.side: must be "outside", "inside", "mid" (got "left")']);
    expect(bad({ axis: { line: "c1" }, thin: 2 })).toEqual(['rev_1: thin: must be { "thickness": <mm>, "side": "outside" | "inside" | "mid" } (got 2)']);
    expect(bad({ axis: { line: "c1" }, operation: "remove", newBody: "x" })).toEqual(['rev_1: newBody: names the new body: it goes with "operation": "new"']);
  });

  it("apply refuses it and says why; the sketch it uses can't be deleted from under it", () => {
    const doc = part([RECT, CENTERLINE], revolve());
    expect(apply(doc, { type: "addFeature", feature: { id: "rev_2", op: "revolve", sketch: "s1", axis: { line: "c1" }, angle: 0 } })).toEqual({
      ok: false,
      error: "addFeature rejected: rev_2: angle: must be over 0° (got 0): a revolve needs an angle to turn through",
    });
    const del = apply(doc, { type: "deleteFeature", id: "s1" });
    expect(del.ok).toBe(false);
  });
});

describe("revolve: by Pappus", () => {
  it("all the way round a centreline: a tube, 2π x 15 x 200", () => {
    const b = built(part([RECT, CENTERLINE], revolve()));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(2 * PI * 15 * 200, 6); // = π (20² − 10²) 20
    expect(b.box).toEqual({ min: [-20, 0, -20], max: [20, 20, 20] });
  });

  it("a partial turn: θ x 15 x 200, right-handed about the line's direction (+Y turns +X toward -Z); reverse turns the other way", () => {
    const q = built(part([RECT, CENTERLINE], revolve({ angle: 90 })));
    expect(q.errors).toEqual([]);
    expect(q.volume).toBeCloseTo((PI / 2) * 15 * 200, 6);
    expect(q.box).toEqual({ min: [0, 0, -20], max: [20, 20, 0] });
    const r = built(part([RECT, CENTERLINE], revolve({ angle: 90, reverse: true })));
    expect(r.box).toEqual({ min: [0, 0, 0], max: [20, 20, 20] });
  });

  it("midplane splits the angle about the sketch plane; angle2 turns the other way first", () => {
    const m = built(part([RECT, CENTERLINE], revolve({ angle: 90, midplane: true })));
    expect(m.errors).toEqual([]);
    expect(m.volume).toBeCloseTo((PI / 2) * 15 * 200, 6);
    const h = r6(20 * Math.sin(PI / 4));
    expect(m.box!.min[2]).toBeCloseTo(-h, 6);
    expect(m.box!.max[2]).toBeCloseTo(h, 6);
    const two = built(part([RECT, CENTERLINE], revolve({ angle: 60, angle2: 30 })));
    expect(two.volume).toBeCloseTo((PI / 2) * 15 * 200, 6);
    expect(two.box!.min[2]).toBeCloseTo(-20 * Math.sin(PI / 3), 6); // 60° one way
    expect(two.box!.max[2]).toBeCloseTo(20 * Math.sin(PI / 6), 6); // 30° the other
  });

  it("about a default axis, a line of the profile, or a line drawn as the axis (not construction)", () => {
    expect(built(part([RECT], revolve({ axis: { datum: "Y" } }))).volume).toBeCloseTo(2 * PI * 15 * 200, 6);
    const solidAxis = { ...CENTERLINE, construction: undefined };
    expect(built(part([RECT, solidAxis], revolve())).volume).toBeCloseTo(2 * PI * 15 * 200, 6);
    // Four lines, x = 0..10, y = 0..20, turned about the one on x = 0: a cylinder r 10, 20 high.
    const box = [
      { id: "a", type: "line", start: [0, 0], end: [10, 0] },
      { id: "b", type: "line", start: [10, 0], end: [10, 20] },
      { id: "c", type: "line", start: [10, 20], end: [0, 20] },
      { id: "d", type: "line", start: [0, 20], end: [0, 0] },
    ];
    const cyl = built(part(box, revolve({ axis: { line: "d" } })));
    expect(cyl.errors).toEqual([]);
    expect(cyl.volume).toBeCloseTo(PI * 10 ** 2 * 20, 6);
  });

  it("a circle makes a torus (2π x 20 x 25π); a half disc on its axis makes a ball (4/3 π 10³)", () => {
    const torus = built(part([{ id: "k", type: "circle", center: [20, 0], radius: 5 }, CENTERLINE], revolve()));
    expect(torus.errors).toEqual([]);
    expect(torus.volume).toBeCloseTo(2 * PI * 20 * PI * 25, 6);
    const halfDisc = [
      { id: "arc", type: "arc", center: [0, 0], start: [0, -10], end: [0, 10] },
      { id: "diam", type: "line", start: [0, 10], end: [0, -10] },
    ];
    const ball = built(part(halfDisc, revolve({ axis: { line: "diam" } })));
    expect(ball.errors).toEqual([]);
    expect(ball.volume).toBeCloseTo((4 / 3) * PI * 1000, 5);
  });
});

describe("revolve: thin", () => {
  const wall = { id: "w", type: "line", start: [10, 0], end: [10, 20] };

  it("thickens an open line into a tube wall: outside (away from the axis), inside, or centred", () => {
    const at = (side?: string) => built(part([wall, CENTERLINE], revolve({ thin: { thickness: 2, ...(side ? { side } : {}) } })));
    expect(at().errors).toEqual([]);
    expect(at().volume).toBeCloseTo(PI * (12 ** 2 - 10 ** 2) * 20, 6);
    expect(at("inside").volume).toBeCloseTo(PI * (10 ** 2 - 8 ** 2) * 20, 6);
    expect(at("mid").volume).toBeCloseTo(PI * (11 ** 2 - 9 ** 2) * 20, 6);
  });

  it("an L-shaped chain: a disc and a tube, the corner mitred", () => {
    const chain = [
      { id: "l1", type: "line", start: [10, 0], end: [30, 0] },
      { id: "l2", type: "line", start: [30, 0], end: [30, 20] },
    ];
    // Outside, away from the axis: the disc below y = 0 (x 10..32), the tube outside x = 30 (y -2..20).
    const b = built(part([...chain, CENTERLINE], revolve({ thin: { thickness: 2 } })));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PI * (32 ** 2 - 10 ** 2) * 2 + PI * (32 ** 2 - 30 ** 2) * 20, 6);
  });

  it("a closed profile's loop thickened into a ring wall", () => {
    // The 10 x 20 rectangle's outline, 1 mm outside it: (x 9..21, y -1..21) less the rectangle.
    const b = built(part([RECT, CENTERLINE], revolve({ thin: { thickness: 1 } })));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PI * (21 ** 2 - 9 ** 2) * 22 - PI * (20 ** 2 - 10 ** 2) * 20, 6);
  });

  it("says what to do with an open profile that is not thin, or a wall thicker than an arc's radius", () => {
    expect(built(part([wall, CENTERLINE], revolve())).errors[0]).toMatch(/^rev_1: sketch "s1" has no closed profile to revolve: .*; for an open profile, make it a thin revolve \("thin": \{ "thickness": 2 \}\)$/);
    const arc = { id: "a", type: "arc", center: [20, 0], start: [21, 0], end: [20, 1] };
    expect(built(part([arc, CENTERLINE], revolve({ thin: { thickness: 2, side: "inside" } }))).errors).toEqual([
      "rev_1: thin: the wall is thicker than arc \"a\"'s radius (1 mm): make it thinner, or put it on the other side",
    ]);
  });
});

describe("revolve: the axis", () => {
  it("refuses an axis through the profile", () => {
    const across = { id: "x", type: "line", start: [15, -5], end: [15, 30], construction: true };
    expect(built(part([RECT, across], revolve({ axis: { line: "x" } }))).errors).toEqual([
      "rev_1: the axis passes through the profile: a revolve needs the whole profile on one side of the axis",
    ]);
  });

  it("refuses a reference axis out of the sketch's plane, and a line the sketch does not have", () => {
    expect(built(part([RECT], revolve({ axis: { datum: "Z" } }))).errors).toEqual([
      "rev_1: axis: Z is not in the sketch's plane (it is at 90° to it): a revolve axis must lie in the plane of the profile",
    ]);
    // An axis feature parallel to the sketch plane, 5 above it.
    const lifted = { id: "ax", op: "axis", mode: "twoPoints", refs: [{ point: [0, 0, 5] }, { point: [0, 10, 5] }] };
    const doc = part([RECT], lifted, revolve({ axis: { datum: "ax" } }));
    expect(built(doc).errors).toEqual(["rev_1: axis: ax is parallel to the sketch's plane but 5 mm off it: a revolve axis must lie in the plane of the profile"]);
    expect(built(part([RECT, CENTERLINE], revolve({ axis: { line: "nope" } }))).errors).toEqual(['rev_1: axis.line: sketch "s1" has no line "nope"; its lines: "c1" (construction)']);
    expect(built(part([RECT, CENTERLINE], revolve({ axis: { line: "r1" } }))).errors).toEqual(['rev_1: axis.line: "r1" is a rect, not a line; its lines: "c1" (construction)']);
  });
});

describe("revolve: operations", () => {
  // A ring about the X axis: y = 5..15, x = -5..5 on Top, turned all the way round (inner r 5, outer r 15, 10 long).
  const ring = { id: "g", type: "rect", center: [0, 10], w: 10, h: 10 };
  const onBracket = (f: Raw) =>
    add(bracket, { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [ring], constraints: [] }, { id: "rev_1", op: "revolve", sketch: "s2", axis: { datum: "X" }, ...f });

  it("a revolved cut takes the ring out of the plate: 10 x (the annulus between z = 0 and 6)", () => {
    // Annulus r 5..15 in YZ, cut to the plate's 0 <= z <= 6: the r 15 disc's strip less the r 5 half disc.
    const strip = (R: number, h: number) => h * Math.sqrt(R * R - h * h) + R * R * Math.asin(h / R);
    const cut = 10 * (strip(15, 6) - (PI * 25) / 2);
    const b = built(onBracket({ operation: "remove" }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - HOLE - cut, 6);
  });

  it("adds to the part's body by default, or starts a new body, or keeps only the common part", () => {
    const tube = 10 * PI * (15 ** 2 - 5 ** 2);
    const strip = (R: number, h: number) => h * Math.sqrt(R * R - h * h) + R * R * Math.asin(h / R);
    const inside = 10 * (strip(15, 6) - (PI * 25) / 2);
    const added = built(onBracket({}));
    expect(added.errors).toEqual([]);
    expect(added.volume).toBeCloseTo(PLATE - HOLE + tube - inside, 6);
    const fresh = built(onBracket({ operation: "new", newBody: "ring" }));
    expect(fresh.bodies).toEqual(["main", "ring"]);
    expect(fresh.volume).toBeCloseTo(PLATE - HOLE + tube, 6);
    const common = built(onBracket({ operation: "intersect" }));
    expect(common.errors).toEqual([]);
    expect(common.volume).toBeCloseTo(inside, 6);
  });

  it("a cut that misses says so", () => {
    const far = add(bracket, { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "g", type: "rect", center: [0, 60], w: 10, h: 10 }], constraints: [] }, { id: "rev_1", op: "revolve", sketch: "s2", axis: { datum: "X" }, angle: 90, operation: "remove" });
    expect(built(far).errors[0]).toMatch(/^rev_1: removed no material/);
  });

  it("is a seed for patterns and mirrors: a ball copied three times, and mirrored", () => {
    const ball = [
      { id: "arc", type: "arc", center: [20, 0], start: [20, -5], end: [20, 5] },
      { id: "diam", type: "line", start: [20, 5], end: [20, -5] },
    ];
    const one = (4 / 3) * PI * 125;
    const seed = { id: "rev_1", op: "revolve", sketch: "s1", axis: { line: "diam" }, operation: "new" };
    const pattern = built(part(ball, seed, { id: "pat_1", op: "linearPattern", feature: "rev_1", direction: [0, 1, 0], spacing: 20, count: 3 }));
    expect(pattern.errors).toEqual([]);
    expect(pattern.volume).toBeCloseTo(3 * one, 5);
    const mirrored = built(part(ball, seed, { id: "m", op: "mirror", feature: "rev_1", plane: { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] } }));
    expect(mirrored.errors).toEqual([]);
    expect(mirrored.volume).toBeCloseTo(2 * one, 5);
    expect(mirrored.box!.min[0]).toBeCloseTo(-25, 6);
  });
});

describe("revolve: the band geometry", () => {
  const Y = { p: [0, 0] as [number, number], u: [0, 1] as [number, number] };

  it("chains lines and arcs from the free end with the lowest coordinates, whatever order they were drawn in", () => {
    const chain = openChain([
      { id: "l2", type: "line", start: [30, 20], end: [30, 0] },
      { id: "l1", type: "line", start: [10, 0], end: [30, 0] },
      { id: "c", type: "line", start: [0, 0], end: [0, 9], construction: true },
    ] as never);
    expect(chain.map((s) => [s.entity, s.a, s.b])).toEqual([
      ["l1", [10, 0], [30, 0]],
      ["l2", [30, 0], [30, 20]],
    ]);
    expect(() => openChain([{ id: "k", type: "circle", center: [0, 0], radius: 2 }] as never)).toThrow(/"k" is a closed shape/);
    expect(() =>
      openChain([
        { id: "a", type: "line", start: [0, 0], end: [1, 0] },
        { id: "b", type: "line", start: [5, 0], end: [6, 0] },
      ] as never),
    ).toThrow("the lines and arcs make 2 separate chains: a thin feature thickens one");
  });

  it("offsets a chain to its left, mitring the corner", () => {
    const chain = openChain([
      { id: "l1", type: "line", start: [10, 0], end: [30, 0] },
      { id: "l2", type: "line", start: [30, 0], end: [30, 20] },
    ] as never);
    const out = offsetChain(chain, -2, false); // to the right: below l1, outside l2
    expect(out.map((s) => [s.a, s.b])).toEqual([
      [[10, -2], [32, -2]],
      [[32, -2], [32, 20]],
    ]);
    expect(awayFromAxis(chain, Y)).toBe(-1);
    expect(regionsArea([openBand(chain, 0, -2)])).toBeCloseTo(22 * 2 + 2 * 20, 9);
  });

  it("offsets arcs to concentric arcs, so a ring around a circle is exact", () => {
    const p = buildProfile([{ id: "k", type: "circle", center: [20, 0], radius: 5 }] as never);
    if (!p.ok) throw new Error(p.error);
    const ring = closedBand(p.regions[0].outer, 1, "mid");
    expect(regionsArea([ring])).toBeCloseTo(PI * (5.5 ** 2 - 4.5 ** 2), 9);
  });

  it("finds an axis through a profile, also where only an arc's bulge crosses it", () => {
    const p = buildProfile([{ id: "k", type: "circle", center: [3, 0], radius: 5 }] as never);
    if (!p.ok) throw new Error(p.error);
    expect(axisCrossing(p.regions[0].outer.segs, Y)).toBe("the axis passes through the profile: a revolve needs the whole profile on one side of the axis");
    const touching = buildProfile([{ id: "k", type: "circle", center: [5, 0], radius: 5 }] as never);
    if (!touching.ok) throw new Error(touching.error);
    expect(axisCrossing(touching.regions[0].outer.segs, Y)).toBeNull();
  });
});
