// Plan symbols: a door's leaves and swing, a room's area found from the plan's lines.

import { describe, expect, it } from "vitest";
import type { Vec2 } from "../src/doc/types";
import { doorLeaves, roomRegion, roomWalls } from "../src/drafting/annotate";
import { allErrors, validateDocument } from "../src/doc/validate";

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

describe("rooms", () => {
  const box = { min: [-100, -100] as Vec2, max: [8100, 5100] as Vec2 };

  it("a 4 × 3 m room: its area and size from the lines round it, to well under one per cent", () => {
    const r = roomRegion([rect(0, 0, 4000, 3000), rect(-90, -90, 8090, 5090)], box, [2000, 1500]);
    expect(r.open).toBe(false);
    expect(Math.abs(r.area - 12e6) / 12e6).toBeLessThan(0.006);
    expect(Math.abs(r.size[0] - 4000)).toBeLessThan(40);
    expect(Math.abs(r.size[1] - 3000)).toBeLessThan(40);
  });

  it("an island standing in it is counted in; a neighbouring room is not", () => {
    const walls = [rect(0, 0, 4000, 3000), rect(4090, 0, 8000, 3000), rect(1500, 1000, 2500, 1600)];
    const r = roomRegion(walls, box, [700, 2500]);
    expect(Math.abs(r.area - 12e6) / 12e6).toBeLessThan(0.006);
  });

  it("an opening leaks to the outside unless a door on the plan closes it", () => {
    // The room's bottom wall has a 900 gap from x = 1000.
    const walls: Vec2[][] = [
      [[1000, 0], [0, 0], [0, 3000], [4000, 3000], [4000, 0], [1900, 0]],
    ];
    expect(roomRegion(walls, box, [2000, 1500]).open).toBe(true);
    const door = { type: "door" as const, id: "d", view: "plan", hinge: [1000, 0] as Vec2, width: 900 };
    const cv = { edges: walls.map((pts) => ({ visible: true, pts })) } as never;
    const closed = roomRegion(roomWalls(cv, [{ a: door, hinge: [1000, 0] }]), box, [2000, 1500]);
    expect(closed.open).toBe(false);
    expect(Math.abs(closed.area - 12e6) / 12e6).toBeLessThan(0.006);
  });
});

describe("doors", () => {
  it("a single leaf turns open to the left by default, to the right when asked; a double door is two half leaves", () => {
    const d = { type: "door" as const, id: "d", view: "plan", hinge: [0, 0] as Vec2, width: 820 };
    expect(doorLeaves(d, [0, 0])).toEqual([{ hinge: [0, 0], shut: [1, 0], width: 820, turn: 1 }]);
    expect(doorLeaves({ ...d, swing: "right" }, [0, 0])[0].turn).toBe(-1);
    const dbl = doorLeaves({ ...d, width: 1640, double: true }, [0, 0]);
    expect(dbl.map((l) => [l.hinge, l.width, l.turn])).toEqual([[[0, 0], 820, 1], [[1640, 0], 820, -1]]);
  });
});

describe("validation", () => {
  const doc = (annotations: unknown[]) => ({ version: 1, units: "mm", name: "p", features: [], drawing: { sheets: [{ id: "s1", format: { size: "A3" }, projection: "third", views: [{ id: "plan", look: "top" }], annotations }] } });
  const errors = (annotations: unknown[]) => allErrors(validateDocument(doc(annotations)));
  it("takes doors and rooms, and says what is wrong with them", () => {
    expect(errors([{ id: "d1", type: "door", view: "plan", hinge: [0, 0], width: 820, swing: "right" }, { id: "r1", type: "room", view: "plan", name: "Bed 1", at: [2000, 1500], size: true }])).toEqual([]);
    const bad = errors([{ id: "d1", type: "door", view: "plan", hinge: "x", width: -1, open: 200 }, { id: "r1", type: "room", view: "plan", at: [0, 0], outline: [[0, 0]] }]).join("\n");
    expect(bad).toMatch(/hinge/);
    expect(bad).toMatch(/open/);
    expect(bad).toMatch(/name/);
    expect(bad).toMatch(/outline/);
  });
});
