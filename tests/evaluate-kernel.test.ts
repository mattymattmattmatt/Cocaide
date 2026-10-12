// Measure and Mass Properties in the kernel (src/kernel/evaluate.ts), on parts
// whose answers are written out by hand: a 100 × 60 × 8 plate with a Ø20 hole
// through its middle, and boxes for the inertia formulas.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { boxInertia } from "../src/geom/inertia";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { massProperties, minDistance, type MeasureRef } from "../src/kernel/evaluate";
import { evaluate } from "../src/worker/evaluate";
import type { RebuildView } from "../src/worker/protocol";
import { viewOf } from "./ui-fixtures";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

/** A w × h rectangle centred on the origin (and a hole of radius r there), extruded `t` up from z = `z0`. */
function plateDoc(opts: { w?: number; h?: number; t?: number; r?: number; z0?: number; material?: { name: string; densityKgPerM3: number } } = {}): RawDocument {
  const { w = 100, h = 60, t = 8, r = 10, z0 = 0 } = opts;
  const [x, y] = [w / 2, h / 2];
  const entities: Record<string, unknown>[] = [
    { id: "l1", type: "line", start: [-x, -y], end: [x, -y] },
    { id: "l2", type: "line", start: [x, -y], end: [x, y] },
    { id: "l3", type: "line", start: [x, y], end: [-x, y] },
    { id: "l4", type: "line", start: [-x, y], end: [-x, -y] },
  ];
  if (r > 0) entities.push({ id: "c1", type: "circle", center: [0, 0], radius: r });
  return {
    version: 1,
    units: "mm",
    name: "plate",
    ...(opts.material ? { material: opts.material } : {}),
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, z0] }, entities, constraints: [] },
      { id: "e1", op: "extrude", sketch: "s1", distance: t },
    ],
  };
}

function withBuilt<T>(doc: RawDocument, fn: (r: ReturnType<typeof rebuild>, view: RebuildView) => T): T {
  const view = viewOf(oc, doc);
  const r = rebuild(doc, oc);
  try {
    expect(r.errors).toEqual([]);
    return fn(r, view);
  } finally {
    r.dispose();
  }
}

const planeFace = (view: RebuildView, normal: [number, number, number], offset: number) => {
  const i = view.faces.findIndex((f) => f.type === "plane" && f.normal!.every((c, k) => Math.abs(c - normal[k]) < 1e-9) && Math.abs(f.offset! - offset) < 1e-9);
  expect(i, `face ${normal} at ${offset}`).toBeGreaterThanOrEqual(0);
  return i;
};

describe("minDistance", () => {
  it("measures the plate's thickness between its top and bottom faces, exactly", () => {
    withBuilt(plateDoc(), (r, view) => {
      const top: MeasureRef = { kind: "face", index: planeFace(view, [0, 0, 1], 8) };
      const bottom: MeasureRef = { kind: "face", index: planeFace(view, [0, 0, -1], 0) };
      const c = minDistance(oc, r.solid, top, bottom);
      expect(c.distance).toBeCloseTo(8, 9);
      expect(c.a[2]).toBeCloseTo(8, 9);
      expect(c.b[2]).toBeCloseTo(0, 9);
    });
  });

  it("measures from the hole wall to a side face, and from a vertex to a face", () => {
    withBuilt(plateDoc(), (r, view) => {
      const wall = view.faces.findIndex((f) => f.type === "cylinder");
      const side = planeFace(view, [1, 0, 0], 50);
      expect(minDistance(oc, r.solid, { kind: "face", index: wall }, { kind: "face", index: side }).distance).toBeCloseTo(40, 9);
      const c = minDistance(oc, r.solid, { kind: "point", at: [50, 30, 8] }, { kind: "face", index: planeFace(view, [0, 0, -1], 0) });
      expect(c.distance).toBeCloseTo(8, 9);
      expect(c.b).toEqual([expect.closeTo(50, 9), expect.closeTo(30, 9), expect.closeTo(0, 9)]);
    });
  });

  it("measures between two edges: the long edges across the top, 60 apart", () => {
    withBuilt(plateDoc(), (r, view) => {
      const long = view.edges.filter((e) => e.kind === "line" && Math.abs(e.length - 100) < 1e-9 && Math.abs(e.start[2] - 8) < 1e-9).map((e) => e.index);
      expect(long).toHaveLength(2);
      expect(minDistance(oc, r.solid, { kind: "edge", index: long[0] }, { kind: "edge", index: long[1] }).distance).toBeCloseTo(60, 9);
    });
  });

  it("measures to infinite reference geometry: the Right plane and the Z axis to a side face, a point to the Top plane", () => {
    withBuilt(plateDoc(), (r, view) => {
      const side = { kind: "face", index: planeFace(view, [1, 0, 0], 50) } as const;
      expect(minDistance(oc, r.solid, { kind: "plane", origin: [0, 0, 0], normal: [1, 0, 0] }, side).distance).toBeCloseTo(50, 9);
      expect(minDistance(oc, r.solid, { kind: "axis", origin: [0, 0, 0], direction: [0, 0, 1] }, side).distance).toBeCloseTo(50, 9);
      // A plane well away from the part, and a point far off to the side: still the distance along the normal.
      expect(minDistance(oc, r.solid, { kind: "point", at: [400, -300, 25] }, { kind: "plane", origin: [0, 0, 0], normal: [0, 0, 1] }).distance).toBeCloseTo(25, 9);
      // Something that touches the plane is 0 from it.
      expect(minDistance(oc, r.solid, side, { kind: "plane", origin: [0, 0, 4], normal: [0, 0, 1] }).distance).toBeCloseTo(0, 9);
    });
  });

  it("says what to do when a picked face is not in this rebuild", () => {
    withBuilt(plateDoc(), (r) => {
      expect(() => minDistance(oc, r.solid, { kind: "face", index: 999 }, { kind: "point", at: [0, 0, 0] })).toThrow(/pick it again/);
    });
  });

  it("is served by the worker's evaluate on the rebuild it already has", () => {
    const doc = plateDoc();
    withBuilt(doc, (r, view) => {
      const out = evaluate(oc, r, doc, { kind: "distance", a: { kind: "face", index: planeFace(view, [0, 0, 1], 8) }, b: { kind: "face", index: planeFace(view, [0, 0, -1], 0) } });
      expect(out.kind === "distance" && out.closest.distance).toBeCloseTo(8, 9);
    });
  });
});

