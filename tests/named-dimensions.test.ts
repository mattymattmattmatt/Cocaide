// Named and driven dimensions in the document (src/doc/dimensions.ts and the
// commands): default names, references from any expression, renames,
// cycles, driven dimensions that measure and never move geometry.

import { describe, expect, it } from "vitest";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { dimensionNames, documentSymbols, pinReferencedNames } from "../src/doc/dimensions";
import { documentParameters, resolvedDocument } from "../src/doc/parameters";
import { allErrors, validateDocument } from "../src/doc/validate";

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };

function ok(r: ReturnType<typeof apply>): RawDocument {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const run = (d: RawDocument, ...cmds: Command[]) => cmds.reduce((x, c) => ok(apply(x, c)), d);
type Sketch = { id: string; entities: Record<string, unknown>[]; constraints: Record<string, unknown>[] };
const feature = (d: RawDocument, id: string) => d.features.find((f) => f.id === id) as unknown as Sketch & Record<string, unknown>;

/** A 40 x 20 rectangle (as a rect entity) and a circle beside it; an extrude of it. */
function plate(): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "plate",
    features: [
      {
        id: "sketch_1",
        op: "sketch",
        plane: TOP,
        entities: [
          { id: "r1", type: "rect", center: [0, 0], w: 40, h: 20 },
          { id: "c1", type: "circle", center: [40, 0], radius: 5 },
        ],
        constraints: [
          { type: "distanceX", entity: "r1", value: 40 },
          { type: "distanceY", entity: "r1", value: 20 },
          { type: "radius", entity: "c1", value: 5 },
        ],
      },
      { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: 6, direction: [0, 0, 1] },
    ],
  } as unknown as RawDocument;
}

/** A second sketch with one circle whose diameter is an expression. */
function withSecond(expr: string): RawDocument {
  const d = plate();
  d.features.push({
    id: "sketch_2",
    op: "sketch",
    plane: TOP,
    entities: [{ id: "c1", type: "circle", center: [0, 50], radius: 10 }],
    constraints: [{ type: "diameter", entity: "c1", value: expr }],
  });
  return d;
}

describe("dimension names", () => {
  it("names each dimension d<n> by its place, or by the name it was given", () => {
    expect(dimensionNames([{ type: "distance", value: 1 }, { type: "horizontal" }, { type: "radius", value: 2 }])).toEqual(["d1", null, "d2"]);
    expect(dimensionNames([{ type: "distance", value: 1, name: "d2" }, { type: "radius", value: 2 }, { type: "radius", value: 3 }])).toEqual(["d2", "d3", "d4"]);
    expect(dimensionNames([{ type: "distance", value: 1, name: "width" }, { type: "radius", value: 2 }])).toEqual(["width", "d2"]);
  });

  it("lists every dimension by its full name with the parameters", () => {
    const d = plate();
    d.parameters = { t: 6 };
    expect(documentParameters(d)).toEqual({ t: 6, "sketch_1.d1": 40, "sketch_1.d2": 20, "sketch_1.d3": 5 });
  });

  it("refuses two dimensions of one name, and a bad name", () => {
    const d = plate();
    feature(d, "sketch_1").constraints[0].name = "w";
    feature(d, "sketch_1").constraints[1].name = "w";
    expect(allErrors(validateDocument(d))).toContain(`sketch_1: constraints[1]: name "w" is already constraints[0]'s; each dimension of a sketch has its own name`);
    feature(d, "sketch_1").constraints[1].name = "2w";
    expect(allErrors(validateDocument(d)).join()).toMatch(/name must be letters, digits and _/);
  });
});

