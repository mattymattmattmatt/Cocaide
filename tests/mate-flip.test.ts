// Flipping mates (src/assembly/solve.ts, src/assembly/flip.ts): concentric and parallel held aligned or opposed;
// a distance on the other side; tangent mates (a flat face and a round one, two round ones side by side or one
// inside the other); what each mate's Flip does.

import { describe, expect, it } from "vitest";
import type { Mate, Vec3 } from "../src/doc/types";
import { residuals, solveMates, type MateGeom, type SolverMate } from "../src/assembly/solve";
import { mateFlips, startingWay } from "../src/assembly/flip";
import { apply, placementOf, pointTo, type Placement } from "../src/assembly/transform";

const plane = (p: Vec3, n: Vec3): MateGeom => ({ kind: "plane", p, n });
const axis = (p: Vec3, d: Vec3, r?: number): MateGeom => ({ kind: "axis", p, d, ...(r !== undefined ? { r } : {}) });
const start = () => new Map<string, Placement>([["base", placementOf({})], ["pin", placementOf({ at: [40, 30, 60], rotation: [10, 20, 0] })]]);
const mate = (type: SolverMate["type"], a: MateGeom, b: MateGeom, extra: Partial<SolverMate> = {}): SolverMate => ({ id: "m", type, a: { component: "base", geom: a }, b: { component: "pin", geom: b }, ...extra });
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("flipping mates in the solver", () => {
  it("concentric aligned points the pin's axis the hole's way; opposed, the other way", () => {
    for (const [extra, sign] of [[{ aligned: true }, 1], [{ opposed: true }, -1]] as const) {
      const r = solveMates(start(), new Set(["base"]), [mate("concentric", axis([0, 0, 0], [0, 0, 1]), axis([0, 0, 0], [0, 0, 1]), extra)]);
      expect(r.solved).toBe(true);
      expect(dot(apply(r.placements.get("pin")!.R, [0, 0, 1]), [0, 0, 1])).toBeCloseTo(sign, 6);
    }
  });
  it("parallel faces aligned or opposed; either way, as before, when neither", () => {
    const g = [plane([0, 0, 10], [0, 0, 1]), plane([0, 0, 0], [0, 0, 1])] as const;
    for (const [extra, sign] of [[{ aligned: true }, 1], [{ opposed: true }, -1]] as const) {
      const r = solveMates(start(), new Set(["base"]), [mate("parallel", g[0], g[1], extra)]);
      expect(r.solved).toBe(true);
      expect(dot(apply(r.placements.get("pin")!.R, [0, 0, 1]), [0, 0, 1])).toBeCloseTo(sign, 6);
    }
    expect((residuals(mate("parallel", g[0], g[1]), plane([0, 0, 0], [0, 0, 1]), plane([0, 0, 0], [0, 0, -1])) as number[]).map(Math.abs)).toEqual([0, 0, 0]);
  });
  it("a distance flipped goes to the other side of the first face", () => {
    const top = plane([50, 25, 10], [0, 0, 1]);
    const bottom = plane([0, 0, 0], [0, 0, -1]);
    const front = solveMates(start(), new Set(["base"]), [mate("distance", top, bottom, { value: 25 })]);
    const back = solveMates(start(), new Set(["base"]), [mate("distance", top, bottom, { value: 25, flip: true })]);
    expect(pointTo(front.placements.get("pin")!, [0, 0, 0])[2]).toBeCloseTo(35, 6);
    expect(pointTo(back.placements.get("pin")!, [0, 0, 0])[2]).toBeCloseTo(-15, 6);
  });
  it("tangent: a round face on a flat one (either side), two round ones side by side or one inside the other", () => {
    const floor = plane([0, 0, 0], [0, 0, 1]);
    const roller = axis([0, 0, 0], [1, 0, 0], 20);
    for (const [flip, z] of [[false, 20], [true, -20]] as const) {
      const r = solveMates(start(), new Set(["base"]), [mate("tangent", floor, roller, flip ? { flip } : {})]);
      expect(r.solved).toBe(true);
      expect(pointTo(r.placements.get("pin")!, [0, 0, 0])[2]).toBeCloseTo(z, 5);
    }
    const shaft = axis([0, 0, 0], [0, 0, 1], 30);
    const wheel = axis([0, 0, 0], [0, 0, 1], 10);
    for (const [flip, d] of [[false, 40], [true, 20]] as const) {
      const r = solveMates(start(), new Set(["base"]), [mate("tangent", shaft, wheel, flip ? { flip } : {})]);
      expect(r.solved).toBe(true);
      const c = pointTo(r.placements.get("pin")!, [0, 0, 0]);
      const dir = apply(r.placements.get("pin")!.R, [0, 0, 1]);
      const along = dot(c, dir);
      expect(Math.hypot(c[0] - dir[0] * along, c[1] - dir[1] * along, c[2] - dir[2] * along)).toBeCloseTo(d, 5);
    }
    expect(residuals(mate("tangent", floor, axis([0, 0, 0], [1, 0, 0])), floor, axis([0, 0, 0], [1, 0, 0]))).toMatch(/round face/);
  });
});

