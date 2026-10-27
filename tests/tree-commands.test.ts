// Phase P: the tree's document side. Moves checked against what each feature
// uses (sketches, the features whose faces it picks, dimensions it reads),
// folders, copy and paste, notes, renames that follow, and the selector
// helpers What's wrong uses (fragile ones, writing a re-found one back).

import { describe, expect, it } from "vitest";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { copyFeatures, pasteFeatures } from "../src/doc/clipboard";
import { fragileSelectors, replaceSelectorPatch, selectorsIn, setAtPath } from "../src/doc/heal";
import { createHistory, record, undo } from "../src/doc/history";
import { foldersOf, moveProblem, provenanceRefs } from "../src/doc/tree";
import { references } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const topFace = { type: "planar", normal: [0, 0, 1], pick: "largest", createdBy: "ext_1" };

function part(): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "t",
    parameters: { w: 80 },
    features: [
      { id: "sketch_1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w: "=w", h: 40 }] },
      { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: 6 },
      { id: "hole_1", op: "hole", face: topFace, center: [30, 0], diameter: 6.6, depth: "through" },
      { id: "fillet_1", op: "fillet", edges: { type: "edge", kind: "circle", radius: 3.3, createdBy: "hole_1", pick: "all" }, radius: 1 },
      { id: "sketch_2", op: "sketch", plane: TOP, entities: [{ id: "c1", type: "circle", center: [-20, 0], radius: 4 }] },
      { id: "cut_1", op: "cut", sketch: "sketch_2", distance: 3, direction: [0, 0, -1] },
    ],
  };
}

