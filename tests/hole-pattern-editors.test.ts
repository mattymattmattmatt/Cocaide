// Wave 5: the editors' and tools' rules for holes, patterns and mirrors, pure:
// each Hole Wizard choice's patch (and that the document it makes is valid
// and cuts what the table says), the instance tick boxes of patterns, and the
// Hole, Pattern, Sketch-driven pattern and Mirror tools run against real
// rebuilds.

import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { holePatternMeasurements } from "../src/ask/packet";
import { holeVolume, screwSize } from "../src/features/hole/standards";
import {
  addCentrePatch,
  blindDepth,
  calloutPreview,
  centresPatch,
  clickedCentre,
  endPatch,
  fitPatch,
  holeCount,
  holeSummary,
  kindPatch,
  pointSketches,
  pointsPatch,
  rememberedHole,
  removeCentrePatch,
  setCentrePatch,
  sizePatch,
  wizardSpec,
} from "../src/features/hole/wizard";
import { countPatch, patternRows, placeRows, seedsPatch, skipPatch } from "../src/features/linearPattern/instances";
import { placesOf, sketchPointList } from "../src/features/sketchPattern/ui";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { faceSelectorFor } from "../src/kernel/synthesize";
import { toolById } from "../src/ui/model/registry";
import type { Raw, ToolCtx } from "../src/ui/model/ToolContext";
import { faceWhere, harness, viewOf } from "./ui-fixtures";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const W = 80;
const D = 40;
const T = 10;
const PLATE = W * D * T;
const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const run = (id: string, ctx: ToolCtx) => toolById(id)!.run(ctx);

/** An 80 x 40 plate, 10 thick (x -40..40, y -20..20, z 0..10), and features after it. */
function plate(...more: Raw[]): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "plate",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: W, h: D }] },
      { id: "e1", op: "extrude", sketch: "s1", distance: T },
      ...more,
    ],
  };
}

/** Three points on the top face, sketched on it. */
const POINTS: Raw = {
  id: "pts",
  op: "sketch",
  plane: { type: "ref", ref: { face: TOP } },
  entities: [
    { id: "p1", type: "point", at: [-20, 0] },
    { id: "p2", type: "point", at: [0, 0] },
    { id: "p3", type: "point", at: [20, 0] },
  ],
};

const hole = (f: Raw): Raw => ({ id: "h", op: "hole", face: TOP, center: [0, 0], depth: "through", ...f });

/** The hole after applying a patch (as updateFeature merges it: null removes a key). */
function patched(f: Raw, patch: Raw | null | string): Raw {
  if (patch === null || typeof patch === "string") throw new Error(String(patch));
  const out: Raw = { ...f };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

function built(doc: RawDocument) {
  const r = rebuild(doc, oc);
  try {
    return { errors: r.errors, volume: r.measurements?.volume ?? 0, holes: r.holes };
  } finally {
    r.dispose();
  }
}

const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));

