// Phase P: face and edge provenance. Every face and edge of the part knows
// the feature that made it and the features that changed it since, recorded
// by the rebuild (src/kernel/provenance.ts) by matching each feature's faces
// to the ones before it on the same surface.

import { beforeAll, describe, expect, it } from "vitest";
import { loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { boxOf, edgeSignature, inherit, overlap, type Snap } from "../src/kernel/provenance";
import { describeEdges, describeFaces, type EdgeInfo, type FaceInfo } from "../src/kernel/topology";
import { selectFaces } from "../src/kernel/selectors";
import { edgeSelectorFor, faceSelectorFor } from "../src/kernel/synthesize";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };

/** The bracket example: an 80 x 40 x 6 plate with a 6.6 mm through hole at x = 30. */
function bracket(...more: Record<string, unknown>[]) {
  return {
    version: 1,
    units: "mm",
    name: "bracket",
    features: [
      { id: "sketch_1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 80, h: 40 }] },
      { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: 6 },
      { id: "hole_1", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [30, 0], diameter: 6.6, depth: "through" },
      ...more,
    ],
  };
}

/** The part's faces and edges, each with its maker. */
function built(doc: unknown): { faces: FaceInfo[]; edges: EdgeInfo[]; errors: string[]; warnings: string[] } {
  const r = rebuild(doc, oc);
  try {
    if (!r.solid) return { faces: [], edges: [], errors: r.errors, warnings: r.warnings };
    const topo = scoped((s) => {
      const f = describeFaces(oc, s, r.solid!);
      return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
    });
    r.label(topo);
    return { ...topo, errors: r.errors, warnings: r.warnings };
  } finally {
    r.dispose();
  }
}

const near = (a: number[], b: number[]) => Math.hypot(...a.map((x, i) => x - b[i])) < 1e-6;
const facing = (faces: FaceInfo[], n: number[]) => faces.filter((f) => f.normal && near(f.normal, n));

describe("inherit (pure)", () => {
  const snap = (sig: string, lo: number[], hi: number[], size = 1): Snap => ({ sig, box: [lo, hi] as never, size, centroid: lo.map((x, i) => (x + hi[i]) / 2) as never });

  it("a face on the same surface overlapping one before it is carried on; one that changed size is modified", () => {
    const before = [{ ...snap("plane z6", [0, 0, 6], [10, 10, 6], 100), createdBy: "ext_1", modifiedBy: [] }];
    const [same] = inherit(before, [snap("plane z6", [0, 0, 6], [10, 10, 6], 100)], "hole_1");
    expect(same).toMatchObject({ createdBy: "ext_1", modifiedBy: [] });
    const [cut] = inherit(before, [snap("plane z6", [0, 0, 6], [10, 10, 6], 90)], "hole_1");
    expect(cut).toMatchObject({ createdBy: "ext_1", modifiedBy: ["hole_1"] });
  });

  it("a face elsewhere on the same plane (a pattern's copy) is new; a face on a new surface is new", () => {
    const before = [{ ...snap("plane z6", [0, 0, 6], [10, 10, 6], 100), createdBy: "boss", modifiedBy: [] }];
    const out = inherit(before, [snap("plane z6", [0, 0, 6], [10, 10, 6], 100), snap("plane z6", [30, 0, 6], [40, 10, 6], 100), snap("cyl", [0, 0, 0], [1, 1, 6], 5)], "pattern");
    expect(out.map((r) => r.createdBy)).toEqual(["boss", "pattern", "pattern"]);
  });

  it("boxes touch within a tenth of a micron", () => {
    expect(overlap(boxOf([[0, 0, 0], [1, 1, 0]]), boxOf([[1, 0, 0], [2, 1, 0]]))).toBeGreaterThan(0);
    expect(overlap(boxOf([[0, 0, 0], [1, 1, 0]]), boxOf([[1.01, 0, 0], [2, 1, 0]]))).toBe(0);
  });

  it("an edge's signature is its line or circle, not its ends", () => {
    const line = (start: number[], end: number[]): EdgeInfo => ({ index: 0, kind: "line", length: 1, start, end, mid: start, centroid: start, direction: [1, 0, 0], faces: [], seam: false }) as unknown as EdgeInfo;
    expect(edgeSignature(line([0, 0, 0], [10, 0, 0]))).toBe(edgeSignature(line([5, 0, 0], [20, 0, 0])));
    expect(edgeSignature(line([0, 1, 0], [10, 1, 0]))).not.toBe(edgeSignature(line([0, 0, 0], [10, 0, 0])));
  });
});

describe("provenance on known parts", () => {
  it("the bracket: the hole made its wall and its two circular edges; it changed the top and bottom faces, not the sides", () => {
    const { faces, edges, errors } = built(bracket());
    expect(errors).toEqual([]);
    const wall = faces.filter((f) => f.type === "cylinder");
    expect(wall.length).toBe(1);
    expect(wall[0].createdBy).toBe("hole_1");
    for (const n of [[0, 0, 1], [0, 0, -1]]) {
      const [f] = facing(faces, n);
      expect(f.createdBy).toBe("ext_1");
      expect(f.modifiedBy).toEqual(["hole_1"]);
    }
    const sides = faces.filter((f) => f.normal && Math.abs(f.normal[2]) < 1e-9);
    expect(sides.length).toBe(4);
    for (const f of sides) expect(f).toMatchObject({ createdBy: "ext_1" }), expect(f.modifiedBy).toBeUndefined();
    const circles = edges.filter((e) => e.kind === "circle");
    expect(circles.length).toBe(2);
    expect(circles.every((e) => e.createdBy === "hole_1")).toBe(true);
    expect(edges.filter((e) => e.kind === "line" && !e.seam).every((e) => e.createdBy === "ext_1")).toBe(true);
  });

  it("after a fillet of the hole's top edge: the round face is the fillet's, the wall and the top were changed by it", () => {
    const fillet = { id: "fillet_1", op: "fillet", edges: { type: "edge", kind: "circle", radius: 3.3, onFace: { type: "planar", normal: [0, 0, 1], pick: "largest" }, pick: "all" }, radius: 1 };
    const { faces, edges, errors } = built(bracket(fillet));
    expect(errors).toEqual([]);
    const round = faces.filter((f) => f.type === "other");
    expect(round.length).toBe(1);
    expect(round[0].createdBy).toBe("fillet_1");
    const wall = faces.find((f) => f.type === "cylinder")!;
    expect(wall).toMatchObject({ createdBy: "hole_1", modifiedBy: ["fillet_1"] });
    const [top] = facing(faces, [0, 0, 1]);
    expect(top).toMatchObject({ createdBy: "ext_1", modifiedBy: ["hole_1", "fillet_1"] });
    // The two circles where the round meets the top and the wall are the fillet's; the bottom circle is still the hole's.
    const circles = edges.filter((e) => e.kind === "circle" && !e.seam);
    expect(circles.filter((e) => e.createdBy === "fillet_1").length).toBe(2);
    expect(circles.filter((e) => e.createdBy === "hole_1").length).toBe(1);
  });

  it("a linear pattern's copies are the pattern's", () => {
    const pattern = { id: "pattern_1", op: "linearPattern", feature: "hole_1", direction: [-1, 0, 0], spacing: 20, count: 3 };
    const { faces, errors } = built(bracket(pattern));
    expect(errors).toEqual([]);
    const walls = faces.filter((f) => f.type === "cylinder");
    expect(walls.map((f) => f.createdBy).sort()).toEqual(["hole_1", "pattern_1", "pattern_1"]);
  });

  it("a boss: its sides and top are its own; a mirror's copy of it is the mirror's", () => {
    const boss = [
      { id: "sketch_2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] }, entities: [{ id: "c", type: "circle", center: [-15, 0], radius: 5 }] },
      { id: "boss", op: "extrude", sketch: "sketch_2", distance: 10 },
      { id: "mirror_1", op: "mirror", feature: "boss", plane: { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] } },
    ];
    const { faces, errors } = built(bracket(...boss));
    expect(errors).toEqual([]);
    const tops = facing(faces, [0, 0, 1]).filter((f) => Math.abs(f.centroid[2] - 16) < 1e-6);
    expect(tops.map((f) => [Math.sign(f.centroid[0]), f.createdBy]).sort()).toEqual([[-1, "boss"], [1, "mirror_1"]]);
    const plateTop = facing(faces, [0, 0, 1]).find((f) => Math.abs(f.centroid[2] - 6) < 1e-6)!;
    expect(plateTop).toMatchObject({ createdBy: "ext_1", modifiedBy: ["hole_1", "boss", "mirror_1"] });
  });

  it("a registry op (shell) and a revolve record theirs too", () => {
    const shell = { id: "shell_1", op: "shell", faces: [{ type: "planar", normal: [0, 0, 1], pick: "largest" }], thickness: 1 };
    const s = built({ ...bracket(), features: bracket().features.slice(0, 2).concat([shell]) });
    expect(s.errors).toEqual([]);
    expect(s.faces.filter((f) => f.createdBy === "shell_1").length).toBe(5);
    const revolve = {
      version: 1,
      units: "mm",
      name: "r",
      features: [
        { id: "s", op: "sketch", plane: { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [10, 5], w: 4, h: 10 }] },
        { id: "rev", op: "revolve", sketch: "s", axis: { datum: "Z" } },
      ],
    };
    const r = built(revolve);
    expect(r.errors).toEqual([]);
    expect(r.faces.every((f) => f.createdBy === "rev")).toBe(true);
  });

  it("faceOrigins (the agent's list) reads the same makers", () => {
    const r = rebuild(bracket(), oc, { provenance: true });
    try {
      expect(new Set(r.faceOrigins)).toEqual(new Set(["ext_1", "hole_1"]));
    } finally {
      r.dispose();
    }
  });
});

