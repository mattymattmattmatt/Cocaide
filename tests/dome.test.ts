// Phase P wave 3B: domes on flat faces, volumes by the cap and ellipsoid
// formulas, and the cosmetic thread bands the view draws.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { domeVolume } from "../src/features/dome/doc";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { threadBands } from "../src/ui/viewport/threadLayer";
import { describeFaces } from "../src/kernel/topology";
import { scoped } from "../src/kernel";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };

/** A Ø40 rod 20 high (z 0..20), and features after it. */
function rod(...more: Record<string, unknown>[]): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "rod",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 20 }] },
      { id: "e1", op: "extrude", sketch: "s1", distance: 20 },
      ...more,
    ],
  };
}
const ROD = Math.PI * 400 * 20;

function built(doc: RawDocument) {
  const r = rebuild(doc, oc);
  try {
    return { errors: r.errors, volume: r.measurements?.volume ?? 0, box: r.measurements?.boundingBox };
  } finally {
    r.dispose();
  }
}

describe("dome", () => {
  it("has the cap and half-ellipsoid volumes", () => {
    expect(domeVolume("spherical", 20, 20)).toBeCloseTo((2 / 3) * Math.PI * 8000, 9);
    expect(domeVolume("spherical", 20, 5)).toBeCloseTo((Math.PI * 5 * (3 * 400 + 25)) / 6, 9);
    expect(domeVolume("elliptical", 20, 5)).toBeCloseTo((2 / 3) * Math.PI * 400 * 5, 9);
  });

  it("caps a round face: spherical", () => {
    const b = built(rod({ id: "d", op: "dome", face: TOP, height: 6 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(ROD + domeVolume("spherical", 20, 6), 4);
    expect(b.box!.max[2]).toBeCloseTo(26, 6);
  });

  it("caps a round face: elliptical, taller than wide", () => {
    const b = built(rod({ id: "d", op: "dome", face: TOP, height: 30, shape: "elliptical" }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(ROD + domeVolume("elliptical", 20, 30), 3);
  });

  it("dishes a face, reversed", () => {
    const b = built(rod({ id: "d", op: "dome", face: TOP, height: 5, reverse: true }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(ROD - domeVolume("spherical", 20, 5), 4);
  });

  it("domes a rectangle by a loft, about two thirds of area × height", () => {
    const doc: RawDocument = {
      version: 1,
      units: "mm",
      name: "box",
      features: [
        { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: 40, h: 20 }] },
        { id: "e1", op: "extrude", sketch: "s1", distance: 10 },
        { id: "d", op: "dome", face: TOP, height: 6, shape: "elliptical" },
      ],
    };
    const b = built(doc);
    expect(b.errors).toEqual([]);
    const dome = b.volume - 40 * 20 * 10;
    expect(Math.abs(dome - (2 / 3) * 800 * 6) / ((2 / 3) * 800 * 6)).toBeLessThan(0.05);
    expect(b.box!.max[2]).toBeCloseTo(16, 3);
  });
});

describe("provenance of the new features' faces", () => {
  it("labels a dome's face and a fill pattern's hole walls with the feature that made them", () => {
    const doc = rod({ id: "d", op: "dome", face: TOP, height: 6 });
    const r = rebuild(doc, oc);
    try {
      const faces = scoped((s) => describeFaces(oc, s, r.solid!).infos);
      r.label({ faces, edges: [] });
      expect(faces.filter((f) => f.createdBy === "d").length).toBeGreaterThan(0);
    } finally {
      r.dispose();
    }
  });
});

describe("cosmetic thread bands", () => {
  it("draws one on a thread's face and on a tapped hole's, none on a modelled thread", () => {
    const doc = rod(
      { id: "t", op: "thread", face: { type: "cylindrical", radius: 20, pick: "largest" }, size: "M20", length: 10 },
      { id: "h", op: "hole", face: TOP, center: [0, 0], size: "M8", kind: "tapped", depth: 15 },
    );
    (doc.features[0] as { entities: { radius: number }[] }).entities[0].radius = 10;
    (doc.features[2] as { face: { radius: number } }).face.radius = 10;
    const r = rebuild(doc, oc);
    try {
      expect(r.errors).toEqual([]);
      const faces = scoped((s) => describeFaces(oc, s, r.solid!).infos);
      const bands = threadBands(r.holes, faces);
      expect(bands.map((b) => [b.feature, b.internal, b.radius, b.length])).toEqual([
        ["t", false, 10, 10],
        ["h", true, 3.4, 15 - 3 * 1.25],
      ]);
      expect(bands[0].start[2]).toBeCloseTo(20, 9);
      expect(bands[0].axis).toEqual([0, 0, -1]);
    } finally {
      r.dispose();
    }
  });
});
