// Smart selection and active selection fields (Phase P wave 2), on real parts
// rebuilt and meshed in node as the worker does: a box whose four upright
// corners are filleted (its top boundary is four lines and four arcs, all
// tangent), and a box with a round boss (an inside edge round its foot).

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { EdgeSelector, FaceSelector } from "../src/doc/types";
import { loadOC, rebuild, scoped, tessellate, type OC } from "../src/kernel";
import { selectEdges, selectFaces } from "../src/kernel/selectors";
import { describeEdges, describeFaces } from "../src/kernel/topology";
import { NO_FILTER } from "../src/ui/evaluate/filter";
import { convexity, faceEdgesOf, faceLoopNear, faceLoops, loopOf, passes, tangencyChain, tangentFaces, type PartTopology } from "../src/ui/model/smartSelect";
import {
  activeField,
  addEdges,
  fieldTakes,
  holds,
  nextField,
  promptLine,
  refTargets,
  resolveEdges,
  takesForKinds,
  toggleEdges,
  toggleFace,
  toggleId,
  toggleRef,
  treeTakes,
  type PickField,
} from "../src/ui/props/picking";
import { pickFieldFor } from "../src/ui/props/pickFields";
import type { RebuildView } from "../src/worker/protocol";

type Raw = Record<string, unknown>;

const base = (...features: Raw[]): RawDocument => ({
  version: 1,
  units: "mm",
  name: "box",
  features: [
    { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 20 }], constraints: [] },
    { id: "ext_1", op: "extrude", sketch: "s1", distance: 10 },
    ...features,
  ],
});
const cornerFillet = { id: "f1", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" }, radius: 3 };
const boss = [
  { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] }, entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 5 }], constraints: [] },
  { id: "ext_2", op: "extrude", sketch: "s2", distance: 4 },
];

let oc: OC;
let rounded: RebuildView;
let bossed: RebuildView;

/** The view the worker sends: topology, bodies and the mesh. */
function fullView(doc: RawDocument): RebuildView {
  const r = rebuild(doc, oc);
  try {
    const topo = scoped((s) => {
      const f = describeFaces(oc, s, r.solid!);
      return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
    });
    return { ok: r.ok, name: r.name, errors: r.errors, features: r.features, sketches: r.sketches, measurements: r.measurements, mesh: tessellate(oc, r.solid!), faces: topo.faces, edges: topo.edges, bodies: r.bodies.map(({ name, faces, edges }) => ({ name, faces, edges })), datums: r.datums };
  } finally {
    r.dispose();
  }
}

beforeAll(async () => {
  oc = await loadOC();
  rounded = fullView(base(cornerFillet));
  bossed = fullView(base(...boss));
});

const faceWhere = (v: PartTopology, test: (f: RebuildView["faces"][number]) => boolean) => v.faces.findIndex(test);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const TOP = (f: RebuildView["faces"][number]) => f.type === "plane" && near(f.normal![2], 1);

