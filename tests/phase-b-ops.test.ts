// Phase B kernel operations: suppression, fillet, chamfer, patterns, edge selectors.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { CocaideDocument, FaceSelector, Feature } from "../src/doc/types";
import { exportSTEP, importSTEP, loadOC, rebuild, scoped, volumeOf, type OC } from "../src/kernel";
import { isValidShape } from "../src/kernel/measure";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as CocaideDocument;
const HOLE = Math.PI * 3.3 ** 2 * 6;
const PLATE = 80 * 40 * 6;
const TOP: FaceSelector = { type: "planar", normal: [0, 0, 1], pick: "largest" };

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function withFeatures(...extra: Feature[]): CocaideDocument {
  return { ...structuredClone(bracket), features: [...structuredClone(bracket.features), ...extra] };
}

function build(doc: CocaideDocument) {
  const r = rebuild(doc, oc);
  const out = { ...r, volume: r.measurements?.volume ?? 0 };
  r.dispose();
  return out;
}

describe("suppression", () => {
  it("skips a suppressed hole and reports it as suppressed, not failed", () => {
    const doc = structuredClone(bracket);
    doc.features[2].suppressed = true;
    const r = build(doc);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.volume).toBeCloseTo(PLATE, 6);
    expect(r.features[2]).toEqual({ id: "hole_1", op: "hole", ok: true, suppressed: true });
  });

  it("names the suppressed sketch when a feature depends on it", () => {
    const doc = structuredClone(bracket);
    doc.features[0].suppressed = true;
    const r = build(doc);
    expect(r.errors).toEqual([
      'ext_1: sketch "sketch_1" is suppressed, so there is no profile to extrude',
      "hole_1: nothing to drill: there is no solid before this feature",
    ]);
  });
});

