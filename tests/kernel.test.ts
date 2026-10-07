import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { CocaideDocument, Feature } from "../src/doc/types";
import { loadOC, rebuild, scoped, tessellate, type OC } from "../src/kernel";
import { describeFaces } from "../src/kernel/topology";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8")) as CocaideDocument;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function build(doc: unknown) {
  const r = rebuild(doc, oc);
  const out = { ...r, volume: r.measurements?.volume ?? 0 };
  r.dispose();
  return out;
}

function plate(extra: Feature[] = [], t = 6): CocaideDocument {
  const doc = load("bracket");
  doc.features = [doc.features[0], { ...doc.features[1], distance: t } as Feature, ...extra];
  return doc;
}

describe("mounting plate example (every Phase A operation)", () => {
  it("rebuilds and matches the hand calculation", () => {
    const r = build(load("mounting-plate"));
    expect(r.errors).toEqual([]);
    const pi = Math.PI;
    const outline = 100 * 60 - 4 * (36 - 9 * pi) - pi * 100; // rounded corners, 20 mm bore
    const slot = (24 * 8 + pi * 16) * 8;
    const pocket = 16 * 24 * 3;
    const cbore = pi * 3.3 ** 2 * 4 + pi * 5.5 ** 2 * 4;
    const sink = 3.2; // (13 - 6.6) / 2 / tan(45°)
    const csink = pi * 3.3 ** 2 * 8 + (pi * sink / 3) * (6.5 ** 2 + 6.5 * 3.3 + 3.3 ** 2) - pi * 3.3 ** 2 * sink;
    const tap = pi * 2.1 ** 2 * 10;
    const expected = outline * 8 - slot - pocket - 2 * cbore - 2 * csink - tap;
    expect(r.volume).toBeCloseTo(expected, 6);
    const m = r.measurements!;
    expect(m.holeCount).toBe(6);
    expect(m.holeDiameters).toEqual([4.2, 6.6, 6.6, 6.6, 6.6, 20]);
    expect(m.holes.filter((h) => h.diameters.includes(11))).toHaveLength(2);
    expect(m.mass.material).toBe("6082-T6 aluminium");
    expect(m.mass.kg).toBeCloseTo(expected * 1e-9 * 2700, 9);
  });

  it("drills the side hole into the +X face at mid-thickness", () => {
    const r = build(load("mounting-plate"));
    const side = r.measurements!.holes.find((h) => h.diameter === 4.2)!;
    expect(Math.abs(side.axis[0])).toBeCloseTo(1, 9);
    expect(side.axisPoint[1]).toBeCloseTo(0, 9);
    expect(side.axisPoint[2]).toBeCloseTo(4, 9);
    expect(side.length).toBeCloseTo(10, 9);
  });
});

