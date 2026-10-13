// Regressions from the Wave 5/6 review of the sketcher: a point on a spline
// past its end, a spline's points moved through updateEntity, sketch edits
// re-solving the sketches that read a dimension they re-measured, tangency
// with a closed spline, and mirrored ellipses and splines held to their
// originals.

import { describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import type { Constraint, EllipseEntity, SketchEntity, SplineEntity, Vec2 } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { checkConstraints } from "../src/geom/constraints";
import { closestOnSpline, entityPoint, splineEndTangent, splineOf } from "../src/geom/curves";
import { sketchDof, solveSketch, wouldOverDefine } from "../src/geom/solver";
import { mirrorEntities, reflectPoint } from "../src/geom/sketchEdit/mirror";
import type { Edit, SketchState } from "../src/geom/sketchEdit/relations";

const PLANE = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const doc = (entities: unknown[], constraints: unknown[] = []): RawDocument => ({
  version: 1,
  units: "mm",
  name: "review",
  features: [{ id: "s1", op: "sketch", plane: PLANE, entities, constraints }],
});
const sketch = (d: RawDocument, id: string) => d.features.find((f) => (f as { id: string }).id === id) as { entities: SketchEntity[]; constraints: Constraint[] };
const byId = <T extends SketchEntity>(es: SketchEntity[], id: string) => es.find((e) => e.id === id) as T;
const ok = (r: Edit | string): Edit => {
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("a point on an open spline", () => {
  const sp: SplineEntity = { id: "sp1", type: "spline", points: [[0, 0], [10, 5], [20, 0]] };

  it("ends on the spline, not on its end tangent's straight extension", () => {
    const p1: SketchEntity = { id: "p1", type: "point", at: [32.5, -8.7] };
    const k: Constraint[] = [{ type: "fix", entity: "sp1" }, { type: "pointOn", point: "p1.at", entity: "sp1" }];
    const r = solveSketch([sp, p1], k);
    if (r.ok) {
      expect(checkConstraints(r.entities, k)).toEqual([]);
      const at = byId<Extract<SketchEntity, { type: "point" }>>(r.entities, "p1").at;
      expect(closestOnSpline(splineOf(sp), at).distance).toBeLessThan(1e-6);
    }
    // Through the command: either refused, or the point really is on the spline.
    const d = doc([sp, p1], [{ type: "fix", entity: "sp1" }]);
    const c = apply(d, { type: "addConstraint", sketch: "s1", constraint: { type: "pointOn", point: "p1.at", entity: "sp1" } });
    if (c.ok) {
      const at = byId<Extract<SketchEntity, { type: "point" }>>(sketch(c.doc, "s1").entities, "p1").at;
      expect(closestOnSpline(splineOf(sp), at).distance).toBeLessThan(1e-6);
    }
  });

  it("still lands a point beside the middle of the spline on it", () => {
    const p1: SketchEntity = { id: "p1", type: "point", at: [10, 9] };
    const k: Constraint[] = [{ type: "fix", entity: "sp1" }, { type: "pointOn", point: "p1.at", entity: "sp1" }];
    const r = solveSketch([sp, p1], k);
    if (!r.ok) throw new Error(r.error);
    expect(checkConstraints(r.entities, k)).toEqual([]);
  });
});

describe("updateEntity on a spline's points", () => {
  it("moves the points and re-solves what is joined to them", () => {
    const d = doc(
      [
        { id: "sp1", type: "spline", points: [[0, 0], [10, 8], [25, 5], [40, 12]] },
        { id: "l1", type: "line", start: [40, 12], end: [60, 12] },
      ],
      [{ type: "coincident", points: ["sp1.p3", "l1.start"] }],
    );
    const r = apply(d, { type: "updateEntity", sketch: "s1", id: "sp1", patch: { points: [[0, 0], [10, 8], [25, 5], [45, 20]] } });
    if (!r.ok) throw new Error(r.error);
    const s = sketch(r.doc, "s1");
    expect(byId<SplineEntity>(s.entities, "sp1").points[3]).toEqual([45, 20]);
    expect(byId<Extract<SketchEntity, { type: "line" }>>(s.entities, "l1").start).toEqual([45, 20]);
    expect(allErrors(validateDocument(r.doc))).toEqual([]);
  });
});

describe("sketch edits and the sketches that read their dimensions", () => {
  const base = (): RawDocument => ({
    version: 1,
    units: "mm",
    name: "linked",
    features: [
      {
        id: "s1",
        op: "sketch",
        plane: PLANE,
        entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 4 }],
        constraints: [{ type: "radius", entity: "c1", value: 4, driven: true, name: "r" }],
      },
      {
        id: "s2",
        op: "sketch",
        plane: PLANE,
        entities: [{ id: "c1", type: "circle", center: [30, 0], radius: 8 }],
        constraints: [{ type: "radius", entity: "c1", value: "=s1.r * 2" }],
      },
    ],
  });
  const radius = (d: RawDocument, s: string) => byId<Extract<SketchEntity, { type: "circle" }>>(sketch(d, s).entities, "c1").radius;

  it("updateEntity re-solves another sketch reading a driven dimension it changed", () => {
    const b = base();
    expect(allErrors(validateDocument(b))).toEqual([]);
    const r = apply(b, { type: "updateEntity", sketch: "s1", id: "c1", patch: { radius: 6 } });
    if (!r.ok) throw new Error(r.error);
    expect(sketch(r.doc, "s1").constraints[0]).toMatchObject({ value: 6 });
    expect(radius(r.doc, "s2")).toBeCloseTo(12, 9);
  });

  it("addConstraint does too", () => {
    const b = base();
    (b.features[0] as { constraints: unknown[] }).constraints.push({ type: "distanceX", points: ["c1.center", "origin"], value: 0 });
    const r = apply(b, { type: "addEntity", sketch: "s1", entity: { id: "l1", type: "line", start: [0, 0], end: [5, 0] } });
    if (!r.ok) throw new Error(r.error);
    const r2 = apply(r.doc, { type: "addConstraint", sketch: "s1", constraint: { type: "tangent", entities: ["l1", "c1"] } });
    if (!r2.ok) throw new Error(r2.error);
    const s1r = radius(r2.doc, "s1");
    expect(radius(r2.doc, "s2")).toBeCloseTo(2 * s1r, 9);
  });
});

