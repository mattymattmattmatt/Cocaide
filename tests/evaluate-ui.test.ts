// The Evaluate and view modules (src/ui/evaluate/**, src/ui/viewport/silhouette.ts):
// Measure's arithmetic, drag handles, dimensions on the model, the section
// plane, selection filters and box select, the command palette's ranking, the
// tree's parents and children, the remembered view and curved outlines.
// Expected values are written out for a 100 × 60 × 8 plate with a Ø20 hole
// through its middle (built in node, as the worker builds it).

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { Vec2 } from "../src/doc/types";
import { loadOC, type OC } from "../src/kernel";
import { featureDimensions, dimensionPatch, sketchOfFeature } from "../src/ui/evaluate/dimensions3d";
import { parseMemory, pushView, sameCamera, type CameraState } from "../src/ui/evaluate/display";
import { allows, boxOf, boxSelect, mergeBox, NO_FILTER, segmentTouches, toggleFilter, triangleTouches, type Projected } from "../src/ui/evaluate/filter";
import { alongAxis, dragValue, featureHandles, handlePatch, handleTip, ownerOfFace, rulerStep } from "../src/ui/evaluate/handles";
import { angleBetween, centreDistance, kernelRef, measure, measureItems, measurePick, rowText } from "../src/ui/evaluate/measure";
import { score, searchPalette, type PaletteEntry } from "../src/ui/evaluate/palette";
import { childrenOf, parentsOf } from "../src/ui/evaluate/relations";
import { extentAlong, isCutAway, sectionChoices, sectionOn, sectionPlane, type SectionState } from "../src/ui/evaluate/section";
import { EMPTY_SELECTION, type PickTarget } from "../src/ui/model/selection";
import { adjacency, silhouette } from "../src/ui/viewport/silhouette";
import type { RebuildView } from "../src/worker/protocol";
import { example, viewOf } from "./ui-fixtures";

let oc: OC;
let plate: RebuildView;
const plateDoc: RawDocument = {
  version: 1,
  units: "mm",
  name: "plate",
  features: [
    {
      id: "s1",
      op: "sketch",
      plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
      entities: [
        { id: "l1", type: "line", start: [-50, -30], end: [50, -30] },
        { id: "l2", type: "line", start: [50, -30], end: [50, 30] },
        { id: "l3", type: "line", start: [50, 30], end: [-50, 30] },
        { id: "l4", type: "line", start: [-50, 30], end: [-50, -30] },
        { id: "c1", type: "circle", center: [0, 0], radius: 10 },
      ],
      constraints: [],
    },
    { id: "e1", op: "extrude", sketch: "s1", distance: 8 },
  ],
};
const features = plateDoc.features as Record<string, unknown>[];

beforeAll(async () => {
  oc = await loadOC();
  plate = viewOf(oc, plateDoc);
});

const faceWhere = (pred: (f: RebuildView["faces"][number]) => boolean) => {
  const i = plate.faces.findIndex(pred);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
};
const top = () => faceWhere((f) => f.type === "plane" && f.normal![2] > 0.99);
const bottom = () => faceWhere((f) => f.type === "plane" && f.normal![2] < -0.99);
const wall = () => faceWhere((f) => f.type === "cylinder");

