// The extrude, cut, fillet and chamfer editors' rules (Wave 3B), pure: each
// patch a field sends is applied to the bracket as the app would (one
// updateFeature) and must leave a valid document that rebuilds; the fields
// shown follow the feature; "Selected contours" lists a sketch's regions and
// ticks them into seed points; fillet radius sets and chamfer types.

import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { contourAt, contours, interiorPoint } from "../src/features/extrude/regions";
import { buildProfile } from "../src/geom/profile";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { EMPTY_SELECTION, type Selection } from "../src/ui/model/selection";
import { CUT_FIELDS, EXTRUDE_FIELDS } from "../src/ui/props/ExtrudeForm";
import {
  contourLabel,
  contoursPatch,
  defaultContours,
  direction2Patch,
  endOptions,
  endPatch,
  pickedContours,
  refKind,
  sketchContours,
  startKind,
  startPatch,
  thinPatch,
} from "../src/ui/props/extrude";
import { addSetPatch, chamferType, chamferTypePatch, describeSet, removeSetPatch, variablePatch } from "../src/ui/props/edgeTreat";
import { commitPatch, fieldTestId, visibleFields, type FormContext } from "../src/ui/props/spec";
import { UI_OPS } from "../src/features/uiDefs";
import type { RebuildView } from "../src/worker/protocol";
import { example, faceWhere, viewOf } from "./ui-fixtures";

type Raw = Record<string, unknown>;
let oc: OC;
let doc: RawDocument;
let view: RebuildView;
beforeAll(async () => {
  oc = await loadOC();
  doc = example("bracket"); // an 80 x 40 x 6 plate on Top, centred on the origin, a 6.6 hole at [30, 0]
  view = viewOf(oc, doc);
});

const sel = (s: Partial<Selection>): Selection => ({ ...EMPTY_SELECTION, ...s });
const ctx = (selection: Selection = EMPTY_SELECTION): Pick<FormContext, "selection" | "view" | "before"> => ({ selection, view, before: doc.features as Raw[] });
const form = (f: Raw, selection: Selection = EMPTY_SELECTION): FormContext => ({ f, resolved: f, before: doc.features as Raw[], bodies: ["main"], doc, view, selection });

/** A boss on the plate's top face (sketch on Top at z = 0, so it starts inside the plate): the feature the patches go to. */
const withFeature = (f: Raw, more: Raw[] = []): RawDocument => ({ ...doc, features: [...doc.features, ...more, f] });
const sq = { id: "sk", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 20] }, entities: [{ id: "r2", type: "rect", center: [0, 0], w: 10, h: 10 }], constraints: [] };

/** Applies the patch as the editor does, then rebuilds: returns the feature and the rebuild's errors. */
function patched(d: RawDocument, id: string, patch: Raw) {
  const r = apply(d, { type: "updateFeature", id, patch });
  if (!r.ok) throw new Error(r.error);
  const b = rebuild(r.doc, oc);
  try {
    return { f: r.doc.features.find((x) => x.id === id) as Raw, errors: b.errors, volume: b.measurements?.volume ?? 0, doc: r.doc };
  } finally {
    b.dispose();
  }
}

