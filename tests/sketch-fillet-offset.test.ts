// Sketch fillet, chamfer and offset (src/geom/sketchEdit): exact geometry,
// the relations they leave, degrees of freedom, and that editing the one
// offset dimension moves the whole offset.

import { describe, expect, it } from "vitest";
import type { Constraint, SketchEntity, Vec2 } from "../src/doc/types";
import { checkConstraints } from "../src/geom/constraints";
import { buildProfile } from "../src/geom/profile";
import { sketchDof, solveSketch } from "../src/geom/solver";
import { chamferCorners, cornersOf, filletCorners } from "../src/geom/sketchEdit/fillet";
import { chainOf, insideOf, offsetEntities, sideOf } from "../src/geom/sketchEdit/offset";
import type { Edit, SketchState } from "../src/geom/sketchEdit/relations";

type Line = Extract<SketchEntity, { type: "line" }>;
type Arc = Extract<SketchEntity, { type: "arc" }>;
const ok = (r: Edit | string): Edit => {
  if (typeof r === "string") throw new Error(r);
  return r;
};
const get = <T extends SketchEntity>(s: { entities: SketchEntity[] }, id: string) => s.entities.find((e) => e.id === id) as T;
const close = (a: number[], b: number[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));
};

/** A 40 × 30 rectangle from the origin, as the corner rectangle tool draws it: four lines, joined, level and plumb (4 freedoms). */
function rectangle(): SketchState {
  const p: Vec2[] = [[0, 0], [40, 0], [40, 30], [0, 30]];
  const entities: SketchEntity[] = p.map((a, i) => ({ id: `l${i + 1}`, type: "line", start: a, end: p[(i + 1) % 4] }));
  const constraints: Constraint[] = [
    ...entities.map((l, i): Constraint => ({ type: "coincident", points: [`${l.id}.end`, `l${((i + 1) % 4) + 1}.start`] })),
    { type: "horizontal", entity: "l1" },
    { type: "vertical", entity: "l2" },
    { type: "horizontal", entity: "l3" },
    { type: "vertical", entity: "l4" },
  ];
  return { entities, constraints };
}

/** Commits an edit as the sketcher does: its relations, the soft ones where they add something, solved. */
function solved(r: Edit): SketchState {
  const s = solveSketch(r.entities, [...r.constraints, ...(r.soft ?? [])]);
  if (!s.ok) throw new Error(s.error);
  return { entities: s.entities, constraints: [...r.constraints, ...(r.soft ?? [])] };
}

