// The sketch point entity (Phase O): { id, type: "point", at }. Validated
// strictly, two unknowns in the solver, related by its point "p1.at" like any
// other point (coincident, midpoint, on a curve, distances, level and plumb,
// fix, symmetric), drawn as a dot, picked and snapped to, never a profile.

import { describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import type { Constraint, SketchEntity } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { checkConstraints } from "../src/geom/constraints";
import { buildProfile, entityPolylines } from "../src/geom/profile";
import { sketchStatus, solveSketch, wouldOverDefine } from "../src/geom/solver";
import { relationGlyphs } from "../src/ui/sketcher/annotate";
import { distanceTo, handlesOf, hitEntity, inferPoint, itemEntities, smartDimension, suggestions } from "../src/ui/sketcher/draft";

const P: SketchEntity = { id: "p1", type: "point", at: [10, 5] };
const L: SketchEntity = { id: "l1", type: "line", start: [0, 0], end: [40, 0] };
const C: SketchEntity = { id: "c1", type: "circle", center: [0, 30], radius: 8 };

const solved = (entities: SketchEntity[], constraints: Constraint[]) => {
  const r = solveSketch(entities, constraints);
  if (!r.ok) throw new Error(r.error);
  expect(checkConstraints(r.entities, constraints)).toEqual([]);
  return r.entities;
};
const pointOf = (es: SketchEntity[]) => (es.find((e) => e.id === "p1") as { at: [number, number] }).at;

const doc = (entities: unknown[], constraints: unknown[] = []): RawDocument => ({
  version: 1,
  units: "mm",
  name: "points",
  features: [{ id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities, constraints }],
});
const errorsOf = (d: RawDocument) => allErrors(validateDocument(d));

describe("validation", () => {
  it("accepts a point and relations to its point", () => {
    expect(
      errorsOf(
        doc(
          [P, L, C],
          [
            { type: "coincident", points: ["p1.at", "origin"] },
            { type: "midpoint", point: "p1.at", entity: "l1" },
            { type: "pointOn", point: "p1.at", entity: "c1" },
            { type: "distance", points: ["p1.at", "l1.end"], value: 5 },
            { type: "distance", point: "p1.at", line: "l1", value: 5 },
            { type: "distanceX", points: ["p1.at", "origin"], value: 5 },
            { type: "horizontal", points: ["p1.at", "l1.start"] },
            { type: "symmetric", points: ["p1.at", "c1.center"], line: "l1" },
            { type: "fix", entity: "p1" },
            { type: "fix", point: "p1.at" },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it("says what is wrong with a bad one", () => {
    expect(errorsOf(doc([{ id: "p1", type: "point", at: [1, 2], radius: 3 }]))).toEqual(['s1: entities[0] "p1": unknown field "radius" (allowed: id, type, construction, ref, at)']);
    expect(errorsOf(doc([{ id: "p1", type: "point" }]))).toEqual(['s1: entities[0] "p1".at: must be an array of 2 numbers (got nothing)']);
    expect(errorsOf(doc([P], [{ type: "coincident", points: ["p1.center", "origin"] }]))).toEqual(['s1: constraints[0] coincident: point ref "p1.center": a point has points at']);
    expect(errorsOf(doc([P], [{ type: "horizontal", entity: "p1" }]))).toEqual(['s1: constraints[0] horizontal: entity "p1" is a point; this constraint applies to line']);
  });
});

describe("solver and checks", () => {
  it("a free point has two degrees of freedom; fixed, none", () => {
    expect(sketchStatus([P], []).dof).toBe(2);
    expect(sketchStatus([P], [{ type: "fix", entity: "p1" }]).dof).toBe(0);
    expect(sketchStatus([P], [{ type: "coincident", points: ["p1.at", "origin"] }])).toMatchObject({ dof: 0, free: new Set(), freePoints: new Set() });
  });

  it("moves to meet coincident, midpoint, on-curve and distance relations", () => {
    expect(pointOf(solved([P, L], [{ type: "fix", entity: "l1" }, { type: "coincident", points: ["p1.at", "l1.end"] }])).map((x) => Math.round(x * 1e9) / 1e9 + 0)).toEqual([40, 0]);
    // The line can move too: the midpoint relation holds wherever the solver settles.
    const mid = solved([P, L], [{ type: "fix", entity: "l1" }, { type: "midpoint", point: "p1.at", entity: "l1" }]);
    expect(pointOf(mid)[0]).toBeCloseTo(20, 9);
    expect(pointOf(mid)[1]).toBeCloseTo(0, 9);
    const on = pointOf(solved([P, C], [{ type: "fix", entity: "c1" }, { type: "pointOn", point: "p1.at", entity: "c1" }]));
    expect(Math.hypot(on[0], on[1] - 30)).toBeCloseTo(8, 9);
    const d = pointOf(solved([P], [{ type: "distance", points: ["p1.at", "origin"], value: 20 }]));
    expect(Math.hypot(...d)).toBeCloseTo(20, 9);
    const sym = solved([P, C, L], [{ type: "fix", entity: "l1" }, { type: "fix", entity: "c1" }, { type: "symmetric", points: ["p1.at", "c1.center"], line: "l1" }]);
    expect(pointOf(sym)[0]).toBeCloseTo(0, 9);
    expect(pointOf(sym)[1]).toBeCloseTo(-30, 9);
  });

  it("is dragged by its point, and a fixed one refuses to move", () => {
    const r = solveSketch([P], [], { drag: [{ handle: "p1.at", to: [3, 4] }] });
    expect(r.ok && pointOf(r.entities)).toEqual([3, 4]);
    const held = solveSketch([P], [{ type: "fix", entity: "p1" }], { drag: [{ handle: "p1.body", from: [10, 5], to: [3, 4] }] });
    expect(held.ok ? pointOf(held.entities) : null).not.toEqual([3, 4]);
  });

  it("knows when a relation on it repeats another", () => {
    const ks: Constraint[] = [{ type: "coincident", points: ["p1.at", "origin"] }];
    expect(wouldOverDefine([P], ks, { type: "fix", point: "p1.at" })).toBe(true);
    expect(wouldOverDefine([P], [], { type: "fix", point: "p1.at" })).toBe(false);
  });

  it("the rebuild's check reads it", () => {
    expect(checkConstraints([P], [{ type: "coincident", points: ["p1.at", "origin"] }])).toEqual([
      "constraint 0 (coincident p1.at origin) is not satisfied: geometry gives 11.18034, constraint says 0",
    ]);
  });
});

describe("profiles", () => {
  it("a point bounds nothing: it is skipped, and alone makes no region", () => {
    const square: SketchEntity[] = [
      { id: "l1", type: "line", start: [0, 0], end: [10, 0] },
      { id: "l2", type: "line", start: [10, 0], end: [10, 10] },
      { id: "l3", type: "line", start: [10, 10], end: [0, 10] },
      { id: "l4", type: "line", start: [0, 10], end: [0, 0] },
    ];
    expect(buildProfile([...square, { id: "p1", type: "point", at: [5, 5] }, { id: "p2", type: "point", at: [10, 10] }])).toMatchObject({ ok: true, area: 100 });
    expect(buildProfile([P])).toEqual({ ok: true, regions: [], area: 0 });
    expect(entityPolylines(P)).toEqual([]);
  });
});

describe("commands", () => {
  it("addEntity gives a point the next p id; a relation to it re-solves and writes it back", () => {
    let d = doc([L]);
    const add = apply(d, { type: "addEntity", sketch: "s1", entity: { type: "point", at: [7, 7] } });
    if (!add.ok) throw new Error(add.error);
    d = add.doc;
    const ents = () => (d.features[0] as { entities: SketchEntity[] }).entities;
    expect(ents()[1]).toEqual({ type: "point", at: [7, 7], id: "p1" });
    const rel = apply(d, { type: "addConstraint", sketch: "s1", constraint: { type: "coincident", points: ["p1.at", "l1.end"] } });
    if (!rel.ok) throw new Error(rel.error);
    d = rel.doc;
    const [line, point] = ents() as unknown as [{ end: number[] }, { at: number[] }];
    expect(point.at).toEqual(line.end);
    expect(errorsOf(d)).toEqual([]);
  });
});

describe("the sketcher", () => {
  it("draws, picks and snaps to it by its dot", () => {
    expect(handlesOf(P)).toEqual([{ ref: "p1.at", point: [10, 5], constraint: true }]);
    expect(distanceTo(P, [13, 9])).toBe(5);
    expect(hitEntity([L, P], [10.5, 5], 1)?.id).toBe("p1");
    expect(inferPoint([L, P], [10.3, 4.8], 1)).toEqual({ p: [10, 5], ref: "p1.at" });
  });

  it("offers a point's relations whether it is picked as an entity or by its point", () => {
    const asEntity = suggestions([P, L], [{ kind: "entity", id: "p1" }, { kind: "entity", id: "l1" }]).map((s) => s.testId);
    const asPoint = suggestions([P, L], [{ kind: "point", ref: "p1.at" }, { kind: "entity", id: "l1" }]).map((s) => s.testId);
    expect(asEntity).toEqual(asPoint);
    expect(asEntity).toEqual(expect.arrayContaining(["c-on", "c-midpoint", "c-line-distance"]));
    expect(smartDimension([P, L], [{ kind: "entity", id: "p1" }, { kind: "entity", id: "l1" }])[0].testId).toBe("c-line-distance");
    expect(itemEntities([{ kind: "point", ref: "p1.at" }, { kind: "point", ref: "l1.end" }, { kind: "entity", id: "l1" }], [P, L])).toEqual(["p1", "l1"]);
  });

  it("puts a relation's glyph on the point", () => {
    const glyphs = relationGlyphs([P, L], [{ type: "fix", entity: "p1" }], 1);
    expect(glyphs).toHaveLength(1);
  });
});