describe("expressions that read dimensions", () => {
  it("drives another feature's depth from a dimension", () => {
    const d = plate();
    feature(d, "ext_1").distance = "=sketch_1.d2 / 2";
    expect(allErrors(validateDocument(d))).toEqual([]);
    expect(resolvedDocument(d).features[1].distance).toBe(10);
    const wider = ok(apply(d, { type: "setDimension", sketch: "sketch_1", index: 1, value: 30 }));
    expect(feature(wider, "sketch_1").entities[0].h).toBe(30);
    expect(resolvedDocument(wider).features[1].distance).toBe(15);
  });

  it("re-solves a sketch whose dimension reads another sketch's, when that one changes", () => {
    const d = run(withSecond("=sketch_1.d3 * 2"), { type: "setDimension", sketch: "sketch_1", name: "d3", value: 7 });
    expect(feature(d, "sketch_1").entities[1].radius).toBe(7);
    // sketch_2's diameter is 2 x 7 = 14: its radius follows.
    expect(feature(d, "sketch_2").entities[0].radius).toBe(7);
    expect(feature(d, "sketch_2").constraints[0].value).toBe("=sketch_1.d3 * 2");
    expect(allErrors(validateDocument(d))).toEqual([]);
  });

  it("lets a parameter be an expression over dimensions, and follows it", () => {
    let d = withSecond("=half");
    d.parameters = { half: "=sketch_1.d1 / 2" } as unknown as Record<string, number>;
    expect(allErrors(validateDocument(d))).toEqual([]);
    expect(documentParameters(d).half).toBe(20);
    d = run(d, { type: "setDimension", sketch: "sketch_1", index: 0, value: 60 });
    expect(feature(d, "sketch_2").entities[0].radius).toBe(15);
    d = run(d, { type: "setParameter", name: "half", value: "=sketch_1.d1 / 3" });
    expect(feature(d, "sketch_2").entities[0].radius).toBe(10);
  });

  it("refuses a cycle, saying which names go round", () => {
    const d = withSecond("=sketch_1.d3 * 2");
    const r = apply(d, { type: "setDimension", sketch: "sketch_1", name: "d3", value: "=sketch_2.d1 / 2" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("setDimension: sketch_1.d3: cycle: sketch_1.d3 → sketch_2.d1 → sketch_1.d3");
    const self = apply(plate(), { type: "setParameter", name: "a", value: "=a + 1" });
    expect(self).toEqual({ ok: false, error: "setParameter: a: cycle: a → a" });
    // A document written with a cycle says so where it is read.
    const bad = withSecond("=sketch_1.d3 * 2");
    feature(bad, "sketch_1").constraints[2].value = "=sketch_2.d1";
    expect(documentSymbols(bad).problems["sketch_2.d1"]).toBe("cycle: sketch_1.d3 → sketch_2.d1 → sketch_1.d3");
    expect(allErrors(validateDocument(bad)).join("\n")).toMatch(/can't be worked out: cycle/);
  });

  it("refuses a reference to a dimension that isn't there", () => {
    const r = apply(plate(), { type: "updateFeature", id: "ext_1", patch: { distance: "=sketch_1.d9" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown dimension "sketch_1.d9"/);
  });
});

describe("names follow renames", () => {
  it("pins a default name once an expression reads it, so deleting before it can't shift it", () => {
    let d = plate();
    d = run(d, { type: "updateFeature", id: "ext_1", patch: { distance: "=sketch_1.d3" } });
    expect(feature(d, "sketch_1").constraints[2]).toEqual({ type: "radius", entity: "c1", value: 5, name: "d3" });
    d = run(d, { type: "deleteConstraint", sketch: "sketch_1", index: 0 });
    expect(dimensionNames(feature(d, "sketch_1").constraints)).toEqual(["d1", "d3"]);
    expect(resolvedDocument(d).features[1].distance).toBe(5);
    // Pinning is idempotent.
    expect(pinReferencedNames(d)).toBe(false);
  });

  it("renameDimension renames it, and every expression that read the old name", () => {
    let d = withSecond("=sketch_1.d3 * 2");
    feature(d, "ext_1").distance = "=sketch_1.d3 + 1";
    d = run(d, { type: "renameDimension", sketch: "sketch_1", index: 2, to: "hole_r" });
    expect(feature(d, "sketch_1").constraints[2].name).toBe("hole_r");
    expect(feature(d, "sketch_2").constraints[0].value).toBe("=sketch_1.hole_r * 2");
    expect(feature(d, "ext_1").distance).toBe("=sketch_1.hole_r + 1");
    expect(allErrors(validateDocument(d))).toEqual([]);
    expect(apply(d, { type: "renameDimension", sketch: "sketch_1", name: "d1", to: "hole_r" })).toEqual({ ok: false, error: 'renameDimension: sketch_1 already has a dimension "hole_r"' });
    expect(apply(d, { type: "renameDimension", sketch: "sketch_1", name: "d1", to: "1x" }).ok).toBe(false);
  });

  it("renaming a sketch renames the expressions that read its dimensions", () => {
    let d = withSecond("=sketch_1.d3 * 2");
    // ext_1 uses sketch_1, so rename the second sketch, which the first reads nothing from: make the first read it.
    d = run(d, { type: "setDimension", sketch: "sketch_1", index: 0, value: "=sketch_2.d1 * 4" });
    // Nothing references sketch_2 by id, so it can be renamed.
    d = run(d, { type: "updateFeature", id: "sketch_2", patch: { id: "holes" } });
    expect(feature(d, "sketch_1").constraints[0].value).toBe("=holes.d1 * 4");
    expect(allErrors(validateDocument(d))).toEqual([]);
  });

  it("renameParameter renames it everywhere", () => {
    let d = plate();
    d = run(d, { type: "setParameter", name: "t", value: 6 }, { type: "updateFeature", id: "ext_1", patch: { distance: "=t * 2" } }, { type: "setParameter", name: "t2", value: "=t + 1" });
    d = run(d, { type: "renameParameter", from: "t", to: "thickness" });
    expect(d.parameters).toEqual({ thickness: 6, t2: "=thickness + 1" });
    expect(feature(d, "ext_1").distance).toBe("=thickness * 2");
    expect(apply(d, { type: "deleteParameter", name: "thickness" })).toEqual({ ok: false, error: "deleteParameter: thickness is used by ext_1, parameter t2" });
  });
});

describe("driven dimensions", () => {
  it("adds an over-defining dimension as driven: it measures, and nothing moves", () => {
    const d = plate();
    // The rect's width is already 40: a second width over-defines it.
    const refused = apply(d, { type: "addConstraint", sketch: "sketch_1", constraint: { type: "distance", points: ["r1.center", "c1.center"], value: 40 } });
    expect(refused.ok).toBe(true); // the centre-to-centre distance is free: not over-defining
    const width = apply(d, { type: "addConstraint", sketch: "sketch_1", constraint: { type: "distanceX", entity: "r1", value: 40 } });
    expect(width.ok).toBe(false);
    const driven = ok(apply(d, { type: "addConstraint", sketch: "sketch_1", constraint: { type: "distanceX", entity: "r1", value: 0, driven: true } }));
    const k = feature(driven, "sketch_1").constraints[3];
    // Its value is what it measures, not what was typed.
    expect(k).toEqual({ type: "distanceX", entity: "r1", value: 40, driven: true });
    expect(feature(driven, "sketch_1").entities).toEqual(feature(d, "sketch_1").entities);
  });

  it("follows the geometry when a driving dimension changes, and expressions read it", () => {
    let d = plate();
    d = run(d, { type: "addConstraint", sketch: "sketch_1", constraint: { type: "distance", points: ["r1.center", "c1.center"], value: 0, driven: true } });
    expect(feature(d, "sketch_1").constraints[3].value).toBe(40);
    d = run(d, { type: "updateFeature", id: "ext_1", patch: { distance: "=sketch_1.d4 / 4" } });
    d = run(d, { type: "updateEntity", sketch: "sketch_1", id: "c1", patch: { center: [50, 0] } });
    expect(feature(d, "sketch_1").constraints[3].value).toBe(50);
    expect(resolvedDocument(d).features[1].distance).toBe(12.5);
  });

  it("refuses setting a driven dimension's value, and refuses making it driving when that over-defines", () => {
    let d = plate();
    d = run(d, { type: "addConstraint", sketch: "sketch_1", constraint: { type: "distanceX", entity: "r1", value: 1, driven: true } });
    const set = apply(d, { type: "setDimension", sketch: "sketch_1", index: 3, value: 50 });
    expect(set.ok).toBe(false);
    if (!set.ok) expect(set.error).toMatch(/is driven: the geometry sets it/);
    const back = apply(d, { type: "setDriven", sketch: "sketch_1", index: 3, driven: false });
    expect(back).toEqual({ ok: false, error: "setDriven: sketch_1.d4 would over-define the sketch as a driving dimension; it stays driven" });
    // Making the first width driven instead frees the second to drive.
    d = run(d, { type: "setDriven", sketch: "sketch_1", index: 0, driven: true }, { type: "setDriven", sketch: "sketch_1", index: 3, driven: false });
    d = run(d, { type: "setDimension", sketch: "sketch_1", index: 3, value: 50 });
    expect(feature(d, "sketch_1").entities[0].w).toBe(50);
    expect(feature(d, "sketch_1").constraints[0]).toEqual({ type: "distanceX", entity: "r1", value: 50, driven: true });
  });
});
