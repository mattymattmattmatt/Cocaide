// Wave 4B sketcher pieces that are pure: the status line and its diagnosis
// (sketchHealth, the relations filter), the Modify box's reading of values
// (units, functions, expressions, spin), the draft's expressions and driven
// dimensions, on-screen numeric input, and Smart Dimension's inference from
// the picks and where the dimension is dropped.

import { describe, expect, it } from "vitest";
import type { Constraint, SketchEntity, Vec2 } from "../src/doc/types";
import { filterRelations, sketchHealth } from "../src/ui/sketcher/status";
import { readValue, shownValue, spinValue } from "../src/ui/sketcher/modify";
import { draftCycle, draftParameters, measureDriven, reexpress, withOldNames } from "../src/ui/sketcher/dimdraft";
import { describeConstraint, dropKind, dropMatters, smartDimension } from "../src/ui/sketcher/draft";
import { CIRCLE_TYPED, LINE_TYPED, rectTyped } from "../src/ui/sketcher/tools/typed";
import { placeTyped, toolByName } from "../src/ui/sketcher/tools/run";
import { checkConstraints } from "../src/geom/constraints";
import { solveSketch } from "../src/geom/solver";

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, type: "line", start, end });
const circle = (id: string, center: Vec2, radius: number): SketchEntity => ({ id, type: "circle", center, radius });

describe("sketch status line", () => {
  const es = [line("l1", [0, 0], [10, 0])];
  it("says an empty sketch is empty, not fully defined", () => {
    const h = sketchHealth([], []);
    expect(h.state).toBe("empty");
    expect(h.text).toBe("Empty sketch");
  });

  it("counts degrees of freedom while under defined, and says fully defined at none", () => {
    expect(sketchHealth(es, []).text).toBe("Under defined · 4 DOF");
    const fixed: Constraint[] = [{ type: "coincident", points: ["l1.start", "origin"] }, { type: "horizontal", entity: "l1" }];
    expect(sketchHealth(es, fixed).text).toBe("Under defined · 1 DOF");
    const full = sketchHealth(es, [...fixed, { type: "distance", entity: "l1", value: 10 }]);
    expect(full.state).toBe("full");
    expect(full.text).toBe("Fully defined");
    expect(full.dof).toBe(0);
  });

  it("names what conflicts when over defined, newest first, and offers fixes", () => {
    const ks: Constraint[] = [
      { type: "coincident", points: ["l1.start", "origin"] },
      { type: "horizontal", entity: "l1" },
      { type: "distance", entity: "l1", value: 10 },
      { type: "distanceX", entity: "l1", value: 10 },
    ];
    const h = sketchHealth(es, ks);
    expect(h.state).toBe("over");
    // Its length and its width are one thing on a level line: the newest (d2) conflicts with the other (d1).
    expect(h.conflicting).toEqual([2, 3]);
    expect(h.text).toBe("Over defined: d2 conflicts with d1");
    expect(h.fixes.map((f) => f.label)).toEqual(["Make d2 driven", "Delete d2", "Make d1 driven", "Delete d1"]);
    expect(h.conflicts).toEqual(new Set(["l1"]));
    // Either fix leaves it fully defined.
    const driven = ks.map((k, i) => (i === 3 ? ({ ...k, driven: true } as Constraint) : k));
    expect(sketchHealth(es, driven).text).toBe("Fully defined");
    expect(sketchHealth(es, ks.slice(0, 3)).text).toBe("Fully defined");
  });

  it("names a relation by its kind and what it holds", () => {
    const ks: Constraint[] = [
      { type: "fix", entity: "l1" },
      { type: "horizontal", entity: "l1" },
    ];
    const h = sketchHealth(es, ks);
    expect(h.state).toBe("over");
    expect(h.text).toBe("Over defined: Horizontal l1 conflicts with Fix l1");
    // A relation can only be deleted; a dimension can also be made driven.
    expect(h.fixes.map((f) => f.testId)).toEqual(["fix-delete-1", "fix-delete-0"]);
  });

  it("reports a reference whose model geometry is gone as dangling (brown)", () => {
    const ref: SketchEntity = { id: "r1", type: "line", start: [0, 5], end: [10, 5], ref: { edge: { type: "edge", pick: "all" } } } as SketchEntity;
    const ks: Constraint[] = [{ type: "distance", point: "l1.start", line: "r1", value: 5 }];
    const h = sketchHealth([...es, ref], ks, new Set(["r1"]));
    expect(h.state).toBe("dangling");
    expect(h.dangling).toEqual([0]);
    expect(h.text).toBe("Dangling: r1 lost its model geometry");
  });

  it("filters the relations list: all, over defining, dangling, on the selected entities", () => {
    const ks: Constraint[] = [{ type: "horizontal", entity: "l1" }, { type: "distance", entity: "l2", value: 3 }, { type: "parallel", entities: ["l1", "l2"] }];
    const health = { conflicting: [0], dangling: [1] };
    expect(filterRelations(ks, "all", health)).toEqual([0, 1, 2]);
    expect(filterRelations(ks, "over", health)).toEqual([0]);
    expect(filterRelations(ks, "dangling", health)).toEqual([1]);
    expect(filterRelations(ks, "selected", health, new Set(["l2"]))).toEqual([1, 2]);
  });
});

