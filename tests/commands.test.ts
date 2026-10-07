import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, nextId, type RawDocument } from "../src/doc/commands";
import { formatDocument } from "../src/doc/format";
import { createHistory, record, redo, undo } from "../src/doc/history";
import { loadOC, rebuild, type OC } from "../src/kernel";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
const ids = (d: RawDocument) => d.features.map((f) => f.id);

function ok(r: ReturnType<typeof apply>): RawDocument {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

describe("apply", () => {
  it("adds a feature at the end or at an index", () => {
    const d = ok(apply(bracket, { type: "addFeature", feature: { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] }, entities: [] } }));
    expect(ids(d)).toEqual(["sketch_1", "ext_1", "hole_1", "s2"]);
    const e = ok(apply(bracket, { type: "addFeature", feature: { id: "s0", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [] }, index: 0 }));
    expect(ids(e)[0]).toBe("s0");
  });

  it("never mutates its input", () => {
    const before = JSON.stringify(bracket);
    apply(bracket, { type: "updateFeature", id: "ext_1", patch: { distance: 10 } });
    apply(bracket, { type: "deleteFeature", id: "hole_1" });
    expect(JSON.stringify(bracket)).toBe(before);
  });

  it("rejects a feature that does not validate, and says why", () => {
    const r = apply(bracket, { type: "addFeature", feature: { id: "h2", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [0, 0], diameter: -2, depth: 3 } });
    expect(r).toEqual({ ok: false, error: "addFeature rejected: h2: diameter: must be greater than 0 (got -2)" });
  });

  it("rejects a duplicate id", () => {
    expect(apply(bracket, { type: "addFeature", feature: { ...bracket.features[2] } })).toEqual({
      ok: false,
      error: 'addFeature: a feature "hole_1" already exists',
    });
  });

  it("updates fields and removes a field set to null", () => {
    const d = ok(apply(bracket, { type: "updateFeature", id: "ext_1", patch: { distance: 10, direction: null } }));
    expect(d.features[1]).toEqual({ id: "ext_1", op: "extrude", sketch: "sketch_1", distance: 10 });
  });

  it("rejects an update that breaks the feature", () => {
    expect(apply(bracket, { type: "updateFeature", id: "ext_1", patch: { distnace: 10 } })).toEqual({
      ok: false,
      error: 'updateFeature rejected: ext_1: unknown field "distnace" (allowed: id, op, sketch, extent, distance, direction, body, newBody)',
    });
  });

  it("will not delete a feature something else uses", () => {
    expect(apply(bracket, { type: "deleteFeature", id: "sketch_1" })).toEqual({
      ok: false,
      error: "deleteFeature: sketch_1 is used by ext_1; delete or change it first",
    });
    expect(ids(ok(apply(bracket, { type: "deleteFeature", id: "hole_1" })))).toEqual(["sketch_1", "ext_1"]);
  });

  it("reorders, but never above a feature it uses", () => {
    expect(apply(bracket, { type: "reorderFeature", id: "ext_1", index: 0 })).toEqual({
      ok: false,
      error: "reorderFeature: ext_1 uses sketch_1, which would come after it",
    });
    const withSketch = ok(apply(bracket, { type: "addFeature", feature: { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] }, entities: [] } }));
    expect(ids(ok(apply(withSketch, { type: "reorderFeature", id: "s2", index: 0 })))).toEqual(["s2", "sketch_1", "ext_1", "hole_1"]);
  });

  it("suppresses and unsuppresses without leaving a false flag behind", () => {
    const s = ok(apply(bracket, { type: "suppressFeature", id: "hole_1", suppressed: true }));
    expect(s.features[2].suppressed).toBe(true);
    const u = ok(apply(s, { type: "suppressFeature", id: "hole_1", suppressed: false }));
    expect(u.features[2]).toEqual(bracket.features[2]);
  });

  it("will not rename a feature that others reference", () => {
    expect(apply(bracket, { type: "updateFeature", id: "sketch_1", patch: { id: "base" } })).toEqual({
      ok: false,
      error: "updateFeature: cannot rename sketch_1; ext_1 uses it",
    });
  });

  it("still edits a document whose other features are broken", () => {
    const broken = structuredClone(bracket);
    broken.features[2].diameter = -1;
    const d = ok(apply(broken, { type: "updateFeature", id: "ext_1", patch: { distance: 8 } }));
    expect(d.features[1].distance).toBe(8);
  });

  it("hands out the next free id", () => {
    expect(nextId(bracket, "hole")).toBe("hole_2");
    expect(nextId(bracket, "fillet")).toBe("fillet_1");
  });
});

describe("undo", () => {
  let oc: OC;
  beforeAll(async () => {
    oc = await loadOC();
  });

  const volume = (text: string) => {
    const r = rebuild(JSON.parse(text), oc);
    const v = r.measurements!.volume;
    r.dispose();
    return v;
  };

  it("returns the previous document, and so the previous solid", () => {
    let h = createHistory(formatDocument(bracket));
    const v0 = volume(h.present);
    h = record(h, formatDocument(ok(apply(JSON.parse(h.present), { type: "updateFeature", id: "ext_1", patch: { distance: 10 } }))));
    const v1 = volume(h.present);
    expect(v1).not.toBeCloseTo(v0, 3);
    h = undo(h);
    expect(volume(h.present)).toBe(v0);
    h = redo(h);
    expect(volume(h.present)).toBe(v1);
  });

  it("ignores no-op records and clears redo on a new edit", () => {
    let h = createHistory("a");
    h = record(h, "a");
    expect(h.past).toEqual([]);
    h = record(record(h, "b"), "c");
    h = undo(h);
    expect(h.present).toBe("b");
    h = record(h, "d");
    expect(h.future).toEqual([]);
    expect(undo(undo(h)).present).toBe("a");
    expect(undo(createHistory("x")).present).toBe("x");
  });
});
