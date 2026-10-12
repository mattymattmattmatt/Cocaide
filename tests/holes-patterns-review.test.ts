// Wave 5 review: regressions for what the review of the Hole Wizard and the
// pattern upgrades found. Overlapping holes of one feature cut what the same
// holes cut one by one; a hole drilled from a sketch's plane that misses the
// part says so whatever its end condition; the editors' patches keep skips
// valid when places or rows go; a grid's tick boxes come row by row; two hole
// callouts in one view do not overlap; a sketch-driven pattern's packet.

import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { holePatternMeasurements } from "../src/ask/packet";
import { apply, type RawDocument } from "../src/doc/commands";
import { composeSheet } from "../src/drafting/compose";
import { overlaps } from "../src/drafting/sheet";
import { firstRowSkips, secondDirection } from "../src/features/linearPattern/ui";
import { patternRows } from "../src/features/linearPattern/instances";
import { keptSkips } from "../src/features/sketchPattern/ui";
import { getOC, loadOC, rebuild, type OC } from "../src/kernel";

let oc: OC;
let kernel: LocalKernel;
beforeAll(async () => {
  oc = await loadOC();
  kernel = new LocalKernel(getOC);
});

type Raw = Record<string, unknown>;
const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };

/** A 100 x 60 plate, 10 thick (x -50..50, y -30..30, z 0..10), and features after it. */
function plate(...more: Raw[]): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "plate",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: 100, h: 60 }] },
      { id: "e1", op: "extrude", sketch: "s1", distance: 10 },
      ...more,
    ],
  };
}

function built(doc: RawDocument) {
  const r = rebuild(doc, oc);
  try {
    return { errors: r.errors, volume: r.measurements?.volume ?? 0, solids: r.measurements?.bodies.length ?? 0 };
  } finally {
    r.dispose();
  }
}

describe("holes of one feature that overlap", () => {
  it("cut what the same holes cut one at a time (the tool is fused, not a compound of overlapping solids)", () => {
    // Two M8 countersinks 10 apart: the Ø18.3 countersinks overlap. Through, blind past the plate, and blind inside it.
    for (const depth of ["through", 19.75, 6]) {
      const together = built(plate({ id: "h", op: "hole", face: TOP, centers: [[-20, -10], [-10, -10]], size: "M8", kind: "countersink", depth }));
      const apart = built(
        plate(
          { id: "h1", op: "hole", face: TOP, center: [-20, -10], size: "M8", kind: "countersink", depth },
          { id: "h2", op: "hole", face: TOP, center: [-10, -10], size: "M8", kind: "countersink", depth },
        ),
      );
      expect(together.errors).toEqual([]);
      expect(apart.errors).toEqual([]);
      expect(together.volume).toBeCloseTo(apart.volume, 3);
      // Something was cut, not everything.
      expect(together.volume).toBeGreaterThan(50000);
      expect(together.volume).toBeLessThan(60000);
    }
  });

  it("counterbores that overlap, at a sketch's points", () => {
    const pts: Raw = { id: "pts", op: "sketch", plane: { type: "ref", ref: { face: TOP } }, entities: [[0, 0], [8, 0], [16, 0]].map((at, i) => ({ id: `p${i}`, type: "point", at })) };
    const together = built(plate(pts, { id: "h", op: "hole", face: TOP, points: "pts", size: "M6", kind: "counterbore", depth: "through" }));
    const apart = built(plate(...[0, 8, 16].map((x, i) => ({ id: `h${i}`, op: "hole", face: TOP, center: [x, 0], size: "M6", kind: "counterbore", depth: "through" }))));
    expect(together.errors).toEqual([]);
    expect(together.volume).toBeCloseTo(apart.volume, 3);
  });
});