describe("measure", () => {
  it("one flat face: its area (100·60 − π·10²) and normal", () => {
    const r = measure(measureItems({ faces: [top()], edges: [] }, plate.faces, plate.edges));
    expect(r.title).toBe("Flat face");
    const area = r.rows.find((x) => x.key === "area")!;
    expect(area.value).toBeCloseTo(6000 - Math.PI * 100, 6);
    expect(rowText(r.rows.find((x) => x.key === "normal")!)).toBe("X 0, Y 0, Z 1");
  });

  it("the hole wall: diameter 20, radius 10, area 2π·10·8", () => {
    const r = measure(measureItems({ faces: [wall()], edges: [] }, plate.faces, plate.edges));
    expect(r.title).toBe("Hole wall");
    expect(r.rows.find((x) => x.key === "diameter")!.value).toBeCloseTo(20, 9);
    expect(r.rows.find((x) => x.key === "radius")!.value).toBeCloseTo(10, 9);
    expect(r.rows.find((x) => x.key === "area")!.value).toBeCloseTo(2 * Math.PI * 10 * 8, 6);
  });

  it("an edge: its length; a circular edge: its diameter and centre", () => {
    const long = plate.edges.findIndex((e) => e.kind === "line" && Math.abs(e.length - 100) < 1e-9);
    const r = measure(measureItems({ faces: [], edges: [long] }, plate.faces, plate.edges));
    expect(r.title).toBe("Straight edge");
    expect(rowText(r.rows.find((x) => x.key === "length")!)).toBe("100 mm");
    const circle = plate.edges.findIndex((e) => e.kind === "circle" && !e.seam);
    const c = measure(measureItems({ faces: [], edges: [circle] }, plate.faces, plate.edges));
    expect(c.title).toBe("Circular edge");
    expect(c.rows.find((x) => x.key === "diameter")!.value).toBeCloseTo(20, 9);
    expect(c.rows.find((x) => x.key === "length")!.value).toBeCloseTo(20 * Math.PI, 6);
  });

  it("top to bottom: normal distance 8, angle 0, the kernel's minimum distance with dX/dY/dZ, and a line labelled 8 mm", () => {
    const items = measureItems({ faces: [top(), bottom()], edges: [] }, plate.faces, plate.edges);
    expect(items.map(kernelRef)).toEqual([
      { kind: "face", index: top() },
      { kind: "face", index: bottom() },
    ]);
    const r = measure(items, { distance: 8, a: [10, 20, 8], b: [10, 20, 0] });
    const value = (k: string) => r.rows.find((x) => x.key === k)?.value;
    expect(value("normal")).toBeCloseTo(8, 12);
    expect(value("angle")).toBeCloseTo(0, 9);
    expect(value("distance")).toBe(8);
    expect([value("dx"), value("dy"), value("dz")]).toEqual([0, 0, 8]);
    expect(r.line).toEqual({ from: [10, 20, 8], to: [10, 20, 0], label: "8 mm" });
    // Before the kernel answers: the normal distance alone.
    expect(measure(items, null).rows.some((x) => x.key === "distance")).toBe(false);
  });

  it("a vertex to the hole wall: centre distance to its axis, √(50² + 30²)", () => {
    const corner = plate.edges.findIndex((e) => e.kind === "line" && Math.abs(e.start[0]) === 50 && Math.abs(e.start[1]) === 30);
    const items = measureItems({ faces: [wall()], edges: [], vertices: [{ edge: corner, at: "start" }] }, plate.faces, plate.edges);
    const r = measure(items, null);
    expect(r.rows.find((x) => x.key === "centre")!.value).toBeCloseTo(Math.hypot(50, 30), 9);
  });

  it("a straight edge to a circular edge: the centre's distance to the edge's line", () => {
    const long = plate.edges.findIndex((e) => e.kind === "line" && Math.abs(e.length - 100) < 1e-9 && e.start[1] === -30 && e.start[2] === 8);
    const circle = plate.edges.findIndex((e) => e.kind === "circle" && !e.seam && e.center![2] === 8);
    const r = measure(measureItems({ faces: [], edges: [long, circle] }, plate.faces, plate.edges));
    expect(r.rows.find((x) => x.key === "centre")!.value).toBeCloseTo(30, 9);
    expect(r.rows.find((x) => x.key === "diameter2")!.value).toBeCloseTo(20, 9);
  });

  it("the hole wall or its edge to a side face: the centre's distance square to the face, 50 (X) and 30 (Y)", () => {
    const side = faceWhere((f) => f.type === "plane" && f.normal![0] > 0.99);
    const front = faceWhere((f) => f.type === "plane" && f.normal![1] < -0.99);
    const r = measure(measureItems({ faces: [wall(), side], edges: [] }, plate.faces, plate.edges));
    expect(r.rows.find((x) => x.key === "centre")!.value).toBeCloseTo(50, 9);
    // The line runs from the axis (level with the middle of the wall, Z 4) square to the face.
    expect(r.line!.from.map((x) => +x.toFixed(9))).toEqual([0, 0, 4]);
    expect(r.line!.to.map((x) => +x.toFixed(9))).toEqual([50, 0, 4]);
    const circle = plate.edges.findIndex((e) => e.kind === "circle" && !e.seam && e.center![2] === 8);
    const e = measure(measureItems({ faces: [front], edges: [circle] }, plate.faces, plate.edges));
    expect(e.rows.find((x) => x.key === "centre")!.value).toBeCloseTo(30, 9);
    // The top face and the hole: the axis crosses the face, so there is no one centre distance.
    expect(measure(measureItems({ faces: [wall(), top()], edges: [] }, plate.faces, plate.edges)).rows.some((x) => x.key === "centre")).toBe(false);
  });

  it("two perpendicular faces are 90° apart; the Right plane to the Z axis is 0°", () => {
    const side = faceWhere((f) => f.type === "plane" && f.normal![0] > 0.99);
    expect(measure(measureItems({ faces: [top(), side], edges: [] }, plate.faces, plate.edges)).rows.find((x) => x.key === "angle")!.value).toBeCloseTo(90, 9);
    const r = measure(measureItems({ ...EMPTY_SELECTION, datums: ["Right", "Z"] }, plate.faces, plate.edges));
    expect(r.rows.find((x) => x.key === "angle")!.value).toBeCloseTo(0, 9);
  });

  it("several: totals", () => {
    const r = measure(measureItems({ faces: [top(), bottom(), wall()], edges: [] }, plate.faces, plate.edges));
    expect(r.rows[0].label).toBe("Total area (3 faces)");
    expect(r.rows[0].value).toBeCloseTo(2 * (6000 - Math.PI * 100) + 160 * Math.PI, 6);
  });

  it("centre distances between lines: parallel, and skew along the common perpendicular", () => {
    expect(centreDistance({ line: { point: [0, 0, 0], direction: [0, 0, 1] } }, { line: { point: [3, 4, 9], direction: [0, 0, -1] } }).distance).toBeCloseTo(5, 12);
    expect(centreDistance({ line: { point: [0, 0, 0], direction: [1, 0, 0] } }, { line: { point: [0, 0, 7], direction: [0, 1, 0] } }).distance).toBeCloseTo(7, 12);
    expect(angleBetween([1, 0, 0], [1, 1, 0])).toBeCloseTo(45, 12);
  });

  it("a click while measuring adds without Ctrl; a third starts again; empty space clears", () => {
    const a = { kind: "face", index: 1, point: [0, 0, 0] } as PickTarget;
    const b = { kind: "edge", index: 2, point: [0, 0, 0] } as PickTarget;
    const c = { kind: "face", index: 3, point: [0, 0, 0] } as PickTarget;
    const two = measurePick(measurePick(EMPTY_SELECTION, a), b);
    expect(two).toMatchObject({ faces: [1], edges: [2] });
    expect(measurePick(two, c)).toMatchObject({ faces: [3], edges: [] });
    expect(measurePick(two, a)).toMatchObject({ faces: [], edges: [2] });
    expect(measurePick(two, null)).toEqual(EMPTY_SELECTION);
  });
});

