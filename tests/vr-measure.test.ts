// VR's Faces measure: what a face is (a hole's diameter and depth, a fillet's radius, a flat face's area and lie)
// and what two faces are to each other (the gap between parallel faces, hole centres, the closest points, the angle).

import { describe, expect, it } from "vitest";
import type { FaceInfo } from "../src/kernel/topology";
import { faceCard, faceName, mm, pairCard } from "../src/ui/vr/vrMeasure";

const plane = (index: number, normal: [number, number, number], point: [number, number, number], area = 2500): FaceInfo => ({ index, type: "plane", area, centroid: point, normal, point, offset: 0 });
const cyl = (index: number, radius: number, origin: [number, number, number], concave = true, span = 2 * Math.PI, axial: [number, number] = [0, 30]): FaceInfo => ({
  index,
  type: "cylinder",
  area: 2 * Math.PI * radius * 30,
  centroid: origin,
  cylinder: { radius, axis: [0, 0, 1], origin, concave, span, axial },
});

describe("VR face measure", () => {
  it("names a face with its size", () => {
    expect(faceName(cyl(0, 6, [0, 0, 0]))).toBe("Hole Ø12");
    expect(faceName(cyl(0, 20, [0, 0, 0], false))).toBe("Round Ø40");
    expect(faceName(cyl(0, 5, [0, 0, 0], true, Math.PI / 2))).toBe("Fillet R5");
    expect(faceName(plane(0, [0, 0, 1], [0, 0, 0]))).toBe("Flat face");
  });
  it("a hole: its diameter and depth; a flat face: its area and how it lies", () => {
    expect(faceCard(cyl(0, 3.3, [0, 0, 0]))).toEqual({ title: "Hole Ø6.6", lines: ["Depth 30 mm · radius 3.3 mm"] });
    expect(faceCard(plane(0, [0, 0, 1], [0, 0, 0], 3_200_000))).toEqual({ title: "Flat face", lines: ["Area 3.20 m²", "Level, facing up"] });
    expect(faceCard(plane(0, [1, 0, 0], [0, 0, 0], 2500)).lines).toEqual(["Area 25 cm²", "Upright (plumb)"]);
  });
  it("two parallel flat faces: the gap square to them, drawn", () => {
    const c = pairCard({ index: 0, face: plane(0, [0, 0, 1], [0, 0, 6]) }, { index: 1, face: plane(1, [0, 0, -1], [0, 0, 0]) }, { distance: 6, a: [0, 0, 6], b: [0, 0, 0] });
    expect(c.title).toBe("Gap 6 mm");
    expect(c.line?.label).toBe("6 mm");
    expect(c.lines.at(-1)).toBe("Flat face → Flat face");
  });
  it("two holes: centre to centre, and wall to wall", () => {
    const c = pairCard({ index: 0, face: cyl(0, 3, [0, 0, 0]) }, { index: 1, face: cyl(1, 3, [50, 0, 0]) }, { distance: 44, a: [3, 0, 10], b: [47, 0, 10] });
    expect(c.title).toBe("Centres 50 mm");
    expect(c.lines).toContain("Wall to wall 44 mm");
  });
  it("faces at an angle: the closest points and the angle", () => {
    const c = pairCard({ index: 0, face: plane(0, [0, 0, 1], [0, 0, 0]) }, { index: 1, face: plane(1, [1, 0, 0], [100, 0, 50]) }, { distance: 1250, a: [0, 0, 0], b: [1250, 0, 0] });
    expect(c.title).toBe("Closest 1,250 mm (1.25 m)");
    expect(c.lines).toContain("Angle 90°");
    expect(c.line).toEqual({ from: [0, 0, 0], to: [1250, 0, 0], label: "1,250 mm (1.25 m)" });
  });
  it("lengths: tenths under 100 mm, whole mm, then metres", () => {
    expect([mm(6.25), mm(245.4), mm(2450)]).toEqual(["6.3 mm", "245 mm", "2,450 mm (2.45 m)"]);
  });
});
