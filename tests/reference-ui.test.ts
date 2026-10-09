// The reference geometry in the UI (Wave 1A): the Plane, Axis and Point tools
// reading the selection to pick their mode (each proposal is then rebuilt on
// the bracket, so what the tool makes builds); where a sketch placed by
// reference is drawn; how the planes are sized and shown; vertices and planes
// in the selection; "Use selected" on a vertex or a plane.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { buildPacket } from "../src/ask/packet";
import { LocalKernel } from "../src/ask/kernel";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { DEFAULT_DATUMS } from "../src/features/datum";
import {
  axisEnds,
  datumShapes,
  datumVisible,
  DEFAULT_DATUM_VIEW,
  eyeOpen,
  parseDatumView,
  planeRect,
  setShown,
  toggleEye,
} from "../src/ui/model/datumDisplay";
import { axisFromSelection, datumKinds, planeFromSelection, pointFromSelection } from "../src/ui/model/referenceFromSelection";
import { describeDatum, EMPTY_SELECTION, pickInto, selectionText, type Selection } from "../src/ui/model/selection";
import { planeChoices, planeOfRef, planeSpecFrameIn, sketchFrameIn, sketchNormal } from "../src/ui/model/sketchPlane";
import { contextEntries, toolById } from "../src/ui/model/registry";
import { extrudeFeature } from "../src/ui/model/tools/extrude";
import { sketchTarget } from "../src/ui/model/tools/sketch";
import { refFromSelection } from "../src/ui/props/datumRef";
import { switchMode } from "../src/ui/props/datumModes";
import { commitPatch } from "../src/ui/props/spec";
import { UI_OPS } from "../src/features/uiDefs";
import { AXIS_MODE_SPECS } from "../src/features/axis/doc";
import { PLANE_MODE_SPECS } from "../src/features/plane/doc";
import { POINT_MODE_SPECS } from "../src/features/point/doc";
import type { RebuildView } from "../src/worker/protocol";
import { example, faceWhere, harness, viewOf } from "./ui-fixtures";

let oc: OC;
let doc: RawDocument;
let view: RebuildView;
beforeAll(async () => {
  oc = await loadOC();
  doc = example("bracket"); // an 80 x 40 x 6 plate on Top, centred on the origin, a 6.6 hole at [30, 0]
  view = viewOf(oc, doc);
});

const near = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 6));
const sel = (s: Partial<Selection>): Selection => ({ ...EMPTY_SELECTION, ...s });
const kinds = () => datumKinds(doc.features as Record<string, unknown>[], view);

/** The plate's faces and edges, found by what they are. */
const topFace = () => faceWhere(view, (f) => f.type === "plane" && f.normal![2] > 0.99);
const bottomFace = () => faceWhere(view, (f) => f.type === "plane" && f.normal![2] < -0.99);
const holeWall = () => faceWhere(view, (f) => f.type === "cylinder");
/** The top front edge (y = -20, z = 6), along X. */
const frontTopEdge = () => view.edges.findIndex((e) => e.kind === "line" && Math.abs(e.direction![0]) > 0.99 && Math.abs(e.start[1] + 20) < 1e-6 && Math.abs(e.start[2] - 6) < 1e-6);
/** A vertical corner edge. */
const cornerEdge = () => view.edges.findIndex((e) => e.kind === "line" && Math.abs(e.direction![2]) > 0.99);
/** The hole's top rim. */
const rim = () => view.edges.findIndex((e) => !e.seam && e.kind === "circle" && Math.abs(e.center![2] - 6) < 1e-6);

/** The proposal rebuilt on the bracket: it must build, and gives its frame. */
function built(feature: Record<string, unknown>) {
  const r = rebuild({ ...doc, features: [...doc.features, { id: "ref_1", ...feature }] }, oc);
  try {
    expect(r.errors).toEqual([]);
    return r.datums.ref_1;
  } finally {
    r.dispose();
  }
}

