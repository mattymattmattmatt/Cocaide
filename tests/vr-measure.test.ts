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
  it("names a face short, with its size", () => {
    expect(faceName(cyl(0, 6, [0, 0, 0]))).toBe("Ø12 hole");
    expect(faceName(cyl(0, 20, [0, 0, 0], false))).toBe("Ø40 round");
    expect(faceName(cyl(0, 5, [0, 0, 0], true, Math.PI / 2))).toBe("R5 fillet");
    expect(faceName(plane(0, [0, 0, 1], [0, 0, 0]))).toBe("flat face");
  });
  it("a hole: its diameter big, its depth under it; a flat face: its area and how it lies", () => {
    expect(faceCard(cyl(0, 3.3, [0, 0, 0]))).toEqual({ value: "Ø6.6", caption: "hole · 30 mm deep", title: "Ø6.6 hole · 30 mm deep" });
    expect(faceCard(plane(0, [0, 0, 1], [0, 0, 0], 3_200_000))).toMatchObject({ value: "3.20 m²", caption: "flat · level" });
    expect(faceCard(plane(0, [1, 0, 0], [0, 0, 0], 2500))).toMatchObject({ value: "25 cm²", caption: "flat · plumb" });
  });
  it("two parallel flat faces: the gap square to them, drawn", () => {
    const c = pairCard({ index: 0, face: plane(0, [0, 0, 1], [0, 0, 6]) }, { index: 1, face: plane(1, [0, 0, -1], [0, 0, 0]) }, { distance: 6, a: [0, 0, 6], b: [0, 0, 0] });
    expect([c.value, c.caption]).toEqual(["6 mm", "gap"]);
    expect(c.line).toBeDefined();
  });
  it("two holes: centre to centre, and wall to wall", () => {
    const c = pairCard({ index: 0, face: cyl(0, 3, [0, 0, 0]) }, { index: 1, face: cyl(1, 3, [50, 0, 0]) }, { distance: 44, a: [3, 0, 10], b: [47, 0, 10] });
    expect([c.value, c.caption]).toEqual(["50 mm", "centres · 44 mm wall to wall"]);
  });
  it("faces at an angle: the closest points and the angle", () => {
    const c = pairCard({ index: 0, face: plane(0, [0, 0, 1], [0, 0, 0]) }, { index: 1, face: plane(1, [1, 0, 0], [100, 0, 50]) }, { distance: 1250, a: [0, 0, 0], b: [1250, 0, 0] });
    expect([c.value, c.caption]).toEqual(["1,250 mm", "closest · 90°"]);
    expect(c.line).toEqual({ from: [0, 0, 0], to: [1250, 0, 0] });
  });
  it("drawn from the point clicked on the first face, not wherever the two come closest", () => {
    // Parallel walls 1000 apart: from the click straight across.
    const g = pairCard({ index: 0, face: plane(0, [0, 1, 0], [0, 0, 0]) }, { index: 1, face: plane(1, [0, -1, 0], [0, 1000, 0]) }, { distance: 1000, a: [5000, 0, 100], b: [5000, 1000, 100] }, { at: [200, 0, 1400] });
    expect(g.value).toBe("1,000 mm");
    expect(g.line).toEqual({ from: [200, 0, 1400], to: [200, 1000, 1400] });
    // Two holes: across from the first axis, level with the click.
    const h = pairCard({ index: 0, face: cyl(0, 3, [0, 0, 0]) }, { index: 1, face: cyl(1, 3, [50, 0, 0]) }, { distance: 44, a: [3, 0, 0], b: [47, 0, 0] }, { at: [3, 0, 22] });
    expect(h.line).toEqual({ from: [0, 0, 22], to: [50, 0, 22] });
    // Faces at an angle: from the click to the second face's nearest point, the closest of all said too.
    const c = pairCard({ index: 0, face: plane(0, [0, 0, 1], [0, 0, 0]) }, { index: 1, face: plane(1, [1, 0, 0], [100, 0, 50]) }, { distance: 100, a: [0, 0, 0], b: [100, 0, 0] }, { at: [-400, 0, 0], onB: [100, 0, 0] });
    expect([c.value, c.caption]).toEqual(["500 mm", "from here · closest 100 mm · 90°"]);
    expect(c.line).toEqual({ from: [-400, 0, 0], to: [100, 0, 0] });
  });
  it("lengths: tenths under 100 mm, whole mm, then metres from 10 m", () => {
    expect([mm(6.25), mm(245.4), mm(2450), mm(12400)]).toEqual(["6.3 mm", "245 mm", "2,450 mm", "12.40 m"]);
  });
});