describe("drag handles", () => {
  it("an extrude has a depth arrow from its sketch's middle along its normal; its tip is on the end face", () => {
    const [h] = featureHandles(features[1], features[1], plate);
    expect(h).toMatchObject({ id: "e1:distance", feature: "e1", key: "distance", value: 8, scale: 1, min: 0, label: "Depth" });
    expect(h.dir).toEqual([0, 0, 1]);
    expect(handleTip(h)[2]).toBeCloseTo(8, 9);
    expect(ownerOfFace(plate.faces[top()], features, features, plate)?.id).toBe("e1:distance");
    expect(ownerOfFace(plate.faces[bottom()], features, features, plate)).toBeNull();
  });

  it("is locked when an expression sets the depth", () => {
    const [h] = featureHandles(features[1], { ...features[1], distance: "=t" }, plate);
    expect(h.locked).toMatch(/expression =t.*Properties/);
  });

  it("a midplane extrude's ends move half as far as its depth", () => {
    const [h] = featureHandles({ ...features[1], extent: "midplane" }, features[1], plate);
    expect(h.scale).toBe(2);
    expect(handleTip(h)[2]).toBeCloseTo(4, 9);
  });

  it("a drag snaps to whole millimetres (Shift: tenths), never to 0 or below", () => {
    const [h] = featureHandles(features[1], features[1], plate);
    expect(dragValue(h, 8, 3.4)).toBe(11);
    expect(dragValue(h, 8, 3.44, true)).toBe(11.4);
    expect(dragValue(h, 8, -20)).toBe(1);
    expect(handlePatch(h, features[1], 12)).toEqual({ distance: 12 });
    expect(handlePatch({ ...h, key: "direction2.distance" }, { direction2: { extent: "blind", distance: 3 } }, 5)).toEqual({ direction2: { extent: "blind", distance: 5 } });
  });

  it("reads how far along an arrow the pointer's ray passes, and refuses one pointing at the eye", () => {
    // Arrow up Z from the origin; a ray along −X at height 5: 5 along.
    expect(alongAxis([0, 0, 0], [0, 0, 1], [100, 0, 5], [-1, 0, 0])).toBeCloseTo(5, 12);
    expect(alongAxis([0, 0, 0], [0, 0, 1], [0, 0, 100], [0, 0, -1])).toBeNull();
    expect(rulerStep(10)).toBe(1);
    expect(rulerStep(0.5)).toBe(20);
  });
});