describe("operations", () => {
  it("extrudes midplane symmetric about the sketch plane", () => {
    const doc = plate();
    doc.features[1] = { id: "ext_1", op: "extrude", sketch: "sketch_1", extent: "midplane", distance: 10 };
    const r = rebuild(doc, oc);
    try {
      expect(r.errors).toEqual([]);
      expect(r.measurements!.boundingBox!.min[2]).toBeCloseTo(-5, 9);
      expect(r.measurements!.boundingBox!.max[2]).toBeCloseTo(5, 9);
    } finally {
      r.dispose();
    }
  });

  it("extrudes along an oblique direction by the given length", () => {
    const doc = plate();
    doc.features[1] = { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: 10, direction: [1, 0, 1] };
    const r = build(doc);
    expect(r.errors).toEqual([]);
    // Prism volume = base area x height along the normal.
    expect(r.volume).toBeCloseTo(80 * 40 * 10 * Math.SQRT1_2, 6);
  });

  it("cuts through all from a sketch plane inside the part", () => {
    const doc = plate([
      {
        id: "s2",
        op: "sketch",
        plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 3] },
        entities: [{ id: "c", type: "circle", center: [0, 0], radius: 5 }],
      },
      { id: "cut_1", op: "cut", sketch: "s2", extent: "throughAll" },
    ]);
    const r = build(doc);
    expect(r.errors).toEqual([]);
    // Only the half above z = 3 is removed.
    expect(r.volume).toBeCloseTo(80 * 40 * 6 - Math.PI * 25 * 3, 6);
    // A round blind pocket has a full concave wall: it measures as a blind hole.
    expect(r.measurements!.holeDiameters).toEqual([10]);
    expect(r.measurements!.holes[0].length).toBeCloseTo(3, 9);
  });

  it("adds a boss on top and keeps the top face whole", () => {
    const doc = plate([
      {
        id: "s2",
        op: "sketch",
        plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] },
        entities: [{ id: "c", type: "circle", center: [0, 0], radius: 5 }],
      },
      { id: "boss", op: "extrude", sketch: "s2", distance: 4 },
    ]);
    const r = rebuild(doc, oc);
    try {
      expect(r.errors).toEqual([]);
      expect(r.measurements!.volume).toBeCloseTo(80 * 40 * 6 + Math.PI * 25 * 4, 6);
      expect(r.measurements!.holeCount).toBe(0); // a boss is convex, not a hole
      scoped((s) => {
        const up = describeFaces(oc, s, r.solid!).infos.filter((f) => f.type === "plane" && f.normal![2] > 0.999);
        expect(up.map((f) => Math.round(f.offset!))).toEqual(expect.arrayContaining([6, 10]));
        expect(up).toHaveLength(2);
      });
    } finally {
      r.dispose();
    }
  });

  it("builds a blind hole with a flat bottom", () => {
    const r = build(
      plate([
        {
          id: "h",
          op: "hole",
          face: { type: "planar", normal: [0, 0, 1], pick: "largest" },
          center: [0, 0],
          diameter: 5,
          depth: 4,
        },
      ]),
    );
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(80 * 40 * 6 - Math.PI * 6.25 * 4, 6);
    expect(r.measurements!.holes[0].length).toBeCloseTo(4, 9);
  });

  it("drills from the bottom face when the selector says -Z", () => {
    const r = build(
      plate([
        {
          id: "h",
          op: "hole",
          face: { type: "planar", normal: [0, 0, -1], pick: "largest" },
          center: [10, 5],
          diameter: 5,
          depth: 2,
        },
      ]),
    );
    expect(r.errors).toEqual([]);
    const h = r.measurements!.holes[0];
    // Bottom-face frame: x = +X, y = -Y.
    expect(h.axisPoint[0]).toBeCloseTo(10, 9);
    expect(h.axisPoint[1]).toBeCloseTo(-5, 9);
    expect(h.axisPoint[2]).toBeCloseTo(0, 9);
    expect(h.length).toBeCloseTo(2, 9);
  });

  it("tessellates the solid for the viewport", () => {
    const r = rebuild(load("bracket"), oc);
    try {
      const mesh = tessellate(oc, r.solid!);
      expect(mesh.positions.length % 3).toBe(0);
      expect(mesh.positions.length).toBe(mesh.normals.length);
      expect(mesh.indices.length % 3).toBe(0);
      expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
      expect(mesh.faceRanges).toHaveLength(7);
      expect(mesh.faceRanges.reduce((t, f) => t + f.count, 0)).toBe(mesh.indices.length);
      expect(mesh.edges.length % 6).toBe(0);
      expect(mesh.edges.length).toBeGreaterThan(0);
    } finally {
      r.dispose();
    }
  });
});