describe("the Modify box reads what is typed", () => {
  const params = { t: 6, "sketch_1.width": 40 };
  it("numbers, calculations with functions and units (worked out once), and =expressions (kept)", () => {
    expect(readValue("12.5", params)).toEqual({ ok: true, value: 12.5 });
    const r = readValue("sqrt(2)*10", params);
    expect(r.ok && r.value).toBeCloseTo(14.142135623730951, 12);
    expect(r.ok && r.expr).toBeUndefined();
    expect(readValue("1in", params)).toEqual({ ok: true, value: 25.4 });
    expect(readValue("2cm + 3mm", params)).toEqual({ ok: true, value: 23 });
    expect(readValue("=sketch_1.width / 2 + t", params)).toEqual({ ok: true, value: 26, expr: "=sketch_1.width / 2 + t" });
  });

  it("says what is wrong", () => {
    const empty = readValue("  ", params);
    expect(empty.ok).toBe(false);
    const bad = readValue("sqrt(", params);
    expect(!bad.ok && bad.error).toMatch(/sqrt\(/);
    const unknown = readValue("=nope * 2", params);
    expect(!unknown.ok && unknown.error).toMatch(/nope/);
  });

  it("shows what a calculation comes to, nothing for a plain number", () => {
    expect(shownValue("10", params, "mm")).toBeNull();
    expect(shownValue("1in", params, "mm")).toBe("= 25.4 mm");
    expect(shownValue("=t * 5", params, "°")).toBe("= 30°");
    expect(shownValue("sqrt(", params, "mm")).toBeNull();
  });

  it("spins by the step, never below the minimum, letting an expression go", () => {
    expect(spinValue("10", 1, 0.5, params)).toBe("10.5");
    expect(spinValue("0.2", -1, 1, params, 0)).toBe("0");
    expect(spinValue("=t", 1, 1, params)).toBe("7");
    expect(spinValue("0.1", 1, 0.2, params)).toBe("0.3");
    expect(spinValue("x(", 1, 1, params)).toBeNull();
  });
});

describe("the draft's dimensions", () => {
  const es = [line("l1", [0, 0], [10, 0]), line("l2", [0, 5], [10, 5])];
  it("knows each dimension's old name, and reads the draft's own values by full name", () => {
    const ks: Constraint[] = [{ type: "horizontal", entity: "l1" }, { type: "distance", entity: "l1", value: 10 }, { type: "distance", entity: "l2", value: 10, name: "top" }];
    expect(withOldNames(ks).map((k) => (k as { was?: string }).was)).toEqual([undefined, "d1", "top"]);
    expect(draftParameters({ p: 1 }, "sketch_1", ks)).toEqual({ p: 1, "sketch_1.d1": 10, "sketch_1.top": 10 });
  });

  it("works expressions out again when what they read changes, chains included", () => {
    const ks = [
      { type: "distance", entity: "l1", value: 30 },
      { type: "distance", entity: "l2", value: 10, expr: "=sketch_1.d1 / 2" },
      { type: "distance", points: ["l1.start", "l2.start"], value: 1, expr: "=sketch_1.d2 - 10 + p" },
    ] as Constraint[];
    const out = reexpress(ks, { p: 2 }, "sketch_1") as { value: number }[];
    expect(out.map((k) => k.value)).toEqual([30, 15, 7]);
  });

  it("measures driven dimensions from the geometry, leaving the rest alone", () => {
    const ks: Constraint[] = [{ type: "distance", entity: "l1", value: 10 }, { type: "distance", points: ["l1.start", "l2.start"], value: 99, driven: true }];
    const out = measureDriven(es, ks);
    expect((out[1] as { value: number }).value).toBe(5);
    expect(out[0]).toBe(ks[0]);
    expect(measureDriven(es, out)).toBe(out);
  });

  it("refuses an expression that reads itself, even through another dimension", () => {
    const ks = [
      { type: "distance", entity: "l1", value: 10 },
      { type: "distance", entity: "l2", value: 10, expr: "=sketch_1.d1" },
    ] as Constraint[];
    expect(draftCycle(ks, 0, "=sketch_1.d2 * 2", "sketch_1")).toBe("sketch_1.d1 → sketch_1.d2 → sketch_1.d1");
    expect(draftCycle(ks, 0, "=sketch_1.d1 + 1", "sketch_1")).toBe("sketch_1.d1 → sketch_1.d1");
    expect(draftCycle(ks, 0, "=p * 2", "sketch_1")).toBeNull();
  });
});

describe("on-screen numeric input", () => {
  const start = [{ p: [0, 0] as Vec2, ref: null }];
  it("a line: the length and angle typed place its end, and become its dimensions", () => {
    const end = LINE_TYPED.place(start, [20, 30], [5, 50])!;
    expect(end.p[0]).toBeCloseTo(20 * Math.cos(Math.PI / 6), 9);
    expect(end.p[1]).toBeCloseTo(10, 9);
    // Only the length typed: the pointer gives the direction.
    expect(LINE_TYPED.place(start, [10, undefined], [0, -3])!.p).toEqual([0, -10]);
    // A typed quarter turn is plumb, by relation.
    expect(LINE_TYPED.place(start, [10, 90], [3, 3])).toMatchObject({ p: [0, 10], orient: "vertical" });

    const made = placeTyped(toolByName("line")!, start, [20, 30], [5, 50], {}, { entities: [] })!;
    const dims = made.relations.filter((k) => "value" in k);
    expect(dims).toEqual([
      { type: "distance", entity: "l1", value: 20 },
      { type: "angle", entities: ["l1", "X"], value: 30 },
    ]);
    // The values hold as placed: solving moves nothing.
    expect(checkConstraints(made.entities, made.relations)).toEqual([]);
  });

  it("a circle's radius, a rectangle's width and height", () => {
    expect(CIRCLE_TYPED.place([{ p: [1, 1], ref: null }], [5], [1, 20])!.p).toEqual([1, 6]);
    const rect = placeTyped(toolByName("rect")!, start, [30, 12], [-4, -4], {}, { entities: [] })!;
    const r = solveSketch(rect.entities, rect.relations);
    expect(r.ok).toBe(true);
    expect(rect.relations.filter((k) => "value" in k).map((k) => (k as { value: number }).value)).toEqual([30, 12]);
    // Toward the pointer's quarter: down and to the left.
    expect(rectTyped(false).place(start, [30, 12], [-4, -4])!.p).toEqual([-30, -12]);
  });
});

describe("Smart Dimension: what the picks and the drop call for", () => {
  it("two points: horizontal above or below them, vertical beside them, else aligned", () => {
    expect(dropKind([0, 0], [10, 5], [5, 20])).toBe("c-distance-x");
    expect(dropKind([0, 0], [10, 5], [20, 2])).toBe("c-distance-y");
    expect(dropKind([0, 0], [10, 5], [20, 20])).toBe("c-distance");
    const es = [line("l1", [0, 0], [10, 5])];
    const picks = [
      { kind: "point" as const, ref: "l1.start" },
      { kind: "point" as const, ref: "l1.end" },
    ];
    expect(smartDimension(es, picks, [5, 20])[0].testId).toBe("c-distance-x");
    expect(smartDimension(es, picks, [5, 20])[0].value).toBe(10);
  });

  it("two lines: the angle where it is dropped, its supplement in the other quadrants", () => {
    const es = [line("l1", [0, 0], [10, 0]), line("l2", [0, 0], [10, 10])];
    const picks = [
      { kind: "entity" as const, id: "l1" },
      { kind: "entity" as const, id: "l2" },
    ];
    const inside = smartDimension(es, picks, [10, 3]);
    expect(inside[0].value).toBeCloseTo(45, 9);
    const outside = smartDimension(es, picks, [-10, 3]);
    expect(outside[0].value).toBeCloseTo(135, 9);
    expect(outside[0].make(135)).toEqual({ type: "angle", entities: ["l1", "l2"], value: 135, supplement: true });
    // Two choices, told apart: the supplement says so.
    expect(outside.map((o) => [o.label, o.testId])).toEqual([
      ["Supplementary angle", "c-angle-supplement"],
      ["Angle", "c-angle"],
    ]);
  });

  it("follows the pointer to be dropped only when where it is dropped changes what it is", () => {
    const es = [line("l1", [0, 0], [10, 5]), line("l2", [0, 0], [10, 0]), line("l3", [0, 3], [10, 3]), { ...line("cl", [0, -5], [0, 5]), construction: true }, circle("c1", [20, 0], 2)];
    const pt = (ref: string) => ({ kind: "point" as const, ref });
    const ent = (id: string) => ({ kind: "entity" as const, id });
    // Two points apart in X and Y: aligned, horizontal or vertical by the drop.
    expect(dropMatters(es, [pt("l1.start"), pt("l1.end")])).toBe(true);
    // Two points level: there is only the one distance.
    expect(dropMatters(es, [pt("l2.start"), pt("l2.end")])).toBe(false);
    // Two lines that meet: angle or supplement. Parallel lines: their distance only.
    expect(dropMatters(es, [ent("l1"), ent("l2")])).toBe(true);
    expect(dropMatters(es, [ent("l2"), ent("l3")])).toBe(false);
    // A point and a centreline or sketch axis: distance or diameter across. A point and a plain line: distance only.
    expect(dropMatters(es, [pt("c1.center"), ent("cl")])).toBe(true);
    expect(dropMatters([...es, line("Y", [0, -1], [0, 1])], [pt("c1.center"), ent("Y")])).toBe(true);
    expect(dropMatters(es, [pt("c1.center"), ent("l2")])).toBe(false);
    // A model edge is construction but no centreline.
    const edge = { ...line("m:3", [0, -5], [0, 5]), construction: true, ref: { edge: { type: "line" } } } as unknown as SketchEntity;
    expect(dropMatters([...es, edge], [pt("c1.center"), ent("m:3")])).toBe(false);
    // One pick: it is placed by the click after it, as before.
    expect(dropMatters(es, [ent("l1")])).toBe(false);
  });

  it("names a supplementary angle as the other side", () => {
    expect(describeConstraint({ type: "angle", entities: ["l1", "l2"], value: 120, supplement: true })).toBe("l1 ∠ l2 (other side)");
    expect(describeConstraint({ type: "angle", entities: ["l1", "l2"], value: 60 })).toBe("l1 ∠ l2");
  });

  it("two parallel lines: the distance between them", () => {
    const es = [line("l1", [0, 0], [10, 0]), line("l2", [2, 7], [12, 7])];
    const [d] = smartDimension(es, [
      { kind: "entity", id: "l1" },
      { kind: "entity", id: "l2" },
    ]);
    expect(d.value).toBe(7);
    expect(d.make(7)).toEqual({ type: "distance", lines: ["l1", "l2"], value: 7 });
  });

  it("a point and a centreline, dropped beyond it: a diameter across it", () => {
    const es = [{ ...line("c", [0, -10], [0, 10]), construction: true } as SketchEntity, line("l1", [15, 0], [15, 10])];
    const picks = [
      { kind: "point" as const, ref: "l1.start" },
      { kind: "entity" as const, id: "c" },
    ];
    const across = smartDimension(es, picks, [-5, 0]);
    expect(across[0].testId).toBe("c-linear-diameter");
    expect(across[0].value).toBe(30);
    expect(across[0].make(30)).toEqual({ type: "distance", point: "l1.start", line: "c", value: 30, doubled: true });
    // Dropped on the point's side: its distance first, the diameter offered after.
    expect(smartDimension(es, picks, [20, 0]).map((s) => s.testId)).toEqual(["c-line-distance", "c-linear-diameter"]);
    // Clicking the centreline itself (where the pick lands) is no drop beyond it.
    expect(smartDimension(es, picks, [0.001, 3])[0].testId).toBe("c-line-distance");
    // A plain line (a model edge, a profile line) is no centreline: its distance only.
    const plain = [line("c", [0, -10], [0, 10]), line("l1", [15, 0], [15, 10])];
    expect(smartDimension(plain, picks, [-5, 0]).map((s) => s.testId)).toEqual(["c-line-distance"]);
  });

  it("Shift-clicking a circle measures to its near or far side by where it was clicked", () => {
    const es = [circle("c1", [30, 0], 5), line("l1", [0, -5], [0, 5])];
    const picks = [
      { kind: "point" as const, ref: "l1.start" },
      { kind: "entity" as const, id: "c1" },
    ];
    const near = smartDimension(es, picks, [15, 10], { arcs: { c1: [25.5, 0] } });
    expect(near[0].label).toMatch(/\(min\)$/);
    expect(near[0].make(near[0].value!)).toMatchObject({ condition: "min" });
    const far = smartDimension(es, picks, [15, 10], { arcs: { c1: [34.5, 0] } });
    expect(far[0].label).toMatch(/\(max\)$/);
  });

  it("an arc: its radius, or its length", () => {
    const es: SketchEntity[] = [{ id: "a1", type: "arc", center: [0, 0], start: [10, 0], end: [0, 10] }];
    const offers = smartDimension(es, [{ kind: "entity", id: "a1" }]);
    const length = offers.find((o) => o.testId === "c-arc-length")!;
    expect(length.value).toBeCloseTo(5 * Math.PI, 6);
    // An arc and one of its ends: its length straight away.
    expect(smartDimension(es, [{ kind: "entity", id: "a1" }, { kind: "point", ref: "a1.end" }])[0].testId).toBe("c-arc-length");
  });

  it("a slanted line: its length, or its angle to the X axis", () => {
    const es = [line("l1", [0, 0], [10, 10])];
    const offers = smartDimension(es, [{ kind: "entity", id: "l1" }]);
    expect(offers.map((o) => o.testId)).toEqual(["c-length", "c-angle-x"]);
    expect(offers[1].value).toBeCloseTo(45, 9);
  });
});