describe("dimensions on the model", () => {
  it("an extrude shows its depth along its arrow, editing the distance field", () => {
    const dims = featureDimensions("e1", features, features, plate, 0.2);
    expect(dims).toHaveLength(1);
    expect(dims[0]).toMatchObject({ id: "e1:distance", text: "8", edit: { kind: "feature", feature: "e1", key: "distance", value: 8 }, title: "e1 depth" });
    expect(dims[0].at[2]).toBeCloseTo(4, 9);
    expect(dimensionPatch({ kind: "feature", feature: "e1", key: "distance", value: 8 }, features[1], 10)).toEqual({ distance: 10 });
    expect(sketchOfFeature(features[1])).toBe("s1");
  });

  it("a sketch's dimensions come with it, each editing its own constraint", () => {
    const doc = example("bracket");
    const view = viewOf(oc, doc);
    const f = doc.features as Record<string, unknown>[];
    const dims = featureDimensions("ext_1", f, f, view, 0.2);
    const sketchDims = dims.filter((d) => d.edit.kind === "sketch");
    const constraints = ((f[0].constraints ?? []) as { value?: unknown }[]).filter((c) => c.value !== undefined);
    expect(sketchDims).toHaveLength(constraints.length);
    for (const d of sketchDims) expect(d.edit).toMatchObject({ kind: "sketch", sketch: "sketch_1" });
    expect(dims.some((d) => d.id === "ext_1:distance")).toBe(true);
  });
});