describe("massProperties", () => {
  it("gives a box's volume, area, mass, centre and the textbook moments about the centre", () => {
    const doc = plateDoc({ r: 0, material: { name: "aluminium", densityKgPerM3: 2700 } });
    withBuilt(doc, (r) => {
      const out = evaluate(oc, r, doc, { kind: "mass" });
      if (out.kind !== "mass") throw new Error("not mass");
      const b = out.mass.bodies[0];
      const m = 100 * 60 * 8 * 1e-9 * 2700;
      expect(b.volume).toBeCloseTo(48000, 6);
      expect(b.area).toBeCloseTo(2 * (100 * 60 + 100 * 8 + 60 * 8), 6);
      expect(b.mass).toBeCloseTo(m, 12);
      expect(b.material).toBe("aluminium");
      expect(b.centre).toEqual([expect.closeTo(0, 9), expect.closeTo(0, 9), expect.closeTo(4, 9)]);
      const want = boxInertia(m, [100, 60, 8]);
      expect(b.inertia.ixx).toBeCloseTo(want.ixx, 8);
      expect(b.inertia.iyy).toBeCloseTo(want.iyy, 8);
      expect(b.inertia.izz).toBeCloseTo(want.izz, 8);
      expect([b.inertia.pxy, b.inertia.pxz, b.inertia.pyz]).toEqual([0, 0, 0]);
      expect(out.mass.total).toMatchObject({ name: "total", mass: b.mass, volume: b.volume });
    });
  });

  it("takes away the hole: a plate with a Ø20 bore", () => {
    withBuilt(plateDoc(), (r) => {
      const { bodies } = massProperties(oc, r.bodies, undefined);
      const rho = 7850e-9;
      const box = 100 * 60 * 8;
      const bore = Math.PI * 100 * 8;
      expect(bodies[0].volume).toBeCloseTo(box - bore, 6);
      expect(bodies[0].material).toBe("steel (default)");
      // Izz: the box's less a solid cylinder's (m r²/2), both about the axis through the centre.
      const izz = boxInertia(box * rho, [100, 60, 8]).izz - (bore * rho * 100) / 2;
      expect(bodies[0].inertia.izz).toBeCloseTo(izz, 8);
    });
  });

  it("adds bodies up about their common centre, each in its own material: two plates stacked are one box", () => {
    const doc = plateDoc({ r: 0 });
    doc.features.push(
      { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 8] }, entities: (doc.features[0].entities as unknown[]).slice(0, 4), constraints: [] },
      { id: "e2", op: "extrude", sketch: "s2", distance: 8, newBody: "lid" },
    );
    withBuilt(doc, (r) => {
      const steel = massProperties(oc, r.bodies, undefined);
      expect(steel.bodies.map((b) => b.name)).toEqual(["main", "lid"]);
      const m = 100 * 60 * 16 * 7850e-9;
      const want = boxInertia(m, [100, 60, 16]);
      expect(steel.total!.mass).toBeCloseTo(m, 12);
      expect(steel.total!.centre[2]).toBeCloseTo(8, 9);
      expect(steel.total!.inertia.ixx).toBeCloseTo(want.ixx, 7);
      expect(steel.total!.inertia.izz).toBeCloseTo(want.izz, 7);
      // The lid in aluminium: the centre of mass drops toward the heavier steel.
      const mixed = massProperties(oc, r.bodies, undefined, { lid: { name: "aluminium", densityKgPerM3: 2700 } });
      const [ms, ma] = [48000 * 7850e-9, 48000 * 2700e-9];
      expect(mixed.bodies[1].material).toBe("aluminium");
      expect(mixed.total!.centre[2]).toBeCloseTo((ms * 4 + ma * 12) / (ms + ma), 9);
      expect(mixed.total!.material).toBe("steel (default), aluminium");
    });
  });
});
