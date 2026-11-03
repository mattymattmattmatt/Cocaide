// Fillets and chamfers as a fabricator meets them: on an L-shaped bracket
// (an inside corner where an outside edge runs into it), on a box with
// rounded corners (the smooth edges beside the rounds), on parts too thin for
// the size asked; edges picked one by one or all of a face; the smart default
// from the room a face leaves beside the edge; and messages that name the
// edge, say why, and give the size that works.
//
// Volumes: a constant fillet of radius r along a straight edge of length L
// between square faces removes (1 − π/4)·r²·L; an equal chamfer of d,
// d²·L/2. An inside fillet adds (1 − π/4)·r²·L.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { EdgeSelector } from "../src/doc/types";
import { describeEdges, describeFaces, loadOC, rebuild, scoped, tessellate, type OC } from "../src/kernel";
import { roomAt, roomBeside } from "../src/kernel/edgeRoom";
import { sizeThatWorks } from "../src/kernel/edgeTreat";
import { edgesSelectorFor, facesSelectorFor } from "../src/kernel/synthesize";
import type { EdgeInfo, FaceInfo } from "../src/kernel/topology";
import { filletRadiusFor } from "../src/ui/model/smartDefaults";
import { edgeFeature } from "../src/ui/model/tools/edges";
import { sizeToSuit } from "../src/ui/props/edgeTreat";
import { pickFieldFor, DEFAULT_EDGE_OPTIONS } from "../src/ui/props/pickFields";
import { EMPTY_SELECTION } from "../src/ui/model/selection";
import type { RebuildView } from "../src/worker/protocol";
import { harness } from "./ui-fixtures";

type Raw = Record<string, unknown>;
const CORNER = 1 - Math.PI / 4;
const FRONT = { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] };
const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const line = (id: string, a: number[], b: number[]) => ({ id, type: "line", start: a, end: b });
const poly = (pts: number[][]) => pts.map((p, i) => line(`l${i + 1}`, p, pts[(i + 1) % pts.length]));
const doc = (...features: Raw[]): RawDocument => ({ version: 1, units: "mm", name: "robust", features }) as RawDocument;

/** An L-shaped bracket 30 deep (y −15..15): a 60 × 6 foot along X and a 6 × 40 upright at x 0..6. */
const L = [
  { id: "s1", op: "sketch", plane: FRONT, entities: poly([[0, 0], [60, 0], [60, 6], [6, 6], [6, 40], [0, 40]]), constraints: [] },
  { id: "ext_1", op: "extrude", sketch: "s1", distance: 30, extent: "midplane" },
];
/** 60·6·30 + 6·34·30 */
const L_VOLUME = 60 * 6 * 30 + 6 * 34 * 30;

