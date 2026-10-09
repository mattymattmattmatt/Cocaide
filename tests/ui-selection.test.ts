// Selecting in the 3D view, as SOLIDWORKS does it: a plain click selects one
// face or edge, Ctrl- or Shift-click adds one or takes it out again, faces and
// edges mix, and the chip over the view says what is selected.

import { describe, expect, it } from "vitest";
import type { EdgeInfo, FaceInfo } from "../src/kernel/topology";
import { EMPTY_SELECTION, pickInto, selectionText, type PickTarget, type Selection } from "../src/ui/model/selection";

const face = (index: number, point: [number, number, number] = [index, 0, 0]): PickTarget => ({ kind: "face", index, point });
const edge = (index: number): PickTarget => ({ kind: "edge", index, point: [0, 0, 0] });
const clicks = (...steps: [PickTarget | null, boolean][]): Selection => steps.reduce((sel, [t, add]) => pickInto(sel, t, add), EMPTY_SELECTION);

describe("picking", () => {
  it("a plain click selects that one face or edge; on empty space it clears", () => {
    expect(clicks([face(3), false])).toEqual({ faces: [3], edges: [], point: [3, 0, 0] });
    expect(clicks([face(3), false], [edge(5), false])).toEqual({ faces: [], edges: [5] });
    expect(clicks([edge(5), false], [face(2), false])).toEqual({ faces: [2], edges: [], point: [2, 0, 0] });
    expect(clicks([face(3), false], [null, false])).toEqual(EMPTY_SELECTION);
  });

  it("Ctrl- or Shift-click adds faces, and the point is where the last face was clicked", () => {
    expect(clicks([face(1), false], [face(4), true], [face(6), true])).toEqual({ faces: [1, 4, 6], edges: [], point: [6, 0, 0] });
  });

  it("Ctrl-clicking a selected face takes it out; the last one out takes its point with it", () => {
    expect(clicks([face(1), false], [face(4), true], [face(1), true])).toEqual({ faces: [4], edges: [], point: [4, 0, 0] });
    expect(clicks([face(1), false], [face(1), true])).toEqual({ faces: [], edges: [] });
  });

  it("faces and edges mix: an added edge keeps the faces, an added face keeps the edges", () => {
    expect(clicks([face(1), false], [edge(7), true])).toEqual({ faces: [1], edges: [7], point: [1, 0, 0] });
    expect(clicks([edge(7), false], [face(2), true], [edge(8), true], [edge(7), true])).toEqual({ faces: [2], edges: [8], point: [2, 0, 0] });
  });

  it("an additive click on empty space keeps the selection", () => {
    const sel = clicks([face(1), false], [edge(2), true]);
    expect(pickInto(sel, null, true)).toBe(sel);
  });
});

describe("the selection chip", () => {
  const faces: FaceInfo[] = [
    { index: 0, type: "plane", area: 3200, centroid: [0, 0, 6], normal: [0, 0, 1], point: [0, 0, 6], offset: 6 },
    { index: 1, type: "cylinder", area: 124.4, centroid: [30, 0, 3], cylinder: { radius: 3.3, axis: [0, 0, 1], origin: [30, 0, 0], concave: true, span: 2 * Math.PI, axial: [0, 6] }, body: "base" },
  ];
  const edges: EdgeInfo[] = [{ index: 0, kind: "line", length: 80, start: [-40, -20, 6], end: [40, -20, 6], mid: [0, -20, 6], centroid: [0, -20, 6], direction: [1, 0, 0], faces: [0], seam: false }];

  it("describes one face or one edge, and counts more", () => {
    expect(selectionText({ faces: [0], edges: [] }, faces, edges)).toBe("planar face · normal +Z · offset 6");
    expect(selectionText({ faces: [1], edges: [] }, faces, edges)).toBe("cylindrical face of base · Ø6.6 · hole wall");
    expect(selectionText({ faces: [], edges: [0] }, faces, edges)).toBe("straight edge · +X · length 80");
    expect(selectionText({ faces: [0, 1, 2], edges: [] }, faces, edges)).toBe("3 faces");
    expect(selectionText({ faces: [0, 1], edges: [0] }, faces, edges)).toBe("2 faces + 1 edge");
    expect(selectionText({ faces: [], edges: [0, 1] }, faces, edges)).toBe("2 edges");
    expect(selectionText(EMPTY_SELECTION, faces, edges)).toBe("");
  });
});
