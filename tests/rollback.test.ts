// The rollback bar (src/doc/rollback.ts and the setRollback command): where
// it sits, what the view rebuilds, where new features go, and how it follows
// deletes and renames; the validator and the write scope.

import { describe, expect, it } from "vitest";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { isRolledBack, rollbackAt, rollbackId, rollbackIndex, rollbackNext, rollbackPrevious, rolledBack, rolledBackIds } from "../src/doc/rollback";
import { validateDocument } from "../src/doc/validate";
import { documentBefore } from "../src/worker/before";
import { example } from "./ui-fixtures";

const bracket = () => example("bracket"); // sketch_1, ext_1, hole_1
const ids = (doc: unknown) => ((doc as RawDocument).features as { id: string }[]).map((f) => f.id);

function run(doc: RawDocument, cmd: Command, writeScope?: string[]): RawDocument {
  const r = apply(doc, cmd, writeScope ? { writeScope } : {});
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

describe("rollback: pure reading", () => {
  it("is at the end when there is no field, or the field names no feature", () => {
    const doc = bracket();
    expect(rollbackId(doc)).toBeNull();
    expect(rollbackIndex(doc)).toBe(3);
    expect(isRolledBack(doc)).toBe(false);
    expect(rolledBack(doc)).toBe(doc); // the same object: a cache keyed by it still hits
    expect(rolledBackIds(doc)).toEqual([]);
    expect(rollbackIndex({ ...doc, rollback: "nothing_1" })).toBe(3);
  });

  it("rolled above ext_1: only the sketch is built, and the field is dropped from what is built", () => {
    const doc = { ...bracket(), rollback: "ext_1" };
    expect(rollbackId(doc)).toBe("ext_1");
    expect(rollbackIndex(doc)).toBe(1);
    expect(isRolledBack(doc)).toBe(true);
    const built = rolledBack(doc);
    expect(ids(built)).toEqual(["sketch_1"]);
    expect("rollback" in (built as object)).toBe(false);
    expect(rolledBackIds(doc)).toEqual(["ext_1", "hole_1"]);
    // The whole document is untouched.
    expect(ids(doc)).toEqual(["sketch_1", "ext_1", "hole_1"]);
  });

  it("steps the bar: the field for an index, previous and next, none past either end", () => {
    const doc = bracket();
    expect(rollbackAt(doc, 0)).toBe("sketch_1");
    expect(rollbackAt(doc, 2)).toBe("hole_1");
    expect(rollbackAt(doc, 3)).toBeNull();
    expect(rollbackPrevious(doc)).toBe("hole_1");
    expect(rollbackNext(doc)).toBeUndefined();
    const top = { ...doc, rollback: "sketch_1" };
    expect(rollbackPrevious(top)).toBeUndefined();
    expect(rollbackNext(top)).toBe("ext_1");
    expect(rollbackNext({ ...doc, rollback: "hole_1" })).toBeNull(); // forward from the last: the end
  });

  it("is left out of the part before a feature (the sketcher's view)", () => {
    const before = documentBefore({ ...bracket(), rollback: "hole_1" }, "ext_1") as Record<string, unknown>;
    expect("rollback" in before).toBe(false);
    expect(ids(before)).toEqual(["sketch_1"]);
  });
});

describe("rollback: the setRollback command", () => {
  it("moves the bar, and back to the end with null", () => {
    const rolled = run(bracket(), { type: "setRollback", before: "ext_1" });
    expect(rolled.rollback).toBe("ext_1");
    const back = run(rolled, { type: "setRollback", before: null });
    expect("rollback" in back).toBe(false);
  });

  it("refuses a feature that is not there, saying what to give", () => {
    const r = apply(bracket(), { type: "setRollback", before: "nope_1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no feature "nope_1".*null to roll to the end/);
  });

  it("puts a new feature in at the bar, and keeps the bar above the same feature", () => {
    const rolled = run(bracket(), { type: "setRollback", before: "hole_1" });
    const added = run(rolled, { type: "addFeature", feature: { id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 20 } });
    expect(ids(added)).toEqual(["sketch_1", "ext_1", "plane_1", "hole_1"]);
    expect(added.rollback).toBe("hole_1");
    expect(rolledBackIds(added)).toEqual(["hole_1"]);
    // An explicit index still wins.
    const atTop = run(rolled, { type: "addFeature", index: 0, feature: { id: "plane_2", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 5 } });
    expect(ids(atTop)[0]).toBe("plane_2");
  });

  it("moves to the next feature when the one below it is deleted, to the end when there is none", () => {
    const rolled = run(bracket(), { type: "setRollback", before: "hole_1" });
    const deleted = run(rolled, { type: "deleteFeature", id: "hole_1" });
    expect("rollback" in deleted).toBe(false);
    const mid = run({ ...bracket(), features: [...bracket().features, { id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 20 }] } as RawDocument, { type: "setRollback", before: "hole_1" });
    expect(run(mid, { type: "deleteFeature", id: "hole_1" }).rollback).toBe("plane_1");
  });

  it("stays between the same features when one is reordered across it", () => {
    const plane = (id: string, distance: number) => ({ id, op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance });
    const doc = run({ ...bracket(), features: [...bracket().features, plane("plane_1", 20), plane("plane_2", 30)] } as RawDocument, { type: "setRollback", before: "plane_1" });
    expect(rolledBackIds(doc)).toEqual(["plane_1", "plane_2"]);
    // The feature just below the bar dragged to the top: it is built now, and plane_2 is still not.
    const up = run(doc, { type: "reorderFeature", id: "plane_1", index: 0 });
    expect(ids(up)).toEqual(["plane_1", "sketch_1", "ext_1", "hole_1", "plane_2"]);
    expect(up.rollback).toBe("plane_2");
    expect(rolledBackIds(up)).toEqual(["plane_2"]);
    // A built feature dragged below the bar is rolled back with the rest.
    const down = run(doc, { type: "reorderFeature", id: "hole_1", index: 4 });
    expect(ids(down)).toEqual(["sketch_1", "ext_1", "plane_1", "plane_2", "hole_1"]);
    expect(rolledBackIds(down)).toEqual(["plane_1", "plane_2", "hole_1"]);
    // The last feature, just below the bar, moved up: the bar goes to the end.
    const last = run(run(doc, { type: "setRollback", before: "plane_2" }), { type: "reorderFeature", id: "plane_2", index: 0 });
    expect("rollback" in last).toBe(false);
  });

  it("follows a rename of the feature it sits above", () => {
    const rolled = run(bracket(), { type: "setRollback", before: "hole_1" });
    const hole = rolled.features.find((f) => f.id === "hole_1")!;
    const renamed = run(rolled, { type: "replaceFeature", id: "hole_1", feature: { ...hole, id: "bore_1" } });
    expect(renamed.rollback).toBe("bore_1");
  });

  it("is allowed by the write scope tokens \"rollback\" and \"+\", refused otherwise", () => {
    const cmd: Command = { type: "setRollback", before: "ext_1" };
    expect(run(bracket(), cmd, ["rollback"]).rollback).toBe("ext_1");
    expect(run(bracket(), cmd, ["+"]).rollback).toBe("ext_1");
    expect(apply(bracket(), cmd, { writeScope: ["name"] }).ok).toBe(false);
  });
});

describe("rollback: validation", () => {
  it("accepts a bar above a feature and rejects one naming none", () => {
    expect(validateDocument({ ...bracket(), rollback: "ext_1" }).headerErrors).toEqual([]);
    const bad = validateDocument({ ...bracket(), rollback: "gone_1" }).headerErrors.join("\n");
    expect(bad).toMatch(/rollback.*must be the id of a feature/);
    expect(validateDocument({ ...bracket(), rollback: 3 }).headerErrors.join("\n")).toMatch(/remove "rollback" to roll to the end/);
  });
});