describe("section", () => {
  const box = { min: [-50, -30, 0] as [number, number, number], max: [50, 30, 8] as [number, number, number] };

  it("starts on a default plane through the middle of the part, rounded to a millimetre", () => {
    const s = sectionOn("Top", {}, box) as SectionState;
    expect(s).toMatchObject({ on: "Top", label: "Top plane", offset: 4, flip: false });
    const p = sectionPlane(s);
    expect(p.constant).toBe(4);
    expect(isCutAway(s, [0, 0, 6])).toBe(true);
    expect(isCutAway(s, [0, 0, 2])).toBe(false);
    expect(isCutAway({ ...s, flip: true }, [0, 0, 2])).toBe(true);
  });

  it("knows the extent along a normal; Front looks along −Y", () => {
    expect(extentAlong([0, -1, 0], [0, 0, 0], box)).toEqual({ min: -30, max: 30, middle: 0 });
    expect((sectionOn("Front", {}, box) as SectionState).normal).toEqual([0, -1, 0]);
  });

  it("on a flat face: just inside it, the face kept; anything else says what to pick", () => {
    const s = sectionOn("face", {}, box, plate.faces[top()]) as SectionState;
    expect(s.offset).toBe(-0.01);
    expect(isCutAway(s, [0, 0, 8])).toBe(true);
    expect(sectionOn("face", {}, box, plate.faces[wall()])).toMatch(/one flat face/);
    expect(sectionOn("Z", {}, box)).toMatch(/not a plane/);
  });

  it("offers the three default planes then the plane features", () => {
    expect(sectionChoices({ plane_1: { kind: "plane", origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] }, axis_1: { kind: "axis", origin: [0, 0, 0], direction: [1, 0, 0] } }).map((c) => c.id)).toEqual([
      "Front",
      "Top",
      "Right",
      "plane_1",
    ]);
  });
});

describe("selection filter and box select", () => {
  it("toggles kinds; none on picks anything", () => {
    expect(allows(NO_FILTER, "edge")).toBe(true);
    const faces = toggleFilter(NO_FILTER, "faces");
    expect(allows(faces, "face")).toBe(true);
    expect(allows(faces, "edge")).toBe(false);
    expect(allows(toggleFilter(faces, "planes"), "datum")).toBe(true);
    expect(toggleFilter(faces, "faces").size).toBe(0);
  });

  const sq = (x: number, y: number, s: number): (Vec2 | null)[][] => [
    [
      [x, y],
      [x + s, y],
      [x + s, y + s],
    ],
    [
      [x, y],
      [x + s, y + s],
      [x, y + s],
    ],
  ];
  const part: Projected = {
    faces: [sq(0, 0, 10), sq(20, 0, 10), [[[50, 50], null, [60, 60]]]],
    edges: [
      [[[0, 0], [10, 0]]],
      [[[5, 5], [40, 5]]],
    ],
    vertices: [
      { edge: 0, at: "start", p: [0, 0] },
      { edge: 1, at: "end", p: [40, 5] },
    ],
  };

  it("a window (left to right) takes what is wholly inside; a crossing box (right to left) what it touches", () => {
    const win = boxOf([-1, -1], [15, 15]);
    expect(win.crossing).toBe(false);
    expect(boxSelect(win.rect, false, part, NO_FILTER)).toEqual({ faces: [0], edges: [] });
    const cross = boxOf([25, 15], [15, -1]);
    expect(cross.crossing).toBe(true);
    expect(boxSelect(cross.rect, true, part, NO_FILTER).faces).toEqual([1]);
    expect(boxSelect(cross.rect, true, part, new Set(["edges"])).edges).toEqual([1]);
    expect(boxSelect(boxOf([-1, -1], [45, 15]).rect, false, part, new Set(["vertices"])).vertices).toHaveLength(2);
  });

  it("geometry: a segment through a box touches it; a box inside a triangle overlaps it", () => {
    const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(segmentTouches(r, [-5, 5], [15, 5])).toBe(true);
    expect(segmentTouches(r, [-5, -5], [-1, 20])).toBe(false);
    expect(triangleTouches({ x0: 4, y0: 4, x1: 5, y1: 5 }, [0, 0], [100, 0], [0, 100])).toBe(true);
  });

  it("Ctrl adds the box to the selection without repeats; a plain box replaces it", () => {
    const sel = { faces: [1], edges: [3] };
    expect(mergeBox(sel, { faces: [1, 2], edges: [] }, true)).toEqual({ faces: [1, 2], edges: [3] });
    expect(mergeBox(sel, { faces: [2], edges: [] }, false)).toEqual({ faces: [2], edges: [] });
  });
});

