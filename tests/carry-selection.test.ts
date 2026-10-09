// What stays selected when a rebuild lands (src/ui/model/carrySelection.ts):
// a body picked in the Bodies panel just after an edit is still that body
// when the edit's rebuild arrives (the multibody table-frame mirror bug).

import { describe, expect, it } from "vitest";
import { carrySelection, wholeBodySelected } from "../src/ui/model/carrySelection";
import { EMPTY_SELECTION } from "../src/ui/model/selection";

const body = (name: string, from: number, to: number) => ({ name, faces: [from, to] as [number, number], edges: [0, 0] as [number, number] });
// Before: four legs of 10 faces each. After deleting leg_b and leg_c: leg_a and leg_d.
const before = { bodies: [body("leg_a", 0, 10), body("leg_b", 10, 20), body("leg_c", 20, 30), body("leg_d", 30, 40)] };
const after = { bodies: [body("leg_a", 0, 10), body("leg_d", 10, 20)] };
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const none = () => false;

describe("the selection across a rebuild", () => {
  it("knows a whole body picked, and nothing less or more", () => {
    expect(wholeBodySelected({ faces: range(30, 40), edges: [] }, before.bodies)).toBe("leg_d");
    expect(wholeBodySelected({ faces: range(30, 39), edges: [] }, before.bodies)).toBeNull();
    expect(wholeBodySelected({ faces: range(29, 40), edges: [] }, before.bodies)).toBeNull();
    expect(wholeBodySelected({ faces: range(0, 10), edges: [3] }, before.bodies)).toBeNull();
    expect(wholeBodySelected(EMPTY_SELECTION, before.bodies)).toBeNull();
  });

  it("keeps a body picked in the Bodies panel as the same body's faces in the new solid", () => {
    expect(carrySelection({ faces: range(30, 40), edges: [] }, before, after, none)).toEqual({ faces: range(10, 20), edges: [] });
    expect(carrySelection({ faces: range(0, 10), edges: [] }, before, after, none)).toEqual({ faces: range(0, 10), edges: [] });
  });

  it("drops faces and edges picked one by one, and a body that is gone", () => {
    expect(carrySelection({ faces: [3], edges: [] }, before, after, none)).toEqual(EMPTY_SELECTION);
    expect(carrySelection({ faces: range(10, 20), edges: [] }, before, after, none)).toEqual(EMPTY_SELECTION);
    expect(carrySelection({ faces: range(0, 10), edges: [] }, null, after, none)).toEqual(EMPTY_SELECTION);
  });

  it("keeps the planes, axes and points that still exist", () => {
    const sel = { faces: [], edges: [], datums: ["Top", "plane_9"] };
    expect(carrySelection(sel, before, after, (id) => id === "Top")).toEqual({ faces: [], edges: [], datums: ["Top"] });
  });
});