describe("sketch fillet", () => {
  it("rounds a rectangle's corner: an arc tangent to both sides, centre and radius exact, as defined as before", () => {
    const s = rectangle();
    const picked = cornersOf(s, { entities: [], points: ["l1.end"] });
    if (typeof picked === "string") throw new Error(picked);
    expect(picked.corners).toEqual([{ a: "l1", aEnd: "end", b: "l2", bEnd: "start", at: [40, 0] }]);
    const r = ok(filletCorners(picked.state, picked.corners, 5));
    const a = get<Arc>(r, "a1");
    close([...a.center, ...a.start, ...a.end], [35, 5, 35, 0, 40, 5]);
    close([...get<Line>(r, "l1").end, ...get<Line>(r, "l2").start], [35, 0, 40, 5]);
    expect(r.constraints).toEqual(
      expect.arrayContaining([
        { type: "coincident", points: ["l1.end", "a1.start"] },
        { type: "coincident", points: ["l2.start", "a1.end"] },
        { type: "tangent", entities: ["l1", "a1"] },
        { type: "tangent", entities: ["l2", "a1"] },
        { type: "radius", entity: "a1", value: 5 },
      ]),
    );
    // The corner's own coincident relation went with the corner.
    expect(r.constraints).not.toContainEqual({ type: "coincident", points: ["l1.end", "l2.start"] });
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    expect(sketchDof(s.entities, s.constraints)).toBe(4);
    expect(sketchDof(r.entities, r.constraints)).toBe(4);
    const p = buildProfile(r.entities);
    expect(p.ok && p.area).toBeCloseTo(1200 - 25 + (Math.PI * 25) / 4, 9);
    // The radius dimension drives it: 8 moves the tangent points to 32 and 8.
    const k = r.constraints.findIndex((c) => c.type === "radius");
    const edited = solveSketch(r.entities, r.constraints.map((c, i) => (i === k ? { ...c, value: 8 } as Constraint : c)));
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      const b = get<Arc>(edited, "a1");
      close([...b.center], [get<Line>(edited, "l2").start[0] - 8, get<Line>(edited, "l1").end[1] + 8]);
    }
  });

  it("fillets every corner of a selected rectangle at once: one radius, the rest equal to it", () => {
    const s = rectangle();
    const picked = cornersOf(s, { entities: ["l1", "l2", "l3", "l4"], points: [] });
    if (typeof picked === "string") throw new Error(picked);
    expect(picked.corners).toHaveLength(4);
    const r = ok(filletCorners(picked.state, picked.corners, 4));
    expect(r.made).toEqual(["a1", "a2", "a3", "a4"]);
    expect(r.constraints.filter((k) => k.type === "radius")).toEqual([{ type: "radius", entity: "a1", value: 4 }]);
    expect(r.constraints.filter((k) => k.type === "equal")).toEqual([
      { type: "equal", entities: ["a2", "a1"] },
      { type: "equal", entities: ["a3", "a1"] },
      { type: "equal", entities: ["a4", "a1"] },
    ]);
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    expect(sketchDof(r.entities, r.constraints)).toBe(4);
    const p = buildProfile(r.entities);
    expect(p.ok && p.area).toBeCloseTo(1200 - 4 * 16 + Math.PI * 16, 9);
  });

  it("keeps a dimension to the old corner on a virtual sharp; without the option it goes", () => {
    const s = rectangle();
    s.constraints.push({ type: "distance", entity: "l1", value: 40 }, { type: "distance", points: ["l2.start", "origin"], value: 40 });
    const picked = cornersOf(s, { entities: [], points: ["l2.start"] });
    if (typeof picked === "string") throw new Error(picked);
    const kept = ok(filletCorners(picked.state, picked.corners, 5, { keepCorners: true }));
    const sharp = kept.entities.find((e) => e.type === "point")!;
    expect(sharp).toEqual({ id: "p1", type: "point", at: [40, 0], construction: true });
    expect(kept.constraints).toEqual(
      expect.arrayContaining([
        { type: "distance", points: ["l1.start", "p1.at"], value: 40 },
        { type: "distance", points: ["p1.at", "origin"], value: 40 },
        { type: "pointOn", point: "p1.at", entity: "l1" },
        { type: "pointOn", point: "p1.at", entity: "l2" },
      ]),
    );
    expect(sketchDof(kept.entities, kept.constraints)).toBe(sketchDof(s.entities, s.constraints));
    const dropped = ok(filletCorners(picked.state, picked.corners, 5, { keepCorners: false }));
    expect(dropped.entities.some((e) => e.type === "point")).toBe(false);
    expect(dropped.constraints.some((k) => k.type === "distance")).toBe(false);
  });

  it("fillets two lines that don't meet, trimming them back from where they would", () => {
    const s = { entities: [{ id: "l1", type: "line", start: [0, 0], end: [20, 0] }, { id: "l2", type: "line", start: [30, 10], end: [30, 40] }] as SketchEntity[], constraints: [] };
    const picked = cornersOf(s, { entities: ["l1", "l2"], points: [] });
    if (typeof picked === "string") throw new Error(picked);
    expect(picked.corners[0].at).toEqual([30, 0]);
    const r = ok(filletCorners(picked.state, picked.corners, 5));
    close([...get<Line>(r, "l1").end, ...get<Line>(r, "l2").start, ...get<Arc>(r, "a1").center], [25, 0, 30, 5, 25, 5]);
  });

  it("refuses a radius too big for a side, and says which", () => {
    const s = rectangle();
    const picked = cornersOf(s, { entities: [], points: ["l1.end"] });
    if (typeof picked === "string") throw new Error(picked);
    expect(filletCorners(picked.state, picked.corners, 35)).toBe("a radius of 35 is too big for l2 (30 mm long): use a smaller radius");
  });

  it("rounds a line into an arc: the fillet is tangent to both", () => {
    // A line along y = 0 ending at (10, 0), where an arc about (10, 10) of radius 10 starts going up and right.
    const s = {
      entities: [
        { id: "l1", type: "line", start: [-20, 0], end: [10, 0] },
        { id: "a1", type: "arc", center: [10, 10], start: [10, 0], end: [20, 10] },
      ] as SketchEntity[],
      constraints: [{ type: "coincident", points: ["l1.end", "a1.start"] }] as Constraint[],
    };
    // Tangent already: no corner. Turn the arc the other way so they make one.
    s.entities[1] = { id: "a1", type: "arc", center: [10, -10], start: [10, 0], end: [20, -10], clockwise: true };
    const picked = cornersOf(s, { entities: [], points: ["l1.end"] });
    if (typeof picked === "string") throw new Error(picked);
    expect(filletCorners(picked.state, picked.corners, 2)).toContain("in line");
    s.entities[1] = { id: "a1", type: "arc", center: [20, 0], start: [10, 0], end: [20, 10], clockwise: true };
    const r = ok(filletCorners(s, [{ a: "l1", aEnd: "end", b: "a1", bEnd: "start", at: [10, 0] }], 2));
    const f = get<Arc>(r, "a2");
    // Tangent to the line: centre 2 above it; the corner is outside the arc's circle, so 10 + 2 from its centre.
    expect(f.center[1]).toBeCloseTo(2, 9);
    expect(Math.hypot(f.center[0] - 20, f.center[1])).toBeCloseTo(12, 9);
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
  });
});

