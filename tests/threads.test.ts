// Phase P wave 3B: threads on cylindrical faces, cosmetic (recorded and
// called out like a tapped hole) and modelled (the ISO groove cut along the
// exact helix), with volumes from the groove formula.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { holeText } from "../src/drafting/compose";
import { basicMinor, grooveVolume, sizeFor } from "../src/features/thread/profile";
import { loadOC, rebuild, type OC } from "../src/kernel";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const SHAFT = { type: "cylindrical", radius: 5, pick: "largest" };

/** A Ø10 shaft 30 long standing on the origin (z 0..30), and features after it. */
function shaft(...more: Record<string, unknown>[]): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "shaft",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 5 }] },
      { id: "e1", op: "extrude", sketch: "s1", distance: 30 },
      ...more,
    ],
  };
}

/** A 40 x 40 x 10 block with a Ø8.5 hole through (M10's tap drill), and features after it. */
function block(...more: Record<string, unknown>[]): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "block",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: 40, h: 40 }] },
      { id: "e1", op: "extrude", sketch: "s1", distance: 10 },
      { id: "h1", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [0, 0], diameter: 8.5, depth: "through" },
      ...more,
    ],
  };
}

function built(doc: RawDocument) {
  const r = rebuild(doc, oc);
  try {
    return { errors: r.errors, volume: r.measurements?.volume ?? 0, records: r.holes };
  } finally {
    r.dispose();
  }
}

describe("thread geometry", () => {
  it("has the ISO basic minor diameter and groove", () => {
    // d1 = d - 5/4 · (√3/2) P: M10 × 1.5 → 8.376.
    expect(basicMinor(10, 1.5)).toBeCloseTo(10 - 1.0825317547 * 1.5, 9);
    // External groove, whole (the shaft is the major diameter): trapezoid P/4 at r0 to 7P/8 at r1, height 5H/8.
    const P = 1.5;
    const r0 = basicMinor(10, P) / 2;
    const r1 = 5;
    const b = (7 * P) / 8 - P / 4;
    const a0 = P / 4;
    // ∫ ρ w dρ with w linear from a0 at r0 to a0 + b at r1: area · centroid radius.
    const h = r1 - r0;
    const area = ((a0 + a0 + b) / 2) * h;
    const centroid = r0 + (h * (a0 + 2 * (a0 + b))) / (3 * (a0 + (a0 + b)));
    expect(grooveVolume(true, 10, P, 5, 20)).toBeCloseTo((20 / P) * 2 * Math.PI * area * centroid, 9);
    // About 13.4 mm³ a millimetre.
    expect(grooveVolume(true, 10, P, 5, 1)).toBeCloseTo(13.4, 1);
  });

  it("finds the size a face fits", () => {
    expect(sizeFor(10, false)?.size).toBe("M10");
    expect(sizeFor(8.5, true)?.size).toBe("M10");
    expect(sizeFor(6.8, true)?.size).toBe("M8");
    expect(sizeFor(11, false)).toBeUndefined();
  });

  it("validates", () => {
    const errs = allErrors(validateDocument(shaft({ id: "t", op: "thread", face: SHAFT, size: "M7", chamfer: true })));
    expect(errs.some((e) => e.includes("size: must be an ISO metric size"))).toBe(true);
    expect(errs.some((e) => e.includes('chamfer: goes with "modelled": true'))).toBe(true);
  });
});

describe("cosmetic threads", () => {
  it("records an external thread for drawings, cutting nothing", () => {
    const b = built(shaft({ id: "t", op: "thread", face: SHAFT, length: 20 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(Math.PI * 25 * 30, 6);
    const t = b.records.find((h) => h.feature === "t")!;
    expect(t.thread).toMatchObject({ designation: "M10×1.5", class: "6g", depth: 20, external: true });
    // It starts at the top (z 30) and runs down.
    expect(t.entry).toEqual([0, 0, 30]);
    expect(t.axis).toEqual([0, 0, -1]);
    expect(holeText(t)).toEqual(["M10×1.5 - 6g ⌴20"]);
  });

  it("records an internal one in a tap-drill hole", () => {
    const b = built(block({ id: "t", op: "thread", face: { type: "cylindrical", radius: 4.25, pick: "largest" } }));
    expect(b.errors).toEqual([]);
    const t = b.records.find((h) => h.feature === "t")!;
    expect(t.thread).toMatchObject({ designation: "M10×1.5", class: "6H", depth: 10 });
    expect(holeText(t)).toEqual(["M10×1.5 - 6H ⌴10", "Ø8.5 ⌴10"]);
  });

  it("says when the face fits no size, or is too wide for the one given", () => {
    const b = built(shaft({ id: "t", op: "thread", face: SHAFT, size: "M20" }));
    expect(b.errors.join()).toMatch(/minor diameter/);
    const doc = shaft({ id: "t", op: "thread", face: { ...SHAFT } });
    (doc.features[0] as { entities: { radius: number }[] }).entities[0].radius = 5.6;
    (doc.features[2] as { face: { radius: number } }).face.radius = 5.6;
    expect(built(doc).errors.join()).toMatch(/fits no ISO metric size/);
  });
});

describe("modelled threads", () => {
  it("cuts M10 on a shaft: the volume the groove formula gives", () => {
    const b = built(shaft({ id: "t", op: "thread", face: SHAFT, length: 20, modelled: true }));
    expect(b.errors).toEqual([]);
    const expected = Math.PI * 25 * 30 - grooveVolume(true, 10, 1.5, 5, 20);
    expect(Math.abs(b.volume - expected) / grooveVolume(true, 10, 1.5, 5, 20)).toBeLessThan(0.005);
  });

  it("cuts M10 in a tap-drill hole", () => {
    const plain = built(block());
    const b = built(block({ id: "t", op: "thread", face: { type: "cylindrical", radius: 4.25, pick: "largest" }, modelled: true }));
    expect(b.errors).toEqual([]);
    const cut = plain.volume - b.volume;
    const expected = grooveVolume(false, 10, 1.5, 4.25, 10);
    expect(Math.abs(cut - expected) / expected).toBeLessThan(0.005);
  });

  it("adds a run-out chamfer, and a left-hand thread cuts the same", () => {
    const plain = built(shaft({ id: "t", op: "thread", face: SHAFT, length: 12, modelled: true }));
    const left = built(shaft({ id: "t", op: "thread", face: SHAFT, length: 12, modelled: true, leftHanded: true }));
    const chamfered = built(shaft({ id: "t", op: "thread", face: SHAFT, length: 12, modelled: true, chamfer: true }));
    expect(left.errors).toEqual([]);
    expect(chamfered.errors).toEqual([]);
    expect(left.volume).toBeCloseTo(plain.volume, 1);
    expect(left.records[0].thread?.designation).toBe("M10×1.5 LH");
    // The chamfer takes more off the end, but no more than its whole cone ring.
    const r0 = basicMinor(10, 1.5) / 2;
    const h = 5 - r0;
    const ring = 2 * Math.PI * ((h * h) / 2) * (r0 + (2 * h) / 3);
    expect(chamfered.volume).toBeLessThan(plain.volume);
    expect(plain.volume - chamfered.volume).toBeLessThan(ring);
  });
});