describe("the Plane tool picks its mode from the selection", () => {
  it("one flat face: 10 mm off it, following the face", () => {
    const p = planeFromSelection(sel({ faces: [topFace()] }), view, kinds());
    expect(p.notice).toBeUndefined();
    expect(p.feature).toEqual({ op: "plane", mode: "offset", refs: [{ face: { type: "planar", normal: [0, 0, 1], pick: "largest" } }], distance: 10 });
    const d = built(p.feature);
    expect(d.kind === "plane" && d.origin[2]).toBeCloseTo(16, 6);
  });

  it("a plane and a straight edge in it: 45° about the edge", () => {
    const p = planeFromSelection(sel({ edges: [frontTopEdge()], datums: ["Top"] }), view, kinds());
    expect(p.feature.mode).toBe("angle");
    expect(p.feature.angle).toBe(45);
    expect((p.feature.refs as unknown[])[0]).toEqual({ datum: "Top" });
    const d = built(p.feature);
    expect(d.kind).toBe("plane");
    // Through the edge (y = -20, z = 6 seen along X); the normal is Top's turned 45° about the edge.
    if (d.kind === "plane") {
      expect(d.origin[1]).toBeCloseTo(-20, 6);
      expect(Math.abs(d.normal[2])).toBeCloseTo(Math.SQRT1_2, 6);
    }
  });

  it("a plane and an edge out of it: square to the edge instead, and says so", () => {
    const p = planeFromSelection(sel({ edges: [cornerEdge()], datums: ["Top"] }), view, kinds());
    expect(p.feature.mode).toBe("normalToEdge");
    expect(p.notice).toMatch(/not in the plane/);
    built(p.feature);
  });

  it("three vertices: through them", () => {
    const e = frontTopEdge();
    const c = cornerEdge();
    const p = planeFromSelection(sel({ vertices: [{ edge: e, at: "start" }, { edge: e, at: "end" }, { edge: c, at: "start" }] }), view, kinds());
    expect(p.feature.mode).toBe("threePoints");
    expect((p.feature.refs as { at?: string }[]).map((r) => r.at)).toEqual(["start", "end", "start"]);
    built(p.feature);
  });

  it("two faces: half way between (the 6 mm plate's mid-plane is z = 3)", () => {
    const p = planeFromSelection(sel({ faces: [topFace(), bottomFace()] }), view, kinds());
    expect(p.feature.mode).toBe("midplane");
    const d = built(p.feature);
    expect(d.kind === "plane" && d.origin[2]).toBeCloseTo(3, 6);
  });

  it("an edge alone: square to it at its start; with a vertex: through it", () => {
    const p = planeFromSelection(sel({ edges: [frontTopEdge()] }), view, kinds());
    expect(p.feature).toMatchObject({ op: "plane", mode: "normalToEdge", t: 0 });
    const d = built(p.feature);
    expect(d.kind === "plane" && Math.abs(d.normal[0])).toBeCloseTo(1, 6);
    const q = planeFromSelection(sel({ edges: [frontTopEdge()], vertices: [{ edge: cornerEdge(), at: "start" }] }), view, kinds());
    expect(q.feature.mode).toBe("normalToEdge");
    expect(q.feature.refs).toHaveLength(2);
  });

  it("a plane and a vertex: parallel to the plane, through the vertex", () => {
    const p = planeFromSelection(sel({ datums: ["Top"], vertices: [{ edge: frontTopEdge(), at: "start" }] }), view, kinds());
    expect(p.feature.mode).toBe("parallelThroughPoint");
    const d = built(p.feature);
    expect(d.kind === "plane" && d.origin[2]).toBeCloseTo(6, 6);
  });

  it("nothing (or nothing it can use) selected: 10 mm above Top, and a notice saying what to select", () => {
    const p = planeFromSelection(EMPTY_SELECTION, view, kinds());
    expect(p.feature).toEqual({ op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 10 });
    expect(p.notice).toMatch(/^Made a plane 10 mm above Top\. Select a flat face/);
    expect(planeFromSelection(sel({ faces: [holeWall()] }), view, kinds()).notice).toMatch(/^That selection doesn't say which plane\./);
    expect(planeFromSelection(sel({ faces: [topFace()] }), null, kinds()).error).toMatch(/not rebuilt yet/);
  });
});

describe("the Axis tool", () => {
  it("a round face: its axis; an edge: along it; a circular edge: its axis", () => {
    const a = axisFromSelection(sel({ faces: [holeWall()] }), view, kinds());
    expect(a.feature.mode).toBe("cylinder");
    const d = built(a.feature);
    if (d.kind === "axis") {
      near([Math.abs(d.direction[2])], [1]);
      near([d.origin[0], d.origin[1]], [30, 0]);
    } else expect(d.kind).toBe("axis");
    expect(axisFromSelection(sel({ edges: [frontTopEdge()] }), view, kinds()).feature.mode).toBe("edge");
    expect(axisFromSelection(sel({ edges: [rim()] }), view, kinds()).feature.mode).toBe("edge");
  });

  it("two planes: where they meet; two vertices: through them; a vertex and a plane: square to it", () => {
    const two = axisFromSelection(sel({ datums: ["Top", "Front"] }), view, kinds());
    expect(two.feature).toEqual({ op: "axis", mode: "twoPlanes", refs: [{ datum: "Top" }, { datum: "Front" }] });
    const d = built(two.feature);
    expect(d.kind === "axis" && Math.abs(d.direction[0])).toBeCloseTo(1, 6);
    const e = frontTopEdge();
    expect(axisFromSelection(sel({ vertices: [{ edge: e, at: "start" }, { edge: e, at: "end" }] }), view, kinds()).feature.mode).toBe("twoPoints");
    const pn = axisFromSelection(sel({ vertices: [{ edge: e, at: "start" }], datums: ["Top"] }), view, kinds());
    expect(pn.feature.mode).toBe("pointNormal");
    built(pn.feature);
  });

  it("nothing: the vertical axis where Front and Right meet, and what to select", () => {
    const a = axisFromSelection(EMPTY_SELECTION, view, kinds());
    expect(a.feature).toEqual({ op: "axis", mode: "twoPlanes", refs: [{ datum: "Front" }, { datum: "Right" }] });
    expect(a.notice).toMatch(/Select a round face/);
  });
});

describe("the Point tool", () => {
  it("a circular edge: its centre (the hole's top centre)", () => {
    const p = pointFromSelection(sel({ edges: [rim()] }), view, kinds());
    expect(p.feature.mode).toBe("center");
    const d = built(p.feature);
    expect(d.kind).toBe("point");
    if (d.kind === "point") near(d.at, [30, 0, 6]);
  });

  it("a face: its centre; an edge: its middle; a vertex: on it", () => {
    expect(pointFromSelection(sel({ faces: [topFace()] }), view, kinds()).feature.mode).toBe("center");
    const mid = pointFromSelection(sel({ edges: [frontTopEdge()] }), view, kinds());
    expect(mid.feature).toMatchObject({ mode: "onEdge", t: 0.5 });
    const d = built(mid.feature);
    if (d.kind === "point") near(d.at, [0, -20, 6]);
    const v = pointFromSelection(sel({ vertices: [{ edge: frontTopEdge(), at: "end" }] }), view, kinds());
    expect(v.feature).toMatchObject({ mode: "onEdge", t: 1 });
  });

  it("an axis and a plane: where they cross", () => {
    const p = pointFromSelection(sel({ faces: [holeWall()], datums: ["Top"] }), view, kinds());
    expect(p.feature.mode).toBe("intersection");
    const d = built(p.feature);
    if (d.kind === "point") near(d.at, [30, 0, 0]);
    const z = pointFromSelection(sel({ datums: ["Z", "Top"] }), view, kinds());
    expect(z.feature).toEqual({ op: "point", mode: "intersection", refs: [{ datum: "Z" }, { datum: "Top" }] });
  });

  it("nothing: at the origin, with what to select", () => {
    expect(pointFromSelection(EMPTY_SELECTION, view, kinds()).notice).toMatch(/Select a circular edge/);
  });
});

describe("the Reference tab's tools", () => {
  it("make the feature the selection means, selected with its properties open, and say what was guessed", () => {
    const { ctx, out } = harness(doc, view, { selection: sel({ faces: [topFace()] }) });
    toolById("tool.plane")!.run(ctx);
    expect(out.created).toEqual([{ id: "plane_1", op: "plane", mode: "offset", refs: [{ face: { type: "planar", normal: [0, 0, 1], pick: "largest" } }], distance: 10 }]);
    expect(out.notices).toEqual([]);
    const none = harness(doc, view);
    toolById("tool.point")!.run(none.ctx);
    expect(none.out.created[0]).toMatchObject({ id: "point_1", mode: "coords" });
    expect(none.out.notices[0][0]).toBe("info");
  });

  it("right-click entries worded for what was clicked", () => {
    const { ctx } = harness(doc, view);
    const labels = (t: Parameters<typeof contextEntries>[1]) => contextEntries(ctx, t).map((e) => e.item.label);
    expect(labels({ kind: "face", index: topFace() })).toEqual(["Plane from this face"]);
    expect(labels({ kind: "face", index: holeWall() })).toEqual(["Axis of this cylinder"]);
    expect(labels({ kind: "edge", index: frontTopEdge() })).toEqual(["Plane normal to this edge", "Axis along this edge"]);
    expect(labels({ kind: "edge", index: rim() })).toEqual(["Plane normal to this edge", "Axis of this circle", "Point at its centre"]);
    expect(labels({ kind: "datum", id: "Top" })).toEqual(["Sketch on this plane", "Offset plane from this"]);
    expect(labels({ kind: "vertex", edge: frontTopEdge(), at: "start" })).toEqual(["Point at this vertex"]);
  });

  it("a right-click entry acts on what was right-clicked alone, not the rest of the selection", () => {
    // Top and the edge selected (the toolbar's Plane would make a 45° plane); "Plane normal to this edge" on the edge.
    const { ctx, out } = harness(doc, view, { selection: sel({ edges: [frontTopEdge()], datums: ["Top"] }) });
    const run = (t: Parameters<typeof contextEntries>[1], label: string) => contextEntries(ctx, t).find((e) => e.item.label === label)!.item.run(ctx);
    run({ kind: "edge", index: frontTopEdge() }, "Plane normal to this edge");
    expect(out.created[0]).toMatchObject({ op: "plane", mode: "normalToEdge", t: 0 });
    run({ kind: "edge", index: frontTopEdge() }, "Axis along this edge");
    expect(out.created[1]).toMatchObject({ op: "axis", mode: "edge" });
    run({ kind: "datum", id: "Top" }, "Offset plane from this");
    expect(out.created[2]).toMatchObject({ op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 10 });
    expect(out.notices).toEqual([]);
  });
});

describe("switching a reference feature's type in its properties", () => {
  const before = (d: RawDocument) => d.features as Record<string, unknown>[];
  it("keeps the references that fit, fills the rest with defaults, drops the old mode's fields", () => {
    const f = { id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Front" }], distance: 20 };
    expect(switchMode(f, "angle", PLANE_MODE_SPECS, before(doc), { distance: 10, angle: 45 })).toEqual({ mode: "angle", refs: [{ datum: "Front" }, { datum: "X" }], distance: null, angle: 45, t: null });
    expect(switchMode(f, "threePoints", PLANE_MODE_SPECS, before(doc))).toMatchObject({ refs: [{ datum: "Origin" }, { datum: "Origin" }, { datum: "Origin" }] });
  });

  it("a type that needs picked geometry (a cylinder's face, an edge) takes what is selected, else says what to select", () => {
    const f = { id: "axis_1", op: "axis", mode: "twoPlanes", refs: [{ datum: "Front" }, { datum: "Right" }] };
    expect(() => switchMode(f, "cylinder", AXIS_MODE_SPECS, before(doc))).toThrow("This type needs a cylindrical or conical face: select it in the view, then choose the type again.");
    // A flat face selected does not fit a cylinder's slot: still refused.
    expect(() => switchMode(f, "cylinder", AXIS_MODE_SPECS, before(doc), {}, { selection: sel({ faces: [topFace()] }), view })).toThrow(/select it in the view/);
    const patch = switchMode(f, "cylinder", AXIS_MODE_SPECS, before(doc), {}, { selection: sel({ faces: [holeWall()] }), view });
    expect(patch).toEqual({ mode: "cylinder", refs: [{ face: { type: "cylindrical", radius: 3.3, pick: "largest" } }] });
    expect(built({ op: "axis", mode: patch.mode, refs: patch.refs })).toMatchObject({ kind: "axis", origin: [30, 0, expect.any(Number)] });
    const p = { id: "point_1", op: "point", mode: "coords", at: [0, 0, 0] };
    expect(switchMode(p, "center", POINT_MODE_SPECS, before(doc), {}, { selection: sel({ edges: [rim()] }), view })).toMatchObject({ mode: "center", refs: [{ edge: expect.any(Object) }], at: null });
  });

  it("the property editor shows the refusal instead of sending a change that can't validate", () => {
    const mode = UI_OPS.axis.fields!.find((s) => s.key === "mode")!;
    const ctxOf = { f: {}, resolved: {}, before: before(doc), bodies: [], doc, view, selection: EMPTY_SELECTION };
    expect(() => commitPatch(mode, "edge", { id: "axis_1", op: "axis", mode: "twoPlanes", refs: [{ datum: "Front" }, { datum: "Right" }] }, ctxOf)).toThrow(/needs an edge/);
  });
});

describe("Sketch on a reference", () => {
  it("a plane picked (in the view or the tree) or one flat face: sketches there straight away", () => {
    const onTop = harness(doc, view, { selection: sel({ datums: ["Front"] }) });
    expect(sketchTarget(onTop.ctx)).toEqual({ plane: { type: "ref", ref: { datum: "Front" } }, what: "Front" });
    expect(toolById("tool.sketch")!.direct!(onTop.ctx)).toMatch(/^Sketch on Front/);
    toolById("tool.sketch")!.run(onTop.ctx);
    expect(onTop.out.sketches).toEqual([{ type: "ref", ref: { datum: "Front" } }]);
    // An axis picked says nothing about where to sketch: the dropdown opens.
    expect(sketchTarget(harness(doc, view, { selection: sel({ datums: ["X"] }) }).ctx)).toBeNull();
  });

  it("the menu lists the plane features after the default planes", () => {
    const withPlane: RawDocument = { ...doc, features: [...doc.features, { id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 20 }] };
    const v = viewOf(oc, withPlane);
    const { ctx, out } = harness(withPlane, v);
    const items = toolById("tool.sketch")!.items!(ctx);
    expect(items.map((i) => i.label)).toEqual(["Top (XY)", "Front (XZ)", "Right (YZ)", "plane_1", "On the selected face"]);
    items[3].run(ctx);
    expect(out.sketches).toEqual([{ type: "ref", ref: { datum: "plane_1" } }]);
  });
});

describe("where a sketch placed by reference is drawn", () => {
  it("a default plane, a plane feature as the rebuild has it, a face by the kernel's rule", () => {
    const top = planeSpecFrameIn({ type: "ref", ref: { datum: "Top" } }, view);
    expect(typeof top !== "string" && top.z).toEqual([0, 0, 1]);
    const face = planeSpecFrameIn({ type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } }, view);
    if (typeof face === "string") throw new Error(face);
    near(face.origin, [0, 0, 6]);
    near(face.z, [0, 0, 1]);
    // Offset along the normal, then turned over.
    const moved = planeSpecFrameIn({ type: "ref", ref: { datum: "Top" }, offset: 5, flip: true }, view);
    if (typeof moved === "string") throw new Error(moved);
    near(moved.origin, [0, 0, 5]);
    near(moved.z, [0, 0, -1]);
    // Written out: itself.
    const written = planeSpecFrameIn({ type: "datum", normal: [1, 0, 0], origin: [3, 0, 0] }, view);
    expect(typeof written !== "string" && written.origin).toEqual([3, 0, 0]);
  });

  it("what can't be a sketch plane says why", () => {
    expect(planeOfRef({ datum: "plane_9" }, view)).toMatch(/plane_9 has not built/);
    expect(planeOfRef({ datum: "X" }, view)).toMatch(/X is an axis, not a plane/);
    expect(planeOfRef({ face: { type: "cylindrical", pick: "largest" } }, view)).toMatch(/curved/);
    expect(planeOfRef({ edge: { type: "edge", kind: "line", pick: "longest" } }, view)).toMatch(/not a plane/);
    expect(planeOfRef({ face: { type: "planar", normal: [0, 0, 1], pick: "largest" } }, null)).toMatch(/not rebuilt/);
  });

  it("an existing sketch is where the rebuild put it; Extrude and Cut read its normal from there", () => {
    const onFace: RawDocument = {
      ...doc,
      features: [
        ...doc.features,
        { id: "sketch_2", op: "sketch", plane: { type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } }, entities: [{ id: "c1", type: "circle", center: [-20, 0], radius: 5 }] },
      ],
    };
    const v = viewOf(oc, onFace);
    const sk = onFace.features[3];
    const f = sketchFrameIn(sk, v);
    if (typeof f === "string") throw new Error(f);
    near(f.origin, [0, 0, 6]);
    expect(sketchNormal(sk, v)).toEqual([0, 0, 1]);
    // A cut on the top face goes into the part: backwards from the face's outward normal.
    const { ctx } = harness(onFace, v, { selected: sk });
    expect(extrudeFeature(ctx, "cut")).toMatchObject({ op: "cut", sketch: "sketch_2", direction: [0, 0, -1] });
    expect(planeChoices(onFace.features as Record<string, unknown>[]).map((c) => c.id)).toEqual(["Top", "Front", "Right"]);
  });
});