describe("end conditions in the editor", () => {
  it("offers SOLIDWORKS's end conditions; direction 2 has no two-way ones", () => {
    expect(endOptions(1).map(([v]) => v)).toEqual(["blind", "throughAll", "throughAllBoth", "upToNext", "upToVertex", "upToFace", "offsetFromFace", "midplane"]);
    expect(endOptions(2).map(([v]) => v)).toEqual(["blind", "throughAll", "upToNext", "upToVertex", "upToFace", "offsetFromFace"]);
  });

  it("knows what a reference is: plane, point, axis or face", () => {
    const before = [{ id: "p1", op: "plane" }, { id: "pt", op: "point" }];
    expect(refKind({ datum: "Top" }, before)).toBe("plane");
    expect(refKind({ datum: "Origin" }, before)).toBe("point");
    expect(refKind({ datum: "p1" }, before)).toBe("plane");
    expect(refKind({ datum: "pt" }, before)).toBe("point");
    expect(refKind({ face: { type: "planar" } }, before)).toBe("face");
    expect(refKind({ edge: {}, at: "end" }, before)).toBe("point");
    expect(refKind({ edge: {} }, before)).toBe("axis");
    expect(refKind(undefined, before)).toBeNull();
  });

  it("blind to through all drops the depth; back to blind brings 10 mm", () => {
    const f = { id: "e", op: "extrude", sketch: "sketch_1", distance: 6 };
    expect(endPatch(f, 1, "throughAll", ctx())).toEqual({ extent: "throughAll", distance: null, upTo: null, offset: null });
    expect(endPatch({ ...f, extent: "throughAll", distance: undefined }, 1, "blind", ctx())).toEqual({ extent: null, distance: 10, upTo: null, offset: null });
    // Mid plane and both ways leave no room for a second direction.
    expect(endPatch({ ...f, direction2: { extent: "blind", distance: 2 } }, 1, "midplane", ctx())).toMatchObject({ extent: "midplane", distance: 6, direction2: null });
  });

  it("up to surface takes the face selected; with nothing selected it says what to click", () => {
    const top = faceWhere(view, (x) => x.type === "plane" && x.normal![2] > 0.99);
    const f = { id: "e", op: "extrude", sketch: "sketch_1", distance: 6 };
    expect(endPatch(f, 1, "upToFace", ctx(sel({ faces: [top] })))).toEqual({ extent: "upToFace", distance: null, upTo: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } }, offset: null });
    expect(() => endPatch(f, 1, "upToFace", ctx())).toThrow(/Up to surface needs a face or a plane to go up to: click it in the view first/);
    // A plane picked in the tree serves too; a vertex is for up to vertex.
    expect(endPatch(f, 1, "offsetFromFace", ctx(sel({ datums: ["Top"] })))).toEqual({ extent: "offsetFromFace", distance: null, upTo: { datum: "Top" }, offset: 5 });
    expect(() => endPatch(f, 1, "upToVertex", ctx(sel({ faces: [top] })))).toThrow(/Up to vertex needs a vertex or a point/);
  });

  it("keeps what it goes up to when the new end condition can use it", () => {
    const f = { id: "e", op: "extrude", sketch: "sketch_1", extent: "upToFace", upTo: { datum: "Top" } };
    expect(endPatch(f, 1, "offsetFromFace", ctx())).toEqual({ extent: "offsetFromFace", distance: null, upTo: { datum: "Top" }, offset: 5 });
    expect(endPatch({ ...f, extent: "upToVertex", upTo: { datum: "Origin" } }, 1, "upToVertex", ctx())).toMatchObject({ upTo: { datum: "Origin" } });
  });

  it("each patch leaves a document that validates and rebuilds: an extrude up to a plate face from a sketch above it", () => {
    // A 10 x 10 boss sketched at z = 20, going down (-Z) to the plate's top face (z = 6): 10 x 10 x 14 = 1400 more.
    const bottomOfBoss = faceWhere(view, (x) => x.type === "plane" && x.normal![2] > 0.99);
    const boss = { id: "boss", op: "extrude", sketch: "sk", distance: 5, direction: [0, 0, -1] };
    const d = withFeature(boss, [sq]);
    const base = patched(d, "boss", {}).volume;
    const up = patched(d, "boss", endPatch(boss, 1, "upToFace", ctx(sel({ faces: [bottomOfBoss] }))));
    expect(up.errors).toEqual([]);
    expect(up.volume - (base - 500)).toBeCloseTo(1400, 6);
    // Up to next stops at the same face.
    const next = patched(d, "boss", endPatch(boss, 1, "upToNext", ctx()));
    expect(next.errors).toEqual([]);
    expect(next.volume - (base - 500)).toBeCloseTo(1400, 6);
    // Offset 4 short of it: 10 x 10 x 10.
    const off = patched(up.doc, "boss", { ...endPatch(up.f, 1, "offsetFromFace", ctx()), offset: 4 });
    expect(off.errors).toEqual([]);
    expect(off.volume - (base - 500)).toBeCloseTo(1000, 6);
  });
});