describe("smart selection on a box with rounded corners", () => {
  it("a top edge's tangency chain is the whole top boundary: four lines and four arcs", () => {
    const top = faceWhere(rounded, TOP);
    const line = rounded.edges.find((e) => e.kind === "line" && e.faces.includes(top) && near(e.length, 34))!;
    const chain = tangencyChain(rounded, line.index);
    expect(chain[0]).toBe(line.index);
    expect(chain.length).toBe(8);
    expect(chain.map((i) => rounded.edges[i].kind).sort()).toEqual(["circle", "circle", "circle", "circle", "line", "line", "line", "line"]);
    expect(chain.every((i) => rounded.edges[i].faces.includes(top))).toBe(true);
  });

  it("an upright edge where a flat side meets a corner fillet runs on only to itself (sharp at both ends)", () => {
    const upright = rounded.edges.find((e) => e.kind === "line" && near(Math.abs(e.direction![2]), 1))!;
    expect(tangencyChain(rounded, upright.index)).toEqual([upright.index]);
  });

  it("the loop of a top edge on the top face (the face under the pointer) is the top boundary; on the side, the side's four edges", () => {
    const top = faceWhere(rounded, TOP);
    const front = faceWhere(rounded, (f) => f.type === "plane" && near(f.normal![1], -1));
    const edge = rounded.edges.find((e) => e.kind === "line" && e.faces.includes(top) && e.faces.includes(front))!;
    expect(loopOf(rounded, edge.index, top).length).toBe(8);
    expect(loopOf(rounded, edge.index, front).length).toBe(4);
    expect(loopOf(rounded, edge.index, front)[0]).toBe(edge.index);
    // With no face under the pointer, a flat one beside it.
    expect(loopOf(rounded, edge.index).length).toBeGreaterThanOrEqual(4);
    expect(faceEdgesOf(rounded, edge.index, top).length).toBe(8);
  });

  it("the tangent faces of a flat side are every side face round the part (the corner fillets join them smoothly)", () => {
    const front = faceWhere(rounded, (f) => f.type === "plane" && near(f.normal![1], -1));
    const faces = tangentFaces(rounded, front);
    expect(faces[0]).toBe(front);
    expect(faces.length).toBe(8);
    expect(faces.every((i) => rounded.faces[i].type === "cylinder" || near(rounded.faces[i].normal![2], 0))).toBe(true);
    // The top face meets them at a sharp edge: alone.
    expect(tangentFaces(rounded, faceWhere(rounded, TOP))).toEqual([faceWhere(rounded, TOP)]);
  });

  it("a face's loops: the top has one; a loop near a point is that loop", () => {
    const top = faceWhere(rounded, TOP);
    expect(faceLoops(rounded, top).length).toBe(1);
    expect(faceLoopNear(rounded, top, [0, 0, 10]).length).toBe(8);
  });
});

describe("outside and inside edges", () => {
  it("a box's top edges are convex, the edge round the boss's foot concave, its top edge convex", () => {
    const foot = bossed.edges.find((e) => e.kind === "circle" && near(e.center![2], 10))!;
    const rim = bossed.edges.find((e) => e.kind === "circle" && near(e.center![2], 14))!;
    const boxTop = bossed.edges.find((e) => e.kind === "line" && near(e.start[2], 10) && near(e.end[2], 10))!;
    expect(convexity(bossed, foot.index)).toBe("concave");
    expect(convexity(bossed, rim.index)).toBe("convex");
    expect(convexity(bossed, boxTop.index)).toBe("convex");
    expect(passes(bossed, foot.index, "convex")).toBe(false);
    expect(passes(bossed, foot.index, "concave")).toBe(true);
    expect(passes(bossed, rim.index, "all")).toBe(true);
  });

  it("a corner fillet's boundary edges are smooth (the faces meet tangentially there)", () => {
    const arc = rounded.edges.find((e) => e.kind === "circle")!;
    expect(convexity(rounded, arc.index)).toBe("convex");
    const seamless = rounded.edges.find((e) => e.kind === "line" && near(Math.abs(e.direction![2]), 1))!;
    expect(convexity(rounded, seamless.index)).toBe("smooth");
  });
});