describe("errors the agent can read", () => {
  it("reports a selector that matches nothing in the spec's wording", () => {
    // A round bar along X has no planar +Z face.
    const doc: CocaideDocument = {
      version: 1,
      units: "mm",
      name: "bar",
      features: [
        {
          id: "s",
          op: "sketch",
          plane: { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] },
          entities: [{ id: "c", type: "circle", center: [0, 0], radius: 10 }],
        },
        { id: "e", op: "extrude", sketch: "s", distance: 50 },
        {
          id: "hole_1",
          op: "hole",
          face: { type: "planar", normal: [0, 0, 1], pick: "largest" },
          center: [0, 0],
          diameter: 6.6,
          depth: "through",
        },
      ],
    };
    const r = build(doc);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(["hole_1: selector matched 0 faces (wanted 1 planar face normal +Z)"]);
    expect(r.features[2]).toEqual({ id: "hole_1", op: "hole", ok: false, error: r.errors[0] });
  });

  it("refuses to choose between two faces when pick is all", () => {
    const doc = plate([
      {
        id: "s2",
        op: "sketch",
        plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] },
        entities: [{ id: "c", type: "circle", center: [0, 0], radius: 5 }],
      },
      { id: "boss", op: "extrude", sketch: "s2", distance: 4 },
      {
        id: "hole_1",
        op: "hole",
        face: { type: "planar", normal: [0, 0, 1], pick: "all" },
        center: [30, 0],
        diameter: 6.6,
        depth: "through",
      },
    ]);
    expect(build(doc).errors).toEqual(["hole_1: selector matched 2 faces (wanted 1 planar face normal +Z)"]);
  });

  it("reports a tie instead of guessing", () => {
    // Two separate equal pads: two +Z faces of identical area.
    const doc: CocaideDocument = {
      version: 1,
      units: "mm",
      name: "pads",
      features: [
        {
          id: "s",
          op: "sketch",
          plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
          entities: [
            { id: "a", type: "rect", center: [-20, 0], w: 10, h: 10 },
            { id: "b", type: "rect", center: [20, 0], w: 10, h: 10 },
          ],
        },
        { id: "e", op: "extrude", sketch: "s", distance: 5 },
        {
          id: "hole_1",
          op: "hole",
          face: { type: "planar", normal: [0, 0, 1], pick: "largest" },
          center: [20, 0],
          diameter: 3,
          depth: "through",
        },
      ],
    };
    const r = build(doc);
    expect(r.errors).toEqual([
      "hole_1: selector matched 2 faces tied for largest area (wanted 1 planar face normal +Z)",
    ]);
    expect(r.measurements!.solids).toBe(2);
  });

  it("rejects a hole centre that is off the face", () => {
    const r = build(
      plate([
        {
          id: "hole_1",
          op: "hole",
          face: { type: "planar", normal: [0, 0, 1], pick: "largest" },
          center: [90, 0],
          diameter: 6.6,
          depth: "through",
        },
      ]),
    );
    expect(r.errors).toEqual(["hole_1: center [90, 0] is not on the selected face (it is 50 mm outside it)"]);
  });

  it("rejects a cut that removes nothing and says which way it went", () => {
    const doc = plate([
      {
        id: "s2",
        op: "sketch",
        plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] },
        entities: [{ id: "c", type: "circle", center: [0, 0], radius: 5 }],
      },
      { id: "cut_1", op: "cut", sketch: "s2", distance: 3 },
    ]);
    expect(build(doc).errors).toEqual([
      "cut_1: removed no material: the cut does not reach the solid in direction +Z; check direction and distance, or use extent throughAll",
    ]);
  });

  it("rejects an op that would remove the whole part", () => {
    const doc = load("bracket");
    (doc.features[2] as { diameter: number }).diameter = 500;
    const r = build(doc);
    expect(r.errors).toEqual(["hole_1: removes all the material: nothing of the part would be left"]);
    expect(r.volume).toBeCloseTo(80 * 40 * 6, 6); // the body before the hole
  });

  it("keeps rebuilding after a failed feature", () => {
    const doc = plate([
      {
        id: "bad",
        op: "hole",
        face: { type: "planar", normal: [0, 0, 1], pick: "largest" },
        center: [500, 0],
        diameter: 6.6,
        depth: "through",
      },
      {
        id: "good",
        op: "hole",
        face: { type: "planar", normal: [0, 0, 1], pick: "largest" },
        center: [-30, 0],
        diameter: 6.6,
        depth: "through",
      },
    ]);
    const r = build(doc);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^bad: center \[500, 0\] is not on the selected face/);
    expect(r.features.map((f) => f.ok)).toEqual([true, true, false, true]);
    expect(r.measurements!.holeCount).toBe(1);
  });

  it("names the open end of a sketch profile", () => {
    const doc = plate();
    (doc.features[0] as Extract<Feature, { op: "sketch" }>).entities = [
      { id: "l1", type: "line", start: [0, 0], end: [10, 0] },
      { id: "l2", type: "line", start: [10, 0], end: [10, 10] },
      { id: "l3", type: "line", start: [10, 10], end: [0, 10] },
    ];
    (doc.features[0] as Extract<Feature, { op: "sketch" }>).constraints = [];
    const r = build(doc);
    expect(r.errors).toEqual([
      "sketch_1: profile is open at [0, 0] (start of \"l1\")",
      'ext_1: sketch "sketch_1" failed, so there is no profile to extrude',
    ]);
    expect(r.solid).toBeNull();
  });

  it("fails the sketch when a constraint does not hold", () => {
    const doc = plate();
    (doc.features[0] as Extract<Feature, { op: "sketch" }>).entities[0] = {
      id: "r1",
      type: "rect",
      center: [0, 0],
      w: 90,
      h: 40,
    };
    expect(build(doc).errors[0]).toBe(
      "sketch_1: constraint 0 (distanceX r1 = 80) is not satisfied: geometry gives 90, constraint says 80",
    );
  });

  it("reports schema errors per feature and still builds the rest", () => {
    const doc = load("bracket") as unknown as { features: Record<string, unknown>[] };
    doc.features[2].diamter = 6.6;
    delete doc.features[2].diameter;
    const r = build(doc);
    expect(r.errors).toEqual([
      'hole_1: unknown field "diamter" (allowed: id, op, face, center, diameter, depth, counterbore, countersink, bodies)',
      "hole_1: diameter: must be a number (got nothing)",
    ]);
    expect(r.volume).toBeCloseTo(80 * 40 * 6, 6);
    expect(r.features[2]).toMatchObject({ id: "hole_1", op: "hole", ok: false });
  });

  it("rejects a document with the wrong units outright", () => {
    const r = build({ ...load("bracket"), units: "in" });
    expect(r.errors).toEqual(['document: units: must be "mm" (got "in"); v1 documents store millimetres only']);
    expect(r.solid).toBeNull();
    expect(r.features).toEqual([]);
  });
});
