// Ellipses and splines as sketch entities (Phase O wave 6): validation,
// their geometry (exact areas, interpolation through the points), solver
// unknowns and relations, profiles, and the write-back of solved spline
// points into the document.

import { describe, expect, it } from "vitest";
import { apply, resolveSketch, type RawDocument } from "../src/doc/commands";
import type { Constraint, EllipseEntity, SketchEntity, SplineEntity, Vec2 } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { checkConstraints } from "../src/geom/constraints";
import { closestOnSpline, ellipseGeom, ellipseLength, ellipsePoint, entityPoint, pointNames, splineEndTangent, splineOf, withPointAt } from "../src/geom/curves";
import { buildProfile, entityPolylines, intersect, segArea } from "../src/geom/profile";
import { fieldsOf, sketchDof, sketchStatus, solveSketch } from "../src/geom/solver";
import { bezierPoint, interpolate, reverseSpline, splineArea, splineLength, splinePoint } from "../src/geom/spline";

/** Lines that close S into a loop under it. */
const BOX: SketchEntity[] = [
  { id: "b1", type: "line", start: [40, 12], end: [40, -10] },
  { id: "b2", type: "line", start: [40, -10], end: [0, -10] },
  { id: "b3", type: "line", start: [0, -10], end: [0, 0] },
];
const E: EllipseEntity = { id: "el1", type: "ellipse", center: [0, 0], major: [30, 0], minor: 20 };
const S: SplineEntity = { id: "sp1", type: "spline", points: [[0, 0], [10, 8], [25, 5], [40, 12]] };

const doc = (entities: unknown[], constraints: unknown[] = []): RawDocument => ({
  version: 1,
  units: "mm",
  name: "curves",
  features: [{ id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities, constraints }],
});
const errorsOf = (d: RawDocument) => allErrors(validateDocument(d));
const solved = (entities: SketchEntity[], constraints: Constraint[]) => {
  const r = solveSketch(entities, constraints);
  if (!r.ok) throw new Error(r.error);
  expect(checkConstraints(r.entities, constraints)).toEqual([]);
  return r.entities;
};
const byId = <T extends SketchEntity>(es: SketchEntity[], id: string) => es.find((e) => e.id === id) as T;
const close = (p: Vec2, q: Vec2, tol = 1e-6) => expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(tol);