describe("direction 2, start, thin, draft", () => {
  it("direction 2 starts blind at direction 1's depth and has its own end condition", () => {
    const f = { id: "e", op: "extrude", sketch: "sketch_1", distance: 6 };
    expect(direction2Patch(f, true)).toEqual({ direction2: { extent: "blind", distance: 6 } });
    expect(direction2Patch(f, false)).toEqual({ direction2: null });
    const two = { ...f, direction2: { extent: "blind", distance: 3, draft: { angle: 2 } } };
    expect(endPatch(two, 2, "throughAll", ctx())).toEqual({ direction2: { extent: "throughAll", draft: { angle: 2 } } });
    expect(endPatch({ ...f, direction2: { extent: "throughAll" } }, 2, "blind", ctx())).toEqual({ direction2: { extent: "blind", distance: 6 } });
  });

  it("the start: the sketch plane, an offset, or a surface selected", () => {
    const f: Raw = { id: "e", op: "extrude", sketch: "sketch_1", distance: 6 };
    expect(startKind(f)).toBe("sketch");
    expect(startKind({ ...f, startOffset: 0 })).toBe("offset");
    expect(startKind({ ...f, from: { datum: "Top" } })).toBe("surface");
    expect(startPatch(f, "offset", ctx())).toEqual({ from: null, startOffset: 5 });
    expect(startPatch({ ...f, startOffset: 2 }, "sketch", ctx())).toEqual({ startOffset: null, from: null });
    expect(startPatch(f, "surface", ctx(sel({ datums: ["Top"] })))).toEqual({ startOffset: null, from: { datum: "Top" } });
    expect(() => startPatch(f, "surface", ctx())).toThrow(/click the flat face, plane or vertex in the view first/);
  });

  it("thin on drops the draft in both directions", () => {
    const f = { id: "e", op: "extrude", sketch: "sketch_1", distance: 6, draft: { angle: 3 }, direction2: { extent: "blind", distance: 2, draft: { angle: 1 } } };
    expect(thinPatch(f, true)).toEqual({ thin: { thickness: 1 }, draft: null, direction2: { extent: "blind", distance: 2 } });
    expect(thinPatch(f, false)).toEqual({ thin: null });
  });

  it("the fields shown follow the feature, SOLIDWORKS's blocks in order", () => {
    const ids = (f: Raw) => visibleFields(EXTRUDE_FIELDS, f, form(f)).map(fieldTestId);
    const blind = ids({ id: "e", op: "extrude", sketch: "sketch_1", distance: 6 });
    expect(blind).toEqual(["prop-sketch", "prop-_from", "prop-from", "prop-_dir1", "prop-extent", "prop-distance", "prop-direction-mode", "prop-draft", "prop-direction2", "prop-thin", "prop-regions", "prop-intersect"]);
    const rich = ids({ id: "e", op: "extrude", sketch: "sketch_1", extent: "offsetFromFace", upTo: { datum: "Top" }, offset: 2, startOffset: 1, draft: { angle: 3 }, direction2: { extent: "upToVertex", upTo: { datum: "Origin" } } });
    expect(rich).toEqual(expect.arrayContaining(["prop-start-offset", "prop-up-to", "prop-offset", "prop-draft-angle", "prop-draft-outward", "prop-direction2-extent", "prop-direction2-up-to", "prop-direction2-draft"]));
    expect(rich).not.toContain("prop-distance");
    // Mid plane: total depth, no direction 2. Thin: thickness and side, no draft.
    expect(ids({ id: "e", op: "extrude", sketch: "sketch_1", extent: "midplane", distance: 6 })).not.toContain("prop-direction2");
    const thin = ids({ id: "e", op: "extrude", sketch: "sketch_1", distance: 6, thin: { thickness: 1 } });
    expect(thin).toEqual(expect.arrayContaining(["prop-thin-thickness", "prop-thin-side"]));
    expect(thin).not.toContain("prop-draft");
    // A cut flips side instead of intersecting.
    expect(visibleFields(CUT_FIELDS, { id: "c", op: "cut", sketch: "sketch_1", distance: 6 }, form({})).map(fieldTestId)).toContain("prop-flip-side");
  });

  it("the draft, thin and direction 2 tick boxes send whole objects; the thin side's default is left out", () => {
    const f: Raw = { id: "e", op: "extrude", sketch: "sketch_1", distance: 6 };
    const field = (tid: string) => EXTRUDE_FIELDS.find((s) => fieldTestId(s) === tid)!;
    expect(commitPatch(field("prop-draft"), true, f, form(f))).toEqual({ draft: { angle: 5 } });
    expect(commitPatch(field("prop-draft-angle"), 7, { ...f, draft: { angle: 5, outward: true } }, form(f))).toEqual({ draft: { angle: 7, outward: true } });
    expect(commitPatch(field("prop-thin-side"), "outside", { ...f, thin: { thickness: 2, side: "mid" } }, form(f))).toEqual({ thin: { thickness: 2 } });
    expect(commitPatch(field("prop-direction2-draft"), true, { ...f, direction2: { extent: "blind", distance: 2 } }, form(f))).toEqual({ direction2: { extent: "blind", distance: 2, draft: { angle: 5 } } });
    expect(commitPatch(field("prop-direction-mode"), "reversed", f, form(f))).toEqual({ direction: [0, 0, -1] });
  });
});