describe("drawing the planes", () => {
  it("with no part: a 100 mm square on the plane's origin", () => {
    const r = planeRect(DEFAULT_DATUMS.Top as Extract<(typeof DEFAULT_DATUMS)[string], { kind: "plane" }>, null, true);
    expect(r.corners).toEqual([
      [-50, -50, 0],
      [50, -50, 0],
      [50, 50, 0],
      [-50, 50, 0],
    ]);
  });

  it("sized to the part: its box seen along the normal, plus a tenth (at least 5 mm)", () => {
    const box = { min: [-40, -20, 0] as [number, number, number], max: [40, 20, 6] as [number, number, number] };
    // Top: x -40..40, y -20..20, margin 8 (a tenth of 80).
    const top = planeRect(DEFAULT_DATUMS.Top as never, box, true);
    near(top.corners[0], [-48, -28, 0]);
    near(top.corners[2], [48, 28, 0]);
    // Front (normal -Y, x along X, y = n x x = +Z): x -40..40, z 0..6 (and the origin), margin 8.
    const front = planeRect(DEFAULT_DATUMS.Front as never, box, true);
    near(front.corners[0], [-48, 0, -8]);
    near(front.corners[2], [48, 0, 14]);
    const axis = axisEnds({ kind: "axis", origin: [0, 0, 0], direction: [0, 0, 1] }, box);
    near(axis[0], [0, 0, -5]);
    near(axis[1], [0, 0, 11]);
    const shapes = datumShapes({ Top: DEFAULT_DATUMS.Top, p: { kind: "point", at: [1, 2, 3] } }, box);
    expect(shapes.map((s) => [s.kind, s.id, s.isDefault])).toEqual([
      ["plane", "Top", true],
      ["point", "p", false],
    ]);
  });

  it("shown as SOLIDWORKS does: default planes hidden until selected or shown; features shown; Planes hides all but the origin", () => {
    const v = DEFAULT_DATUM_VIEW;
    expect(datumVisible("Top", v)).toBe(false);
    expect(datumVisible("Top", v, ["Top"])).toBe(true);
    expect(datumVisible("plane_1", v)).toBe(true);
    expect(datumVisible("Origin", v)).toBe(true);
    const shown = toggleEye(v, "Top");
    expect(eyeOpen("Top", shown)).toBe(true);
    // Back to the default: the override is dropped.
    expect(toggleEye(shown, "Top")).toEqual(v);
    const off = { ...shown, planes: false };
    expect(datumVisible("Top", off)).toBe(false);
    expect(datumVisible("Origin", off)).toBe(true);
    expect(datumVisible("plane_1", off, ["plane_1"])).toBe(true);
    // Showing one while all are hidden turns Planes back on.
    expect(setShown(off, "plane_1", true).planes).toBe(true);
    expect(setShown(v, "plane_1", false).shown).toEqual({ plane_1: false });
  });

  it("the remembered view is checked: anything malformed is the default", () => {
    expect(parseDatumView(JSON.stringify({ shown: { Top: true, x: "yes" }, planes: false }))).toEqual({ shown: { Top: true }, planes: false });
    expect(parseDatumView("{")).toEqual(DEFAULT_DATUM_VIEW);
    expect(parseDatumView(null)).toEqual(DEFAULT_DATUM_VIEW);
    expect(parseDatumView('{"planes": 1, "shown": {}}')).toEqual(DEFAULT_DATUM_VIEW);
  });
});

