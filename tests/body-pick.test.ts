// The Bodies selection filter: a click on a face picks its whole body, in a
// feature's bodies field (toggling it) and in the plain selection.

import { describe, expect, it } from "vitest";
import { allows, toggleFilter, NO_FILTER } from "../src/ui/evaluate/filter";
import { facesOfBody, pickBody } from "../src/ui/model/selection";
import { fieldTakes } from "../src/ui/props/picking";

const view = {
  faces: [0, 1, 2, 3, 4].map((index) => ({ index, body: index < 3 ? "leg" : "rail", centroid: [index, 0, 0] as [number, number, number] })),
  bodies: [{ name: "leg" }, { name: "rail" }],
};

describe("the Bodies filter", () => {
  it("lets faces through (a body is picked by any of its faces), nothing else", () => {
    const f = toggleFilter(NO_FILTER, "bodies");
    expect(allows(f, "face")).toBe(true);
    expect(allows(f, "edge")).toBe(false);
    expect(allows(f, "vertex")).toBe(false);
    expect(fieldTakes({ takes: ["bodies"] }, { kind: "face", index: 0, point: [0, 0, 0] })).toBe(true);
    expect(fieldTakes({ takes: ["bodies"] }, { kind: "edge", index: 0, point: [0, 0, 0] })).toBe(false);
  });

  it("selects every face of the body clicked; Ctrl adds another, and takes it out again", () => {
    expect(facesOfBody(view, 4)).toEqual([3, 4]);
    const one = pickBody({ faces: [], edges: [] }, { kind: "face", index: 1, point: [0, 0, 0] }, false, facesOfBody(view, 1));
    expect(one.faces).toEqual([0, 1, 2]);
    const two = pickBody(one, { kind: "face", index: 3, point: [0, 0, 0] }, true, facesOfBody(view, 3));
    expect(two.faces).toEqual([0, 1, 2, 3, 4]);
    const back = pickBody(two, { kind: "face", index: 0, point: [0, 0, 0] }, true, facesOfBody(view, 0));
    expect(back.faces).toEqual([3, 4]);
  });
});
