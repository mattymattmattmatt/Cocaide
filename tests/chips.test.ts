// A feature's picked edges and faces as short chips: one per edge or face
// found ("Straight · 120 mm", "Circle · R 3.3", "Flat · facing +Z"), a count
// with the kinds, and the selectors that find nothing (an upstream change
// broke them) listed apart, to re-pick or remove.

import { beforeAll, describe, expect, it } from "vitest";
import { loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { describeEdges, describeFaces, type EdgeInfo, type FaceInfo } from "../src/kernel/topology";
import { chipsSummary, edgeChips, faceChips } from "../src/ui/props/chips";

let oc: OC;
let faces: FaceInfo[];
let edges: EdgeInfo[];
beforeAll(async () => {
  oc = await loadOC();
  const doc = {
    version: 1,
    units: "mm",
    name: "plate",
    features: [
      { id: "sketch_1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 80, h: 40 }] },
      { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: 6 },
      { id: "hole_1", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [30, 0], diameter: 6.6, depth: "through" },
    ],
  };
  const r = rebuild(doc, oc);
  try {
    const t = scoped((s) => {
      const f = describeFaces(oc, s, r.solid!);
      return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
    });
    r.label(t);
    faces = t.faces;
    edges = t.edges;
  } finally {
    r.dispose();
  }
});

describe("chips", () => {
  it("one per edge a selector finds, in a few words, with a count by kind", () => {
    const value = [
      { type: "edge", kind: "line", direction: [1, 0, 0], pick: "all" },
      { type: "edge", kind: "circle", radius: 3.3, pick: "all" },
    ];
    const { chips, missing } = edgeChips(value, edges, faces, false);
    expect(missing).toEqual([]);
    expect(chips.filter((c) => c.text === "Straight · 80 mm")).toHaveLength(4);
    expect(chips.filter((c) => c.text === "Circle · R 3.3")).toHaveLength(2);
    expect(chipsSummary(chips, "edge")).toBe("6 edges: 4 straight, 2 circle");
    expect(chips[0].title).toMatch(/edges/);
  });

  it("a selector that finds nothing now is listed apart, by its place", () => {
    const value = [{ type: "edge", kind: "line", direction: [1, 0, 0], pick: "longest" }, { type: "edge", kind: "circle", radius: 9, pick: "all" }];
    const { chips, missing } = edgeChips(value, edges, faces, false);
    expect(chips.length).toBeGreaterThan(0);
    expect(missing.map((m) => m.at)).toEqual([1]);
  });

  it("faces: flat ones by the way they face, round ones by radius", () => {
    const { chips } = faceChips([{ type: "planar", normal: [0, 0, 1], pick: "largest" }, { type: "cylindrical", radius: 3.3, pick: "all" }], faces, false);
    expect(chips.map((c) => c.text)).toEqual(["Flat · facing +Z", "Round · R 3.3 (hole)"]);
    expect(chipsSummary(chips, "face")).toBe("2 faces: 1 flat, 1 round");
  });
});