describe("command palette", () => {
  const e = (id: string, label: string, keywords?: string): PaletteEntry => ({ id, label, group: "Features", keywords, run: () => undefined });
  const list = [e("tool.extrude", "Extruded Boss"), e("tool.fillet", "Fillet", "round"), e("view.display.hiddenVisible", "Hidden lines visible"), e("tool.chamfer", "Chamfer")];

  it("ranks exact, prefix, word, all-words, substring and in-order letters", () => {
    expect(score("Fillet", "fillet")).toBe(100);
    expect(score("Fillet", "fil")).toBe(80);
    expect(score("Hidden lines visible", "lin")).toBe(60);
    expect(score("Hidden lines visible", "hid vis")).toBe(50);
    expect(score("Fillet", "lle")).toBe(40);
    expect(score("Fillet", "fllt")).toBe(10);
    expect(score("Fillet", "zz")).toBe(0);
  });

  it("finds Fillet by name and by a keyword, best first", () => {
    expect(searchPalette(list, "fil")[0].id).toBe("tool.fillet");
    expect(searchPalette(list, "round")[0].id).toBe("tool.fillet");
    expect(searchPalette(list, "").map((x) => x.id)).toEqual(list.map((x) => x.id));
  });
});

describe("parents and children in the tree", () => {
  it("an extrude's parent is its sketch; the sketch's children include the extrude", () => {
    const f = example("bracket").features as Record<string, unknown>[];
    expect(parentsOf(f, "ext_1")).toEqual(["sketch_1"]);
    expect(childrenOf(f, "sketch_1")).toContain("ext_1");
    expect(parentsOf(f, "sketch_1")).toEqual([]);
    expect(parentsOf(f, "nothing")).toEqual([]);
  });

  it("an expression reading a sketch dimension makes the sketch a parent", () => {
    const f = [
      { id: "sketch_1", op: "sketch" },
      { id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: "=sketch_1.width * 2" },
    ];
    expect(parentsOf(f, "plane_1")).toEqual(["sketch_1"]);
  });
});

describe("remembered view", () => {
  const cam: CameraState = { position: [100, -100, 80], target: [0, 0, 0], up: [0, 0, 1] };

  it("keeps a good entry and drops anything odd", () => {
    expect(parseMemory({ camera: cam, display: { style: "wireframe", perspective: false } })).toEqual({ camera: cam, display: { style: "wireframe", perspective: false } });
    expect(parseMemory({ camera: { position: [1, 2], target: [0, 0, 0], up: [0, 0, 1] }, display: { style: "bogus" } })).toEqual({});
    expect(parseMemory("junk")).toEqual({});
  });

  it("previous views: each settled camera once, newest last, at most the limit", () => {
    let stack = pushView([], cam);
    stack = pushView(stack, { ...cam });
    expect(stack).toHaveLength(1);
    stack = pushView(stack, { ...cam, position: [0, -200, 0] });
    expect(stack).toHaveLength(2);
    expect(sameCamera(stack[1], { ...cam, position: [0, -200, 1e-9] })).toBe(true);
    let many: CameraState[] = [];
    for (let i = 0; i < 40; i++) many = pushView(many, { ...cam, position: [i, 0, 0] }, 30);
    expect(many).toHaveLength(30);
    expect(many[29].position[0]).toBe(39);
  });
});

describe("curved outlines", () => {
  it("finds the shared triangle edge between a face turned to the eye and one turned away", () => {
    // Two triangles of one curved face folded along the edge (0,0,0)–(1,0,0): one faces +Z, the other +Y.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const adj = adjacency(positions, indices, [{ start: 0, count: 6 }], [true]);
    expect(adj.count).toBe(1);
    // Looking down −Z sees the first (normal +Z) and not the second: the fold is an outline.
    const seen = silhouette(adj, null, [0, 0, -1]);
    expect(seen).toHaveLength(6);
    expect([Array.from(seen.slice(0, 3)), Array.from(seen.slice(3))].map((p) => p.join(",")).sort()).toEqual(["0,0,0", "1,0,0"]);
    // A flat face has no outline.
    expect(adjacency(positions, indices, [{ start: 0, count: 6 }], [false]).count).toBe(0);
  });
});
