// Trim, extend, split and explode (src/geom/sketchEdit): exact coordinates,
// and the relations on what is left.

import { describe, expect, it } from "vitest";
import type { Constraint, SketchEntity } from "../src/doc/types";
import { buildProfile } from "../src/geom/profile";
import { checkConstraints } from "../src/geom/constraints";
import { sketchDof, solveSketch } from "../src/geom/solver";
import { explode } from "../src/geom/sketchEdit/explode";
import { crossings, cutsOf, extendAt, extended, powerTrim, splitAt, trimAt, trimPreview } from "../src/geom/sketchEdit/trim";
import type { Edit } from "../src/geom/sketchEdit/relations";

const line = (id: string, start: [number, number], end: [number, number], extra: Partial<SketchEntity> = {}): SketchEntity => ({ id, type: "line", start, end, ...extra }) as SketchEntity;
const ok = (r: Edit | string): Edit => {
  if (typeof r === "string") throw new Error(r);
  return r;
};
const byId = (r: { entities: SketchEntity[] }, id: string) => r.entities.find((e) => e.id === id)!;
const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));

/** A line l1 along x from 0 to 30, crossed by l2 at x = 10 and l3 at x = 20. */
const crossed = () => ({
  entities: [line("l1", [0, 0], [30, 0]), line("l2", [10, -5], [10, 5]), line("l3", [20, -5], [20, 5])],
  constraints: [{ type: "horizontal", entity: "l1" }, { type: "fix", point: "l1.start" }, { type: "coincident", points: ["l1.end", "origin"] }] as Constraint[],
});

describe("trim to closest", () => {
  it("cuts a line crossed by two others out of the middle: two collinear pieces are left, each end on what it met", () => {
    const r = ok(trimAt(crossed(), "l1", [15, 0]));
    const a = byId(r, "l1") as Extract<SketchEntity, { type: "line" }>;
    close([...a.start, ...a.end], [0, 0, 10, 0]);
    const b = r.entities.find((e) => e.id === "l4") as Extract<SketchEntity, { type: "line" }>;
    close([...b.start, ...b.end], [20, 0, 30, 0]);
    expect(r.constraints).toContainEqual({ type: "horizontal", entity: "l1" });
    expect(r.constraints).toContainEqual({ type: "fix", point: "l1.start" });
    // The old end's relation went with the end to the second piece (and holds no more: the end didn't move, the origin did not either).
    expect(r.constraints).toContainEqual({ type: "collinear", entities: ["l1", "l4"] });
    expect(r.soft).toEqual([
      { type: "pointOn", point: "l1.end", entity: "l2" },
      { type: "pointOn", point: "l4.start", entity: "l3" },
    ]);
    expect(r.made).toEqual(["l1", "l4"]);
  });

  it("carries the old end's relations to the second piece", () => {
    const s = crossed();
    s.entities[0] = line("l1", [0, 0], [30, 0]);
    s.constraints = [{ type: "distance", points: ["l1.end", "origin"], value: 30 }];
    const r = ok(trimAt(s, "l1", [15, 0]));
    expect(r.constraints).toContainEqual({ type: "distance", points: ["l4.end", "origin"], value: 30 });
    // The first piece's length changed: a length dimension on it would go.
    const t = ok(trimAt({ ...s, constraints: [{ type: "distance", entity: "l1", value: 30 }] }, "l1", [15, 0]));
    expect(t.constraints.some((k) => k.type === "distance")).toBe(false);
  });

  it("cuts an end piece back to the first crossing, and drops what held the end that went", () => {
    const s = { ...crossed(), constraints: [{ type: "coincident", points: ["l1.start", "origin"] }] as Constraint[] };
    const r = ok(trimAt(s, "l1", [3, 0]));
    const a = byId(r, "l1") as Extract<SketchEntity, { type: "line" }>;
    close([...a.start, ...a.end], [10, 0, 30, 0]);
    expect(r.constraints).toEqual([]);
    expect(r.soft).toEqual([{ type: "pointOn", point: "l1.start", entity: "l2" }]);
  });

  it("deletes an entity nothing crosses, with its relations", () => {
    const r = ok(trimAt({ entities: [line("l1", [0, 0], [10, 0]), line("l2", [0, 5], [10, 5])], constraints: [{ type: "parallel", entities: ["l1", "l2"] }] }, "l1", [5, 0]));
    expect(r.entities.map((e) => e.id)).toEqual(["l2"]);
    expect(r.constraints).toEqual([]);
    expect(r.note).toContain("crossed nothing");
  });

  it("turns a circle crossed twice into the arc that is left, keeping its relations", () => {
    const s = {
      entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 10 } as SketchEntity, line("l1", [-20, 0], [20, 0])],
      constraints: [{ type: "diameter", entity: "c1", value: 20 }, { type: "coincident", points: ["c1.center", "origin"] }] as Constraint[],
    };
    // Click the top half: the bottom half is left, anticlockwise from (-10, 0) to (10, 0).
    const r = ok(trimAt(s, "c1", [0, 10]));
    const a = byId(r, "c1") as Extract<SketchEntity, { type: "arc" }>;
    expect(a.type).toBe("arc");
    close([...a.center, ...a.start, ...a.end], [0, 0, -10, 0, 10, 0]);
    expect(a.clockwise).toBeUndefined();
    expect(r.constraints).toEqual(s.constraints);
    expect(r.soft).toEqual([
      { type: "pointOn", point: "c1.start", entity: "l1" },
      { type: "pointOn", point: "c1.end", entity: "l1" },
    ]);
    // A closed profile again: the half disc's area is half of π·10².
    const rest = trimAt(r, "l1", [-15, 0]) as Edit;
    const done = ok(trimAt(rest, "l1", [15, 0]));
    const p = buildProfile(done.entities);
    expect(p.ok && p.area).toBeCloseTo(Math.PI * 50, 6);
  });

  it("joins a trimmed end to the end it landed on, by a coincident relation", () => {
    // l2 ends on l1 at x = 10 (a T): trimming l1 left of it joins l1's new start to l2's end.
    const s = { entities: [line("l1", [0, 0], [30, 0]), line("l2", [10, 10], [10, 0])], constraints: [] };
    const r = ok(trimAt(s, "l1", [4, 0]));
    expect(r.soft).toEqual([{ type: "coincident", points: ["l1.start", "l2.end"] }]);
  });

  it("explodes a rectangle entity first, then trims the side clicked", () => {
    const s = {
      entities: [{ id: "r1", type: "rect", center: [0, 0], w: 20, h: 10 } as SketchEntity, line("l9", [0, -20], [0, 20])],
      constraints: [{ type: "distanceX", entity: "r1", value: 20 }] as Constraint[],
    };
    const r = ok(trimAt(s, "r1", [5, -5]));
    expect(r.entities.some((e) => e.type === "rect")).toBe(false);
    const bottom = byId(r, "l1") as Extract<SketchEntity, { type: "line" }>;
    close([...bottom.start, ...bottom.end], [-10, -5, 0, -5]);
    // The width dimension went with the bottom side, whose length changed: it goes. The sides keep level and plumb.
    expect(r.constraints).toContainEqual({ type: "horizontal", entity: "l1" });
    expect(r.constraints.some((k) => k.type === "distance" && k.entity === "l1")).toBe(false);
  });
});

