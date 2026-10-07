import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { CocaideDocument } from "../src/doc/types";
import { loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { edgeSelectorFor, edgesSelectorFor, faceSelectorFor } from "../src/kernel/synthesize";
import { describeEdges, describeFaces, type EdgeInfo, type FaceInfo } from "../src/kernel/topology";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8")) as CocaideDocument;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function topology(doc: CocaideDocument): { faces: FaceInfo[]; edges: EdgeInfo[] } {
  const r = rebuild(doc, oc);
  try {
    return scoped((s) => {
      const { faces, infos } = describeFaces(oc, s, r.solid!);
      return { faces: infos, edges: describeEdges(oc, s, r.solid!, faces).infos };
    });
  } finally {
    r.dispose();
  }
}

describe("face picks", () => {
  it("names the bracket's top face the way the spec does", () => {
    const { faces } = topology(load("bracket"));
    const top = faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99);
    expect(faceSelectorFor(faces, top)).toEqual({ ok: true, selector: { type: "planar", normal: [0, 0, 1], pick: "largest" } });
  });

  it("gives every flat or round face of the mounting plate a selector that finds it again", () => {
    const { faces } = topology(load("mounting-plate"));
    faces.forEach((f, i) => {
      const s = faceSelectorFor(faces, i);
      expect(s.ok).toBe(f.type === "plane" || f.type === "cylinder");
    });
  });

  it("tells identical faces apart by position only as a last resort", () => {
    const doc = load("bracket");
    doc.features[0] = {
      id: "sketch_1",
      op: "sketch",
      plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
      entities: [
        { id: "a", type: "rect", center: [-20, 0], w: 10, h: 10 },
        { id: "b", type: "rect", center: [20, 0], w: 10, h: 10 },
      ],
    };
    doc.features.length = 2;
    const { faces } = topology(doc);
    const tops = faces.flatMap((f, i) => (f.type === "plane" && f.normal![2] > 0.99 ? [i] : []));
    expect(tops).toHaveLength(2);
    for (const i of tops) {
      const s = faceSelectorFor(faces, i);
      expect(s).toEqual({
        ok: true,
        selector: { type: "planar", normal: [0, 0, 1], near: [faces[i].centroid[0], 0, 6], pick: "all" },
      });
    }
  });
});

describe("edge picks", () => {
  it("picks a plate edge as the edge between two faces", () => {
    const { faces, edges } = topology(load("bracket"));
    const target = edges.findIndex((e) => e.kind === "line" && e.direction && Math.abs(e.direction[1]) > 0.99 && e.mid[0] > 39 && e.mid[2] > 5);
    const s = edgeSelectorFor(edges, faces, target);
    expect(s).toEqual({
      ok: true,
      selector: {
        type: "edge",
        between: [
          { type: "planar", normal: [1, 0, 0], pick: "largest" },
          { type: "planar", normal: [0, 0, 1], pick: "largest" },
        ],
        pick: "all",
      },
    });
  });

  it("picks the hole rim as a circle of its radius on the top face", () => {
    const { faces, edges } = topology(load("bracket"));
    const rim = edges.findIndex((e) => e.kind === "circle" && e.center![2] > 5);
    expect(edgeSelectorFor(edges, faces, rim)).toEqual({
      ok: true,
      selector: { type: "edge", kind: "circle", radius: 3.3, onFace: { type: "planar", normal: [0, 0, 1], pick: "largest" }, pick: "all" },
    });
  });

  it("gives every real edge of the mounting plate a selector that finds it again", () => {
    const { faces, edges } = topology(load("mounting-plate"));
    edges.forEach((e, i) => expect(edgeSelectorFor(edges, faces, i).ok).toBe(!e.seam));
  });

  it("refuses a seam", () => {
    const { faces, edges } = topology(load("bracket"));
    expect(edgeSelectorFor(edges, faces, edges.findIndex((e) => e.seam)).ok).toBe(false);
  });

  it("finds one selector for the four vertical corners", () => {
    const { faces, edges } = topology(load("bracket"));
    const corners = edges.flatMap((e, i) => (!e.seam && e.kind === "line" && Math.abs(e.direction![2]) > 0.99 ? [i] : []));
    expect(corners).toHaveLength(4);
    expect(edgesSelectorFor(edges, faces, corners)).toEqual({
      ok: true,
      selector: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" },
    });
  });

  it("finds 'every edge of the top face' for the top boundary", () => {
    const { faces, edges } = topology(load("bracket"));
    const topIndex = faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99);
    const boundary = edges.flatMap((e, i) => (e.faces.includes(topIndex) ? [i] : []));
    expect(edgesSelectorFor(edges, faces, boundary)).toEqual({
      ok: true,
      selector: { type: "edge", onFace: { type: "planar", normal: [0, 0, 1], pick: "largest" }, pick: "all" },
    });
  });

  it("falls back to one selector per edge, each verified", () => {
    const { faces, edges } = topology(load("bracket"));
    const a = edges.findIndex((e) => e.kind === "circle" && e.center![2] > 5);
    const b = edges.findIndex((e) => e.kind === "line" && Math.abs(e.direction![2]) > 0.99);
    const s = edgesSelectorFor(edges, faces, [a, b]);
    expect(s.ok && Array.isArray(s.selector) && s.selector.length).toBe(2);
  });
});
