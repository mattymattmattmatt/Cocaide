// SOLIDWORKS's sketch relations: each one moves the geometry to meet it,
// the rebuild's check agrees, validation knows its shape, and the sketch
// reports which entities are still free (blue) and which are defined (black).

import { describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import type { Constraint, SketchEntity } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { checkConstraints, measureConstraint } from "../src/geom/constraints";
import { sketchStatus, solveSketch, wouldOverDefine } from "../src/geom/solver";

type Line = Extract<SketchEntity, { type: "line" }>;
type Circle = Extract<SketchEntity, { type: "circle" }>;
type Arc = Extract<SketchEntity, { type: "arc" }>;

const solved = (entities: SketchEntity[], constraints: Constraint[]) => {
  const r = solveSketch(entities, constraints);
  if (!r.ok) throw new Error(r.error);
  expect(checkConstraints(r.entities, constraints)).toEqual([]);
  return r.entities;
};
const line = (id: string, start: [number, number], end: [number, number]): Line => ({ id, type: "line", start, end });
const dir = (l: Line) => {
  const d = [l.end[0] - l.start[0], l.end[1] - l.start[1]];
  const n = Math.hypot(d[0], d[1]);
  return [d[0] / n, d[1] / n];
};
const cross = (a: number[], b: number[]) => a[0] * b[1] - a[1] * b[0];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1];

describe("relations between lines", () => {
  const a = line("l1", [0, 0], [40, 2]);
  const b = line("l2", [5, 20], [45, 27]);

  it("parallel turns them to one direction; perpendicular squares them", () => {
    const [p, q] = solved([a, b], [{ type: "parallel", entities: ["l1", "l2"] }]) as Line[];
    expect(cross(dir(p), dir(q))).toBeCloseTo(0, 9);
    const [r, s] = solved([a, b], [{ type: "perpendicular", entities: ["l1", "l2"] }]) as Line[];
    expect(dot(dir(r), dir(s))).toBeCloseTo(0, 9);
  });

  it("collinear puts both on one line", () => {
    const [p, q] = solved([a, b], [{ type: "collinear", entities: ["l1", "l2"] }]) as Line[];
    const u = dir(p);
    for (const pt of [q.start, q.end]) expect(cross(u, [pt[0] - p.start[0], pt[1] - p.start[1]])).toBeCloseTo(0, 9);
  });

  it("an angle dimension holds the angle between their directions, either side", () => {
    const [p, q] = solved([a, b], [{ type: "angle", entities: ["l1", "l2"], value: 30 }]) as Line[];
    expect((Math.acos(dot(dir(p), dir(q))) * 180) / Math.PI).toBeCloseTo(30, 6);
    expect(measureConstraint([p, q], { type: "angle", entities: ["l1", "l2"], value: 30 }).actual).toBeCloseTo(30, 6);
  });

  it("a point's distance from a line is measured square to it, the line extended", () => {
    const [p, q] = solved([a, b], [
      { type: "parallel", entities: ["l1", "l2"] },
      { type: "distance", point: "l2.start", line: "l1", value: 12.5 },
    ]) as Line[];
    const u = dir(p);
    expect(Math.abs(cross(u, [q.start[0] - p.start[0], q.start[1] - p.start[1]]))).toBeCloseTo(12.5, 9);
    expect(Math.abs(cross(u, [q.end[0] - p.start[0], q.end[1] - p.start[1]]))).toBeCloseTo(12.5, 9);
  });

  it("horizontal and vertical also take two points", () => {
    const [p, q] = solved([a, b], [
      { type: "horizontal", points: ["l1.end", "l2.start"] },
      { type: "vertical", points: ["l1.start", "l2.end"] },
    ]) as Line[];
    expect(p.end[1]).toBeCloseTo(q.start[1], 9);
    expect(p.start[0]).toBeCloseTo(q.end[0], 9);
  });
});