describe("selected contours", () => {
  // A 40 x 40 square with a circle of radius 10 in it: the ring and the disc.
  const entities = [
    { id: "r1", type: "rect", center: [0, 0], w: 40, h: 40 },
    { id: "c1", type: "circle", center: [0, 0], radius: 10 },
  ];

  it("lists each region with a point well inside it", () => {
    const list = sketchContours(entities);
    expect(list).toHaveLength(2);
    expect(list.map(contourLabel)).toEqual([`r1 less c1 · ${Math.round((1600 - 100 * Math.PI) * 100) / 100} mm²`, `c1 · ${Math.round(100 * Math.PI * 100) / 100} mm²`]);
    const p = buildProfile(entities as never);
    if (!p.ok) throw new Error(p.error);
    // Each seed picks its own region again, and is not on a line.
    list.forEach((c, i) => expect(contourAt(p.regions, c.seed)).toBe(i));
    expect(contourAt(p.regions, [100, 100])).toBe(-1);
    expect(contourAt(p.regions, [10, 0])).toBe(-1);
  });

  it("ticks regions into seeds; the sketch's own regions ticked is no regions; none is refused", () => {
    const list = sketchContours(entities);
    // The ring is the sketch's region; the disc is the circle's hole, until picked.
    expect(list.map((c) => c.inDefault)).toEqual([true, false]);
    expect(defaultContours(list)).toEqual([0]);
    expect(pickedContours(entities, undefined)).toBeNull();
    const both = contoursPatch(list, null, 1, true)!;
    expect(both).toEqual({ regions: [list[0].seed, list[1].seed] });
    expect(pickedContours(entities, both.regions)).toEqual([0, 1]);
    const disc = contoursPatch(list, [0, 1], 0, false)!;
    expect(disc).toEqual({ regions: [list[1].seed] });
    expect(contoursPatch(list, [0, 1], 1, false)).toEqual({ regions: null });
    expect(contoursPatch(list, [1], 1, false)).toBeNull();
    expect(contoursPatch(list, null, 0, false)).toBeNull();
  });

  it("the seeds it writes build: the ring (default), ring and disc, the disc alone", () => {
    const ring = [{ id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] }, entities, constraints: [] }];
    const f = { id: "boss", op: "extrude", sketch: "s2", distance: 5 };
    const d = withFeature(f, ring);
    const plate = rebuild(doc, oc);
    const base = plate.measurements!.volume;
    plate.dispose();
    const list = sketchContours(entities);
    expect(patched(d, "boss", {}).volume - base).toBeCloseTo((1600 - 100 * Math.PI) * 5, 4);
    const both = patched(d, "boss", contoursPatch(list, null, 1, true)!);
    expect(both.errors).toEqual([]);
    expect(both.volume - base).toBeCloseTo(1600 * 5, 4);
    const disc = patched(d, "boss", contoursPatch(list, [0, 1], 0, false)!);
    expect(disc.errors).toEqual([]);
    expect(disc.volume - base).toBeCloseTo(100 * Math.PI * 5, 4);
  });

  it("finds the middle of a thin ring, not a point on its lines", () => {
    const p = buildProfile([{ id: "a", type: "circle", center: [0, 0], radius: 10 }, { id: "b", type: "circle", center: [0, 0], radius: 9 }] as never);
    if (!p.ok) throw new Error(p.error);
    const c = contours(p.regions);
    const r = Math.hypot(...c[0].seed);
    expect(r).toBeGreaterThan(9.2);
    expect(r).toBeLessThan(9.8);
    expect(c).toHaveLength(2);
    expect(interiorPoint(p.regions[0])).toEqual(c[0].seed);
  });
});

