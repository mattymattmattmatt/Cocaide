// Regressions from the Wave 5/6 review of the document and AI layers: a
// linear pattern's second direction read as a reference everywhere, a sketch
// rename that rewrites other features' expressions checked against the write
// scope, sketchProfile keeping negative =expression positions, measureBetween
// reading every point an ellipse or a spline has, and the holes helper in a
// right-click face ask.

import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { measureBetween } from "../src/ask/tools/inspect";
import { sketchProfile } from "../src/ask/tools/sketchProfile";
import { apply, references, type RawDocument } from "../src/doc/commands";
import type { EllipseEntity, SketchEntity, SplineEntity } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { entityPoint } from "../src/geom/curves";
import { getOC, loadOC, rebuild, type OC } from "../src/kernel";

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

describe("sketchProfile positions given as =expressions", () => {
  type Circle = Extract<SketchEntity, { type: "circle" }>;
  const centreAfter = (cx: string, w2: number, shape: Record<string, unknown>) => {
    const doc: RawDocument = { version: 1, units: "mm", name: "t", parameters: { w: 40 }, features: [] };
    const m = sketchProfile(doc, { sketch: "sk", shapes: [{ rect: { center: [cx, 0], width: 10, height: 10 } }, shape] });
    if (typeof m === "string") throw new Error(m);
    const a = apply(doc, m.command);
    if (!a.ok) throw new Error(a.error);
    const kept = (feature(a.doc, "sk").constraints as { type: string; value: unknown }[]).filter((k) => typeof k.value === "string").map((k) => [k.type, k.value]);
    const b = apply(a.doc, { type: "setParameter", name: "w", value: w2 });
    if (!b.ok) throw new Error(b.error);
    expect(errorsOf(b.doc)).toEqual([]);
    const c = (feature(b.doc, "sk").entities as SketchEntity[]).find((e) => e.type === "circle") as Circle;
    return { kept, center: c.center };
  };

  it("keeps a negative one (left of the origin), and the shapes follow the parameter", () => {
    const pos = centreAfter("=w/4", 80, { circle: { center: ["=w/4", 20], diameter: 4 } });
    expect(pos.center[0]).toBeCloseTo(20, 6);
    const neg = centreAfter("=-w/4", 80, { circle: { center: ["=-w/4", 20], diameter: 4 } });
    expect(neg.kept.length).toBe(2);
    expect(neg.center[0]).toBeCloseTo(-20, 6);
    expect(neg.center[1]).toBeCloseTo(20, 6);
  });

  it("keeps a negative y, and a polygon's centre", () => {
    const r = centreAfter("=-w/4", 80, { polygon: { center: ["=-w/4", "=-w/2"], sides: 6, diameter: 6 } });
    // The polygon's construction circle is the only circle.
    expect(r.center[0]).toBeCloseTo(-20, 6);
    expect(r.center[1]).toBeCloseTo(-40, 6);
  });
});

describe("measureBetween and the points of ellipses and splines", () => {
  const el: EllipseEntity = { id: "el", type: "ellipse", center: [10, 5], major: [30, 5], minor: 8, startAngle: 0, endAngle: 90 };
  const sp: SplineEntity = { id: "sp", type: "spline", points: [[-10, 0], [-5, 12], [0, 20]] };
  const d: RawDocument = {
    version: 1,
    units: "mm",
    name: "curves",
    features: [{ id: "sk", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [el, sp, { id: "l1", type: "line", start: [0, 0], end: [5, 5] }] }],
  };

  it("resolves every documented point ref, the computed ones too", async () => {
    expect(errorsOf(d)).toEqual([]);
    const kernel = new LocalKernel(getOC);
    const refs = ["l1.end", "el.center", "el.major", "el.minorEnd", "el.start", "el.end", "sp.p0", "sp.p2"];
    for (const point of refs) {
      const [id, name] = point.split(".");
      const e = (feature(d, "sk").entities as SketchEntity[]).find((x) => x.id === id)!;
      const p = entityPoint(e, name)!;
      const r = await measureBetween(d, kernel, { a: { sketch: "sk", point }, b: [0, 0, 20] });
      expect(r.error, point).toBeUndefined();
      expect(r.distance as number, point).toBeCloseTo(Math.hypot(p[0], p[1], 20), 6);
    }
  });

  it("lists the points an entity really has when one is not", async () => {
    const kernel = new LocalKernel(getOC);
    const r = await measureBetween(d, kernel, { a: { sketch: "sk", point: "sp.center" }, b: [0, 0, 0] });
    expect(r.error).toBe('measureBetween: a: "sp.center" is not a point of sp (a spline: sp.p0, sp.p1, sp.p2)');
    const e = await measureBetween(d, kernel, { a: { sketch: "sk", point: "el.p0" }, b: [0, 0, 0] });
    expect(e.error).toContain("el.minorEnd");
    expect(e.error).toContain("el.start");
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
