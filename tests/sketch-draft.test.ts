import { describe, expect, it } from "vitest";
import type { Constraint, SketchEntity } from "../src/doc/types";
import { checkConstraints } from "../src/geom/constraints";
import { solveSketch } from "../src/geom/solver";
import { entityFromClicks, handlesOf, hitEntity, hitHandle, removeEntities, suggestions } from "../src/ui/sketcher/draft";

describe("drawing tools", () => {
  it("builds each entity from its clicks", () => {
    expect(entityFromClicks("rect", "r1", [[-30, -15], [30, 15]], false)).toEqual({ id: "r1", type: "rect", center: [0, 0], w: 60, h: 30 });
    expect(entityFromClicks("circle", "c1", [[1, 2], [4, 6]], true)).toEqual({ id: "c1", type: "circle", center: [1, 2], radius: 5, construction: true });
    const arc = entityFromClicks("arc", "a1", [[0, 0], [10, 0], [0, 3]], false) as Extract<SketchEntity, { type: "arc" }>;
    expect(arc.end[0]).toBeCloseTo(0, 9);
    expect(arc.end[1]).toBeCloseTo(10, 9); // projected onto the circle through the start
    expect(entityFromClicks("slot", "s1", [[0, 0], [20, 0], [5, 4]], false)).toEqual({ id: "s1", type: "slot", center1: [0, 0], center2: [20, 0], width: 8 });
    expect(entityFromClicks("line", "l1", [[1, 1], [1, 1]], false)).toBeNull();
  });
});

describe("picking", () => {
  const ents: SketchEntity[] = [
    { id: "r1", type: "rect", center: [0, 0], w: 80, h: 40 },
    { id: "c1", type: "circle", center: [30, 0], radius: 3.3 },
  ];

  it("offers rect corners as drag handles, centres as constraint points", () => {
    const hs = handlesOf(ents[0]);
    expect(hs.map((h) => [h.ref, h.constraint])).toEqual([
      ["r1.center", true],
      ["r1.corner0", false],
      ["r1.corner1", false],
      ["r1.corner2", false],
      ["r1.corner3", false],
    ]);
    expect(hs[3].point).toEqual([40, 20]);
  });

  it("finds the nearest handle, the origin included", () => {
    expect(hitHandle(ents, [0.5, 0.2], 1)?.ref).toBe("origin");
    expect(hitHandle(ents, [30.4, 0], 1)?.ref).toBe("c1.center");
    expect(hitHandle(ents, [39.5, 19.5], 1, { constraintOnly: true })).toBeNull();
  });

  it("hits an entity by its outline", () => {
    expect(hitEntity(ents, [0, 20.3], 0.5)?.id).toBe("r1");
    expect(hitEntity(ents, [33.2, 0], 0.5)?.id).toBe("c1");
    expect(hitEntity(ents, [10, 5], 0.5)).toBeNull();
  });
});

describe("constraint suggestions", () => {
  const rect: SketchEntity = { id: "r1", type: "rect", center: [3, 1], w: 60, h: 30 };

  it("offers width, height and centring for a rect, valued at what it measures now", () => {
    const s = suggestions([rect], [{ kind: "entity", id: "r1" }]);
    expect(s.map((o) => [o.label, o.value])).toEqual([
      ["Width", 60],
      ["Height", 30],
      ["Centre on origin", undefined],
    ]);
  });

  it("builds the bracket's constraints and they solve to the bracket", () => {
    const [width, height, centre] = suggestions([rect], [{ kind: "entity", id: "r1" }]);
    const ks: Constraint[] = [width.make(80), height.make(40), centre.make(0)];
    expect(ks).toEqual([
      { type: "distanceX", entity: "r1", value: 80 },
      { type: "distanceY", entity: "r1", value: 40 },
      { type: "coincident", points: ["r1.center", "origin"] },
    ]);
    const r = solveSketch([rect], ks);
    expect(r.ok && r.dof).toBe(0);
    if (r.ok) expect(checkConstraints(r.entities, ks)).toEqual([]);
  });

  it("offers point-to-point dimensions for two points", () => {
    const lines: SketchEntity[] = [
      { id: "l1", type: "line", start: [0, 0], end: [10, 5] },
      { id: "l2", type: "line", start: [20, 5], end: [30, 5] },
    ];
    const s = suggestions(lines, [
      { kind: "point", ref: "l1.end" },
      { kind: "point", ref: "l2.start" },
    ]);
    expect(s.map((o) => [o.label, o.value])).toEqual([
      ["Coincident", undefined],
      ["Horizontal distance", 10],
      ["Vertical distance", 0],
      ["Distance", 10],
    ]);
  });
});

describe("deleting", () => {
  it("removes the constraints that mention deleted entities", () => {
    const ents: SketchEntity[] = [
      { id: "l1", type: "line", start: [0, 0], end: [10, 0] },
      { id: "l2", type: "line", start: [10, 0], end: [10, 10] },
    ];
    const ks: Constraint[] = [
      { type: "coincident", points: ["l1.end", "l2.start"] },
      { type: "horizontal", entity: "l1" },
      { type: "vertical", entity: "l2" },
      { type: "coincident", points: ["l1.start", "origin"] },
    ];
    expect(removeEntities(ents, ks, ["l2"])).toEqual({
      entities: [ents[0]],
      constraints: [
        { type: "horizontal", entity: "l1" },
        { type: "coincident", points: ["l1.start", "origin"] },
      ],
    });
  });
});
