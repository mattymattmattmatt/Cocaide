import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;

function ok(r: ReturnType<typeof apply>): RawDocument {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
type Sketch = { entities: Record<string, unknown>[]; constraints: Record<string, unknown>[] };
const sketchOf = (d: RawDocument) => d.features[0] as unknown as Sketch;

/** The bracket with a construction circle c1 in its sketch, radius fixed at 3. */
function withCircle(): RawDocument {
  let d = ok(apply(bracket, { type: "addEntity", sketch: "sketch_1", entity: { type: "circle", center: [20, 0], radius: 3, construction: true } }));
  d = ok(apply(d, { type: "addConstraint", sketch: "sketch_1", constraint: { type: "radius", entity: "c1", value: 3 } }));
  return d;
}

describe("sketch commands", () => {
  it("adds an entity, naming it when the id is left out", () => {
    const d = withCircle();
    expect(sketchOf(d).entities[1]).toEqual({ type: "circle", center: [20, 0], radius: 3, construction: true, id: "c1" });
    expect(sketchOf(d).constraints).toHaveLength(2);
    expect(allErrors(validateDocument(d))).toEqual([]);
  });

  it("a new constraint moves the geometry to meet it", () => {
    const d = ok(apply(withCircle(), { type: "setDimension", sketch: "sketch_1", index: 1, value: 4 }));
    expect(sketchOf(d).entities[1].radius).toBe(4);
    expect(sketchOf(d).entities[1].center).toEqual([20, 0]);
  });

  it("updateEntity holds what it sets, and refuses what the constraints forbid", () => {
    const moved = ok(apply(withCircle(), { type: "updateEntity", sketch: "sketch_1", id: "c1", patch: { center: [25, 5] } }));
    expect(sketchOf(moved).entities[1]).toMatchObject({ center: [25, 5], radius: 3 });
    const r = apply(withCircle(), { type: "updateEntity", sketch: "sketch_1", id: "r1", patch: { w: 90 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("updateEntity: sketch_1: the constraints conflict or cannot all be met; remove or change one (with r1.w held where you set them)");
    const plain = ok(apply(withCircle(), { type: "updateEntity", sketch: "sketch_1", id: "c1", patch: { construction: null } }));
    expect(sketchOf(plain).entities[1].construction).toBeUndefined();
  });

  it("refuses a constraint the sketch already has", () => {
    expect(apply(withCircle(), { type: "addConstraint", sketch: "sketch_1", constraint: { type: "radius", entity: "c1", value: 3 } })).toEqual({
      ok: false,
      error: "addConstraint: sketch_1: that constraint repeats or contradicts what the sketch already fixes",
    });
  });

  it("deleting an entity takes its constraints with it", () => {
    const d = ok(apply(withCircle(), { type: "deleteEntity", sketch: "sketch_1", id: "c1" }));
    expect(sketchOf(d).entities.map((e) => e.id)).toEqual(["r1"]);
    expect(sketchOf(d).constraints).toEqual([{ type: "distanceX", entity: "r1", value: 80 }]);
    const e = ok(apply(withCircle(), { type: "deleteConstraint", sketch: "sketch_1", index: 1 }));
    expect(sketchOf(e).constraints).toHaveLength(1);
  });

  it("says when the target is not a sketch or the entity does not exist", () => {
    expect(apply(bracket, { type: "updateEntity", sketch: "ext_1", id: "x", patch: {} })).toEqual({ ok: false, error: 'updateEntity: "ext_1" is a extrude, not a sketch' });
    expect(apply(bracket, { type: "deleteEntity", sketch: "sketch_1", id: "zz" })).toEqual({ ok: false, error: 'deleteEntity: sketch_1 has no entity "zz"' });
  });
});

describe("sketch scopes", () => {
  const allowed = (cmd: Command, scope: string[], doc = withCircle()) => {
    const r = apply(doc, cmd, { writeScope: scope });
    if (!r.ok && !r.error.startsWith("writeScope:")) throw new Error(`unexpected: ${r.error}`);
    return r.ok;
  };

  it("an entity scope covers that entity and the constraints on it, nothing else", () => {
    const s = ["sketch_1/c1"];
    expect(allowed({ type: "updateEntity", sketch: "sketch_1", id: "c1", patch: { center: [22, 0] } }, s)).toBe(true);
    expect(allowed({ type: "setDimension", sketch: "sketch_1", index: 1, value: 4 }, s)).toBe(true);
    expect(allowed({ type: "deleteConstraint", sketch: "sketch_1", index: 1 }, s)).toBe(true);
    expect(allowed({ type: "addConstraint", sketch: "sketch_1", constraint: { type: "coincident", points: ["c1.center", "origin"] } }, s)).toBe(true);
    expect(allowed({ type: "updateEntity", sketch: "sketch_1", id: "r1", patch: { construction: true } }, s)).toBe(false);
    expect(allowed({ type: "setDimension", sketch: "sketch_1", index: 0, value: 90 }, s)).toBe(false);
    expect(allowed({ type: "addEntity", sketch: "sketch_1", entity: { type: "circle", center: [0, 0], radius: 1 } }, s)).toBe(false);
    expect(allowed({ type: "updateFeature", id: "ext_1", patch: { distance: 9 } }, s)).toBe(false);
    const pattern = { id: "pat_1", op: "linearPattern", feature: "ext_1", direction: [0, 0, 1], spacing: 10, count: 2 };
    expect(allowed({ type: "addFeature", feature: pattern }, s)).toBe(false);
  });

  it("a sketch-contents scope covers its entities and constraints, not the feature or its children", () => {
    const s = ["sketch_1/*"];
    expect(allowed({ type: "addEntity", sketch: "sketch_1", entity: { type: "circle", center: [-20, 0], radius: 2 } }, s)).toBe(true);
    expect(allowed({ type: "setDimension", sketch: "sketch_1", index: 0, value: 90 }, s)).toBe(true);
    const entities = sketchOf(withCircle()).entities.slice(0, 1);
    expect(allowed({ type: "updateFeature", id: "sketch_1", patch: { entities, constraints: [] } }, s)).toBe(true);
    expect(allowed({ type: "updateFeature", id: "sketch_1", patch: { plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 1] } } }, s)).toBe(false);
    expect(allowed({ type: "deleteFeature", id: "hole_1" }, s)).toBe(false);
    expect(allowed({ type: "suppressFeature", id: "sketch_1", suppressed: true }, s)).toBe(false);
    expect(allowed({ type: "addFeature", feature: { id: "cut_1", op: "cut", sketch: "sketch_1", distance: 1 } }, s)).toBe(false);
  });
});