describe("the Hole Wizard's choices", () => {
  it("a size takes every number from the table; the type picker swaps them for the new type's", () => {
    let f = hole({ diameter: 5 });
    f = patched(f, sizePatch(f, "M6"));
    expect(f).toEqual(hole({ size: "M6" }));
    expect(wizardSpec(f)).toEqual({ kind: "simple", diameter: 6.6 });
    f = patched(f, kindPatch(f, "counterbore"));
    expect(wizardSpec(f)).toEqual({ kind: "counterbore", diameter: 6.6, counterbore: { diameter: 11, depth: 6.5 } });
    f = patched(f, kindPatch(f, "countersink"));
    expect(wizardSpec(f)).toEqual({ kind: "countersink", diameter: 6.6, countersink: { diameter: 13.7, angle: 90 } });
    f = patched(f, kindPatch(f, "tapped"));
    expect(f.fit).toBeUndefined();
    expect(wizardSpec(f)).toMatchObject({ kind: "tapped", diameter: 5, thread: { designation: "M6×1", major: 6, pitch: 1, depth: "through" } });
    expect(errorsOf(plate(f))).toEqual([]);
  });

  it("a fit picks the ISO 273 clearance; normal is left out of the document", () => {
    const f = hole({ size: "M8" });
    expect(wizardSpec(patched(f, fitPatch("close")))).toEqual({ kind: "simple", diameter: 8.4 });
    expect(wizardSpec(patched(f, fitPatch("loose")))).toEqual({ kind: "simple", diameter: 10 });
    expect(fitPatch("normal")).toEqual({ fit: null, diameter: null });
  });

  it("without a size, a counterbore or countersink gets numbers in proportion to the bore, and tapped takes the nearest size", () => {
    const f = hole({ diameter: 5, depth: 12 });
    expect(kindPatch(f, "counterbore")).toMatchObject({ kind: "counterbore", counterbore: { diameter: 9, depth: 5 } });
    expect(kindPatch(f, "countersink")).toMatchObject({ kind: "countersink", countersink: { diameter: 10, angle: 90 } });
    // Ø5 is M6's tap drill.
    expect(kindPatch(f, "tapped")).toMatchObject({ kind: "tapped", size: "M6", diameter: null });
    for (const k of ["counterbore", "countersink", "tapped"] as const) expect(errorsOf(plate(patched(f, kindPatch(f, k))))).toEqual([]);
  });

  it("leaving the sizes keeps the numbers the hole had, written out", () => {
    const f = hole({ size: "M10", kind: "counterbore" });
    const custom = patched(f, sizePatch(f, ""));
    expect(custom).toEqual(hole({ kind: "counterbore", diameter: 11, counterbore: { diameter: 17.5, depth: 10.8 } }));
    expect(wizardSpec(custom)).toEqual(wizardSpec(f));
    // A tapped one becomes a plain hole the thread's size across.
    const tapped = hole({ size: "M8", kind: "tapped" });
    expect(patched(tapped, sizePatch(tapped, ""))).toMatchObject({ kind: "simple", diameter: 8 });
  });

  it("end conditions: blind starts deep enough for the thread or the size; through drops a tapped hole's own thread depth", () => {
    const f = hole({ size: "M8", kind: "tapped", thread: { depth: 9 }, depth: 15 });
    expect(endPatch(f, "through")).toEqual({ depth: "through", thread: null });
    // 2 d + 3 pitches: 16 + 3.75.
    expect(blindDepth(hole({ size: "M8", kind: "tapped" }))).toBe(19.75);
    expect(endPatch(hole({ size: "M8", kind: "tapped" }), "blind")).toEqual({ depth: 19.75 });
    // A counterbored M6: two diameters, and below the counterbore.
    expect(blindDepth(hole({ size: "M6", kind: "counterbore" }))).toBe(12);
    expect(endPatch(hole({ diameter: 5, depth: 8 }), "blind")).toEqual({});
    expect(endPatch(hole({ diameter: 5 }), "upToNext")).toEqual({ depth: "upToNext" });
  });

  it("centres: one is center, several are centers; a click adds one where it landed on the face, not twice", () => {
    let f = hole({ diameter: 5 });
    f = patched(f, addCentrePatch(f, [10, 5]));
    expect(f.centers).toEqual([[0, 0], [10, 5]]);
    expect(f.center).toBeUndefined();
    expect(addCentrePatch(f, [10, 5])).toBeNull();
    f = patched(f, setCentrePatch(f, 1, 1, "=2 * 4"));
    expect(f.centers).toEqual([[0, 0], [10, "=2 * 4"]]);
    f = patched(f, removeCentrePatch(f, 0));
    expect(f).toMatchObject({ center: [10, "=2 * 4"] });
    expect(f.centers).toBeUndefined();
    expect(removeCentrePatch(f, 0)).toBeNull();
    expect(centresPatch([[1, 2]])).toEqual({ center: [1, 2], centers: null, points: null });
  });

  it("works out where a click lands in the face's frame, and refuses a face that faces another way", () => {
    const face = { type: "plane", normal: [0, 0, 1] as [number, number, number], point: [5, 5, 10] as [number, number, number] };
    expect(clickedCentre(face, [12.5, -3, 10], [0, 0, 1])).toEqual([12.5, -3]);
    expect(clickedCentre({ ...face, normal: [1, 0, 0] }, [40, 0, 5], [0, 0, 1])).toMatch(/does not face the way/);
    expect(clickedCentre({ type: "cylinder" }, [0, 0, 0], [0, 0, 1])).toMatch(/not flat/);
    expect(clickedCentre(undefined, undefined, [0, 0, 1])).toMatch(/Click a point/);
  });

  it("sketch points: the sketches that have some, how many holes, and the patch", () => {
    const before = plate(POINTS).features;
    expect(pointSketches(before)).toEqual([["pts", "pts (3 points)"]]);
    const f = patched(hole({ size: "M6", kind: "counterbore" }), pointsPatch("pts"));
    expect(f.points).toBe("pts");
    expect(f.center).toBeUndefined();
    expect(holeCount(f, before)).toBe(3);
    expect(holeSummary(f, before)).toBe("3 × M6 counterbore");
    expect(holeSummary(hole({ diameter: 6.6 }))).toBe("Ø6.6");
  });

  it("previews the callout a drawing will give", () => {
    const spec = (f: Raw) => {
      const s = wizardSpec(f);
      if (typeof s === "string") throw new Error(s);
      return s;
    };
    expect(calloutPreview(spec(hole({ size: "M6", kind: "counterbore" })), "through")).toEqual(["Ø6.6 THRU", "CBORE Ø11 × 6.5 DEEP"]);
    expect(calloutPreview(spec(hole({ size: "M8", kind: "tapped", depth: 15 })), 15)).toEqual(["M8×1.25 - 6H ⌴11.25", "Ø6.8 ⌴15"]);
    expect(calloutPreview(spec(hole({ size: "M5", kind: "countersink" })), 8)).toEqual(["Ø5.5 × 8 DEEP", "CSK Ø11.5 × 90°"]);
  });

  it("remembers the last hole's size, type, fit and depth for the next", () => {
    expect(rememberedHole([])).toEqual({ diameter: 5, depth: "through" });
    const last = hole({ size: "M6", kind: "counterbore", fit: "close", depth: 20, center: [1, 1] });
    expect(rememberedHole([last])).toEqual({ size: "M6", kind: "counterbore", fit: "close", depth: 20 });
  });

  it("a counterbored M6 made by the choices cuts what the formula says", () => {
    let f = hole({ diameter: 5 });
    f = patched(f, sizePatch(f, "M6"));
    f = patched(f, kindPatch(f, "counterbore"));
    const r = built(plate(f));
    expect(r.errors).toEqual([]);
    const m6 = screwSize("M6")!;
    expect(r.volume).toBeCloseTo(PLATE - holeVolume({ diameter: m6.clearance.normal, counterbore: m6.counterbore }, T), 3);
  });
});

