import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apply, type Command, type RawDocument } from "../src/doc/commands";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;

const hole2 = { id: "hole_2", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [-30, 0], diameter: 6.6, depth: "through" };

function inScope(cmd: Command, scope: string[], doc = bracket): boolean {
  const r = apply(doc, cmd, { writeScope: scope });
  if (!r.ok && !r.error.startsWith("writeScope:")) throw new Error(`unexpected: ${r.error}`);
  return r.ok;
}

describe("writeScope", () => {
  it("rejects a change to a feature outside the scope, and changes nothing", () => {
    const before = JSON.stringify(bracket);
    const r = apply(bracket, { type: "updateFeature", id: "ext_1", patch: { distance: 10 } }, { writeScope: ["hole_1"] });
    expect(r).toEqual({ ok: false, error: 'writeScope: updateFeature "ext_1" is outside the scope [hole_1]' });
    expect(JSON.stringify(bracket)).toBe(before);
  });

  it("allows changes to the features in scope", () => {
    expect(inScope({ type: "updateFeature", id: "hole_1", patch: { diameter: 8 } }, ["hole_1"])).toBe(true);
    expect(inScope({ type: "suppressFeature", id: "hole_1", suppressed: true }, ["hole_1"])).toBe(true);
    expect(inScope({ type: "deleteFeature", id: "hole_1" }, ["hole_1"])).toBe(true);
    expect(inScope({ type: "deleteFeature", id: "hole_1" }, ["ext_1"])).toBe(false);
    expect(inScope({ type: "reorderFeature", id: "hole_1", index: 1 }, ["hole_1"])).toBe(true);
    expect(inScope({ type: "setDimension", sketch: "sketch_1", index: 0, value: 90 }, ["hole_1"])).toBe(false);
    expect(inScope({ type: "setDimension", sketch: "sketch_1", index: 0, value: 90 }, ["sketch_1"])).toBe(true);
  });

  it("new features need + or a reference to something in scope", () => {
    expect(inScope({ type: "addFeature", feature: hole2 }, ["hole_1"])).toBe(false);
    expect(inScope({ type: "addFeature", feature: hole2 }, ["hole_1", "+"])).toBe(true);
    const pattern = { id: "pat_1", op: "linearPattern", feature: "hole_1", direction: [-1, 0, 0], count: 2, spacing: 60 };
    expect(inScope({ type: "addFeature", feature: pattern }, ["hole_1"])).toBe(true);
    expect(inScope({ type: "addFeature", feature: pattern }, ["ext_1"])).toBe(false);
  });

  it("parameters: param:<name>, or every user of the parameter in scope", () => {
    const d = structuredClone(bracket);
    d.parameters = { t: 6, d: 6.6 };
    d.features[1].distance = "=t";
    d.features[2].diameter = "=d";
    expect(inScope({ type: "setParameter", name: "t", value: 8 }, ["hole_1"], d)).toBe(false);
    expect(inScope({ type: "setParameter", name: "d", value: 8 }, ["hole_1"], d)).toBe(true);
    expect(inScope({ type: "setParameter", name: "t", value: 8 }, ["param:t"], d)).toBe(true);
    expect(inScope({ type: "setParameter", name: "new_one", value: 1 }, ["hole_1"], d)).toBe(false);
    expect(inScope({ type: "setParameter", name: "new_one", value: 1 }, ["+"], d)).toBe(true);
    expect(inScope({ type: "setParameter", name: "t", value: 1 }, ["+"], d)).toBe(false);
  });

  it('"*" is the whole part; renaming needs "name"', () => {
    expect(inScope({ type: "updateFeature", id: "ext_1", patch: { distance: 8 } }, ["*"])).toBe(true);
    expect(inScope({ type: "setName", name: "b2" }, ["hole_1"])).toBe(false);
    expect(inScope({ type: "setName", name: "b2" }, ["name"])).toBe(true);
  });

  it("no scope means no restriction (the human in the UI)", () => {
    expect(apply(bracket, { type: "updateFeature", id: "ext_1", patch: { distance: 8 } }).ok).toBe(true);
  });
});