describe("power trim", () => {
  it("trims every piece a drag crosses, in order", () => {
    // A plus sign: l1 along x, l2 along y. A stroke down through l1's right arm, then l2's top arm.
    const s = { entities: [line("l1", [-10, 0], [10, 0]), line("l2", [0, -10], [0, 10])], constraints: [] };
    expect(crossings(s.entities, [5, 5], [5, -5]).map((x) => x.id)).toEqual(["l1"]);
    const r = powerTrim(s, [[5, 5], [5, -5], [8, -5], [8, 8], [-5, 8], [-5, 5]]);
    expect(r.trimmed).toEqual(["l1", "l2"]);
    const a = byId(r, "l1") as Extract<SketchEntity, { type: "line" }>;
    const b = byId(r, "l2") as Extract<SketchEntity, { type: "line" }>;
    close([...a.start, ...a.end], [-10, 0, 0, 0]);
    close([...b.start, ...b.end], [0, -10, 0, 0]);
  });
});

describe("extend", () => {
  it("grows a line's nearer end to the next entity it meets", () => {
    const s = { entities: [line("l1", [0, 0], [10, 0]), line("l2", [15, -5], [15, 5]), line("l3", [25, -5], [25, 5])], constraints: [{ type: "horizontal", entity: "l1" }, { type: "distance", entity: "l1", value: 10 }] as Constraint[] };
    const r = ok(extendAt(s, "l1", [9, 0.2]));
    const a = byId(r, "l1") as Extract<SketchEntity, { type: "line" }>;
    close([...a.start, ...a.end], [0, 0, 15, 0]);
    expect(r.constraints).toEqual([{ type: "horizontal", entity: "l1" }]);
    expect(r.soft).toEqual([{ type: "pointOn", point: "l1.end", entity: "l2" }]);
    expect(extended(s, "l1", [1, 0])).toBeNull(); // the start meets nothing
    expect(extendAt(s, "l1", [1, 0])).toBe("l1's start meets nothing if it is extended");
  });

  it("grows an arc round its circle to the line it meets", () => {
    // A quarter arc from (10, 0) to (0, 10) about the origin; the line x = -6 meets its circle at y = 8.
    const s = { entities: [{ id: "a1", type: "arc", center: [0, 0], start: [10, 0], end: [0, 10] } as SketchEntity, line("l1", [-6, -20], [-6, 20])], constraints: [] };
    const r = ok(extendAt(s, "a1", [1, 10]));
    const a = byId(r, "a1") as Extract<SketchEntity, { type: "arc" }>;
    close([...a.end], [-6, 8]);
  });
});

