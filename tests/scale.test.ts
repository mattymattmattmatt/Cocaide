// scale (Phase O, DESIGN §2.6): the registry's first op, end to end. One
// factor in every direction, about the origin or each body's own centroid;
// the volume goes as the factor cubed; holes scale with their bodies; a
// scaled member is no longer stock.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { centroidOf } from "../src/kernel/measure";

const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket"); // 80 x 40 x 6 plate on z = 0, centred; a 6.6 hole through at [30, 0]
const stand = example("stand"); // base 120 x 80 x 8 with two 10 mm holes; upright 120 x 8 x 60 on z = 8..68, y = -4..4
const add = (doc: RawDocument, ...f: Record<string, unknown>[]): RawDocument => ({ ...doc, features: [...doc.features, ...f] });
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const PLATE = 80 * 40 * 6;
const HOLE = Math.PI * 3.3 ** 2 * 6;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

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
      box: m?.boundingBox ? { min: m.boundingBox.min.map(r6), max: m.boundingBox.max.map(r6) } : null,
      bodies: Object.fromEntries((m?.bodies ?? []).map((b) => [b.name, { volume: b.volume, min: b.boundingBox!.min.map(r6), max: b.boundingBox!.max.map(r6) }])),
      centroid: r.solid ? scoped((s) => centroidOf(oc, s, r.solid!)) : null,
      holes: r.holes.map((h) => ({ ...h })),
      holeDiameters: m?.holeDiameters ?? [],
      members: (m?.members ?? []).map((x) => x.id),
    };
  } finally {
    r.dispose();
  }
}

describe("scale: validation", () => {
  const bad = (f: Record<string, unknown>) => errorsOf(add(bracket, { id: "s", op: "scale", ...f }));

  it("needs a factor over 0, and nothing it does not know", () => {
    expect(bad({})).toEqual(["s: factor: must be a number (got nothing)"]);
    expect(bad({ factor: 0 })).toEqual(["s: factor: must be greater than 0 (got 0)"]);
    expect(bad({ factor: -2 })).toEqual(["s: factor: must be greater than 0 (got -2)"]);
    expect(bad({ factor: 2, about: "center" })).toEqual(['s: about: must be "origin", "centroid" (got "center")']);
    expect(bad({ factor: 2, scale: 3 })).toEqual(['s: unknown field "scale" (allowed: id, op, bodies, factor, about)']);
  });

  it("its bodies are a list of bodies that exist before it", () => {
    expect(bad({ factor: 2, bodies: [] })).toEqual(["s: bodies: must be a list of body names (got [])"]);
    expect(bad({ factor: 2, bodies: ["main", "main"] })).toEqual(['s: bodies: lists "main" twice']);
    expect(bad({ factor: 2, bodies: ["nope"] })).toEqual(['s: bodies[0]: no body "nope" before this feature (bodies so far: main)']);
  });

  it("takes an expression for its factor; the command layer refuses a bad one", () => {
    const doc = { ...add(bracket, { id: "s", op: "scale", factor: "=k / 2" }), parameters: { k: 3 } };
    expect(errorsOf(doc)).toEqual([]);
    expect(validateDocument(doc).features[3].feature).toEqual({ id: "s", op: "scale", factor: 1.5 });
    expect(apply(bracket, { type: "addFeature", feature: { id: "s", op: "scale", factor: 0 } })).toEqual({ ok: false, error: "addFeature rejected: s: factor: must be greater than 0 (got 0)" });
  });

  it("is not a pattern seed", () => {
    expect(errorsOf(add(bracket, { id: "s", op: "scale", factor: 2 }, { id: "p", op: "linearPattern", feature: "s", direction: [1, 0, 0], spacing: 10, count: 2 }))).toEqual([
      'p: feature: "s" is a scale; a pattern repeats an extrude, cut or hole',
    ]);
  });
});

