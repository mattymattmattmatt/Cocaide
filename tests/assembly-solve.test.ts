// The mate solver (src/assembly/solve.ts): a block put on another by three
// coincident faces lands exactly on it; a pin goes into a hole by a
// concentric mate and a face; distance and angle mates hold their values;
// what can't be written says so; the held component never moves.

import { describe, expect, it } from "vitest";
import type { Vec3 } from "../src/doc/types";
import { solveMates, type SolverMate } from "../src/assembly/solve";
import { fromEuler, placementOf, pointTo, toEuler, written, type Placement } from "../src/assembly/transform";

const near = (a: number[], b: number[], tol = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < tol);
const plane = (p: Vec3, n: Vec3) => ({ kind: "plane" as const, p, n });
const axis = (p: Vec3, d: Vec3) => ({ kind: "axis" as const, p, d });

describe("placements", () => {
  it("turns go X, then Y, then Z, and come back as the same angles", () => {
    for (const r of [[0, 0, 0], [30, 0, 0], [0, 45, 0], [10, 20, 30], [-120, 60, 170]] as Vec3[]) expect(near(toEuler(fromEuler(r)), r, 1e-9)).toBe(true);
    // 90° about Z takes +X to +Y.
    expect(near(pointTo(placementOf({ rotation: [0, 0, 90] }), [1, 0, 0]), [0, 1, 0], 1e-12)).toBe(true);
  });
});

describe("solving mates", () => {
  // Two 100 × 50 × 10 blocks, corner at the origin of each part; the second starts somewhere else, turned.
  const start = () =>
    new Map<string, Placement>([
      ["base", placementOf({})],
      ["top", placementOf({ at: [300, 40, 70], rotation: [20, -15, 40] })],
    ]);
  const faces = {
    top: plane([50, 25, 10], [0, 0, 1]),
    bottom: plane([50, 25, 0], [0, 0, -1]),
    left: plane([0, 25, 5], [-1, 0, 0]),
    front: plane([50, 0, 5], [0, -1, 0]),
  };
  const mate = (id: string, type: SolverMate["type"], a: SolverMate["a"]["geom"], b: SolverMate["b"]["geom"], extra: Partial<SolverMate> = {}): SolverMate => ({ id, type, a: { component: "base", geom: a }, b: { component: "top", geom: b }, ...extra });

  it("stacks one block on the other, flush at the left and front, by three coincident faces", () => {
    const r = solveMates(start(), new Set(["base"]), [
      mate("m1", "coincident", faces.top, faces.bottom),
      { ...mate("m2", "coincident", faces.left, faces.left), aligned: true },
      { ...mate("m3", "coincident", faces.front, faces.front), aligned: true },
    ]);
    expect(r.solved).toBe(true);
    expect(r.mates.every((m) => m.ok)).toBe(true);
    const top = written(r.placements.get("top")!);
    expect(near(top.at, [0, 0, 10], 1e-6)).toBe(true);
    expect(near(top.rotation, [0, 0, 0], 1e-5)).toBe(true);
    // The held one never moves.
    expect(written(r.placements.get("base")!)).toEqual({ at: [0, 0, 0], rotation: [0, 0, 0] });
  });

  it("holds a distance between faces, and a pin's axis in a hole's", () => {
    const d = solveMates(start(), new Set(["base"]), [mate("d", "distance", faces.top, faces.bottom, { value: 25 })]);
    expect(d.solved).toBe(true);
    const p = d.placements.get("top")!;
    // The bottom face of the top block is 25 above the base's top: z = 35 there.
    expect(pointTo(p, [50, 25, 0])[2]).toBeCloseTo(35, 6);

    const pin = solveMates(start(), new Set(["base"]), [
      mate("c", "concentric", axis([30, 25, 0], [0, 0, 1]), axis([5, 5, 0], [0, 0, 1])),
      mate("f", "coincident", faces.top, faces.bottom),
    ]);
    expect(pin.solved).toBe(true);
    const q = pin.placements.get("top")!;
    const at = pointTo(q, [5, 5, 0]);
    expect(near([at[0], at[1]], [30, 25], 1e-6)).toBe(true);
    expect(at[2]).toBeCloseTo(10, 6);
  });

  it("holds parallel, perpendicular and angle mates", () => {
    const par = solveMates(start(), new Set(["base"]), [mate("p", "parallel", faces.top, faces.top)]);
    expect(par.solved).toBe(true);
    const perp = solveMates(start(), new Set(["base"]), [mate("q", "perpendicular", faces.top, faces.top)]);
    expect(perp.solved).toBe(true);
    const ang = solveMates(start(), new Set(["base"]), [mate("a", "angle", faces.top, faces.top, { value: 30 })]);
    expect(ang.solved).toBe(true);
    const n = ang.placements.get("top")!.R.map((row) => row[2]);
    expect(Math.acos(n[2]) * (180 / Math.PI)).toBeCloseTo(30, 4);
  });

  it("says what can't be written, and leaves those mates out of the solve", () => {
    const r = solveMates(start(), new Set(["base"]), [mate("x", "concentric", faces.top, faces.bottom)]);
    expect(r.solved).toBe(false);
    expect(r.mates[0].problem).toMatch(/concentric takes two axes/);
  });

  it("reports mates that fight each other as not holding", () => {
    const r = solveMates(start(), new Set(["base"]), [mate("m1", "coincident", faces.top, faces.bottom), mate("m2", "distance", faces.top, faces.bottom, { value: 20 })]);
    expect(r.solved).toBe(false);
    expect(r.mates.some((m) => !m.ok)).toBe(true);
  });

  it("holds the first component when none is fixed", () => {
    const r = solveMates(start(), new Set(), [mate("m1", "coincident", faces.top, faces.bottom)]);
    expect(r.solved).toBe(true);
    expect(written(r.placements.get("base")!).at).toEqual([0, 0, 0]);
  });
});
