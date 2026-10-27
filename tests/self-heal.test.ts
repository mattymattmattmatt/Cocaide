// Phase P: self-healing references. A selector made from a pick keeps a hint
// of where its face or edge was; when an upstream edit leaves it matching
// nothing (or several), the rebuild finds it again near where it was, made by
// the same feature, uses it and warns; when it cannot tell, it fails and
// lists the candidates.

import { beforeAll, describe, expect, it } from "vitest";
import { loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { describeEdges, describeFaces, type EdgeInfo, type FaceInfo } from "../src/kernel/topology";
import { edgeSelectorFor, faceSelectorFor } from "../src/kernel/synthesize";
import { rankByHint, selectEdges, selectFaces, selectionError } from "../src/kernel/selectors";
import type { EdgeSelector, FaceSelector } from "../src/doc/types";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };

function doc(features: Record<string, unknown>[]) {
  return { version: 1, units: "mm", name: "heal", features };
}

/** A w x 40 x h block (and more features). */
const block = (h: number, w = 80, ...more: Record<string, unknown>[]) =>
  doc([{ id: "sketch_1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w, h: 40 }] }, { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: h }, ...more]);

function topology(d: unknown): { faces: FaceInfo[]; edges: EdgeInfo[] } {
  const r = rebuild(d, oc);
  try {
    const topo = scoped((s) => {
      const f = describeFaces(oc, s, r.solid!);
      return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
    });
    r.label(topo);
    return topo;
  } finally {
    r.dispose();
  }
}

function run(d: unknown) {
  const r = rebuild(d, oc);
  try {
    return { errors: r.errors, warnings: r.warnings, features: r.features, volume: r.measurements?.volume ?? 0 };
  } finally {
    r.dispose();
  }
}

describe("a taller block keeps its up-to face", () => {
  it("an extrude up to the block's top face, picked at 10 mm, follows the top to 20 mm with a warning", () => {
    const { faces } = topology(block(10));
    const top = faces.find((f) => f.normal?.[2] === 1)!;
    // As written from a pick on a part where its offset told it apart (the form that breaks when the face moves).
    const picked = faceSelectorFor(faces, top.index);
    expect(picked.ok).toBe(true);
    const upTo: FaceSelector = { type: "planar", normal: [0, 0, 1], offset: 10, pick: "largest", createdBy: "ext_1", hint: (picked as { selector: FaceSelector }).selector.hint };
    const post = [
      { id: "sketch_2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "c", type: "circle", center: [60, 0], radius: 5 }] },
      { id: "post", op: "extrude", sketch: "sketch_2", extent: "upToFace", upTo: { face: upTo }, newBody: "post" },
    ];
    const before = run(block(10, 80, ...post));
    expect(before.errors).toEqual([]);
    expect(before.warnings).toEqual([]);
    const taller = run(block(20, 80, ...post));
    expect(taller.errors).toEqual([]);
    expect(taller.warnings).toEqual(["post: a face moved — re-found it (check)"]);
    const status = taller.features.find((f) => f.id === "post")!;
    expect(status.heals?.[0]).toMatchObject({ kind: "face", matched: 0, was: [0, 0, 10], now: [0, 0, 20] });
    // Accept writes a selector for where it is now: it no longer needs healing.
    expect(status.heals?.[0].healed).toMatchObject({ type: "planar", normal: [0, 0, 1], createdBy: "ext_1", hint: { centroid: [0, 0, 20] } });
    // The post reaches the new top: 20 mm tall, π·5²·20.
    expect(taller.volume - 80 * 40 * 20).toBeCloseTo(Math.PI * 25 * 20, 3);
  });
});

describe("a hole moved along a face keeps its fillet edge", () => {
  /** A plate with two 6.6 mm holes made by two features, the second at `at`, and a fillet on the second's top edge. */
  const plate = (at: [number, number], d = 6.6, edges?: EdgeSelector) =>
    block(6, 80, { id: "hole_1", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [30, 0], diameter: 6.6, depth: "through" }, { id: "hole_2", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: at, diameter: d, depth: "through" }, ...(edges ? [{ id: "fillet_2", op: "fillet", edges, radius: 1 }] : []));

  const pickedEdge = (): EdgeSelector => {
    const { faces, edges } = topology(plate([-30, 0]));
    const e = edges.find((x) => x.kind === "circle" && x.createdBy === "hole_2" && Math.abs(x.centroid[2] - 6) < 1e-6)!;
    const s = edgeSelectorFor(edges, faces, e.index);
    if (!s.ok) throw new Error(s.error);
    return s.selector;
  };

  it("the selector picked names hole_2: moving the hole along the face, the fillet stays on it, quietly", () => {
    const sel = pickedEdge();
    expect(sel.createdBy).toBe("hole_2");
    const moved = run(plate([-10, 8], 6.6, sel));
    expect(moved.errors).toEqual([]);
    const { faces } = topology(plate([-10, 8], 6.6, sel));
    const round = faces.filter((f) => f.createdBy === "fillet_2");
    expect(round.length).toBe(1);
    expect(round[0].centroid[0]).toBeCloseTo(-10, 3);
    expect(round[0].centroid[1]).toBeCloseTo(8, 3);
  });

  it("when the hole also changes size, the edge (radius 3.3 no more) is re-found with a warning", () => {
    const sel = pickedEdge();
    const changed = run(plate([-10, 8], 8, sel));
    expect(changed.errors).toEqual([]);
    expect(changed.warnings).toEqual(["fillet_2: an edge moved — re-found it (check)"]);
    const heal = changed.features.find((f) => f.id === "fillet_2")!.heals![0];
    expect(heal.now[0]).toBeCloseTo(-10, 6);
    expect((heal.healed as EdgeSelector).radius).toBe(4);
  });
});

describe("an ambiguous case fails clearly", () => {
  it("a hole wall picked between two holes that are now equally near is not guessed: the error lists both", () => {
    const holes = (x: number) =>
      block(6, 80, { id: "hole_1", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, centers: [[-x, 0], [x, 0]], diameter: 6.6, depth: "through" });
    const { faces } = topology(holes(10));
    const sel: FaceSelector = { type: "cylindrical", radius: 3.3, pick: "all", hint: { centroid: [0, 0, 3], size: 62.2 } };
    const r = selectFaces(faces, sel);
    expect(r.healed).toBeUndefined();
    expect(r.unhealed?.length).toBe(2);
    const text = selectionError(sel, r, 1)!;
    expect(text).toContain("it matches 2 faces now");
    expect(text).toContain("[-10, 0, 3]");
    expect(text).toContain("[10, 0, 3]");
    expect(text).toContain("re-pick it");
  });

  it("a fillet whose edge is gone and has two equal candidates fails, naming them", () => {
    const sel: EdgeSelector = { type: "edge", kind: "line", direction: [0, 1, 0], length: 40, pick: "all", hint: { centroid: [0, 0, 6], normal: [0, 1, 0], size: 40 } };
    const r = run(block(6, 80, { id: "fillet_1", op: "fillet", edges: sel, radius: 1 }));
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatch(/^fillet_1: .*could not tell which edge it is now/);
  });

  it("edges: a clear winner is used, in place and direction", () => {
    const { faces, edges } = topology(block(6, 100));
    // Picked as the top front edge of an 80 mm block: its length no longer matches; it is still the top front edge.
    const sel: EdgeSelector = { type: "edge", kind: "line", direction: [1, 0, 0], length: 80, pick: "all", hint: { centroid: [0, -20, 6], normal: [1, 0, 0], size: 80 } };
    const r = selectEdges(edges, faces, sel);
    expect(r.healed?.matched).toBe(0);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].centroid).toEqual([expect.closeTo(0, 6), expect.closeTo(-20, 6), expect.closeTo(6, 6)]);
  });

  it("ranking: nearer, same direction, same size first", () => {
    const items = [
      { index: 0, centroid: [0, 0, 10] as [number, number, number] },
      { index: 1, centroid: [0, 0, 0] as [number, number, number] },
    ];
    const ranked = rankByHint(items, { centroid: [0, 0, 1], size: 100 }, () => undefined, () => 100, false, true);
    expect(ranked.map((c) => c.index)).toEqual([1, 0]);
    expect(ranked[0].score).toBeCloseTo(1 / 20, 9);
  });
});