describe("sketch chamfer", () => {
  it("cuts a corner by two distances, dimensioned from a virtual sharp", () => {
    const s = rectangle();
    const picked = cornersOf(s, { entities: [], points: ["l1.end"] });
    if (typeof picked === "string") throw new Error(picked);
    const r = ok(chamferCorners(picked.state, picked.corners, { kind: "distances", d1: 6, d2: 4 }));
    const c = get<Line>(r, "l5");
    close([...c.start, ...c.end], [34, 0, 40, 4]);
    expect(r.constraints).toEqual(
      expect.arrayContaining([
        { type: "distance", points: ["p1.at", "l1.end"], value: 6 },
        { type: "distance", points: ["p1.at", "l2.start"], value: 4 },
        { type: "pointOn", point: "p1.at", entity: "l1" },
        { type: "pointOn", point: "p1.at", entity: "l2" },
      ]),
    );
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    expect(sketchDof(r.entities, r.constraints)).toBe(4);
    const p = buildProfile(r.entities);
    expect(p.ok && p.area).toBeCloseTo(1200 - 12, 9);
  });

  it("cuts a corner by a distance and an angle", () => {
    const s = rectangle();
    const r = ok(chamferCorners(s, [{ a: "l1", aEnd: "end", b: "l2", bEnd: "start", at: [40, 0] }], { kind: "angle", d: 5, angle: 30 }));
    const c = get<Line>(r, "l5");
    // 5 back along the bottom, then up the side to where a 30° line from there meets it: 5·tan 30°.
    close([...c.start, ...c.end], [35, 0, 40, 5 * Math.tan(Math.PI / 6)]);
    expect(r.constraints.find((k) => k.type === "angle")).toEqual({ type: "angle", entities: ["l5", "l1"], value: 30 });
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    expect(chamferCorners(s, [{ a: "l1", aEnd: "end", b: "l2", bEnd: "start", at: [40, 0] }], { kind: "angle", d: 5, angle: 95 })).toContain("can't cut this corner");
  });
});