describe("vertices and planes in the selection", () => {
  it("a click selects one; Ctrl- or Shift-click adds it or takes it out", () => {
    const vtx = { kind: "vertex" as const, edge: 2, at: "end" as const, point: [0, 0, 0] as [number, number, number] };
    const top = { kind: "datum" as const, id: "Top", point: [0, 0, 0] as [number, number, number] };
    expect(pickInto(EMPTY_SELECTION, vtx, false)).toEqual({ faces: [], edges: [], vertices: [{ edge: 2, at: "end" }] });
    const both = pickInto(pickInto(EMPTY_SELECTION, vtx, false), top, true);
    expect(both).toEqual({ faces: [], edges: [], vertices: [{ edge: 2, at: "end" }], datums: ["Top"] });
    expect(pickInto(both, vtx, true)).toEqual({ faces: [], edges: [], datums: ["Top"] });
    expect(pickInto(both, top, false)).toEqual({ faces: [], edges: [], datums: ["Top"] });
  });

  it("the chip names one, and counts more", () => {
    const e = frontTopEdge();
    expect(selectionText(sel({ vertices: [{ edge: e, at: "start" }] }), view.faces, view.edges)).toMatch(/^vertex · /);
    expect(selectionText(sel({ datums: ["Top"] }), view.faces, view.edges)).toBe("Top plane");
    expect(selectionText(sel({ faces: [topFace()], datums: ["Top", "X"], vertices: [{ edge: e, at: "end" }] }), view.faces, view.edges)).toBe("1 face + 1 vertex + 1 plane + 1 axis");
    expect(describeDatum("p", { p: { kind: "point", at: [1, 2.5, 0] } })).toBe("p · point · 1, 2.5, 0");
  });

  it("Use selected: a vertex is that end of its edge, a plane its id", () => {
    const e = frontTopEdge();
    const v = refFromSelection(sel({ vertices: [{ edge: e, at: "start" }] }), view, ["point"]);
    expect(v.ok && "edge" in v.ref && v.ref.at).toBe("start");
    expect(refFromSelection(sel({ datums: ["Right"] }), view, ["plane"])).toEqual({ ok: true, ref: { datum: "Right" } });
    expect(refFromSelection(sel({ datums: ["Right"] }), view, ["axis"])).toEqual({ ok: false, error: "Right plane is a plane, but an axis is needed here." });
  });
});