describe("tangent with a closed spline", () => {
  const open: SplineEntity = { id: "sp1", type: "spline", points: [[0, 0], [10, 8], [20, 0]] };
  const closed: SplineEntity = { id: "sp2", type: "spline", points: [[30, 0], [40, 10], [50, 0], [40, -10]], closed: true };

  for (const pair of [["sp1", "sp2"], ["sp2", "sp1"]] as [string, string][]) {
    it(`is refused with a clear message either way round (${pair.join(", ")})`, () => {
      const d = doc([open, closed], [{ type: "tangent", entities: pair }]);
      expect(allErrors(validateDocument(d)).join("\n")).toContain('"sp2" is a closed spline');
      const r = apply(doc([open, closed]), { type: "addConstraint", sketch: "s1", constraint: { type: "tangent", entities: pair } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("closed spline");
        expect(r.error).not.toContain("Cannot read properties");
      }
    });
  }
});

describe("mirroring ellipses and splines", () => {
  /** A fully defined elliptical arc: fixed. */
  const arcState = (): SketchState => ({
    entities: [{ id: "el1", type: "ellipse", center: [20, 0], major: [40, 10], minor: 8, startAngle: 10, endAngle: 120 }],
    constraints: [{ type: "fix", entity: "el1" }],
  });

  it("holds a copied elliptical arc's ends: no freedom added, and editing the original's end moves the image's", () => {
    const base = arcState();
    expect(sketchDof(base.entities, base.constraints)).toBe(0);
    const r = ok(mirrorEntities(base, ["el1"], "Y"));
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    expect(sketchDof(r.entities, r.constraints)).toBe(0);
    // The original's end angle moved to 150: the image's start follows to −150.
    const moved = r.entities.map((e) => (e.id === "el1" ? { ...e, endAngle: 150 } : e)) as SketchEntity[];
    const s = solveSketch(moved, r.constraints);
    if (!s.ok) throw new Error(s.error);
    const im = byId<EllipseEntity>(s.entities, r.made![0]);
    expect(im.startAngle).toBeCloseTo(-150, 6);
    const orig = byId<EllipseEntity>(s.entities, "el1");
    const m = (p: Vec2): Vec2 => [-p[0], p[1]];
    const end = m(entityPoint(orig, "end")!);
    const start = entityPoint(im, "start")!;
    expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeLessThan(1e-6);
  });

  it("holds a copied spline's end tangents to the original's mirrored", () => {
    const sp: SplineEntity = { id: "sp1", type: "spline", points: [[5, 0], [15, 8], [30, 4]], startTangent: 30, endTangent: -20 };
    const base: SketchState = { entities: [sp], constraints: [{ type: "fix", entity: "sp1" }] };
    expect(sketchDof(base.entities, base.constraints)).toBe(0);
    const r = ok(mirrorEntities(base, ["sp1"], "Y"));
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    expect(sketchDof(r.entities, r.constraints)).toBe(0);
    // The original's start tangent turned to 60°: the image's follows to 120°.
    const moved = r.entities.map((e) => (e.id === "sp1" ? { ...e, startTangent: 60 } : e)) as SketchEntity[];
    const s = solveSketch(moved, r.constraints);
    if (!s.ok) throw new Error(s.error);
    const t = splineEndTangent(byId<SplineEntity>(s.entities, r.made![0]), false);
    expect(t[0]).toBeCloseTo(Math.cos((120 * Math.PI) / 180), 6);
    expect(t[1]).toBeCloseTo(Math.sin((120 * Math.PI) / 180), 6);
    // It validates as a document.
    expect(allErrors(validateDocument(doc(r.entities, r.constraints)))).toEqual([]);
  });

  it("refuses a symmetric relation between splines that can't be mirror images", () => {
    const d = doc(
      [
        { id: "sp1", type: "spline", points: [[5, 0], [15, 8], [30, 4]] },
        { id: "sp2", type: "spline", points: [[-5, 0], [-30, 4]] },
      ],
      [{ type: "symmetric", entities: ["sp1", "sp2"], line: "Y" }],
    );
    expect(allErrors(validateDocument(d)).join("\n")).toContain("as many points");
  });

  it("moves an ellipse over without copying and keeps a relation on its minor end", () => {
    const state: SketchState = {
      entities: [
        { id: "el1", type: "ellipse", center: [20, 0], major: [40, 0], minor: 8 },
        { id: "p1", type: "point", at: [20, 8] },
      ],
      constraints: [{ type: "coincident", points: ["el1.minorEnd", "p1.at"] }],
    };
    const r = ok(mirrorEntities(state, ["el1", "p1"], "X", { copy: false }));
    expect(r.constraints).toContainEqual({ type: "coincident", points: ["el1.minorEnd", "p1.at"] });
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    const el = byId<EllipseEntity>(r.entities, "el1");
    const p = byId<Extract<SketchEntity, { type: "point" }>>(r.entities, "p1").at;
    expect(p[1]).toBeCloseTo(-8, 9);
    const me = entityPoint(el, "minorEnd")!;
    expect(Math.hypot(me[0] - p[0], me[1] - p[1])).toBeLessThan(1e-9);
    // The same ellipse as before, mirrored: its major end is where the original's mirrored lies, at either end.
    expect([reflectPoint([40, 0], [[0, 0], [1, 0]]), reflectPoint([0, 0], [[0, 0], [1, 0]])]).toContainEqual(el.major);
  });

  it("moves an elliptical arc over without copying: the same curve, mirrored", () => {
    const el: EllipseEntity = { id: "el1", type: "ellipse", center: [20, 5], major: [40, 10], minor: 8, startAngle: 10, endAngle: 120 };
    for (const constraints of [[], [{ type: "coincident", points: ["el1.minorEnd", "p1.at"] } as Constraint]]) {
      const p1: SketchEntity = { id: "p1", type: "point", at: entityPoint(el, "minorEnd")! };
      const r = ok(mirrorEntities({ entities: [el, p1], constraints }, ["el1", "p1"], "X", { copy: false }));
      const im = byId<EllipseEntity>(r.entities, "el1");
      const m = (q: Vec2): Vec2 => [q[0], -q[1]];
      for (const [a, b] of [["start", "end"], ["end", "start"]]) {
        const want = m(entityPoint(el, a)!);
        const got = entityPoint(im, b)!;
        expect(Math.hypot(want[0] - got[0], want[1] - got[1])).toBeLessThan(1e-9);
      }
      expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
      expect(r.constraints).toHaveLength(constraints.length);
    }
  });

  it("does not let wouldOverDefine crash on a closed spline", () => {
    const open: SplineEntity = { id: "sp1", type: "spline", points: [[0, 0], [10, 8], [20, 0]] };
    const closed: SplineEntity = { id: "sp2", type: "spline", points: [[30, 0], [40, 10], [50, 0], [40, -10]], closed: true };
    expect(() => wouldOverDefine([open, closed], [], { type: "tangent", entities: ["sp2", "sp1"] })).toThrow(/closed spline/);
  });
});