describe("scale: the kernel", () => {
  it("about the origin, x2: every length doubles, the volume is 8 times (2³)", () => {
    const b = built(add(bracket, { id: "s", op: "scale", factor: 2 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(8 * (PLATE - HOLE), 6);
    expect(b.box).toEqual({ min: [-80, -40, 0], max: [80, 40, 12] });
    const half = built(add(bracket, { id: "s", op: "scale", factor: 0.5 }));
    expect(half.volume).toBeCloseTo((PLATE - HOLE) / 8, 6);
    expect(half.box).toEqual({ min: [-20, -10, 0], max: [20, 10, 3] });
  });

  it("about the centroid, x3: the centroid stays where it was, the volume is 27 times", () => {
    const before = built(bracket);
    const after = built(add(bracket, { id: "s", op: "scale", factor: 3, about: "centroid" }));
    expect(after.errors).toEqual([]);
    expect(after.volume).toBeCloseTo(27 * (PLATE - HOLE), 5);
    // The plate's centroid, less the hole's: x = -30 H / (P - H), at mid-thickness.
    const c = before.centroid!;
    expect(c[0]).toBeCloseTo((-30 * HOLE) / (PLATE - HOLE), 9);
    expect(c[2]).toBeCloseTo(3, 9);
    after.centroid!.forEach((x, i) => expect(x).toBeCloseTo(c[i], 6));
    // Each corner moves away from it three times as far.
    expect(after.box!.min[0]).toBeCloseTo(c[0] + 3 * (-40 - c[0]), 6);
    expect(after.box!.max[2]).toBeCloseTo(c[2] + 3 * (6 - c[2]), 6);
  });

  it("only the bodies it lists: the stand's upright halved about its own centroid, the base as it was", () => {
    const b = built(add(stand, { id: "s", op: "scale", factor: 0.5, bodies: ["upright"], about: "centroid" }));
    expect(b.errors).toEqual([]);
    expect(b.bodies.upright.volume).toBeCloseTo((120 * 8 * 60) / 8, 6);
    // Its centroid [0, 0, 38] stays: 60 x 4 x 30 about it.
    expect(b.bodies.upright).toMatchObject({ min: [-30, -2, 23], max: [30, 2, 53] });
    expect(b.bodies.base.volume).toBeCloseTo(120 * 80 * 8 - 2 * Math.PI * 25 * 8, 6);
    // The base's holes did not move or grow.
    expect(b.holes.map((h) => [h.feature, h.diameter, h.copies])).toEqual([["hole_1", 10, 1]]);
  });

  it("holes scale with their body: the drawing's callout reads the new size", () => {
    const b = built(add(bracket, { id: "s", op: "scale", factor: 2 }));
    expect(b.holeDiameters).toEqual([13.2]);
    // A through hole's depth is how far it was drilled (through the part, and a margin): that doubles too.
    const drilled = built(bracket).holes[0].depth;
    expect(b.holes).toEqual([{ feature: "hole_1", entry: [60, 0, 12], axis: [0, 0, -1], diameter: 13.2, depth: r6(2 * drilled), through: true, copies: 0 }]);
  });

  it("a scaled member is no longer stock: the cut list leaves it out", () => {
    const frame = example("frame-members");
    expect(built(frame).members).toEqual(["leg", "rail"]);
    const b = built(add(frame, { id: "s", op: "scale", factor: 1.5, bodies: ["leg"] }));
    expect(b.errors).toEqual([]);
    expect(b.members).toEqual(["rail"]);
  });

  it("a body it lists that a failed feature should have made is reported, not skipped", () => {
    const doc = add(stand, { id: "s", op: "scale", factor: 2, bodies: ["upright"] });
    const broken = apply(doc, { type: "suppressFeature", id: "ext_2", suppressed: true });
    expect(broken.ok).toBe(true);
    const b = built(broken.ok && broken.doc);
    expect(b.errors).toEqual(['s: no body "upright" (bodies: base); the feature that makes it failed or is suppressed']);
  });
});