describe("fillet and chamfer", () => {
  it("rounds the four vertical corners", () => {
    const r = build(
      withFeatures({ id: "fil_1", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" }, radius: 5 }),
    );
    expect(r.errors).toEqual([]);
    const corner = (1 - Math.PI / 4) * 25 * 6;
    expect(r.volume).toBeCloseTo(PLATE - HOLE - 4 * corner, 6);
  });

  it("chamfers the single edge between the top face and the +X face", () => {
    const r = build(
      withFeatures({
        id: "ch_1",
        op: "chamfer",
        edges: { type: "edge", between: [TOP, { type: "planar", normal: [1, 0, 0], pick: "largest" }], pick: "all" },
        distance: 1,
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(PLATE - HOLE - 0.5 * 1 * 1 * 40, 6);
  });

  it("fillets the top edge of the hole (Pappus: spandrel area x centroid path)", () => {
    const r = build(
      withFeatures({
        id: "fil_1",
        op: "fillet",
        edges: { type: "edge", kind: "circle", radius: 3.3, onFace: TOP, pick: "all" },
        radius: 0.5,
      }),
    );
    expect(r.errors).toEqual([]);
    const f = 0.5;
    const area = (1 - Math.PI / 4) * f * f;
    const centroid = ((10 - 3 * Math.PI) / (3 * (4 - Math.PI))) * f; // from the edge into the material
    expect(r.volume).toBeCloseTo(PLATE - HOLE - area * 2 * Math.PI * (3.3 + centroid), 6);
  });

  it("combines a list of edge selectors", () => {
    const r = build(
      withFeatures({
        id: "fil_1",
        op: "fillet",
        edges: [
          { type: "edge", between: [TOP, { type: "planar", normal: [1, 0, 0], pick: "largest" }], pick: "all" },
          { type: "edge", between: [TOP, { type: "planar", normal: [-1, 0, 0], pick: "largest" }], pick: "all" },
        ],
        radius: 1,
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(PLATE - HOLE - 2 * (1 - Math.PI / 4) * 40, 6);
  });

  it("exports a filleted part that reimports as the same valid solid", () => {
    const r = rebuild(
      withFeatures({ id: "fil_1", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" }, radius: 5 }),
      oc,
    );
    try {
      const back = importSTEP(oc, exportSTEP(oc, r.solid!, "filleted"));
      scoped((s) => {
        expect(isValidShape(oc, s, back)).toBe(true);
        expect(volumeOf(oc, s, back)).toBeCloseTo(r.measurements!.volume, 6);
      });
      back.delete();
    } finally {
      r.dispose();
    }
  });

  it("reports an edge selector that matches nothing", () => {
    const r = build(
      withFeatures({ id: "fil_1", op: "fillet", edges: { type: "edge", kind: "circle", radius: 9, pick: "all" }, radius: 1 }),
    );
    expect(r.errors).toEqual(["fil_1: edges: selector matched 0 edges (wanted circle edges radius 9)"]);
    expect(r.volume).toBeCloseTo(PLATE - HOLE, 6);
  });

  it("reports a tie instead of choosing an edge", () => {
    const r = build(
      withFeatures({ id: "fil_1", op: "fillet", edges: { type: "edge", kind: "line", pick: "longest" }, radius: 1 }),
    );
    expect(r.errors).toEqual(["fil_1: edges: selector matched 4 edges tied for longest (wanted 1 of line edges (longest))"]);
  });

  it("reports a nested face selector that cannot resolve", () => {
    const r = build(
      withFeatures({
        id: "fil_1",
        op: "fillet",
        edges: { type: "edge", onFace: { type: "planar", normal: [1, 1, 0], pick: "all" }, pick: "all" },
        radius: 1,
      }),
    );
    expect(r.errors).toEqual(["fil_1: edges.onFace: selector matched 0 faces (wanted 1 planar face normal [0.7071, 0.7071, 0] or more)"]);
  });

  it("turns a kernel failure into an error, not a crash", () => {
    const r = build(
      withFeatures({ id: "fil_1", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" }, radius: 30 }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^fil_1: /);
    expect(r.volume).toBeCloseTo(PLATE - HOLE, 6);
  });
});

describe("patterns", () => {
  it("repeats a hole along a line", () => {
    const r = build(
      withFeatures({ id: "lp_1", op: "linearPattern", feature: "hole_1", direction: [-1, 0, 0], spacing: 20, count: 4 }),
    );
    expect(r.errors).toEqual([]);
    expect(r.measurements!.holeCount).toBe(4);
    expect(r.volume).toBeCloseTo(PLATE - 4 * HOLE, 6);
    const xs = r.measurements!.holes.map((h) => Math.round(h.axisPoint[0])).sort((a, b) => a - b);
    expect(xs).toEqual([-30, -10, 10, 30]);
  });

  it("repeats a hole on a grid", () => {
    const doc = structuredClone(bracket);
    (doc.features[2] as Extract<Feature, { op: "hole" }>).center = [30, -10];
    doc.features.push({
      id: "lp_1",
      op: "linearPattern",
      feature: "hole_1",
      direction: [-1, 0, 0],
      spacing: 60,
      count: 2,
      direction2: [0, 1, 0],
      spacing2: 20,
      count2: 2,
    });
    const r = build(doc);
    expect(r.errors).toEqual([]);
    expect(r.measurements!.holeCount).toBe(4);
    expect(r.volume).toBeCloseTo(PLATE - 4 * HOLE, 6);
  });

  it("repeats a hole about an axis", () => {
    const r = build(
      withFeatures({ id: "cp_1", op: "circularPattern", feature: "hole_1", axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: 2 }),
    );
    expect(r.errors).toEqual([]);
    const xs = r.measurements!.holes.map((h) => Math.round(h.axisPoint[0])).sort((a, b) => a - b);
    expect(xs).toEqual([-30, 30]);
  });

  it("names the instance that falls off the part", () => {
    const r = build(
      withFeatures({ id: "cp_1", op: "circularPattern", feature: "hole_1", axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: 4 }),
    );
    expect(r.errors).toEqual(["cp_1: instance 2 (90 deg) removes no material"]);
    expect(r.measurements!.holeCount).toBe(1);
  });

  it("spreads a partial circular pattern over the given angle", () => {
    const r = build(
      withFeatures({
        id: "cp_1",
        op: "circularPattern",
        feature: "hole_1",
        axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
        count: 2,
        angle: 180,
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.measurements!.holeCount).toBe(2);
  });

  it("repeats a boss", () => {
    const r = build(
      withFeatures(
        {
          id: "s2",
          op: "sketch",
          plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] },
          entities: [{ id: "c", type: "circle", center: [-30, 0], radius: 4 }],
        },
        { id: "boss", op: "extrude", sketch: "s2", distance: 5 },
        { id: "lp_1", op: "linearPattern", feature: "boss", direction: [1, 0, 0], spacing: 15, count: 3 },
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(PLATE - HOLE + 3 * Math.PI * 16 * 5, 6);
  });

  it("cannot repeat a suppressed feature", () => {
    const doc = withFeatures({ id: "lp_1", op: "linearPattern", feature: "hole_1", direction: [-1, 0, 0], spacing: 20, count: 2 });
    doc.features[2].suppressed = true;
    expect(build(doc).errors).toEqual(['lp_1: feature "hole_1" is suppressed, so there is nothing to repeat']);
  });

  it("only repeats extrudes, cuts and holes", () => {
    const r = build(withFeatures({ id: "lp_1", op: "linearPattern", feature: "sketch_1", direction: [1, 0, 0], spacing: 20, count: 2 }));
    expect(r.errors).toEqual(['lp_1: feature: "sketch_1" is a sketch; a pattern repeats an extrude, cut or hole']);
  });
});

describe("edge topology", () => {
  it("lists each edge once, in edge-mesh order, and marks hole seams", async () => {
    const { describeEdges, describeFaces, selectEdges, tessellate } = await import("../src/kernel");
    const r = rebuild(bracket, oc);
    try {
      scoped((s) => {
        const { faces, infos: faceInfos } = describeFaces(oc, s, r.solid!);
        const { infos } = describeEdges(oc, s, r.solid!, faces);
        // 12 plate edges + 2 hole circles + 1 seam
        expect(infos).toHaveLength(15);
        expect(infos.filter((e) => e.seam)).toHaveLength(1);
        expect(infos.filter((e) => !e.seam).every((e) => e.faces.length === 2)).toBe(true);
        const vertical = selectEdges(infos, faceInfos, { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" });
        expect(vertical.matches).toHaveLength(4);
        const mesh = tessellate(oc, r.solid!);
        expect(mesh.edgeRanges).toHaveLength(15);
        // Each mesh edge range starts on its B-rep edge.
        infos.forEach((e, i) => {
          const at = mesh.edgeRanges[i].start * 6;
          const p = [mesh.edges[at], mesh.edges[at + 1], mesh.edges[at + 2]];
          const d = Math.min(...[e.start, e.end].map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])));
          expect(d).toBeLessThan(1e-3);
        });
      });
    } finally {
      r.dispose();
    }
  });
});