describe("validation", () => {
  it("accepts ellipses, elliptical arcs and splines with relations to their points", () => {
    const arc: EllipseEntity = { id: "el2", type: "ellipse", center: [80, 0], major: [80, 20], minor: 10, startAngle: 0, endAngle: 180 };
    const line = { id: "l1", type: "line", start: [-40, -30], end: [40, -30] };
    expect(
      errorsOf(
        doc(
          [E, arc, S, { ...S, id: "sp2", points: [[0, 50], [20, 60], [10, 70]], closed: true }, line],
          [
            { type: "coincident", points: ["el1.center", "origin"] },
            { type: "horizontal", entity: "el1" },
            { type: "distance", points: ["el1.center", "el1.major"], value: 30 },
            { type: "distance", points: ["el1.center", "el1.minorEnd"], value: 20 },
            { type: "coincident", points: ["el2.start", "l1.end"] },
            { type: "tangent", entities: ["el1", "l1"] },
            { type: "concentric", entities: ["el1", "el2"] },
            { type: "pointOn", point: "sp1.p0", entity: "el1" },
            { type: "pointOn", point: "l1.start", entity: "sp1" },
            { type: "tangent", entities: ["sp1", "l1"] },
            { type: "fix", point: "sp1.p3" },
            { type: "fix", entity: "sp2" },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it("says what is wrong with a bad ellipse", () => {
    expect(errorsOf(doc([{ ...E, minor: 0 }]))).toEqual(['s1: entities[0] "el1".minor: must be greater than 0 (got 0)']);
    expect(errorsOf(doc([{ ...E, major: [0, 0] }]))[0]).toContain("must not be at the center");
    expect(errorsOf(doc([{ ...E, startAngle: 10 }]))[0]).toContain("needs both startAngle and endAngle");
    expect(errorsOf(doc([{ ...E, startAngle: 10, endAngle: 370 }]))[0]).toContain("the same place");
    expect(errorsOf(doc([{ ...E, ref: { datum: "X" } }]))[0]).toContain("an ellipse can't reference the model");
    expect(errorsOf(doc([E], [{ type: "radius", entity: "el1", value: 4 }]))[0]).toContain('"points": ["el1.center", "el1.major"]');
    expect(errorsOf(doc([E], [{ type: "coincident", points: ["el1.start", "origin"] }]))[0]).toContain("is a whole ellipse");
  });

  it("says what is wrong with a bad spline", () => {
    expect(errorsOf(doc([{ ...S, points: [[0, 0]] }]))[0]).toContain("at least 2 points");
    expect(errorsOf(doc([{ ...S, points: [[0, 0], [5, 5]], closed: true }]))[0]).toContain("at least 3 points");
    expect(errorsOf(doc([{ ...S, points: [[0, 0], [0, 0], [5, 5]] }]))[0]).toContain("points 0 and 1 are in the same place");
    expect(errorsOf(doc([{ ...S, points: [[0, 0], [5, 5], [0, 5]], closed: true, startTangent: 0 }]))[0]).toContain("a closed spline has no ends");
    expect(errorsOf(doc([{ ...S, points: [[0, 0], [5, "x"]] }]))[0]).toContain("points.1: must be an array of 2 numbers");
    expect(errorsOf(doc([S], [{ type: "coincident", points: ["sp1.p4", "origin"] }]))[0]).toContain("has points p0, p1, p2, p3");
    const closed = { ...S, closed: true };
    expect(errorsOf(doc([closed, { id: "l1", type: "line", start: [0, 0], end: [-9, 0] }], [{ type: "tangent", entities: ["sp1", "l1"] }]))[0]).toContain("closed spline: it has no ends");
    expect(errorsOf(doc([E, { id: "c1", type: "circle", center: [0, 0], radius: 5 }], [{ type: "tangent", entities: ["el1", "c1"] }]))[0]).toContain("tangent to a line");
    expect(errorsOf(doc([E, { id: "c1", type: "circle", center: [0, 0], radius: 5 }], [{ type: "equal", entities: ["el1", "c1"] }]))[0]).toContain("cannot make an ellipse equal to a circle or arc");
  });
});

describe("ellipse geometry", () => {
  it("names its points: centre, major end, minor end, an arc's ends", () => {
    expect(pointNames(E)).toEqual(["center", "major", "minorEnd"]);
    close(entityPoint(E, "minorEnd")!, [0, 20]);
    const tilted: EllipseEntity = { id: "e", type: "ellipse", center: [1, 1], major: [1, 11], minor: 4, startAngle: 90, endAngle: 270 };
    // Major along +y, so the minor axis (its left) is −x.
    close(entityPoint(tilted, "minorEnd")!, [-3, 1]);
    close(entityPoint(tilted, "start")!, [-3, 1]);
    close(entityPoint(tilted, "end")!, [5, 1]);
  });

  it("has the exact area πab, whole or as a sector closed by two radii", () => {
    const p = buildProfile([E]);
    expect(p.ok && p.area).toBeCloseTo(Math.PI * 30 * 20, 9);
    // Upper half (0° to 180°) and the major axis: πab/2.
    const half = buildProfile([{ ...E, startAngle: 0, endAngle: 180 }, { id: "l1", type: "line", start: [-30, 0], end: [30, 0] }]);
    expect(half.ok && half.area).toBeCloseTo((Math.PI * 30 * 20) / 2, 9);
    // A quarter from 0° to 90° with both radii: πab/4, wherever it sits and however it tilts.
    const q: EllipseEntity = { id: "q", type: "ellipse", center: [5, -7], major: [5 + 30 * Math.cos(0.4), -7 + 30 * Math.sin(0.4)], minor: 20, startAngle: 0, endAngle: 90 };
    const g = ellipseGeom(q);
    const quarter = buildProfile([q, { id: "a", type: "line", start: q.center, end: ellipsePoint(g, 0) }, { id: "b", type: "line", start: ellipsePoint(g, Math.PI / 2), end: q.center }]);
    expect(quarter.ok && quarter.area).toBeCloseTo((Math.PI * 30 * 20) / 4, 9);
  });

  it("measures its length round (Ramanujan's approximation agrees to 1e-6 for these radii)", () => {
    const [a, b] = [30, 20];
    const h = ((a - b) / (a + b)) ** 2;
    const ramanujan = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    expect(ellipseLength(E)).toBeCloseTo(ramanujan, 4);
  });

  it("meets a line exactly where the quadratic says", () => {
    const p = buildProfile([E]);
    if (!p.ok) throw new Error(p.error);
    const seg = p.regions[0].outer.segs[0];
    // x = 15: y = ±20·√(1 − 1/4).
    const hits = intersect({ kind: "line", entity: "l", a: [15, -50], b: [15, 50] }, seg) as Vec2[];
    expect(hits).toHaveLength(2);
    const ys = hits.map((h) => h[1]).sort((x, y) => x - y);
    expect(ys[0]).toBeCloseTo(-20 * Math.sqrt(0.75), 9);
    expect(ys[1]).toBeCloseTo(20 * Math.sqrt(0.75), 9);
    // Touching at the major end: one point.
    expect(intersect({ kind: "line", entity: "l", a: [30, -5], b: [30, 5] }, seg)).toHaveLength(1);
  });

  it("refuses a profile where a line crosses it", () => {
    const p = buildProfile([E, { id: "l1", type: "line", start: [0, -40], end: [0, 40] }]);
    expect(p.ok).toBe(false);
  });
});

describe("spline geometry", () => {
  it("passes through every point, in order, at its chord-length parameters", () => {
    const c = splineOf(S);
    c.points.forEach((p, i) => close(splinePoint(c, c.knots[i]), p, 1e-12));
    expect(c.knots[1]).toBeCloseTo(Math.hypot(10, 8), 12);
  });

  it("is curvature continuous at its inner points and natural (unbent) at its ends", () => {
    const c = splineOf(S);
    // Second derivative of a piece at u (d²/dt²): 6(1−u)(p2−2p1+p0) + 6u(p3−2p2+p1), over h².
    const second = (i: number, u: number) => {
      const [p0, p1, p2, p3] = c.spans[i];
      const h = c.knots[i + 1] - c.knots[i];
      return [0, 1].map((k) => (6 * (1 - u) * (p2[k] - 2 * p1[k] + p0[k]) + 6 * u * (p3[k] - 2 * p2[k] + p1[k])) / (h * h));
    };
    for (let i = 0; i + 1 < c.spans.length; i++) {
      const [a, b] = [second(i, 1), second(i + 1, 0)];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-9);
    }
    expect(Math.hypot(...second(0, 0))).toBeLessThan(1e-12);
    expect(Math.hypot(...second(c.spans.length - 1, 1))).toBeLessThan(1e-12);
  });

  it("leaves along a given end tangent", () => {
    const t = splineEndTangent({ ...S, startTangent: 90, endTangent: 0 }, false);
    close(t, [0, 1], 1e-12);
    close(splineEndTangent({ ...S, startTangent: 90, endTangent: 0 }, true), [1, 0], 1e-12);
  });

  it("closes smoothly and has the exact enclosed area (against a very fine polygon)", () => {
    const pts: Vec2[] = [[0, 0], [30, -5], [40, 20], [10, 30], [-8, 12]];
    const c = interpolate(pts, true);
    expect(c.spans).toHaveLength(5);
    close(c.spans[4][3], pts[0], 1e-12);
    // C1 at the seam: the last derivative equals the first.
    close(c.derivs[5], c.derivs[0], 1e-9);
    const fine: Vec2[] = [];
    for (const b of c.spans) for (let k = 0; k < 4000; k++) fine.push(bezierPoint(b, k / 4000));
    const shoelace = fine.reduce((s, p, i) => s + (p[0] * fine[(i + 1) % fine.length][1] - fine[(i + 1) % fine.length][0] * p[1]) / 2, 0);
    expect(splineArea(c)).toBeCloseTo(shoelace, 3);
    const p = buildProfile([{ id: "sp", type: "spline", points: pts, closed: true }]);
    expect(p.ok && p.area).toBeCloseTo(Math.abs(splineArea(c)), 9);
  });

  it("reverses into the same curve run backwards", () => {
    const c = interpolate(S.points, false);
    const r = reverseSpline(c);
    const total = c.knots[c.knots.length - 1];
    for (const t of [0, 3, 11.5, 30]) close(splinePoint(r, total - t), splinePoint(c, t), 1e-9);
    expect(splineLength(r)).toBeCloseTo(splineLength(c), 9);
  });

  it("makes a profile with lines, and refuses one that crosses itself", () => {
    const p = buildProfile([S, ...BOX]);
    expect(p.ok).toBe(true);
    const loop: SketchEntity = { id: "sp", type: "spline", points: [[0, 0], [20, 20], [20, 0], [0, 20]], closed: true };
    const bad = buildProfile([loop]);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain("crosses itself");
  });

  it("draws through its points", () => {
    const [poly] = entityPolylines(S);
    for (const p of S.points) expect(poly.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-12)).toBe(true);
  });

  it("puts a named point somewhere new", () => {
    const moved = withPointAt(S, "p2", [1, 2]) as SplineEntity;
    expect(moved.points[2]).toEqual([1, 2]);
    expect(withPointAt(S, "p9", [1, 2])).toBe(S);
  });

  it("segment area sums to the loop area", () => {
    const p = buildProfile([S, ...BOX]);
    if (!p.ok) throw new Error(p.error);
    const loop = p.regions[0].outer;
    expect(loop.segs.reduce((t, s) => t + segArea(s), 0)).toBeCloseTo(loop.area, 12);
  });
});

describe("solver", () => {
  it("has unknowns: an ellipse 5 (7 as an arc), a spline 2 per point (and its end tangents)", () => {
    expect(fieldsOf(E).reduce((t, [, n]) => t + n, 0)).toBe(5);
    expect(fieldsOf({ ...E, startAngle: 0, endAngle: 90 }).reduce((t, [, n]) => t + n, 0)).toBe(7);
    expect(fieldsOf(S).reduce((t, [, n]) => t + n, 0)).toBe(8);
    expect(fieldsOf({ ...S, startTangent: 0 }).reduce((t, [, n]) => t + n, 0)).toBe(9);
    expect(sketchDof([E], [])).toBe(5);
    expect(sketchDof([S], [])).toBe(8);
  });

  it("dimensions an ellipse fully: centre, radii, a level major axis", () => {
    const tilted: EllipseEntity = { ...E, center: [3, 2], major: [25, 12], minor: 9 };
    const ks: Constraint[] = [
      { type: "coincident", points: ["el1.center", "origin"] },
      { type: "horizontal", entity: "el1" },
      { type: "distance", points: ["el1.center", "el1.major"], value: 40 },
      { type: "distance", points: ["el1.center", "el1.minorEnd"], value: 15 },
    ];
    const out = byId<EllipseEntity>(solved([tilted], ks), "el1");
    close(out.center, [0, 0]);
    expect(Math.abs(out.major[1])).toBeLessThan(1e-7);
    expect(Math.abs(out.major[0])).toBeCloseTo(40, 6);
    expect(out.minor).toBeCloseTo(15, 6);
    expect(sketchDof([out], ks)).toBe(0);
    expect(sketchStatus([out], ks).free.size).toBe(0);
  });

  it("puts a point on an ellipse and a line tangent to it", () => {
    const line: SketchEntity = { id: "l1", type: "line", start: [-50, 25], end: [50, 26] };
    const p: SketchEntity = { id: "p1", type: "point", at: [10, 10] };
    const ks: Constraint[] = [
      { type: "fix", entity: "el1" },
      { type: "tangent", entities: ["el1", "l1"] },
      { type: "pointOn", point: "p1.at", entity: "el1" },
    ];
    const out = solved([E, line, p], ks);
    const g = ellipseGeom(byId<EllipseEntity>(out, "el1"));
    const at = byId<Extract<SketchEntity, { type: "point" }>>(out, "p1").at;
    expect((at[0] / g.a) ** 2 + (at[1] / g.b) ** 2).toBeCloseTo(1, 7);
  });

  it("joins an elliptical arc's end to a line, tangent there", () => {
    const arc: EllipseEntity = { ...E, startAngle: 0, endAngle: 90 };
    const line: SketchEntity = { id: "l1", type: "line", start: [1, 21], end: [-40, 24] };
    const ks: Constraint[] = [
      { type: "fix", entity: "el1" },
      { type: "coincident", points: ["el1.end", "l1.start"] },
      { type: "tangent", entities: ["el1", "l1"] },
    ];
    const out = solved([arc, line], ks);
    const l = byId<Extract<SketchEntity, { type: "line" }>>(out, "l1");
    close(l.start, [0, 20], 1e-6);
    // Tangent at the minor end: level.
    expect(Math.abs(l.end[1] - l.start[1])).toBeLessThan(1e-6);
  });

  it("drags a spline's point and keeps the rest", () => {
    const r = solveSketch([S], [{ type: "fix", point: "sp1.p0" }], { drag: [{ handle: "sp1.p2", to: [25, 15] }] });
    if (!r.ok) throw new Error(r.error);
    const out = r.entities[0] as SplineEntity;
    close(out.points[2], [25, 15]);
    close(out.points[0], [0, 0]);
    close(out.points[1], S.points[1]);
  });

  it("drags an ellipse's major end about its centre, keeping the minor radius", () => {
    const r = solveSketch([E], [], { drag: [{ handle: "el1.major", to: [0, 40] }] });
    if (!r.ok) throw new Error(r.error);
    const out = r.entities[0] as EllipseEntity;
    close(out.center, [0, 0]);
    close(out.major, [0, 40]);
    expect(out.minor).toBeCloseTo(20, 9);
  });

  it("makes a spline leave tangent to a line at the end that meets it", () => {
    const line: SketchEntity = { id: "l1", type: "line", start: [-30, 0], end: [0, 0] };
    const sp: SplineEntity = { ...S, startTangent: 45 };
    const ks: Constraint[] = [
      { type: "fix", entity: "l1" },
      { type: "coincident", points: ["l1.end", "sp1.p0"] },
      { type: "fix", point: "sp1.p1" },
      { type: "fix", point: "sp1.p2" },
      { type: "fix", point: "sp1.p3" },
      { type: "tangent", entities: ["sp1", "l1"] },
    ];
    const out = byId<SplineEntity>(solved([line, sp], ks), "sp1");
    // Only the tangent angle could move: it is now along the line.
    expect(Math.abs(Math.sin((out.startTangent! * Math.PI) / 180))).toBeLessThan(1e-7);
    close(splineEndTangent(out, false), [Math.sign(Math.cos((out.startTangent! * Math.PI) / 180)), 0], 1e-7);
  });

  it("puts a point on a spline", () => {
    const p: SketchEntity = { id: "p1", type: "point", at: [20, 20] };
    const out = solved([S, p], [{ type: "fix", entity: "sp1" }, { type: "pointOn", point: "p1.at", entity: "sp1" }]);
    const at = byId<Extract<SketchEntity, { type: "point" }>>(out, "p1").at;
    expect(closestOnSpline(splineOf(S), at).distance).toBeLessThan(1e-8);
    // It moved the least way: onto the curve below it.
    expect(at[0]).toBeGreaterThan(10);
    expect(at[0]).toBeLessThan(30);
  });

  it("holds equal ellipses to both radii", () => {
    const other: EllipseEntity = { id: "el2", type: "ellipse", center: [100, 0], major: [100, 12], minor: 5 };
    const out = solved([E, other], [{ type: "fix", entity: "el1" }, { type: "equal", entities: ["el1", "el2"] }]);
    const g = ellipseGeom(byId<EllipseEntity>(out, "el2"));
    expect(g.a).toBeCloseTo(30, 6);
    expect(g.b).toBeCloseTo(20, 6);
  });
});

describe("document write-back", () => {
  it("writes solved spline points back into the nested array", () => {
    const d = doc([S], [{ type: "distanceX", points: ["sp1.p0", "sp1.p3"], value: 50 }]);
    const r = resolveSketch(d.features[0] as Record<string, unknown>, {});
    if (!r.ok) throw new Error(r.error);
    const pts = (r.feature.entities as SplineEntity[])[0].points;
    expect(pts).toHaveLength(4);
    expect(Math.abs(pts[3][0] - pts[0][0])).toBeCloseTo(50, 6);
    expect(pts.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number"))).toBe(true);
  });

  it("adds a spline and dimensions it through commands", () => {
    const done = (r: ReturnType<typeof apply>) => {
      if (!r.ok) throw new Error(r.error);
      return r.doc;
    };
    let d = doc([]);
    d = done(apply(d, { type: "addEntity", sketch: "s1", entity: { ...S } }));
    d = done(apply(d, { type: "addConstraint", sketch: "s1", constraint: { type: "coincident", points: ["sp1.p3", "origin"] } }));
    const sp = (d.features[0] as { entities: SplineEntity[] }).entities[0];
    close(sp.points[3], [0, 0], 1e-6);
    expect(errorsOf(d)).toEqual([]);
  });
});