/** A 40 × 30 × 15 box with its four upright corners rounded R5. */
const ROUNDED = [
  { id: "s1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 30 }], constraints: [] },
  { id: "ext_1", op: "extrude", sketch: "s1", distance: 15 },
  { id: "corners", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" }, radius: 5 },
];

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

/** The view the app's worker sends (faces, edges, mesh, provenance labels). */
function viewOf(d: RawDocument): RebuildView {
  const r = rebuild(d, oc);
  try {
    const topo = scoped((s) => {
      const f = describeFaces(oc, s, r.solid!);
      return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
    });
    r.label(topo);
    return { ok: r.ok, name: r.name, errors: r.errors, features: r.features, sketches: r.sketches, measurements: r.measurements, mesh: tessellate(oc, r.solid!), faces: topo.faces, edges: topo.edges, bodies: r.bodies.map(({ name, faces, edges }) => ({ name, faces, edges })), datums: r.datums };
  } finally {
    r.dispose();
  }
}

function built(d: RawDocument) {
  const r = rebuild(d, oc);
  try {
    return { errors: r.errors, volume: r.measurements?.volume ?? 0 };
  } finally {
    r.dispose();
  }
}

const near = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
const edgeAt = (v: { edges: EdgeInfo[] }, mid: number[]) => {
  const i = v.edges.findIndex((e) => near(e.mid, mid));
  if (i < 0) throw new Error(`no edge at ${mid}`);
  return i;
};
const faceFacing = (v: { faces: FaceInfo[] }, n: number[], at?: number[]) =>
  v.faces.findIndex((f) => f.type === "plane" && near(f.normal!, n) && (!at || Math.abs((f.centroid[0] - at[0]) * n[0] + (f.centroid[1] - at[1]) * n[1] + (f.centroid[2] - at[2]) * n[2]) < 1e-6));
const pickEdges = (v: RebuildView, mids: number[][]): EdgeSelector | EdgeSelector[] => {
  const s = edgesSelectorFor(v.edges, v.faces, mids.map((m) => edgeAt(v, m)));
  if (!s.ok) throw new Error(s.error);
  return s.selector;
};

describe("the room a face leaves beside an edge", () => {
  it("the L's long front face beside its foot's top edge: the foot's 6 mm, not the face's 60 mm reach", () => {
    const v = viewOf(doc(...L));
    const e = v.edges[edgeAt(v, [33, 15, 6])];
    const front = faceFacing(v, [0, 1, 0]);
    expect(roomBeside(v.edges, front, e)).toBeCloseTo(6, 9);
    // The foot's top beside the same edge: 30 deep.
    expect(roomBeside(v.edges, faceFacing(v, [0, 0, 1], [0, 0, 6]), e)).toBeCloseTo(30, 9);
    expect(roomAt(v.edges, e)).toBeCloseTo(6, 9);
    // So the smart radius is a tenth of 6, rounded down to a round value: 0.5 (it was 3, from the 60 mm reach).
    expect(filletRadiusFor(v, [edgeAt(v, [33, 15, 6])])).toBe(0.5);
  });

  it("a hole's rim on the bracket's top face: from the circle to the nearest other edge (the hole's own wall below is 6 deep)", () => {
    const v = viewOf(doc(
      { id: "s1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 80, h: 40 }], constraints: [] },
      { id: "ext_1", op: "extrude", sketch: "s1", distance: 6 },
      { id: "hole_1", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [30, 0], diameter: 6.6, depth: "through" },
    ));
    const rim = v.edges.find((e) => e.kind === "circle" && Math.abs(e.mid[2] - 6) < 1e-6)!;
    // Across the top: to the plate's right end, 40 − 30 − 3.3 = 6.7; down the wall: 6.
    expect(roomBeside(v.edges, faceFacing(v, [0, 0, 1]), rim)).toBeCloseTo(6.7, 6);
    expect(roomAt(v.edges, rim)).toBeCloseTo(6, 6);
  });

  it("sizes that work, rounded down to two digits", () => {
    expect(sizeThatWorks(2.96)).toBe(2.9);
    expect(sizeThatWorks(0.347)).toBe(0.34);
    expect(sizeThatWorks(12.9)).toBe(12);
    expect(sizeThatWorks(0)).toBe(0);
  });
});

describe("fillets and chamfers on an L-shaped bracket", () => {
  it("every edge of the foot's top face (an inside corner and three outside edges): built in two passes, as in one", () => {
    const v = viewOf(doc(...L));
    const faces = facesSelectorFor(v.faces, [faceFacing(v, [0, 0, 1], [0, 0, 6])]);
    expect(faces.ok).toBe(true);
    const b = built(doc(...L, { id: "f", op: "fillet", faces: (faces as { selector: unknown }).selector, radius: 1 }));
    expect(b.errors).toEqual([]);
    // OCCT refuses the four together (the outside fillets run into the inside corner); they are built in passes, the
    // inside corner before the outside edges that run into it (the other way round, the inside corner fails).
    // About the straight runs: the inside corner adds along 30, the outside edges take away along 54 + 54 + 30.
    expect(Math.abs(b.volume - (L_VOLUME + CORNER * 30 - CORNER * (54 + 54 + 30)))).toBeLessThan(10);
  });

  it("every edge of the upright's inside face: the same", () => {
    const v = viewOf(doc(...L));
    const faces = facesSelectorFor(v.faces, [faceFacing(v, [1, 0, 0], [6, 0, 0])]);
    expect(built(doc(...L, { id: "f", op: "fillet", faces: (faces as { selector: unknown }).selector, radius: 2 })).errors).toEqual([]);
    expect(built(doc(...L, { id: "c", op: "chamfer", faces: (faces as { selector: unknown }).selector, distance: 2 })).errors).toEqual([]);
  });

  it("the inside corner alone, picked: exactly (1 − π/4)·r²·30 more", () => {
    const v = viewOf(doc(...L));
    const b = built(doc(...L, { id: "f", op: "fillet", edges: pickEdges(v, [[6, 0, 6]]), radius: 4 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(L_VOLUME + CORNER * 16 * 30, 6);
  });

  it("too large for the 6 mm foot: names the edge, the room beside it, and the radius that fits", () => {
    const v = viewOf(doc(...L));
    const b = built(doc(...L, { id: "f", op: "fillet", edges: pickEdges(v, [[33, 15, 6]]), radius: 8 }));
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]).toMatch(/^f: edge 1 \(straight, [+-]X, length 54, at \[33, 15, 6\]\): radius 8 is too large for the 6 mm face beside it: the most that fits here is radius ≈ 5\.\d mm$/);
  });

  it("the front face's edges all at half the foot's thickness: they fail only together, and the message says up to what radius they work", () => {
    const v = viewOf(doc(...L));
    const faces = facesSelectorFor(v.faces, [faceFacing(v, [0, 1, 0])]);
    const b = built(doc(...L, { id: "f", op: "fillet", faces: (faces as { selector: unknown }).selector, radius: 3 }));
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]).toMatch(/^f: the fillet fails where its 6 edges meet \(each works alone\)\. Together they work up to radius ≈ 2\.\d mm\./);
    // At the radius it gives, it builds.
    const fits = Number(/≈ ([\d.]+) mm/.exec(b.errors[0])![1]);
    expect(built(doc(...L, { id: "f", op: "fillet", faces: (faces as { selector: unknown }).selector, radius: fits })).errors).toEqual([]);
  });

  it("chamfers: equal, two distances (and flipped), distance and angle on the foot's top edge: exact volumes", () => {
    const v = viewOf(doc(...L));
    const edges = pickEdges(v, [[33, 15, 6]]);
    const removed = (f: Raw) => {
      const b = built(doc(...L, { id: "c", op: "chamfer", edges, ...f }));
      expect(b.errors).toEqual([]);
      return L_VOLUME - b.volume;
    };
    expect(removed({ distance: 2 })).toBeCloseTo((2 * 2 * 54) / 2, 6);
    expect(removed({ distance: 2, distance2: 4 })).toBeCloseTo((2 * 4 * 54) / 2, 6);
    expect(removed({ distance: 2, distance2: 4, flip: true })).toBeCloseTo((2 * 4 * 54) / 2, 6);
    expect(removed({ distance: 2, angle: 30 })).toBeCloseTo((2 * 2 * Math.tan(Math.PI / 6) * 54) / 2, 6);
  });
});

describe("next to an earlier fillet", () => {
  it("a smooth edge beside a round, picked: says there is no corner there and to pick the sharp edge", () => {
    const v = viewOf(doc(...ROUNDED));
    // The tangent line where the R5 round meets the front face (y = −15): x = −15.
    const b = built(doc(...ROUNDED, { id: "f", op: "fillet", edges: pickEdges(v, [[-15, -15, 7.5]]), radius: 1 }));
    expect(b.errors).toEqual([
      "f: edge 1 (straight, +Z, length 15, at [-15, -15, 7.5]): the faces meet smoothly there (it is the edge of a round), so there is no corner to round: pick the sharp edge beside it instead",
    ]);
  });

  it("every edge of the front face (its smooth sides left out): builds", () => {
    const v = viewOf(doc(...ROUNDED));
    const faces = facesSelectorFor(v.faces, [faceFacing(v, [0, -1, 0])]);
    const b = built(doc(...ROUNDED, { id: "f", op: "fillet", faces: (faces as { selector: unknown }).selector, radius: 1 }));
    expect(b.errors).toEqual([]);
  });

  it("the top's whole boundary, rounds and all, as a tangent chain: R2", () => {
    const v = viewOf(doc(...ROUNDED));
    const top = faceFacing(v, [0, 0, 1]);
    const all = v.edges.filter((e) => e.faces.includes(top)).map((e) => e.index);
    const s = edgesSelectorFor(v.edges, v.faces, all);
    expect(s.ok).toBe(true);
    expect(built(doc(...ROUNDED, { id: "f", op: "fillet", edges: (s as { selector: unknown }).selector, radius: 2 })).errors).toEqual([]);
  });
});

describe("the radius follows the edges picked", () => {
  it("a radius that suits a thick corner comes down when a thin edge joins it; one that suits is kept", () => {
    const v = viewOf(doc(...L));
    const corner = pickEdges(v, [[6, 0, 6]]);
    const both = pickEdges(v, [[6, 0, 6], [33, 15, 6]]);
    const f = { id: "f", op: "fillet", edges: corner, radius: 3 };
    // The inside corner leaves 34 and 54 mm beside it: 3 suits. With the foot's 6 mm edge, it is over 0.4 × 6: down to 0.5.
    expect(sizeToSuit({ edges: both }, f, { view: v, resolved: f })).toEqual({ edges: both, radius: 0.5 });
    expect(sizeToSuit({ edges: both }, { ...f, radius: 2 }, { view: v, resolved: { ...f, radius: 2 } })).toEqual({ edges: both });
    // A chamfer's distance the same way; an expression is left as typed.
    const c = { id: "c", op: "chamfer", edges: corner, distance: 3 };
    expect(sizeToSuit({ edges: both }, c, { view: v, resolved: c })).toEqual({ edges: both, distance: 0.5 });
    expect(sizeToSuit({ edges: both }, { ...f, radius: "=r" }, { view: v, resolved: f })).toEqual({ edges: both });
  });

});

describe("a face no face selector holds (a countersink's cone) goes in as its edges", () => {
  /** A plate with a hole whose top rim is chamfered: the chamfer is a cone. */
  const CONED = [
    { id: "s1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 80, h: 40 }], constraints: [] },
    { id: "ext_1", op: "extrude", sketch: "s1", distance: 6 },
    { id: "hole_1", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [0, 0], diameter: 10, depth: "through" },
    { id: "c", op: "chamfer", edges: { type: "edge", kind: "circle", radius: 5, near: [0, 5, 6], pick: "all" }, distance: 1 },
  ];
  const coneOf = (v: RebuildView) => v.faces.findIndex((f) => f.type === "cone");

  it("selection-first: Fillet on the cone rounds its two rims", () => {
    const v = viewOf(doc(...CONED));
    const cone = coneOf(v);
    expect(cone).toBeGreaterThanOrEqual(0);
    expect(facesSelectorFor(v.faces, [cone]).ok).toBe(false);
    const { ctx } = harness(doc(...CONED), v, { selection: { ...EMPTY_SELECTION, faces: [cone] } });
    const made = edgeFeature(ctx, "fillet") as Raw;
    expect(typeof made).toBe("object");
    expect(made.faces).toBeUndefined();
    const b = built(doc(...CONED, made));
    expect(b.errors).toEqual([]);
  });

  it("in a session: a click on the cone puts its edges in the edges field (and a second click takes them out)", () => {
    const v = viewOf(doc(...CONED));
    const cone = coneOf(v);
    const f: Raw = { id: "f", op: "fillet", radius: 0.5 };
    const sent: [unknown, Raw | undefined][] = [];
    const spec = { kind: "faces" as const, key: "faces", label: "Faces", optional: true, edgesKey: "edges" };
    const env = { view: v, before: [], bodies: [], edge: DEFAULT_EDGE_OPTIONS, chainOf: (i: number) => [i], passes: () => true };
    const c = { f, resolved: f, before: [], bodies: [], doc: doc(...CONED), view: v, selection: EMPTY_SELECTION };
    const field = pickFieldFor(spec, f, c, 1, env, (value, also) => void sent.push([value, also]))!;
    expect(field.toggle({ kind: "face", index: cone, point: v.faces[cone].centroid })).toBeNull();
    const [value, also] = sent[0];
    expect(value).toBeNull();
    const rims = v.edges.filter((e) => !e.seam && e.faces.includes(cone)).map((e) => e.index).sort();
    const s = edgesSelectorFor(v.edges, v.faces, rims);
    expect(also).toEqual({ edges: (s as { selector: unknown }).selector });
    const withEdges = { ...f, edges: also!.edges };
    const again = pickFieldFor(spec, withEdges, { ...c, f: withEdges, resolved: withEdges }, 1, env, (value2, also2) => void sent.push([value2, also2]))!;
    again.toggle({ kind: "face", index: cone, point: v.faces[cone].centroid });
    expect(sent[1][1]).toEqual({ edges: null });
  });
});