describe("selectors and the synthesizer use provenance", () => {
  /** Two holes the same size: a selector can tell them apart by who made them. */
  const twoHoles = (x2: [number, number] = [-30, 0], d2 = 6.6, ...more: Record<string, unknown>[]) =>
    bracket({ id: "hole_2", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: x2, diameter: d2, depth: "through" }, ...more);

  it("createdBy narrows a selector to the faces that feature made", () => {
    const { faces } = built(twoHoles());
    expect(selectFaces(faces, { type: "cylindrical", radius: 3.3, pick: "all" }).matches.length).toBe(2);
    const mine = selectFaces(faces, { type: "cylindrical", radius: 3.3, pick: "all", createdBy: "hole_2" }).matches;
    expect(mine.length).toBe(1);
    expect(mine[0].centroid[0]).toBeCloseTo(-30, 6);
  });

  it("a picked face's selector names its maker and keeps a hint of where it was", () => {
    const { faces } = built(twoHoles());
    const wall = faces.find((f) => f.type === "cylinder" && f.createdBy === "hole_2")!;
    const s = faceSelectorFor(faces, wall.index);
    expect(s.ok && s.selector).toMatchObject({ type: "cylindrical", createdBy: "hole_2", hint: { centroid: [-30, 0, 3] } });
  });

  it("a picked edge's selector names its maker; the faces nested in it name theirs without a hint", () => {
    const { faces, edges } = built(twoHoles());
    const top = edges.find((e) => e.kind === "circle" && e.createdBy === "hole_2" && Math.abs(e.centroid[2] - 6) < 1e-6)!;
    const s = edgeSelectorFor(edges, faces, top.index);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.selector.createdBy).toBe("hole_2");
    expect(s.selector.hint?.centroid).toEqual([-30, 0, 6]);
    expect(s.selector.onFace?.hint).toBeUndefined();
  });
});