describe("what Flip does", () => {
  const m = (x: Partial<Mate>): Mate => ({ id: "m", type: "coincident", a: { component: "base", face: {} as never }, b: { component: "pin", face: {} as never }, ...x }) as Mate;
  const held = (a: MateGeom, b: MateGeom): SolverMate => ({ id: "m", type: "coincident", a: { component: "base", geom: a }, b: { component: "pin", geom: b } });
  const P = new Map<string, Placement>([["base", placementOf({})], ["pin", placementOf({})]]);
  it("flat faces: face to face ↔ aligned; a distance also has a side", () => {
    const h = held(plane([0, 0, 0], [0, 0, 1]), plane([0, 0, 0], [0, 0, -1]));
    expect(mateFlips(m({}), h).flip?.patch).toEqual({ aligned: true });
    expect(mateFlips(m({ aligned: true }), h).flip?.patch).toEqual({ aligned: undefined });
    const d = mateFlips(m({ type: "distance", value: 5 }), h);
    expect(d.side?.patch).toEqual({ flip: true });
    expect(mateFlips(m({ type: "distance", value: 5, flip: true }), h).side?.patch).toEqual({ flip: undefined });
  });
  it("directions: aligned ↔ opposed; an old 'either way' mate flips from how it sits", () => {
    const h = { ...held(axis([0, 0, 0], [0, 0, 1]), axis([0, 0, 0], [0, 0, 1])), type: "concentric" as const };
    expect(mateFlips(m({ type: "concentric", aligned: true }), h).flip?.patch).toEqual({ aligned: undefined, opposed: true });
    expect(mateFlips(m({ type: "concentric", opposed: true }), h).flip?.patch).toEqual({ aligned: true, opposed: undefined });
    expect(mateFlips(m({ type: "concentric" }), h, P).flip?.patch).toEqual({ aligned: undefined, opposed: true });
    expect(mateFlips(m({ type: "perpendicular" }), h).flip).toBeNull();
  });
  it("an angle flips to 180° less it; a tangent to its other side", () => {
    expect(mateFlips(m({ type: "angle", value: 30 }), undefined).flip?.patch).toEqual({ value: 150 });
    expect(mateFlips(m({ type: "tangent" }), undefined).flip?.patch).toEqual({ flip: true });
  });
  it("a new mate starts the way its things sit", () => {
    expect(startingWay("concentric", { kind: "axis", normal: [0, 0, 1] }, { kind: "axis", normal: [0, 0, -1] })).toEqual({ opposed: true });
    expect(startingWay("parallel", { kind: "plane", normal: [0, 0, 1] }, { kind: "plane", normal: [0, 0.1, 0.9] })).toEqual({ aligned: true });
    expect(startingWay("tangent", { kind: "plane", normal: [0, 0, 1], point: [0, 0, 0] }, { kind: "axis", normal: [1, 0, 0], point: [0, 0, -50], radius: 10 })).toEqual({ flip: true });
    expect(startingWay("tangent", { kind: "axis", normal: [0, 0, 1], point: [0, 0, 0], radius: 30 }, { kind: "axis", normal: [0, 0, 1], point: [21, 0, 0], radius: 10 })).toEqual({ flip: true });
  });
});
