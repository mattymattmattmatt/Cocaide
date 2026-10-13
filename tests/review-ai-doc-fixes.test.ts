// Regressions from the Wave 5/6 review of the document and AI layers: a
// linear pattern's second direction read as a reference everywhere, a sketch
// rename that rewrites other features' expressions checked against the write
// scope, sketchProfile keeping negative =expression positions, measureBetween
// reading every point an ellipse or a spline has, and the holes helper in a
// right-click face ask.

import { beforeAll, describe, expect, it } from "vitest";
import { apply, references, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, type OC } from "../src/kernel";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const feature = (d: RawDocument, id: string) => d.features.find((f) => (f as { id: string }).id === id) as Record<string, unknown>;

describe("a linear pattern's second direction (along2)", () => {
  const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };
  const edge = (body: string, direction: number[], near: number[]) => ({ edge: { type: "edge", kind: "line", direction, body, near, pick: "all" } });
  /** A 100 x 60 x 10 plate named "plate", a hole, and a 2 x 2 pattern of it. */
  const plate = (along2: unknown, more: Record<string, unknown>[] = []): RawDocument => ({
    version: 1,
    units: "mm",
    name: "plate",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [50, 30], w: 100, h: 60 }] },
      { id: "e1", op: "extrude", sketch: "s1", distance: 10, newBody: "plate" },
      { id: "h1", op: "hole", face: TOP, center: [10, 10], diameter: 4, depth: "through" },
      ...more,
      { id: "lp", op: "linearPattern", feature: "h1", along: edge("plate", [1, 0, 0], [50, 0, 10]), spacing: 20, count: 2, along2, spacing2: 10, count2: 2 },
    ],
  });

  it("renameBody rewrites along2's body too, and the result rebuilds", () => {
    const d = plate(edge("plate", [0, 1, 0], [0, 30, 10]));
    expect(errorsOf(d)).toEqual([]);
    expect(rebuild(d, oc).errors).toEqual([]);
    const r = apply(d, { type: "renameBody", from: "plate", to: "slab" });
    if (!r.ok) throw new Error(r.error);
    const lp = feature(r.doc, "lp") as { along: { edge: { body: string } }; along2: { edge: { body: string } } };
    expect(lp.along.edge.body).toBe("slab");
    expect(lp.along2.edge.body).toBe("slab");
    expect(rebuild(r.doc, oc).errors).toEqual([]);
  });

  it("validation checks along2's body as it does along's", () => {
    expect(errorsOf(plate(edge("nope", [0, 1, 0], [0, 30, 10])))).toEqual(['lp: along2.edge.body: no body "nope" before this feature (bodies so far: plate)']);
  });

  it("an axis used only by along2 is a reference of the pattern: renaming or deleting it says the pattern uses it", () => {
    const ax = { id: "ax", op: "axis", mode: "twoPlanes", refs: [{ datum: "Top" }, { datum: "Right" }] };
    const d = plate({ datum: "ax" }, [ax]);
    expect(errorsOf(d)).toEqual([]);
    expect(references(feature(d, "lp"))).toContain("ax");
    // Renaming or deleting it is refused with the usual message naming the pattern.
    const renamed = apply(d, { type: "updateFeature", id: "ax", patch: { id: "ax2" } });
    expect(renamed.ok ? "" : renamed.error).toBe("updateFeature: cannot rename ax; lp uses it");
    const del = apply(d, { type: "deleteFeature", id: "ax" });
    expect(del.ok ? "" : del.error).toBe("deleteFeature: ax is used by lp; delete or change it first");
  });
});

describe("renaming a sketch and the write scope", () => {
  /** ext_1's distance reads sketch_2's diameter dimension; a parameter may read it too. */
  const linked = (paramReads = false): RawDocument => ({
    version: 1,
    units: "mm",
    name: "linked",
    ...(paramReads ? { parameters: { t: "=sketch_2.d1 / 2" } } : {}),
    features: [
      { id: "sketch_1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: 40, h: 20 }] },
      { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: "=sketch_2.d1" },
      {
        id: "sketch_2",
        op: "sketch",
        plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
        entities: [{ id: "c1", type: "circle", center: [5, 0], radius: 3 }],
        constraints: [{ type: "diameter", entity: "c1", value: 6 }],
      },
    ],
  });

  it("is refused when it would rewrite a feature outside the scope, as renameDimension is", () => {
    const d = linked();
    expect(errorsOf(d)).toEqual([]);
    const dim = apply(d, { type: "renameDimension", sketch: "sketch_2", name: "d1", to: "dia" }, { writeScope: ["sketch_2"] });
    expect(dim.ok).toBe(false);
    for (const cmd of [
      { type: "updateFeature", id: "sketch_2", patch: { id: "holes" } },
      { type: "replaceFeature", id: "sketch_2", feature: { ...feature(d, "sketch_2"), id: "holes" } },
    ] as const) {
      const r = apply(d, cmd, { writeScope: ["sketch_2"] });
      expect(r.ok ? "" : r.error).toBe(`writeScope: ${cmd.type} "sketch_2" is outside the scope [sketch_2]`);
      // With the reader in scope it goes, and the expression follows.
      const ok = apply(d, cmd, { writeScope: ["sketch_2", "ext_1"] });
      if (!ok.ok) throw new Error(ok.error);
      expect(feature(ok.doc, "ext_1").distance).toBe("=holes.d1");
    }
  });

  it("counts a parameter that reads the sketch's dimensions as a reader", () => {
    const d = linked(true);
    expect(errorsOf(d)).toEqual([]);
    const cmd = { type: "updateFeature", id: "sketch_2", patch: { id: "holes" } } as const;
    expect(apply(d, cmd, { writeScope: ["sketch_2", "ext_1"] }).ok).toBe(false);
    expect(apply(d, cmd, { writeScope: ["sketch_2", "ext_1", "param:t"] }).ok).toBe(true);
  });

  it("a sketch nothing reads by its dimensions renames within its own scope", () => {
    const d = linked();
    const lone = { ...d, features: [...d.features, { id: "sketch_3", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [] }] };
    expect(apply(lone, { type: "updateFeature", id: "sketch_3", patch: { id: "spare" } }, { writeScope: ["sketch_3"] }).ok).toBe(true);
  });
});