describe("a hole drilled from a sketch's plane", () => {
  const pts = (plane: unknown): Raw => ({ id: "pts", op: "sketch", plane, entities: [{ id: "p1", type: "point", at: [0, 0] }] });
  it("says it meets no material, through all as well as blind", () => {
    // The Top plane is the plate's bottom: against its normal (-Z) there is no plate.
    for (const [depth, words] of [
      ["through", "along its axis"],
      [5, "within its depth 5"],
    ] as const) {
      const b = built(plate(pts({ type: "ref", ref: { datum: "Top" } }), { id: "h", op: "hole", points: "pts", diameter: 5, depth }));
      expect(b.errors).toEqual([`h: the hole at point "p1" [0, 0] meets no material ${words}: sketch its point over the part (drilled against the sketch's normal), or flip the sketch's plane`]);
    }
  });

  it("drills through when the sketch is over the part", () => {
    const b = built(plate(pts({ type: "datum", normal: [0, 0, 1], origin: [0, 0, 15] }), { id: "h", op: "hole", points: "pts", diameter: 5, depth: "through" }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(60000 - Math.PI * 2.5 ** 2 * 10, 3);
  });
});

describe("editor patches that keep skips valid", () => {
  it("a sketch-driven pattern with fewer places drops the skips past its last instance", () => {
    // 3 copies (instances 2..4), 4 skipped: down to 2 copies, the skip goes.
    expect(keptSkips({ skip: [4] }, 2)).toEqual({ skip: null });
    expect(keptSkips({ skip: [2, 4] }, 2)).toEqual({ skip: [2] });
    // Down to one copy: skipping it would leave none, so the skips go.
    expect(keptSkips({ skip: [2] }, 1)).toEqual({ skip: null });
    // Nothing to change.
    expect(keptSkips({ skip: [3] }, 3)).toEqual({});
    expect(keptSkips({}, 1)).toEqual({});
  });

  it("a grid's second direction starts square to the first, and off it keeps the first row's skips", () => {
    expect(secondDirection({ direction: [1, 0, 0] })).toEqual([0, 1, 0]);
    expect(secondDirection({ direction: [0, -1, 0] })).toEqual([1, 0, 0]);
    expect(secondDirection({ along: { datum: "X" } })).toEqual([0, 1, 0]);
    // 4 along, 2 rows: 3 is on the first row, 6 on the second.
    expect(firstRowSkips({ count: 4, skip: [3, 6] })).toEqual({ skip: [3] });
    expect(firstRowSkips({ count: 4, skip: [6] })).toEqual({ skip: null });
  });

  it("the second direction made by the editor is valid where the first runs along Y", () => {
    const doc = plate(
      { id: "h", op: "hole", face: TOP, center: [-40, -20], diameter: 4, depth: "through" },
      { id: "lp", op: "linearPattern", feature: "h", direction: [0, 1, 0], spacing: 10, count: 2 },
    );
    const lp = doc.features[3] as Raw;
    const r = apply(doc, { type: "updateFeature", id: "lp", patch: { direction2: secondDirection(lp), spacing2: 10, count2: 2 } } as never);
    expect(r.ok).toBe(true);
  });

  it("a grid's instances come row by row, a row number on each", () => {
    const rows = patternRows({ op: "linearPattern", count: 3, direction2: [0, 1, 0], count2: 2 });
    expect(rows.map((r) => [r.n, r.row])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 1],
      [5, 1],
      [6, 1],
    ]);
    expect(patternRows({ op: "linearPattern", count: 3 }).every((r) => r.row === undefined)).toBe(true);
  });
});

describe("hole callouts on a drawing", () => {
  it("two hole features called out in one view do not overlap each other", async () => {
    const doc = plate(
      { id: "cb", op: "hole", face: TOP, centers: [[40, 20], [40, -20], [-40, 20]], size: "M6", kind: "counterbore", depth: "through" },
      { id: "tp", op: "hole", face: TOP, center: [0, 0], size: "M8", kind: "tapped", depth: 8 },
      { id: "lp", op: "linearPattern", feature: "tp", direction: [1, 0, 0], spacing: 15, count: 2 },
    );
    const views = [{ id: "top", look: "top" as const }];
    const drawn = apply(doc, {
      type: "setDrawing",
      drawing: {
        sheet: { size: "A3", scale: "2:1", projection: "third" },
        views,
        annotations: [
          { id: "c1", type: "hole", view: "top", hole: "cb" },
          { id: "c2", type: "hole", view: "top", hole: "tp" },
        ],
      },
    });
    if (!drawn.ok) throw new Error(drawn.error);
    const c = await kernel.check(drawn.doc);
    const sheet = composeSheet(drawn.doc, { measurements: c.measurements, geometry: await kernel.project(drawn.doc, views) })!;
    const [a, b] = ["c1", "c2"].map((id) => sheet.annotations.find((x) => x.id === id)!);
    expect([a.problem, b.problem]).toEqual([undefined, undefined]);
    expect(a.text).toBe("3× Ø6.6 THRU CBORE Ø11 × 6.5 DEEP");
    expect(b.text).toBe("2× M8×1.25 - 6H ⌴4.25 Ø6.8 ⌴8");
    // Their texts (each annotation's box less its leader is hard to tell apart; the text prims are not).
    const textBox = (id: string) => {
      const ps = sheet.prims.filter((p) => p.owner === id && p.k === "text") as { at: [number, number]; text: string }[];
      const xs = ps.map((p) => p.at[0]);
      const ys = ps.map((p) => p.at[1]);
      return { min: [Math.min(...xs), Math.min(...ys) - 1] as [number, number], max: [Math.max(...xs) + 40, Math.max(...ys) + 4] as [number, number] };
    };
    expect(overlaps(textBox("c1"), textBox("c2"))).toBe(false);
  });
});

describe("a sketch-driven pattern in the packet", () => {
  it("names its seeds, its instances, the skipped and the copies", () => {
    const sketch: Raw = { id: "pts", op: "sketch", entities: [[0, 0], [10, 0], [20, 0], [30, 0]].map((at, i) => ({ id: `p${i}`, type: "point", at })) };
    expect(holePatternMeasurements({ op: "sketchPattern", feature: "h", sketch: "pts", skip: [3] }, [sketch])).toEqual({
      seeds: ["h"],
      instances: 4,
      skipped: [3],
      copies: 2,
      at: "the points of pts",
    });
    expect(holePatternMeasurements({ op: "sketchPattern", features: ["a", "b"], sketch: "pts", positions: [[0, 0], [5, 5]], from: [9, 9] }, [sketch])).toEqual({
      seeds: ["a", "b"],
      instances: 3,
      copies: 2,
      at: "2 positions in the plane of pts",
    });
  });
});