describe("split", () => {
  it("splits a line in two, joined and collinear", () => {
    const s = { entities: [line("l1", [-10, 0], [0, 0])], constraints: [{ type: "coincident", points: ["l1.end", "origin"] }] as Constraint[] };
    const r = ok(splitAt(s, "l1", [-6, 0.1]));
    close([...(byId(r, "l1") as Extract<SketchEntity, { type: "line" }>).end], [-6, 0]);
    close([...(byId(r, "l2") as Extract<SketchEntity, { type: "line" }>).start], [-6, 0]);
    expect(r.constraints).toEqual(
      expect.arrayContaining([
        { type: "coincident", points: ["l2.end", "origin"] },
        { type: "collinear", entities: ["l1", "l2"] },
        { type: "coincident", points: ["l1.end", "l2.start"] },
      ]),
    );
    // A split adds as many freedoms as its new end has (the point can slide along the line): 1.
    expect(sketchDof(r.entities, r.constraints) - sketchDof(s.entities, s.constraints)).toBe(1);
    expect(splitAt(s, "l1", [-10, 0])).toContain("away from its ends");
  });

  it("splits a circle into two half circles joined at both ends", () => {
    const s = { entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 5 } as SketchEntity], constraints: [] };
    const r = ok(splitAt(s, "c1", [0, 5]));
    const [a, b] = [byId(r, "c1"), byId(r, "a1")] as Extract<SketchEntity, { type: "arc" }>[];
    close([...a.start, ...a.end, ...b.start, ...b.end], [0, 5, 0, -5, 0, -5, 0, 5]);
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    const p = buildProfile(r.entities);
    expect(p.ok && p.area).toBeCloseTo(Math.PI * 25, 6);
  });
});

describe("explode", () => {
  it("turns a rectangle entity into four lines and moves its dimensions and centre onto them", () => {
    const s = {
      entities: [{ id: "r1", type: "rect", center: [0, 0], w: 30, h: 20 } as SketchEntity],
      constraints: [{ type: "distanceX", entity: "r1", value: 30 }, { type: "distanceY", entity: "r1", value: 20 }, { type: "coincident", points: ["r1.center", "origin"] }] as Constraint[],
    };
    const r = ok(explode(s, "r1"));
    expect(r.entities.filter((e) => e.type === "line" && !e.construction)).toHaveLength(4);
    expect(r.constraints).toEqual(
      expect.arrayContaining([
        { type: "distance", entity: "l1", value: 30 },
        { type: "distance", entity: "l4", value: 20 },
        { type: "coincident", points: ["p1.at", "origin"] },
        { type: "midpoint", point: "p1.at", entity: "l5" },
      ]),
    );
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    // As defined as before: the rectangle's 5 numbers less its 3 relations' worth.
    expect(sketchDof(r.entities, r.constraints)).toBe(sketchDof(s.entities, s.constraints));
  });

  it("turns a slot entity into two lines, two arcs and a centreline, its centres onto the arcs'", () => {
    const s = {
      entities: [{ id: "s1", type: "slot", center1: [0, 0], center2: [20, 0], width: 10 } as SketchEntity],
      constraints: [{ type: "distance", entity: "s1", value: 20 }, { type: "coincident", points: ["s1.center1", "origin"] }] as Constraint[],
    };
    const r = ok(explode(s, "s1"));
    expect(r.entities.map((e) => e.type)).toEqual(["line", "arc", "line", "arc", "line"]);
    expect(r.constraints).toEqual(expect.arrayContaining([{ type: "distance", entity: "l3", value: 20 }, { type: "coincident", points: ["a2.center", "origin"] }]));
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    expect(sketchDof(r.entities, r.constraints)).toBe(sketchDof(s.entities, s.constraints));
    const p = buildProfile(r.entities);
    expect(p.ok && p.area).toBeCloseTo(200 + Math.PI * 25, 6);
    expect(solveSketch(r.entities, r.constraints).ok).toBe(true);
  });
});

describe("helpers", () => {
  it("finds where others cross an entity, in order, with the points they have there", () => {
    const s = crossed();
    expect(cutsOf(s.entities, "l1").map((c) => [c.t, c.by])).toEqual([
      [1 / 3, [{ id: "l2", ref: null }]],
      [2 / 3, [{ id: "l3", ref: null }]],
    ]);
    const pre = trimPreview(s, "l1", [25, 0]) as Extract<SketchEntity, { type: "line" }>;
    close([...pre.start, ...pre.end], [20, 0, 30, 0]);
  });
});