describe("the AI sees the reference geometry", () => {
  it("the part packet lists the defaults and each plane, axis and point with its frame; a feature packet has its frame now", async () => {
    const withRefs: RawDocument = {
      ...doc,
      features: [
        ...doc.features,
        { id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 20 },
        { id: "axis_1", op: "axis", mode: "cylinder", refs: [{ face: { type: "cylindrical", pick: "largest" } }] },
        { id: "point_1", op: "point", mode: "coords", at: [1, 2, 3], suppressed: true },
      ],
    };
    const kernel = new LocalKernel(() => oc);
    const part = await buildPacket(withRefs, { kind: "part" }, kernel);
    const refs = (part.part as { referenceGeometry: { defaults: string; features: unknown[] } }).referenceGeometry;
    expect(refs.defaults).toMatch(/Top \(XY, normal \+Z\)/);
    expect(refs.features[0]).toEqual({ id: "plane_1", op: "plane", mode: "offset", kind: "plane", origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] });
    expect(refs.features[1]).toMatchObject({ id: "axis_1", kind: "axis", origin: [30, 0, expect.any(Number)] });
    expect(refs.features[2]).toEqual({ id: "point_1", op: "point", mode: "coords", built: false, suppressed: true });
    const one = await buildPacket(withRefs, { kind: "feature", id: "plane_1" }, kernel);
    expect((one.measurements as { now?: unknown }).now).toEqual({ kind: "plane", origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] });
  });
});