describe("picking into a session's fields", () => {
  it("a click puts a face in, a second click on it takes it out", () => {
    const top = faceWhere(bossed, TOP);
    const one = toggleFace([], bossed.faces, top) as FaceSelector[];
    expect(one.length).toBe(1);
    expect(selectFaces(bossed.faces, one[0]).matches.map((f) => f.index)).toEqual([top]);
    const side = faceWhere(bossed, (f) => f.type === "plane" && near(f.normal![0], 1));
    const two = toggleFace(one, bossed.faces, side) as FaceSelector[];
    expect(two.length).toBe(2);
    expect(toggleFace(two, bossed.faces, top)).toEqual([two[1]]);
    // A selector that matched several faces keeps the others when one is taken out.
    const sides: FaceSelector = { type: "planar", normal: [0, 0, 1], pick: "all" };
    const kept = toggleFace([sides], bossed.faces, top) as FaceSelector[];
    expect(kept.length).toBe(1);
    expect(selectFaces(bossed.faces, kept[0]).matches.map((f) => f.index)).not.toContain(top);
  });

  it("edges go in with their chain (tangent propagation) and come out together; one selector for the lot where one finds them", () => {
    const top = faceWhere(rounded, TOP);
    const line = rounded.edges.find((e) => e.kind === "line" && e.faces.includes(top))!;
    const chain = tangencyChain(rounded, line.index);
    const v = toggleEdges(undefined, rounded.edges, rounded.faces, chain);
    expect(typeof v).not.toBe("string");
    expect(resolveEdges(v, rounded.edges, rounded.faces).indices).toEqual([...chain].sort((a, b) => a - b));
    expect(Array.isArray(v)).toBe(false); // "every edge on the top face"
    expect(toggleEdges(v, rounded.edges, rounded.faces, chain)).toBeNull();
    // Without propagation: one edge at a time.
    const single = toggleEdges(undefined, rounded.edges, rounded.faces, [line.index]) as EdgeSelector;
    expect(selectEdges(rounded.edges, rounded.faces, single).matches.map((e) => e.index)).toEqual([line.index]);
    expect(resolveEdges(addEdges(single, rounded.edges, rounded.faces, chain), rounded.edges, rounded.faces).indices.length).toBe(8);
  });

  it("an edge field's click and its preselection reach the same edges: the chain with propagation on, the one edge with it off; the corner filter refuses", () => {
    const top = faceWhere(rounded, TOP);
    const line = rounded.edges.find((e) => e.kind === "line" && e.faces.includes(top))!;
    const target = { kind: "edge" as const, index: line.index, point: line.mid };
    const spec = { kind: "edges" as const, key: "edges", label: "Edges", propagation: true };
    const doc = base(cornerFillet);
    const c = { f: {}, resolved: {}, before: [], bodies: ["main"], doc, view: rounded, selection: { faces: [], edges: [] } };
    const env = (propagate: boolean, kinds: "all" | "convex" | "concave" = "all") => ({ view: rounded, before: [], bodies: ["main"], edge: { propagate, kinds }, chainOf: (e: number) => tangencyChain(rounded, e), passes: (e: number) => passes(rounded, e, kinds) });
    let committed: unknown;
    const field = pickFieldFor(spec, {}, c, 0, env(true), (v) => void (committed = v))!;
    const indices = (ts: { kind: string; index?: number }[]) => ts.map((t) => t.index ?? -1).sort((a, b) => a - b);
    expect(indices(field.reach!(target))).toEqual([...tangencyChain(rounded, line.index)].sort((a, b) => a - b));
    expect(field.toggle(target)).toBeNull();
    expect(resolveEdges(committed, rounded.edges, rounded.faces).indices.length).toBe(8);
    const one = pickFieldFor(spec, {}, c, 0, env(false), (v) => void (committed = v))!;
    expect(indices(one.reach!(target))).toEqual([line.index]);
    // The top's edges are outside corners: an inside-only filter turns them away.
    const inside = pickFieldFor(spec, {}, c, 0, env(true, "concave"), () => undefined)!;
    expect(inside.toggle(target)).toMatch(/outside edge/);
  });

  it("a selector that finds nothing on the part shown is kept, not lost, when others change", () => {
    const ghost: EdgeSelector = { type: "edge", kind: "circle", radius: 99, pick: "all" };
    const edge = rounded.edges.find((e) => e.kind === "line" && !e.seam)!;
    const v = toggleEdges([ghost], rounded.edges, rounded.faces, [edge.index]);
    expect(Array.isArray(v) && v.some((s) => (s as EdgeSelector).radius === 99)).toBe(true);
  });

  it("a reference field takes the face clicked as a plane, clears on a second click when it may be empty, and says what is wrong", () => {
    const top = faceWhere(bossed, TOP);
    const target = { kind: "face" as const, index: top, point: bossed.faces[top].centroid };
    const ref = toggleRef(undefined, target, bossed, ["plane"], [], true);
    expect(ref).toMatchObject({ face: { type: "planar" } });
    expect(holds(refTargets(ref, bossed), target)).toBe(true);
    expect(toggleRef(ref, target, bossed, ["plane"], [], true)).toBeNull();
    expect(toggleRef(ref, target, bossed, ["plane"], [], false)).toBe(ref);
    const cyl = faceWhere(bossed, (f) => f.type === "cylinder");
    expect(toggleRef(undefined, { kind: "face", index: cyl, point: [0, 0, 0] }, bossed, ["plane"], [], true)).toMatch(/round face is an axis, but a plane is needed/);
    expect(refTargets({ datum: "Top" }, bossed)).toEqual([{ kind: "datum", id: "Top", point: [0, 0, 0] }]);
  });

  it("the filter follows the field: faces for faces, edges and faces for an axis, vertices for a point", () => {
    expect(takesForKinds(["plane"]).sort()).toEqual(["faces", "planes"]);
    expect(takesForKinds(["axis"]).sort()).toEqual(["edges", "faces", "planes"]);
    expect(takesForKinds(["point"]).sort()).toEqual(["edges", "planes", "vertices"]);
    expect(fieldTakes({ takes: ["edges"] }, { kind: "face", index: 0, point: [0, 0, 0] })).toBe(false);
    expect(fieldTakes({ takes: ["edges"] }, { kind: "edge", index: 0, point: [0, 0, 0] })).toBe(true);
    expect(NO_FILTER.size).toBe(0);
  });

  it("the active field: the one named, else the first empty one the feature needs; Tab goes round", () => {
    const field = (key: string, order: number, count: number, required = false): PickField => ({
      key,
      label: key,
      order,
      kind: "faces",
      takes: ["faces"],
      count,
      required,
      items: [],
      toggle: () => null,
      prompt: `Pick ${key}`,
    });
    const list = [field("neutral", 20, 0, true), field("faces", 10, 2, true), field("bodies", 30, 0)];
    expect(activeField(list, undefined)!.key).toBe("neutral");
    expect(activeField(list, "bodies")!.key).toBe("bodies");
    expect(activeField(list, "gone")!.key).toBe("neutral");
    expect(activeField(list, null)).toBeNull();
    expect(activeField([field("faces", 10, 2, true)], undefined)!.key).toBe("faces");
    // Selection-first: the field the selection went into stays active (more edges go there), not an empty alternative.
    expect(activeField([field("faces", 20, 0), field("edges", 10, 1), field("features", 30, 0)], undefined)!.key).toBe("edges");
    expect(nextField(list, "faces")!.key).toBe("neutral");
    expect(nextField(list, "bodies")!.key).toBe("faces");
    expect(nextField(list, "faces", true)!.key).toBe("bodies");
    expect(promptLine({ prompt: "Pick edges to fillet", count: 2 })).toBe("Pick edges to fillet — 2 picked");
    expect(promptLine({ prompt: "Pick edges to fillet", count: 0 })).toBe("Pick edges to fillet");
  });

  it("features from the tree: in, out, in the tree's order; only the ops the field takes", () => {
    expect(toggleId(["ext_2"], "hole_1", ["ext_1", "hole_1", "ext_2"])).toEqual(["hole_1", "ext_2"]);
    expect(toggleId(["hole_1", "ext_2"], "hole_1", ["ext_1", "hole_1", "ext_2"])).toEqual(["ext_2"]);
    expect(treeTakes(["extrude", "cut", "hole"], "hole")).toBe(true);
    expect(treeTakes(["extrude"], "fillet")).toBe(false);
    expect(treeTakes("any", "fillet")).toBe(true);
    expect(treeTakes(undefined, "fillet")).toBe(false);
  });
});