describe("relations with points", () => {
  const a = line("l1", [0, 0], [40, 0]);
  const b = line("l2", [12, 9], [30, 25]);

  it("midpoint puts a point at the middle of a line", () => {
    const [p, q] = solved([a, b], [{ type: "midpoint", point: "l2.start", entity: "l1" }]) as Line[];
    expect(q.start[0]).toBeCloseTo((p.start[0] + p.end[0]) / 2, 9);
    expect(q.start[1]).toBeCloseTo((p.start[1] + p.end[1]) / 2, 9);
  });

  it("a point on a line (extended), on a circle, on an arc", () => {
    const [p, q] = solved([a, b], [{ type: "pointOn", point: "l2.end", entity: "l1" }]) as Line[];
    expect(cross(dir(p), [q.end[0] - p.start[0], q.end[1] - p.start[1]])).toBeCloseTo(0, 9);
    const c: Circle = { id: "c1", type: "circle", center: [0, 0], radius: 10 };
    const [, , circle] = solved([a, b, c], [{ type: "pointOn", point: "l2.end", entity: "c1" }]);
    const end = (solved([a, b, c], [{ type: "pointOn", point: "l2.end", entity: "c1" }])[1] as Line).end;
    expect(Math.hypot(end[0] - (circle as Circle).center[0], end[1] - (circle as Circle).center[1])).toBeCloseTo((circle as Circle).radius, 9);
  });

  it("symmetric mirrors two points about a line", () => {
    const axis = line("l3", [0, -10], [0, 10]);
    const [, q, ax] = solved([a, b, axis], [{ type: "symmetric", points: ["l2.start", "l2.end"], line: "l3" }]) as Line[];
    const u = dir(ax);
    const mid = [(q.start[0] + q.end[0]) / 2, (q.start[1] + q.end[1]) / 2];
    expect(cross(u, [mid[0] - ax.start[0], mid[1] - ax.start[1]])).toBeCloseTo(0, 9);
    expect(dot(u, [q.end[0] - q.start[0], q.end[1] - q.start[1]])).toBeCloseTo(0, 9);
  });

  it("fix holds an entity where it is: a dimension must move the rest", () => {
    const ks: Constraint[] = [
      { type: "fix", entity: "l1" },
      { type: "coincident", points: ["l1.end", "l2.start"] },
    ];
    const [p, q] = solved([a, b], ks) as Line[];
    [...p.start, ...p.end].forEach((v, i) => expect(v).toBeCloseTo([0, 0, 40, 0][i], 12));
    expect(q.start[0]).toBeCloseTo(40, 9);
    // Lengthening the fixed line can't be done.
    expect(solveSketch([p, q], [...ks, { type: "distance", entity: "l1", value: 50 }]).ok).toBe(false);
  });
});

describe("relations with circles and arcs", () => {
  const c1: Circle = { id: "c1", type: "circle", center: [0, 0], radius: 10 };
  const c2: Circle = { id: "c2", type: "circle", center: [25, 3], radius: 6 };

  it("tangent: a line to a circle, two circles outside or inside", () => {
    const l = line("l1", [-20, 14], [30, 12]);
    const [c, , ln] = solved([c1, c2, l], [{ type: "tangent", entities: ["l1", "c1"] }]) as [Circle, Circle, Line];
    expect(Math.abs(cross(dir(ln), [c.center[0] - ln.start[0], c.center[1] - ln.start[1]]))).toBeCloseTo(c.radius, 9);
    const [p, q] = solved([c1, c2], [{ type: "tangent", entities: ["c1", "c2"] }]) as Circle[];
    expect(Math.hypot(q.center[0] - p.center[0], q.center[1] - p.center[1])).toBeCloseTo(p.radius + q.radius, 9);
    const inner: Circle = { id: "c3", type: "circle", center: [3, 1], radius: 4 };
    const [r, s] = solved([c1, inner], [{ type: "tangent", entities: ["c1", "c3"] }]) as Circle[];
    expect(Math.hypot(s.center[0] - r.center[0], s.center[1] - r.center[1])).toBeCloseTo(r.radius - s.radius, 9);
  });

  it("an arc tangent to a line keeps its ends on its circle", () => {
    const arc: Arc = { id: "a1", type: "arc", center: [0, 0], start: [10, 0], end: [0, 10] };
    const l = line("l1", [10.5, -20], [11, 0]);
    const [ar, ln] = solved([arc, l], [
      { type: "tangent", entities: ["a1", "l1"] },
      { type: "coincident", points: ["a1.start", "l1.end"] },
    ]) as [Arc, Line];
    const r = Math.hypot(ar.start[0] - ar.center[0], ar.start[1] - ar.center[1]);
    expect(Math.hypot(ar.end[0] - ar.center[0], ar.end[1] - ar.center[1])).toBeCloseTo(r, 9);
    expect(Math.abs(cross(dir(ln), [ar.center[0] - ln.start[0], ar.center[1] - ln.start[1]]))).toBeCloseTo(r, 7);
  });

  it("concentric shares a centre; diameter sets twice the radius", () => {
    const [p, q] = solved([c1, c2], [
      { type: "concentric", entities: ["c1", "c2"] },
      { type: "diameter", entity: "c2", value: 30 },
    ]) as Circle[];
    expect(p.center[0]).toBeCloseTo(q.center[0], 9);
    expect(p.center[1]).toBeCloseTo(q.center[1], 9);
    expect(q.radius).toBeCloseTo(15, 9);
  });
});

