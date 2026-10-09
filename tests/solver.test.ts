import { describe, expect, it } from "vitest";
import type { Constraint, SketchEntity } from "../src/doc/types";
import { checkConstraints } from "../src/geom/constraints";
import { sketchDof, solveSketch, wouldOverDefine } from "../src/geom/solver";

const solved = (entities: SketchEntity[], constraints: Constraint[], drag?: Parameters<typeof solveSketch>[2]) => {
  const r = solveSketch(entities, constraints, drag);
  if (!r.ok) throw new Error(r.error);
  // Whatever the solver returns must pass the rebuild's own constraint check.
  expect(checkConstraints(r.entities, constraints)).toEqual([]);
  return r;
};
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 7));

describe("typed dimensions drive the geometry", () => {
  const rect: SketchEntity = { id: "r1", type: "rect", center: [3, 4], w: 50, h: 30 };
  const dims: Constraint[] = [
    { type: "distanceX", entity: "r1", value: 80 },
    { type: "distanceY", entity: "r1", value: 40 },
    { type: "coincident", points: ["r1.center", "origin"] },
  ];

  it("sizes and centres the bracket rectangle, fully defined", () => {
    const r = solved([rect], dims);
    expect(r.entities[0]).toEqual({ id: "r1", type: "rect", center: [expect.closeTo(0, 9), expect.closeTo(0, 9)], w: expect.closeTo(80, 9), h: expect.closeTo(40, 9) });
    expect(r.dof).toBe(0);
  });

  it("follows a changed dimension and nothing else", () => {
    const first = solved([rect], dims).entities;
    const wider = dims.map((k) => (k.type === "distanceX" ? { ...k, value: 100 } : k));
    const r = solved(first, wider).entities[0] as Extract<SketchEntity, { type: "rect" }>;
    expect(r.w).toBeCloseTo(100, 9);
    expect(r.h).toBeCloseTo(40, 9);
    close(r.center, [0, 0]);
  });

  it("solves a constrained chain of lines", () => {
    const lines: SketchEntity[] = [
      { id: "l1", type: "line", start: [1, 1], end: [28, 3] },
      { id: "l2", type: "line", start: [28, 2], end: [29, 18] },
      { id: "l3", type: "line", start: [30, 19], end: [0, 0] },
    ];
    const ks: Constraint[] = [
      { type: "coincident", points: ["l1.end", "l2.start"] },
      { type: "coincident", points: ["l2.end", "l3.start"] },
      { type: "coincident", points: ["l3.end", "l1.start"] },
      { type: "horizontal", entity: "l1" },
      { type: "vertical", entity: "l2" },
      { type: "distance", entity: "l1", value: 30 },
      { type: "distance", entity: "l2", value: 20 },
    ];
    const r = solved(lines, ks);
    expect(r.dof).toBe(2); // the triangle can still slide
    const anchored = solved(r.entities, [...ks, { type: "coincident", points: ["l1.start", "origin"] }]);
    expect(anchored.dof).toBe(0);
    const [l1, l2] = anchored.entities as Extract<SketchEntity, { type: "line" }>[];
    close([...l1.start, ...l1.end, ...l2.end], [0, 0, 30, 0, 30, 20]);
  });

  it("keeps an arc's ends on one circle and honours equal radii", () => {
    const r = solved(
      [
        { id: "c", type: "circle", center: [0, 0], radius: 5 },
        { id: "a", type: "arc", center: [20, 0], start: [23, 0], end: [20, 3] },
      ],
      [
        { type: "radius", entity: "c", value: 7 },
        { type: "equal", entities: ["c", "a"] },
      ],
    );
    const a = r.entities[1] as Extract<SketchEntity, { type: "arc" }>;
    expect(Math.hypot(a.start[0] - a.center[0], a.start[1] - a.center[1])).toBeCloseTo(7, 7);
    expect(Math.hypot(a.end[0] - a.center[0], a.end[1] - a.center[1])).toBeCloseTo(7, 7);
  });

  it("refuses constraints that conflict, and says so", () => {
    const r = solveSketch(
      [{ id: "l1", type: "line", start: [0, 0], end: [10, 0] }],
      [
        { type: "horizontal", entity: "l1" },
        { type: "vertical", entity: "l1" },
        { type: "distance", entity: "l1", value: 10 },
      ],
    );
    expect(r).toEqual({ ok: false, error: "the constraints conflict or cannot all be met; remove or change one" });
  });

  it("refuses a dimension that would turn geometry inside out", () => {
    const r = solveSketch([{ id: "c", type: "circle", center: [0, 0], radius: 5 }], [{ type: "radius", entity: "c", value: 5 }], {
      drag: [{ handle: "c.edge", to: [0, 0] }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("dragging", () => {
  it("moves a line end and keeps the line horizontal", () => {
    const r = solved([{ id: "l1", type: "line", start: [0, 0], end: [10, 0] }], [{ type: "horizontal", entity: "l1" }], {
      drag: [{ handle: "l1.end", to: [20, 5] }],
    });
    const l = r.entities[0] as Extract<SketchEntity, { type: "line" }>;
    close([...l.start, ...l.end], [0, 5, 20, 5]);
  });

  it("will not move a point the constraints pin", () => {
    const r = solveSketch(
      [{ id: "l1", type: "line", start: [0, 0], end: [10, 0] }],
      [{ type: "coincident", points: ["l1.start", "origin"] }],
      { drag: [{ handle: "l1.start", to: [5, 5] }] },
    );
    expect(r).toEqual({ ok: false, error: "the constraints do not let that move" });
  });

  it("slides a dragged point as near the pointer as the constraints let it", () => {
    // Level from the origin: the end can only go along the x axis, so it goes to the pointer's x.
    const r = solved(
      [{ id: "l1", type: "line", start: [0, 0], end: [10, 0] }],
      [
        { type: "coincident", points: ["l1.start", "origin"] },
        { type: "horizontal", entity: "l1" },
      ],
      { drag: [{ handle: "l1.end", from: [10, 0], to: [25, 10] }] },
    );
    const l = r.entities[0] as Extract<SketchEntity, { type: "line" }>;
    close([...l.start, ...l.end], [0, 0, 25, 0]);
    // On a circle about the origin: the nearest point of the circle to the pointer.
    const p = solved(
      [{ id: "p1", type: "point", at: [10, 0] }],
      [{ type: "distance", points: ["p1.at", "origin"], value: 10 }],
      { drag: [{ handle: "p1.at", from: [10, 0], to: [30, 30] }] },
    );
    const at = (p.entities[0] as Extract<SketchEntity, { type: "point" }>).at;
    at.forEach((v) => expect(v).toBeCloseTo(10 / Math.SQRT2, 5));
  });

  it("drags a rect corner and keeps the opposite corner still", () => {
    const r = solved([{ id: "r1", type: "rect", center: [0, 0], w: 20, h: 10 }], [], {
      drag: [{ handle: "r1.corner2", to: [50, 30] }],
    });
    expect(r.entities[0]).toMatchObject({ center: [expect.closeTo(20, 7), expect.closeTo(12.5, 7)], w: expect.closeTo(60, 7), h: expect.closeTo(35, 7) });
  });

  it("drags a centred rect corner symmetrically when the centre is fixed", () => {
    const r = solved([{ id: "r1", type: "rect", center: [0, 0], w: 20, h: 10 }], [{ type: "coincident", points: ["r1.center", "origin"] }], {
      drag: [{ handle: "r1.corner2", to: [40, 20] }],
    });
    expect(r.entities[0]).toMatchObject({ w: expect.closeTo(80, 7), h: expect.closeTo(40, 7) });
  });

  it("moves a whole entity by the drag delta", () => {
    const r = solved([{ id: "s", type: "slot", center1: [0, 0], center2: [10, 0], width: 4 }], [], {
      drag: [{ handle: "s.body", from: [5, 0], to: [8, 2] }],
    });
    expect(r.entities[0]).toMatchObject({ center1: [expect.closeTo(3, 7), expect.closeTo(2, 7)], center2: [expect.closeTo(13, 7), expect.closeTo(2, 7)], width: 4 });
  });

  it("drags a circle edge to set its radius", () => {
    const r = solved([{ id: "c", type: "circle", center: [1, 1], radius: 2 }], [], { drag: [{ handle: "c.edge", to: [4, 5] }] });
    expect((r.entities[0] as Extract<SketchEntity, { type: "circle" }>).radius).toBeCloseTo(5, 7);
  });
});

describe("degrees of freedom", () => {
  it("counts what is left to define", () => {
    expect(sketchDof([{ id: "r", type: "rect", center: [0, 0], w: 1, h: 1 }], [])).toBe(4);
    expect(sketchDof([{ id: "c", type: "circle", center: [0, 0], radius: 1 }], [{ type: "radius", entity: "c", value: 1 }])).toBe(2);
    expect(sketchDof([{ id: "a", type: "arc", center: [0, 0], start: [1, 0], end: [0, 1] }], [])).toBe(5);
  });

  it("spots a constraint that adds nothing", () => {
    const line: SketchEntity[] = [{ id: "l1", type: "line", start: [0, 0], end: [10, 0] }];
    expect(wouldOverDefine(line, [{ type: "horizontal", entity: "l1" }], { type: "horizontal", entity: "l1" })).toBe(true);
    expect(wouldOverDefine(line, [{ type: "horizontal", entity: "l1" }], { type: "distance", entity: "l1", value: 10 })).toBe(false);
  });
});