describe("offset entities", () => {
  /** An L: l1 along x from (0, 0) to (20, 0), l2 up from there to (20, 10). */
  const ell = (): SketchState => ({
    entities: [
      { id: "l1", type: "line", start: [0, 0], end: [20, 0] },
      { id: "l2", type: "line", start: [20, 0], end: [20, 10] },
    ],
    constraints: [{ type: "coincident", points: ["l1.end", "l2.start"] }],
  });

  it("takes the chain through the picked entity, in order", () => {
    expect(chainOf(ell().entities, "l2")).toEqual({ links: [{ id: "l1", reversed: false }, { id: "l2", reversed: false }], closed: false });
    expect(chainOf(rectangle().entities, "l3")).toEqual({ links: ["l3", "l4", "l1", "l2"].map((id) => ({ id, reversed: false })), closed: true });
    const chain = chainOf(rectangle().entities, "l1");
    if (typeof chain === "string") throw new Error(chain);
    expect(insideOf(rectangle().entities, chain)).toBe(1);
    expect(sideOf(rectangle().entities, chain, [20, 10])).toBe(1);
    expect(sideOf(rectangle().entities, chain, [20, -10])).toBe(-1);
  });

  it("offsets an L chain to its inside: the lines meet at their crossing", () => {
    const r = ok(offsetEntities(ell(), ["l1"], { distance: 2, side: 1 }));
    close([...get<Line>(r, "l3").start, ...get<Line>(r, "l3").end, ...get<Line>(r, "l4").start, ...get<Line>(r, "l4").end], [0, 2, 18, 2, 18, 2, 18, 10]);
    expect(r.constraints).toEqual(
      expect.arrayContaining([
        { type: "offset", entities: ["l1", "l2"], offsets: ["l3", "l4"], value: 2 },
        { type: "coincident", points: ["l3.end", "l4.start"] },
      ]),
    );
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
  });

  it("offsets an L chain to its outside: sharp, the lines run on to meet; round, an arc round the corner", () => {
    const sharp = ok(offsetEntities(ell(), ["l1"], { distance: 2, side: -1 }));
    close([...get<Line>(sharp, "l3").end, ...get<Line>(sharp, "l4").start], [22, -2, 22, -2]);
    const round = ok(offsetEntities(ell(), ["l1"], { distance: 2, side: -1, corners: "round" }));
    const a = round.entities.find((e) => e.type === "arc") as Arc;
    close([...a.center, ...a.start, ...a.end], [20, 0, 20, -2, 22, 0]);
    expect(round.constraints).toContainEqual({ type: "offset", entities: ["l1", "l1.end", "l2"], offsets: ["l3", "a1", "l4"], value: 2 });
    expect(checkConstraints(round.entities, round.constraints)).toEqual([]);
  });

  it("offsets an open chain both ways with arc caps: one closed slot-like loop round it", () => {
    const r = ok(offsetEntities(ell(), ["l1"], { distance: 2, side: 1, both: true, cap: "arcs", corners: "round" }));
    const p = buildProfile(r.entities.filter((e) => !["l1", "l2"].includes(e.id)));
    // A band 2 each side of the L: its length (20 + 10) times 4, the two half-disc caps (π·2²), the quarter disc round the
    // outside of the corner, less the 2 × 2 square the two sides' strips share inside it.
    expect(p.ok && p.area).toBeCloseTo(30 * 4 + Math.PI * 4 + Math.PI - 4, 6);
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    const lines = ok(offsetEntities(ell(), ["l1"], { distance: 2, side: 1, both: true, cap: "lines" }));
    const q = buildProfile(lines.entities.filter((e) => !["l1", "l2"].includes(e.id)));
    expect(q.ok && q.area).toBeCloseTo(30 * 4, 6);
  });

  it("offsets a rectangle both ways: two rectangles, held by one dimension that moves both", () => {
    const s = rectangle();
    const r = ok(offsetEntities(s, ["l1"], { distance: 3, side: 1, both: true }));
    expect(r.made).toHaveLength(8);
    const inner = r.made!.slice(0, 4).map((id) => get<Line>(r, id));
    const outer = r.made!.slice(4).map((id) => get<Line>(r, id));
    close(inner.flatMap((l) => [...l.start]), [3, 3, 37, 3, 37, 27, 3, 27]);
    close(outer.flatMap((l) => [...l.start]), [-3, -3, 43, -3, 43, 33, -3, 33]);
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    // As defined as the rectangle was: the offsets add nothing free.
    expect(sketchDof(r.entities, r.constraints)).toBe(4);
    // Editing the one offset dimension moves every copy.
    const k = r.constraints.findIndex((c) => c.type === "offset");
    const moved = solveSketch(r.entities, r.constraints.map((c, i) => (i === k ? ({ ...c, value: 5 } as Constraint) : c)));
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      const l1 = get<Line>(moved, "l1");
      const inner1 = get<Line>(moved, r.made![0]);
      const outer1 = get<Line>(moved, r.made![4]);
      expect(inner1.start[1] - l1.start[1]).toBeCloseTo(5, 6);
      expect(l1.start[1] - outer1.start[1]).toBeCloseTo(5, 6);
    }
  });

  it("offsets a circle and an arc by changing the radius, and refuses one that would vanish", () => {
    const s = { entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 10 } as SketchEntity], constraints: [] };
    const r = ok(offsetEntities(s, ["c1"], { distance: 4, side: 1 }));
    expect(get(r, "c2")).toEqual({ id: "c2", type: "circle", center: [0, 0], radius: 6 });
    expect(r.constraints).toEqual([{ type: "offset", entities: ["c1"], offsets: ["c2"], value: 4 }]);
    expect(offsetEntities(s, ["c1"], { distance: 12, side: 1 })).toContain("reaches its centre");
    const out = ok(offsetEntities(s, ["c1"], { distance: 4, side: -1, construction: true }));
    expect(get(out, "c2")).toMatchObject({ radius: 14 });
    expect(get(out, "c1")).toMatchObject({ construction: true });
  });

  it("offsets a filleted rectangle inward: lines and arcs, the corners tangent so they meet", () => {
    const s = rectangle();
    const picked = cornersOf(s, { entities: ["l1", "l2", "l3", "l4"], points: [] });
    if (typeof picked === "string") throw new Error(picked);
    const f = solved(ok(filletCorners(picked.state, picked.corners, 5)));
    const r = ok(offsetEntities(f, ["l1"], { distance: 3, side: 1 }));
    const p = buildProfile(r.entities.filter((e) => r.made!.includes(e.id)));
    // The inner loop: (40 − 6) × (30 − 6) less its four corners of radius 2 rounded off.
    expect(p.ok && p.area).toBeCloseTo(34 * 24 - 4 * 4 + Math.PI * 4, 6);
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    expect(sketchDof(r.entities, r.constraints)).toBe(sketchDof(f.entities, f.constraints));
  });
});