describe("pattern instances in the editor", () => {
  it("numbers a grid row by row and labels each with its place; a circular pattern with its angle", () => {
    const grid = patternRows({ op: "linearPattern", count: 3, direction2: [0, 1, 0], count2: 2, skip: [5] });
    expect(grid.map((r) => r.label)).toEqual(["1 [1, 1]", "2 [2, 1]", "3 [3, 1]", "4 [1, 2]", "5 [2, 2]", "6 [3, 2]"]);
    expect(grid.filter((r) => r.skipped).map((r) => r.n)).toEqual([5]);
    expect(patternRows({ op: "linearPattern", count: 3 }).map((r) => r.label)).toEqual(["1", "2", "3"]);
    expect(patternRows({ op: "circularPattern", count: 3, angle: 180 }).map((r) => r.label)).toEqual(["1 (0°)", "2 (90°)", "3 (180°)"]);
    expect(patternRows({ op: "circularPattern", count: 4 }).map((r) => r.label)).toEqual(["1 (0°)", "2 (90°)", "3 (180°)", "4 (270°)"]);
    expect(placeRows([[10, 0], [20, 5]], [3]).map((r) => [r.label, r.skipped])).toEqual([["1 (the seed)", false], ["2 at [10, 0]", false], ["3 at [20, 5]", true]]);
  });

  it("unticking skips an instance, ticking brings it back; never the original, never every copy", () => {
    const f = { op: "linearPattern", count: 4, skip: [3] };
    const rows = patternRows(f);
    expect(skipPatch(f, rows, 2, false)).toEqual({ skip: [2, 3] });
    expect(skipPatch(f, rows, 3, true)).toEqual({ skip: null });
    expect(skipPatch(f, rows, 1, false)).toMatch(/original/);
    expect(skipPatch({ ...f, skip: [2, 3] }, rows, 4, false)).toMatch(/at least one copy/);
  });

  it("a smaller count drops the skips past its end", () => {
    expect(countPatch({ op: "linearPattern", count: 5, skip: [2, 5] }, "count", 4)).toEqual({ count: 4, skip: [2] });
    expect(countPatch({ op: "linearPattern", count: 5, skip: [4, 5] }, "count", 3)).toEqual({ count: 3, skip: null });
    expect(countPatch({ op: "linearPattern", count: 5 }, "count", 3)).toEqual({ count: 3 });
  });

  it("one ticked feature is `feature`, several are `features`, none is refused", () => {
    expect(seedsPatch(["a"])).toEqual({ feature: "a", features: null });
    expect(seedsPatch(["a", "b"])).toEqual({ features: ["a", "b"], feature: null });
    expect(seedsPatch([])).toMatch(/at least one/);
  });

  it("a sketch-driven pattern's places are its sketch's points, or its table", () => {
    const before = plate(POINTS).features;
    expect(sketchPointList(before, "pts")).toEqual([["p1", [-20, 0]], ["p2", [0, 0]], ["p3", [20, 0]]]);
    expect(placesOf({ sketch: "pts" }, before)).toEqual([[-20, 0], [0, 0], [20, 0]]);
    expect(placesOf({ sketch: "pts", positions: [[1, 2], [3, 4]] }, before)).toEqual([[1, 2], [3, 4]]);
  });
});