describe("defined state, as SOLIDWORKS colours it", () => {
  it("names what can still move, and nothing once fully defined", () => {
    const l = line("l1", [1, 1], [30, 2]);
    const c: Circle = { id: "c1", type: "circle", center: [50, 5], radius: 5 };
    expect(sketchStatus([l, c], []).free).toEqual(new Set(["l1", "c1"]));
    const ks: Constraint[] = [
      { type: "coincident", points: ["l1.start", "origin"] },
      { type: "horizontal", entity: "l1" },
      { type: "distance", entity: "l1", value: 30 },
    ];
    const ents = solved([l, c], ks);
    const st = sketchStatus(ents, ks);
    expect([...st.free]).toEqual(["c1"]);
    expect(st.freePoints.has("l1.start")).toBe(false);
    expect(st.freePoints.has("c1.center")).toBe(true);
    expect(st.dof).toBe(3);
  });

  it("a point can be defined while its line still swings", () => {
    const l = line("l1", [0, 0], [30, 10]);
    const st = sketchStatus([l], [{ type: "coincident", points: ["l1.start", "origin"] }]);
    expect(st.freePoints.has("l1.start")).toBe(false);
    expect(st.freePoints.has("l1.end")).toBe(true);
    expect(st.free.has("l1")).toBe(true);
  });

  it("refuses a relation the sketch already has", () => {
    const l = line("l1", [0, 0], [30, 0]);
    const m = line("l2", [0, 5], [30, 5]);
    const ks: Constraint[] = [
      { type: "horizontal", entity: "l1" },
      { type: "horizontal", entity: "l2" },
    ];
    expect(wouldOverDefine([l, m], ks, { type: "parallel", entities: ["l1", "l2"] })).toBe(true);
  });
});

describe("validation and commands", () => {
  const doc = (constraints: unknown[]): RawDocument => ({
    version: 1,
    units: "mm",
    name: "relations",
    features: [
      {
        id: "s1",
        op: "sketch",
        plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
        entities: [
          { id: "l1", type: "line", start: [0, 0], end: [40, 0] },
          { id: "l2", type: "line", start: [0, 10], end: [40, 12] },
          { id: "c1", type: "circle", center: [20, 30], radius: 5 },
        ],
        constraints,
      },
    ],
  });
  it("accepts every relation in its documented shape", () => {
    const ok = [
      { type: "parallel", entities: ["l1", "l2"] },
      { type: "tangent", entities: ["l1", "c1"] },
      { type: "midpoint", point: "c1.center", entity: "l1" },
      { type: "fix", entity: "l1" },
      { type: "horizontal", points: ["l1.start", "l2.start"] },
    ];
    // The geometry doesn't meet them yet: validation is about shape, the rebuild about values.
    expect(allErrors(validateDocument(doc(ok)))).toEqual([]);
  });

  it("explains a malformed one", () => {
    const text = (k: unknown) => allErrors(validateDocument(doc([k]))).join("\n");
    expect(text({ type: "parallel", entities: ["l1", "c1"] })).toMatch(/"c1" is a circle; this constraint applies to line/);
    expect(text({ type: "tangent", entities: ["l1", "l2"] })).toMatch(/two lines cannot be tangent/);
    expect(text({ type: "angle", entities: ["l1", "l2"], value: 0 })).toMatch(/over 0 and under 180/);
    expect(text({ type: "midpoint", point: "l1.start", entity: "l1" })).toMatch(/is a point of "l1" itself/);
    expect(text({ type: "fix", entity: "l1", point: "l2.end" })).toMatch(/exactly one of entity or point/);
    expect(text({ type: "glue", entities: ["l1", "l2"] })).toMatch(/supported: coincident, .*symmetric, fix/);
  });

  it("addConstraint moves the sketch to meet a relation", () => {
    const r = apply(doc([]), { type: "addConstraint", sketch: "s1", constraint: { type: "parallel", entities: ["l1", "l2"] } });
    if (!r.ok) throw new Error(r.error);
    const s = r.doc.features[0] as { entities: SketchEntity[]; constraints: Constraint[] };
    expect(checkConstraints(s.entities, s.constraints)).toEqual([]);
    const [p, q] = s.entities as Line[];
    expect(cross(dir(p), dir(q))).toBeCloseTo(0, 6);
  });
});
