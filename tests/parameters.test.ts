import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { evaluate, parameterRefs, resolvedDocument, restoreExpressions, resolveExpressions } from "../src/doc/parameters";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, type OC } from "../src/kernel";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;

function ok(r: ReturnType<typeof apply>): RawDocument {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

/** The bracket with its sizes as parameters. */
function parametric(): RawDocument {
  const d = structuredClone(bracket);
  d.parameters = { plate_w: 80, plate_t: 6, hole_d: 6.6 };
  const sketch = d.features[0] as { entities: Record<string, unknown>[]; constraints: Record<string, unknown>[] };
  sketch.constraints[0].value = "=plate_w";
  d.features[1].distance = "=plate_t";
  d.features[2].diameter = "=hole_d";
  d.features[2].center = ["=plate_w / 2 - 10", 0];
  return d;
}

describe("expressions", () => {
  it("evaluates arithmetic over parameters", () => {
    const p = { a: 6, b: 2.5 };
    expect(evaluate("=a", p)).toEqual({ ok: true, value: 6 });
    expect(evaluate("=a * 2 + b", p)).toEqual({ ok: true, value: 14.5 });
    expect(evaluate("=(a + b) / 2", p)).toEqual({ ok: true, value: 4.25 });
    expect(evaluate("=-a + 1e1", p)).toEqual({ ok: true, value: 4 });
    expect(evaluate("=a - -b", p)).toEqual({ ok: true, value: 8.5 });
  });

  it("says what is wrong with a bad expression", () => {
    expect(evaluate("=c * 2", {})).toEqual({ ok: false, error: 'unknown parameter "c" in "=c * 2"' });
    expect(evaluate("=1 / 0", {})).toEqual({ ok: false, error: 'division by zero in "=1 / 0"' });
    expect(evaluate("=(1 + 2", {})).toEqual({ ok: false, error: 'missing ) in "=(1 + 2"' });
    expect(evaluate("=2 +", {})).toEqual({ ok: false, error: 'unexpected end in "=2 +"' });
    expect(evaluate("=2 ^ 3", {})).toEqual({ ok: false, error: 'unexpected "^" in "=2 ^ 3"' });
    expect(evaluate("=Math.PI", {}).ok).toBe(false);
  });

  it("finds the parameters an object uses", () => {
    expect([...parameterRefs(parametric().features[2])].sort()).toEqual(["hole_d", "plate_w"]);
    expect([...parameterRefs({ v: "=2e3 * k" })]).toEqual(["k"]);
  });

  it("validates a parametric document and resolves it", () => {
    const d = parametric();
    expect(allErrors(validateDocument(d))).toEqual([]);
    const r = resolvedDocument(d);
    expect(r.features[1].distance).toBe(6);
    expect(r.features[2].center).toEqual([30, 0]);
  });

  it("reports a bad expression against its feature and field", () => {
    const d = parametric();
    d.features[2].diameter = "=hole_dia";
    expect(allErrors(validateDocument(d))).toEqual(['hole_1: diameter: unknown parameter "hole_dia" in "=hole_dia"']);
    d.parameters = { "1x": 2 };
    expect(allErrors(validateDocument(d))).toContain("document: parameters.1x: a parameter name is letters, digits and _ and starts with a letter");
  });
});

describe("restoring expressions after a numeric edit", () => {
  it("keeps expressions whose value did not change, matching entities by id and constraints by refs", () => {
    const params = { w: 80, h: 40 };
    const original = {
      entities: [
        { id: "r1", type: "rect", center: [0, 0], w: "=w", h: "=h" },
        { id: "c1", type: "circle", center: ["=w / 4", 0], radius: 3 },
      ],
      constraints: [{ type: "distanceX", entity: "r1", value: "=w" }],
    };
    const edited = resolveExpressions(original, params, []) as typeof original;
    // The sketcher deleted nothing, added a circle first, and changed the height.
    (edited.entities[0] as { h: unknown }).h = 50;
    edited.entities.unshift({ id: "c0", type: "circle", center: [1, 1], radius: 1 } as never);
    const back = restoreExpressions(original, edited, params) as typeof original;
    expect(back.entities[0]).toEqual({ id: "c0", type: "circle", center: [1, 1], radius: 1 });
    expect(back.entities[1]).toEqual({ id: "r1", type: "rect", center: [0, 0], w: "=w", h: 50 });
    expect(back.entities[2]).toEqual({ id: "c1", type: "circle", center: ["=w / 4", 0], radius: 3 });
    expect(back.constraints).toEqual([{ type: "distanceX", entity: "r1", value: "=w" }]);
  });
});

describe("parameter commands", () => {
  it("setParameter changes every field that uses it", () => {
    const d = ok(apply(parametric(), { type: "setParameter", name: "plate_t", value: 10 }));
    expect(d.parameters).toEqual({ plate_w: 80, plate_t: 10, hole_d: 6.6 });
    expect(d.features[1].distance).toBe("=plate_t");
    expect(resolvedDocument(d).features[1].distance).toBe(10);
  });

  it("setParameter re-solves a sketch whose dimension uses it", () => {
    const d = ok(apply(parametric(), { type: "setParameter", name: "plate_w", value: 100 }));
    const sketch = d.features[0] as { entities: Record<string, unknown>[]; constraints: Record<string, unknown>[] };
    expect(sketch.entities[0].w).toBe(100);
    expect(sketch.entities[0].center).toEqual([0, 0]); // the anchor stays put
    expect(sketch.constraints[0].value).toBe("=plate_w");
    expect(resolvedDocument(d).features[2].center).toEqual([40, 0]);
    expect(allErrors(validateDocument(d))).toEqual([]);
  });

  it("setParameter rejects a value that makes a feature invalid", () => {
    const r = apply(parametric(), { type: "setParameter", name: "hole_d", value: -1 });
    expect(r).toEqual({ ok: false, error: "setParameter rejected: hole_1: diameter: must be greater than 0 (got -1)" });
  });

  it("setParameter adds a new parameter", () => {
    const d = ok(apply(bracket, { type: "setParameter", name: "boss_h", value: 12 }));
    expect(d.parameters).toEqual({ boss_h: 12 });
    expect(apply(bracket, { type: "setParameter", name: "2x", value: 1 })).toEqual({
      ok: false,
      error: 'setParameter: "2x" is not a parameter name (letters, digits, _)',
    });
  });

  it("deleteParameter refuses while a feature uses it", () => {
    expect(apply(parametric(), { type: "deleteParameter", name: "hole_d" })).toEqual({
      ok: false,
      error: "deleteParameter: hole_d is used by hole_1",
    });
    const d = ok(apply(ok(apply(bracket, { type: "setParameter", name: "k", value: 1 })), { type: "deleteParameter", name: "k" }));
    expect(d.parameters).toBeUndefined();
  });

  it("setDimension changes a sketch dimension and re-solves", () => {
    const d = ok(apply(bracket, { type: "setDimension", sketch: "sketch_1", index: 0, value: 90 }));
    const s = d.features[0] as { entities: Record<string, unknown>[] };
    expect(s.entities[0].w).toBe(90);
    expect(s.entities[0].h).toBe(40);
    const e = ok(apply(parametric(), { type: "setDimension", sketch: "sketch_1", index: 0, value: "=plate_w + 20" }));
    expect((e.features[0] as { entities: Record<string, unknown>[] }).entities[0].w).toBe(100);
  });

  it("setDimension says why it cannot", () => {
    expect(apply(bracket, { type: "setDimension", sketch: "ext_1", index: 0, value: 1 })).toEqual({
      ok: false,
      error: 'setDimension: "ext_1" is a extrude, not a sketch',
    });
    expect(apply(bracket, { type: "setDimension", sketch: "sketch_1", index: 3, value: 1 })).toEqual({
      ok: false,
      error: "setDimension: sketch_1 has no dimension at index 3 (it has 1 constraints)",
    });
    expect(apply(bracket, { type: "setDimension", sketch: "sketch_1", index: 0, value: -5 }).ok).toBe(false);
  });

  it("a field written as an expression is held while the sketch solves", () => {
    const d = structuredClone(bracket);
    d.parameters = { h: 40 };
    const s = d.features[0] as { entities: Record<string, unknown>[] };
    s.entities[0].h = "=h";
    const r = ok(apply(d, { type: "setDimension", sketch: "sketch_1", index: 0, value: 50 }));
    const e = (r.features[0] as { entities: Record<string, unknown>[] }).entities[0];
    expect(e.w).toBe(50);
    expect(e.h).toBe("=h");
  });
});

describe("parametric rebuild", () => {
  let oc: OC;
  beforeAll(async () => {
    oc = await loadOC();
  });

  it("the parametric bracket has the bracket's volume, and follows its parameters", () => {
    const a = rebuild(parametric(), oc);
    expect(a.errors).toEqual([]);
    expect(a.measurements!.volume).toBeCloseTo(18994.728336, 4);
    a.dispose();
    const thick = ok(apply(parametric(), { type: "setParameter", name: "plate_t", value: 10 }));
    const b = rebuild(thick, oc);
    expect(b.measurements!.volume).toBeCloseTo(80 * 40 * 10 - Math.PI * 3.3 ** 2 * 10, 4);
    b.dispose();
  });
});
