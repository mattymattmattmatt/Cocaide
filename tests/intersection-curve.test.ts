// Phase P wave 3B: intersection curves. The sketcher finds where the
// model's faces cut the sketch plane (from the mesh) and makes each piece an
// entity referencing { face, section }; the rebuild cuts the face again,
// exactly, and the sketch (and what is dimensioned to the curve) follows.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { planeFrame } from "../src/geom/frame";
import { loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { tessellate } from "../src/kernel/mesh";
import { describeFaces } from "../src/kernel/topology";
import { chainSegments, sectionPieces } from "../src/ui/sketcher/section";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const FRONT = { type: "ref", ref: { datum: "Front" } };

/** A 100 x 60 plate t thick with a Ø6 hole through its middle, and features after it. */
function plate(t: number, ...more: Record<string, unknown>[]): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "plate",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: 100, h: 60 }] },
      { id: "e1", op: "extrude", sketch: "s1", distance: t },
      { id: "h1", op: "hole", face: TOP, center: [0, 0], diameter: 6, depth: "through" },
      ...more,
    ],
  };
}

describe("intersection curves in the sketcher", () => {
  it("chains cut segments", () => {
    expect(chainSegments([
      [[1, 0], [2, 0]],
      [[0, 0], [1, 0]],
      [[2, 0], [3, 1]],
    ])).toEqual([[[0, 0], [1, 0], [2, 0], [3, 1]]]);
  });

  it("finds the pieces where the faces cross the Front plane", () => {
    const r = rebuild(plate(10), oc);
    try {
      const view = { mesh: tessellate(oc, r.solid!), faces: scoped((s) => describeFaces(oc, s, r.solid!).infos) };
      // Front: normal -Y, x along X, y along Z.
      const pieces = sectionPieces(view, planeFrame([0, -1, 0], [0, 0, 0], [1, 0, 0]));
      // The top and bottom faces (two lines each: the hole splits them), the two end faces and the hole's wall (two lines).
      expect(pieces.length).toBe(8);
      expect(pieces.every((p) => p.entity?.type === "line")).toBe(true);
      const top = pieces.find((p) => p.entity?.type === "line" && Math.abs(p.entity.start[1] - 10) < 1e-6 && Math.abs(p.entity.end[1] - 10) < 1e-6)!;
      expect(top).toBeDefined();
      expect(top.entity!.ref.section[1]).toBeCloseTo(10, 6);
    } finally {
      r.dispose();
    }
  });
});

describe("intersection curves in the rebuild", () => {
  const sketch = (more: Record<string, unknown> = {}) => ({
    id: "s2",
    op: "sketch",
    plane: FRONT,
    entities: [
      // Deliberately wrong numbers: the rebuild cuts the top face and puts the line where it is.
      { id: "l1", type: "line", start: [0, 0], end: [1, 0], ref: { face: TOP, section: [-20, 10] } },
      { id: "p1", type: "point", at: [0, 20] },
    ],
    constraints: [{ type: "distance", point: "p1.at", line: "l1", value: 10 }],
    ...more,
  });

  it("validates the reference", () => {
    expect(allErrors(validateDocument(plate(10, sketch())))).toEqual([]);
    const bad = plate(10, { id: "s2", op: "sketch", plane: FRONT, entities: [{ id: "q", type: "point", at: [0, 0], ref: { face: TOP, section: [0, 0] } }] });
    expect(allErrors(validateDocument(bad)).join()).toMatch(/can't be an intersection curve/);
  });

  it("cuts the face again, and what is dimensioned to it follows the model", () => {
    for (const t of [10, 15]) {
      const r = rebuild(plate(t, sketch()), oc);
      try {
        expect(r.errors).toEqual([]);
        const s = r.sketches.find((x) => x.id === "s2")!;
        const l = s.entities.find((e) => e.id === "l1")!;
        const p = s.entities.find((e) => e.id === "p1")!;
        expect(l.type === "line" && [l.start[1], Math.abs(l.end[0] - l.start[0])]).toEqual([t, 47]);
        expect(p.type === "point" && p.at[1]).toBeCloseTo(t + 10, 6);
      } finally {
        r.dispose();
      }
    }
  });

  it("says when the cut is no longer that kind of curve", () => {
    const r = rebuild(plate(10, { id: "s2", op: "sketch", plane: FRONT, entities: [{ id: "c1", type: "circle", center: [0, 5], radius: 3, ref: { face: TOP, section: [0, 10] } }] }), oc);
    try {
      expect(r.errors.join()).toMatch(/is a circle, but where the face cuts the sketch plane is a line/);
    } finally {
      r.dispose();
    }
  });

  it("makes profile geometry when not construction: a section line closes a profile", () => {
    const r = rebuild(plate(10, sketch({ entities: [{ id: "l1", type: "line", start: [0, 0], end: [1, 0], construction: false, ref: { face: TOP, section: [0, 10] } }], constraints: [] })), oc);
    try {
      expect(r.errors).toEqual([]);
      expect(r.sketches.find((x) => x.id === "s2")!.open).toBeDefined();
    } finally {
      r.dispose();
    }
  });
});