describe("the packet tells the agent a hole's numbers and a pattern's instances", () => {
  it("reads the hole's size, type, numbers, thread and hole count", () => {
    const before = plate(POINTS).features;
    expect(holePatternMeasurements(hole({ size: "M8", kind: "tapped", depth: 15, points: "pts", center: undefined }), before)).toEqual({
      kind: "tapped",
      diameter: 6.8,
      size: "M8",
      thread: "M8×1.25 - 6H ⌴11.25",
      holes: 3,
      at: "the points of pts",
    });
    expect(holePatternMeasurements({ op: "linearPattern", features: ["a", "b"], count: 3, count2: 2, direction2: [0, 1, 0], skip: [4] }, [])).toEqual({
      seeds: ["a", "b"],
      instances: 6,
      skipped: [4],
      copies: 4,
    });
  });
});

describe("the tools", () => {
  it("Hole at a selected sketch's points drills into the face the sketch stands on, with the last hole's settings", () => {
    const doc = plate(hole({ id: "h0", size: "M6", kind: "counterbore", center: [30, 10] }), POINTS);
    const view = viewOf(oc, doc);
    const sketch = (harness(doc, view).ctx.resolved as Raw[]).find((f) => f.id === "pts");
    const { ctx, out } = harness(doc, view, { selected: sketch });
    run("tool.hole", ctx);
    expect(out.created).toEqual([{ id: "hole_1", op: "hole", face: TOP, points: "pts", size: "M6", kind: "counterbore", depth: "through" }]);
    const r = built({ ...doc, features: [...doc.features, out.created[0] as Raw] });
    expect(r.errors).toEqual([]);
    const m6 = screwSize("M6")!;
    expect(r.volume).toBeCloseTo(PLATE - 4 * holeVolume({ diameter: m6.clearance.normal, counterbore: m6.counterbore }, T), 3);
  });

  it("Linear pattern takes its direction from a selected edge; Circular pattern its axis from a selected round face", () => {
    const doc = plate(hole({ id: "h0", diameter: 6, center: [5, 0] }), { id: "boss_s", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, T] }, entities: [{ id: "c", type: "circle", center: [20, 0], radius: 8 }] }, { id: "boss", op: "extrude", sketch: "boss_s", distance: 5 });
    const view = viewOf(oc, doc);
    const h0 = (harness(doc, view).ctx.resolved as Raw[]).find((f) => f.id === "h0");
    // A long straight edge along X (the plate's front top edge).
    const edge = view.edges.findIndex((e) => e.kind === "line" && Math.abs(Math.abs(e.direction![0]) - 1) < 1e-9 && Math.abs(e.length - W) < 1e-6);
    expect(edge).toBeGreaterThanOrEqual(0);
    const linear = harness(doc, view, { selected: h0, selection: { faces: [], edges: [edge] } });
    run("tool.linearPattern", linear.ctx);
    const lp = linear.out.created[0] as Raw;
    expect(lp.direction).toBeUndefined();
    expect(lp.along).toHaveProperty("edge");
    const wall = faceWhere(view, (f) => f.type === "cylinder" && !f.cylinder?.concave);
    const circular = harness(doc, view, { selected: h0, selection: { faces: [wall], edges: [] } });
    run("tool.circularPattern", circular.ctx);
    const cp = circular.out.created[0] as Raw;
    expect(cp.axis).toEqual({ ref: { face: faceSelectorFor(view.faces, wall).ok ? (faceSelectorFor(view.faces, wall) as { selector: unknown }).selector : null } });
    // Both rebuild: three holes 10 apart along the edge; two about the boss's axis (x = 20), the copy at x = 35.
    const withLinear = built({ ...doc, features: [...doc.features, lp] });
    expect(withLinear.errors).toEqual([]);
    expect(withLinear.holes.map((h) => h.copies)).toEqual([2]);
    const withCircular = built({ ...doc, features: [...doc.features, { ...cp, count: 2 }] });
    expect(withCircular.errors).toEqual([]);
    const boss = Math.PI * 64 * 5;
    expect(withLinear.volume).toBeCloseTo(PLATE + boss - 3 * Math.PI * 9 * T, 3);
    expect(withCircular.volume).toBeCloseTo(PLATE + boss - 2 * Math.PI * 9 * T, 3);
  });

  it("Mirror about a flat face selected in the view: the plane by reference", () => {
    const doc = plate(hole({ id: "h0", diameter: 6, center: [-30, 0] }));
    const view = viewOf(oc, doc);
    const h0 = (harness(doc, view).ctx.resolved as Raw[]).find((f) => f.id === "h0");
    const side = faceWhere(view, (f) => f.type === "plane" && f.normal![0] > 0.99);
    const { ctx, out } = harness(doc, view, { selected: h0, selection: { faces: [side], edges: [] } });
    run("tool.mirror", ctx);
    const m = out.created[0] as Raw;
    expect(m.plane).toEqual({ type: "ref", ref: { face: (faceSelectorFor(view.faces, side) as { selector: unknown }).selector } });
    // Mirrored about x = 40: the copy at x = 110 is off the plate, so the mirror fails, saying so.
    expect(built({ ...doc, features: [...doc.features, m] }).errors.join(" ")).toMatch(/mirror/);
  });

  it("Sketch-driven pattern copies the selected feature to the newest sketch with points, or says what to make first", () => {
    const doc = plate(hole({ id: "h0", diameter: 6, center: [-20, 0] }), POINTS);
    const view = viewOf(oc, doc);
    const h0 = (harness(doc, view).ctx.resolved as Raw[]).find((f) => f.id === "h0");
    const { ctx, out } = harness(doc, view, { selected: h0 });
    run("tool.sketchPattern", ctx);
    expect(out.created).toEqual([{ id: "sketchPattern_1", op: "sketchPattern", feature: "h0", sketch: "pts" }]);
    const r = built({ ...doc, features: [...doc.features, out.created[0] as Raw] });
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(PLATE - 3 * Math.PI * 9 * T, 3);
    const none = harness(plate(hole({ id: "h0", diameter: 6 })), null, { selected: h0 });
    run("tool.sketchPattern", none.ctx);
    expect(none.out.notices[0][1]).toMatch(/Sketch the places first/);
  });

  it("the editors' patches go through updateFeature: skip an instance of a pattern of two features", () => {
    const doc = plate(hole({ id: "a", diameter: 4, center: [-30, -10] }), hole({ id: "b", diameter: 4, center: [-30, 10] }), { id: "lp", op: "linearPattern", feature: "a", direction: [1, 0, 0], spacing: 20, count: 4 });
    const seeds = seedsPatch(["a", "b"]) as Raw;
    const two = apply(doc, { type: "updateFeature", id: "lp", patch: seeds });
    expect(two.ok).toBe(true);
    const lp = (two as { doc: RawDocument }).doc.features.find((f) => f.id === "lp")!;
    const skipped = apply((two as { doc: RawDocument }).doc, { type: "updateFeature", id: "lp", patch: skipPatch(lp, patternRows(lp), 3, false) as Raw });
    expect(skipped.ok).toBe(true);
    const r = built((skipped as { doc: RawDocument }).doc);
    expect(r.errors).toEqual([]);
    // 2 seeds x (1 + 2 copies) holes of Ø4.
    expect(r.volume).toBeCloseTo(PLATE - 6 * Math.PI * 4 * T, 3);
  });
});