function ok(doc: RawDocument, cmd: Command): RawDocument {
  const r = apply(doc, cmd);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const ids = (d: RawDocument) => d.features.map((f) => f.id);

describe("moving a feature in the history", () => {
  it("refuses to put an extrude above its sketch, with the reason", () => {
    const r = apply(part(), { type: "reorderFeature", id: "ext_1", index: 0 });
    expect(r).toEqual({ ok: false, error: "reorderFeature: ext_1 uses sketch_1, which would come after it" });
  });

  it("refuses to put a fillet above the hole whose edge it picks by maker", () => {
    const r = apply(part(), { type: "reorderFeature", id: "fillet_1", index: 2 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("reorderFeature: fillet_1 picks faces or edges hole_1 made, so hole_1 must come before it");
    expect(moveProblem(part().features, "fillet_1", 2, (f) => references(f))).toBe("fillet_1 picks faces or edges hole_1 made, so hole_1 must come before it");
  });

  it("a legal move goes through, and the live check agrees", () => {
    expect(moveProblem(part().features, "sketch_2", 2, (f) => references(f))).toBeNull();
    expect(ids(ok(part(), { type: "reorderFeature", id: "sketch_2", index: 2 }))).toEqual(["sketch_1", "ext_1", "sketch_2", "hole_1", "fillet_1", "cut_1"]);
  });

  it("refuses to put a feature above a sketch whose dimensions it reads", () => {
    const d = part();
    (d.features[4] as { constraints?: unknown[] }).constraints = [{ type: "radius", entity: "c1", value: 4 }];
    d.features[2].diameter = "=sketch_2.d1 * 1.5";
    // As written, hole_1 already reads a later sketch: that is not a move's doing and blocks no other move.
    expect(moveProblem(d.features, "cut_1", 5, (f) => references(f))).toBeNull();
    const e = ok(d, { type: "reorderFeature", id: "sketch_2", index: 1 });
    expect(moveProblem(e.features, "sketch_2", 3, (f) => references(f))).toBe("hole_1 reads sketch_2's dimensions, so sketch_2 must come before it");
  });
});

describe("folders", () => {
  const withFolder = () => ok(part(), { type: "setFolder", id: "folder_1", folder: { name: "Hole and its round", features: ["hole_1", "fillet_1"] } });

  it("a folder groups features next to each other; one with a gap is refused", () => {
    expect(foldersOf(withFolder())).toEqual([{ id: "folder_1", name: "Hole and its round", features: ["hole_1", "fillet_1"] }]);
    const r = apply(part(), { type: "setFolder", id: "f", folder: { name: "x", features: ["hole_1", "cut_1"] } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("its features must be next to each other in the history (fillet_1 is between them)");
  });

  it("suppressing a folder suppresses its features, one undo step", () => {
    const d = ok(withFolder(), { type: "suppressFolder", id: "folder_1", suppressed: true });
    expect(d.features.filter((f) => f.suppressed).map((f) => f.id)).toEqual(["hole_1", "fillet_1"]);
    const back = ok(d, { type: "suppressFolder", id: "folder_1", suppressed: false });
    expect(back.features.some((f) => f.suppressed)).toBe(false);
  });

  it("a feature dropped between two of a folder's joins it; moved away it leaves; an emptied folder goes", () => {
    let d = ok(part(), { type: "setFolder", id: "folder_1", folder: { name: "Plate", features: ["sketch_1", "ext_1", "hole_1"] } });
    d = ok(d, { type: "reorderFeature", id: "sketch_2", index: 1 });
    expect(foldersOf(d)[0].features).toEqual(["sketch_1", "sketch_2", "ext_1", "hole_1"]);
    d = ok(d, { type: "reorderFeature", id: "sketch_2", index: 4 });
    expect(foldersOf(d)[0].features).toEqual(["sketch_1", "ext_1", "hole_1"]);
    // Dragged out at its edge, asked into no folder.
    d = ok(d, { type: "reorderFeature", id: "hole_1", index: 2, folder: null });
    expect(foldersOf(d)[0].features).toEqual(["sketch_1", "ext_1"]);
    // Dragged in at its edge, asked into it.
    d = ok(d, { type: "reorderFeature", id: "hole_1", index: 2, folder: "folder_1" });
    expect(foldersOf(d)[0].features).toEqual(["sketch_1", "ext_1", "hole_1"]);
    const single = ok(part(), { type: "setFolder", id: "folder_2", folder: { name: "Cut", features: ["cut_1"] } });
    const gone = ok(ok(single, { type: "deleteFeature", id: "cut_1" }), { type: "deleteFeature", id: "sketch_2" });
    expect(gone.folders).toBeUndefined();
  });

  it("renaming a feature renames it in its folder and in the selectors that name it as their maker", () => {
    const d = ok(withFolder(), { type: "updateFeature", id: "hole_1", patch: { id: "bolt_hole" } });
    expect(foldersOf(d)[0].features).toEqual(["bolt_hole", "fillet_1"]);
    expect(provenanceRefs(d.features[3])).toEqual(["bolt_hole"]);
    const e = ok(part(), { type: "updateFeature", id: "ext_1", patch: { id: "plate" } });
    expect((e.features[2].face as { createdBy: string }).createdBy).toBe("plate");
  });

  it("validation: a feature in two folders, an unknown id", () => {
    const d = { ...part(), folders: [{ id: "a", name: "A", features: ["hole_1"] }, { id: "b", name: "B", features: ["hole_1"] }, { id: "c", name: "C", features: ["nope"] }] };
    const errors = allErrors(validateDocument(d));
    expect(errors.some((e) => e.includes("is in folder \"a\" already"))).toBe(true);
    expect(errors.some((e) => e.includes('no feature "nope"'))).toBe(true);
  });
});

describe("notes", () => {
  it("a feature keeps a short note; a long one is refused", () => {
    const d = ok(part(), { type: "updateFeature", id: "hole_1", patch: { note: "M6 clearance for the guard" } });
    expect(validateDocument(d).features[2].feature?.note).toBe("M6 clearance for the guard");
    expect(apply(part(), { type: "updateFeature", id: "hole_1", patch: { note: "x".repeat(501) } }).ok).toBe(false);
  });
});

describe("copy and paste", () => {
  it("copying a cut brings its sketch; pasting onto a face stands the sketch on it and drops the written direction", () => {
    const clip = copyFeatures(part(), ["cut_1"]);
    if (typeof clip === "string") throw new Error(clip);
    expect(clip.features.map((f) => f.id)).toEqual(["sketch_2", "cut_1"]);
    const side = { type: "planar" as const, normal: [1, 0, 0] as [number, number, number], pick: "largest" as const };
    const p = pasteFeatures(part(), clip, { face: side });
    expect(p.features.map((f) => f.id)).toEqual(["sketch_3", "cut_2"]);
    expect(p.features[0].plane).toEqual({ type: "ref", ref: { face: side } });
    expect(p.features[1]).toMatchObject({ sketch: "sketch_3" });
    expect(p.features[1].direction).toBeUndefined();
    const d = ok(part(), { type: "insertFeatures", features: p.features });
    expect(ids(d).slice(-2)).toEqual(["sketch_3", "cut_2"]);
  });

  it("a hole pasted onto another face drills that face; the paste is one undo step", () => {
    const clip = copyFeatures(part(), ["hole_1"]) as Exclude<ReturnType<typeof copyFeatures>, string>;
    const face = { type: "planar" as const, normal: [0, 0, -1] as [number, number, number], pick: "largest" as const };
    const p = pasteFeatures(part(), clip, { face });
    expect(p.features).toEqual([{ id: "hole_2", op: "hole", face, center: [30, 0], diameter: 6.6, depth: "through" }]);
    let h = createHistory(JSON.stringify(part()));
    const d = ok(part(), { type: "insertFeatures", features: p.features });
    h = record(h, JSON.stringify(d), undefined, "Paste hole_2");
    expect(JSON.parse(undo(h).present).features.length).toBe(6);
  });

  it("a pattern pasted alone keeps its seeds and says so", () => {
    const d = ok(part(), { type: "addFeature", feature: { id: "linearPattern_1", op: "linearPattern", feature: "hole_1", direction: [-1, 0, 0], spacing: 10, count: 2 } });
    const clip = copyFeatures(d, ["linearPattern_1"]) as Exclude<ReturnType<typeof copyFeatures>, string>;
    const p = pasteFeatures(d, clip);
    expect(p.features[0]).toMatchObject({ id: "linearPattern_2", feature: "hole_1" });
    expect(p.notes).toEqual(["linearPattern_2 uses hole_1 as linearPattern_1 did (its seeds)"]);
  });

  it("expressions reading a copied sketch's dimensions read the copy's", () => {
    const d = part();
    (d.features[4] as { constraints?: unknown[] }).constraints = [{ type: "radius", entity: "c1", value: 4, name: "r" }];
    d.features[5].distance = "=sketch_2.r";
    const p = pasteFeatures(d, copyFeatures(d, ["cut_1"]) as never);
    expect(p.features[1].distance).toBe("=sketch_3.r");
    expect((p.features[0].entities as { id: string }[])[0].id).toBe("c1");
  });
});

describe("parameters: renaming one follows everywhere", () => {
  it("renaming w rewrites the sketch that reads it; two features driven by one parameter", () => {
    let d = ok(part(), { type: "setParameter", name: "depth", value: 3 });
    d = ok(d, { type: "updateFeature", id: "cut_1", patch: { distance: "=depth" } });
    d = ok(d, { type: "updateFeature", id: "ext_1", patch: { distance: "=depth * 2" } });
    d = ok(d, { type: "renameParameter", from: "depth", to: "plate_t" });
    expect(d.features[5].distance).toBe("=plate_t");
    expect(d.features[1].distance).toBe("=plate_t * 2");
    d = ok(d, { type: "renameParameter", from: "w", to: "width" });
    expect((d.features[0].entities as { w: unknown }[])[0].w).toBe("=width");
  });
});

describe("the selectors of a feature (What's wrong)", () => {
  it("lists each with its path; a re-found one is written back in its place", () => {
    const f = { id: "fillet_9", op: "fillet", edges: [{ type: "edge", kind: "line", length: 80, pick: "all" }, { type: "edge", kind: "circle", radius: 3, pick: "all", hint: { centroid: [0, 0, 6] } }], radius: 1 };
    expect(selectorsIn(f).map((s) => s.path)).toEqual(["edges[0]", "edges[1]"]);
    const healed = { type: "edge", kind: "line", direction: [1, 0, 0], pick: "all", createdBy: "ext_1", hint: { centroid: [0, -20, 6] } };
    // The selector as the rebuild read it: same keys, maybe another order.
    const patch = replaceSelectorPatch(f, { pick: "all", length: 80, kind: "line", type: "edge" }, healed)!;
    expect(patch).toEqual({ edges: [healed, f.edges[1]] });
    expect(setAtPath({ upTo: { face: { a: 1 } } }, "upTo.face", { b: 2 })).toEqual({ upTo: { face: { b: 2 } } });
  });

  it("fragile selectors: by offset, by position only, by length (none once they carry a hint)", () => {
    const f = {
      id: "x",
      op: "draft",
      faces: [
        { type: "planar", normal: [0, 0, 1], offset: 6, pick: "largest" },
        { type: "cylindrical", radius: 3, near: [1, 2, 3], pick: "all" },
        { type: "planar", normal: [0, 0, 1], offset: 6, pick: "largest", hint: { centroid: [0, 0, 6] } },
      ],
    };
    expect(fragileSelectors(f).map((s) => [s.path, s.reason])).toEqual([
      ["faces[0]", "names the face by its offset: it breaks when the face moves"],
      ["faces[1]", "tells it apart by position only: it can pick another one when things move"],
    ]);
  });
});
