// Phase A acceptance (spec section 7):
//   the bracket JSON rebuilds, volume matches hand calc within 0.1%,
//   STEP reimports, and the hole selector survives a rebuild after the
//   plate thickness changes.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { exportSTEP, importSTEP, loadOC, rebuild, scoped, volumeOf, type OC } from "../src/kernel";
import { describeFaces } from "../src/kernel/topology";
import { isValidShape } from "../src/kernel/measure";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8"));

/** 80 x 40 plate, thickness t, one 6.6 through hole. */
const handCalcVolume = (t: number) => 80 * 40 * t - Math.PI * 3.3 * 3.3 * t;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

describe("Phase A acceptance: the spec bracket", () => {
  it("rebuilds with no errors", () => {
    const r = rebuild(bracket, oc);
    try {
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.features.map((f) => [f.id, f.ok])).toEqual([
        ["sketch_1", true],
        ["ext_1", true],
        ["hole_1", true],
      ]);
    } finally {
      r.dispose();
    }
  });

  it("matches the hand-calculated volume within 0.1%", () => {
    const r = rebuild(bracket, oc);
    try {
      const expected = handCalcVolume(6); // 19200 - 205.2717 = 18994.7283 mm³
      const m = r.measurements!;
      expect(Math.abs(m.volume - expected) / expected).toBeLessThan(0.001);
      // The kernel is exact here; hold it to far better than the acceptance bar.
      expect(m.volume).toBeCloseTo(expected, 6);
    } finally {
      r.dispose();
    }
  });

  it("reports the measurements the agent reads", () => {
    const r = rebuild(bracket, oc);
    try {
      const m = r.measurements!;
      expect(m.units).toBe("mm");
      expect(m.boundingBox!.min).toEqual([-40, -20, 0].map((x) => expect.closeTo(x, 9)));
      expect(m.boundingBox!.max).toEqual([40, 20, 6].map((x) => expect.closeTo(x, 9)));
      expect(m.holeCount).toBe(1);
      expect(m.holeDiameters).toEqual([6.6]);
      expect(m.holes[0].length).toBeCloseTo(6, 9);
      expect(m.holes[0].axis).toEqual([0, 0, 1].map((x) => expect.closeTo(x, 9)));
      expect(m.holes[0].axisPoint[0]).toBeCloseTo(30, 9);
      expect(m.holes[0].axisPoint[1]).toBeCloseTo(0, 9);
      // 2 x (plate face - hole) + perimeter x t + hole wall
      const area = 2 * (80 * 40 - Math.PI * 3.3 ** 2) + 240 * 6 + 2 * Math.PI * 3.3 * 6;
      expect(m.surfaceArea).toBeCloseTo(area, 6);
      expect(m.mass.densityKgPerM3).toBe(7850);
      expect(m.mass.kg).toBeCloseTo(handCalcVolume(6) * 1e-9 * 7850, 9);
      expect(m.solids).toBe(1);
      expect(m.faces).toBe(7);
    } finally {
      r.dispose();
    }
  });

  it("exports STEP that reimports as the same valid solid", () => {
    const r = rebuild(bracket, oc);
    try {
      const step = exportSTEP(oc, r.solid!, r.name);
      expect(step.startsWith("ISO-10303-21;")).toBe(true);
      expect(step).toContain("PRODUCT('bracket','bracket'");
      expect(step).toContain("SI_UNIT(.MILLI.,.METRE.)");
      const back = importSTEP(oc, step);
      try {
        scoped((s) => {
          expect(isValidShape(oc, s, back)).toBe(true);
          expect(volumeOf(oc, s, back)).toBeCloseTo(r.measurements!.volume, 6);
          expect(describeFaces(oc, s, back).infos.length).toBe(7);
        });
      } finally {
        back.delete();
      }
    } finally {
      r.dispose();
    }
  });

  it("keeps the hole on the top face after the plate thickness changes", () => {
    const thicker = structuredClone(bracket);
    thicker.features[1].distance = 10;
    const r = rebuild(thicker, oc);
    try {
      expect(r.errors).toEqual([]);
      const m = r.measurements!;
      expect(m.boundingBox!.max[2]).toBeCloseTo(10, 9);
      expect(m.volume).toBeCloseTo(handCalcVolume(10), 6);
      expect(m.holeCount).toBe(1);
      expect(m.holeDiameters).toEqual([6.6]);
      // Still a through hole: its wall spans the full new thickness.
      expect(m.holes[0].length).toBeCloseTo(10, 9);
      // And the top face it was drilled from is the one at z = 10.
      scoped((s) => {
        const top = describeFaces(oc, s, r.solid!).infos.filter(
          (f) => f.type === "plane" && f.normal![2] > 1 - 1e-9,
        );
        expect(top).toHaveLength(1);
        expect(top[0].offset).toBeCloseTo(10, 9);
        expect(top[0].area).toBeCloseTo(80 * 40 - Math.PI * 3.3 ** 2, 6);
      });
    } finally {
      r.dispose();
    }
  });

  it("follows a thinner plate too", () => {
    const thinner = structuredClone(bracket);
    thinner.features[1].distance = 3;
    const r = rebuild(thinner, oc);
    try {
      expect(r.errors).toEqual([]);
      expect(r.measurements!.volume).toBeCloseTo(handCalcVolume(3), 6);
      expect(r.measurements!.holes[0].length).toBeCloseTo(3, 9);
    } finally {
      r.dispose();
    }
  });
});