describe("fillet and chamfer editors", () => {
  it("variable radius starts at twice the radius; off removes radius2", () => {
    expect(variablePatch({ radius: 1.5 }, true)).toEqual({ radius2: 3 });
    expect(variablePatch({ radius: 1.5 }, false)).toEqual({ radius2: null });
  });

  it("adds the selected edges as a radius set at the radius there is, and removes sets", () => {
    const corner = view.edges.findIndex((e) => e.kind === "line" && Math.abs(e.direction![2]) > 0.99);
    const f: Raw = { id: "f", op: "fillet", edges: { type: "edge", direction: [1, 0, 0], pick: "all" }, radius: 2 };
    const patch = addSetPatch(f, f, { selection: sel({ edges: [corner] }), view });
    if (typeof patch === "string") throw new Error(patch);
    const sets = patch.sets as Raw[];
    expect(sets).toHaveLength(1);
    expect(sets[0].radius).toBe(2);
    expect(describeSet(sets[0])).toMatch(/^R 2 on /);
    expect(addSetPatch(f, f, { selection: EMPTY_SELECTION, view })).toMatch(/Click the edges for the new radius/);
    expect(removeSetPatch({ ...f, ...patch }, 0)).toEqual({ sets: null });
    expect(describeSet({ radius: 1, radius2: 3, features: ["ext_1"] })).toBe("R 1 → 3 on the edges ext_1 made");
  });

  it("the chamfer type sets its fields: equal, distance–distance, angle–distance", () => {
    const f: Raw = { id: "c", op: "chamfer", edges: {}, distance: 2 };
    expect(chamferType(f)).toBe("equal");
    expect(chamferTypePatch(f, "distances")).toEqual({ angle: null, distance2: 2 });
    expect(chamferType({ ...f, distance2: 1 })).toBe("distances");
    expect(chamferTypePatch(f, "angle")).toEqual({ distance2: null, angle: 45 });
    expect(chamferType({ ...f, angle: 30 })).toBe("angle");
    expect(chamferTypePatch({ ...f, angle: 30, flip: true }, "equal")).toEqual({ distance2: null, angle: null, flip: null });
  });

  it("their fields: faces and features beside edges; the second radius and distance only when used", () => {
    const fillet = UI_OPS.fillet.fields!;
    const chamfer = UI_OPS.chamfer.fields!;
    const ids = (specs: typeof fillet, f: Raw) => visibleFields(specs, f, form(f)).map(fieldTestId);
    expect(ids(fillet, { radius: 1 })).toEqual(["prop-edges", "prop-fillet-faces", "prop-fillet-features", "prop-radius", "prop-fillet-variable", "prop-sets"]);
    expect(ids(fillet, { radius: 1, radius2: 2 })).toContain("prop-radius2");
    expect(ids(chamfer, { distance: 1 })).toEqual(["prop-edges", "prop-chamfer-faces", "prop-chamfer-features", "prop-chamfer-type", "prop-chamfer-distance"]);
    expect(ids(chamfer, { distance: 1, distance2: 2 })).toEqual(expect.arrayContaining(["prop-chamfer-distance2", "prop-chamfer-flip"]));
    expect(ids(chamfer, { distance: 1, angle: 30 })).toEqual(expect.arrayContaining(["prop-chamfer-angle", "prop-chamfer-flip"]));
    expect(UI_OPS.chamfer.summary!({ distance: 2, distance2: 1 })).toBe("2 × 1");
    expect(UI_OPS.fillet.summary!({ radius: 2, radius2: 4 })).toBe("R2→4");
  });
});
