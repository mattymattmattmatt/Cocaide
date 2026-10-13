// Wave 7 review: kernel and document fixes, each from a reproduced finding.
// - a counterbore or countersink deeper than the wall of a through hole is refused
//   (it was checked against the reach past the part, and drilled its full diameter through);
// - draft on an extrude of an ellipse or spline;
// - a sweep path with a sharp corner next to a curve;
// - a pattern or mirror of an intersecting registry op says why there is nothing to repeat;
// - mass properties and centroids on spline bodies use the same integration as Measurements;
// - a thread depth on a hole drilled through is refused, not dropped;
// - an extrude naming no body that starts "main" over another body is refused.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { interpolate, splineArea } from "../src/geom/spline";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { massProperties } from "../src/kernel/evaluate";
import { centroidOf } from "../src/kernel/measure";
import { scoped } from "../src/kernel/oc";

type Raw = Record<string, unknown>;
const PI = Math.PI;
const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const FRONT = { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] };
const TOP_FACE = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const sketch = (id: string, plane: unknown, entities: Raw[]): Raw => ({ id, op: "sketch", plane, entities, constraints: [] });
const doc = (...features: Raw[]): RawDocument => ({ version: 1, units: "mm", name: "wave 7 review", features });
const errorsOf = (d: unknown) => allErrors(validateDocument(d));

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(d: unknown) {
  const r = rebuild(d, oc);
  try {
    return { errors: r.errors, volume: r.measurements?.volume ?? 0, holes: r.holes, bodies: (r.measurements?.bodies ?? []).map((b) => b.name) };
  } finally {
    r.dispose();
  }
}

/** An 80 x 40 plate `t` thick on Top, and features after it. */
const plate = (t: number, ...more: Raw[]) => doc(sketch("s1", TOP, [{ id: "r", type: "rect", center: [0, 0], w: 80, h: 40 }]), { id: "e1", op: "extrude", sketch: "s1", distance: t }, ...more);

describe("hole: a counterbore or countersink must stop inside the wall, through all too", () => {
  const hole = (f: Raw) => ({ id: "h1", op: "hole", face: TOP_FACE, center: [0, 0], ...f });

  it("refuses an M6 counterbore (6.5 deep) through a 6 mm plate, as up to next does", () => {
    expect(built(plate(6, hole({ size: "M6", kind: "counterbore", depth: "upToNext" }))).errors).toEqual(["h1: the counterbore reaches through the part"]);
    expect(built(plate(6, hole({ size: "M6", kind: "counterbore", depth: "through" }))).errors).toEqual(["h1: the counterbore reaches through the part"]);
  });

  it("refuses an M6 countersink (3.55 deep) through a 3 mm plate", () => {
    expect(built(plate(3, hole({ size: "M6", kind: "countersink", depth: "through" }))).errors).toEqual(["h1: the countersink reaches through the part"]);
  });

  it("still drills a counterbore that fits through a thicker plate", () => {
    const b = built(plate(10, hole({ size: "M6", kind: "counterbore", depth: "through" })));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(80 * 40 * 10 - PI * 5.5 ** 2 * 6.5 - PI * 3.3 ** 2 * 3.5, 4);
  });
});

describe("hole: a thread depth goes with a blind hole", () => {
  const tapped = (f: Raw) => plate(10, { id: "h1", op: "hole", face: TOP_FACE, center: [0, 0], size: "M6", kind: "tapped", ...f });

  it("refuses thread.depth on a hole drilled through or up to next", () => {
    expect(errorsOf(tapped({ depth: "through", thread: { depth: 4 } }))).toEqual([
      'h1: thread.depth: a thread depth goes with a blind hole; drilled "through", the hole is threaded all the way through: leave thread.depth out, or give the hole a depth',
    ]);
    expect(errorsOf(tapped({ depth: "upToNext", thread: { depth: 4 } }))).toHaveLength(1);
  });

  it("keeps a thread depth on a blind hole, and a through hole's thread runs through", () => {
    expect(errorsOf(tapped({ depth: 8, thread: { depth: 4 } }))).toEqual([]);
    expect(built(tapped({ depth: 8, thread: { depth: 4 } })).holes[0].thread?.depth).toBe(4);
    expect(built(tapped({ depth: "through", thread: { pitch: 0.75 } })).holes[0].thread?.depth).toBe("through");
  });
});

describe("extrude draft on ellipse and spline profiles", () => {
  const drafted = (entities: Raw[], angle: number) => built(doc(sketch("s1", TOP, entities), { id: "e1", op: "extrude", sketch: "s1", distance: 10, draft: { angle } }));
  const ELLIPSE = { id: "el", type: "ellipse", center: [0, 0], major: [10, 0], minor: 5 };
  const SPLINE = { id: "sp", type: "spline", points: [[0, 0], [20, 0], [20, 15], [0, 12]], closed: true };
  const HALF = [
    { id: "el", type: "ellipse", center: [0, 0], major: [10, 0], minor: 5, startAngle: 0, endAngle: 180 },
    { id: "l", type: "line", start: [-10, 0], end: [10, 0] },
  ];

  it("a circle drafts to a frustum (the reference case)", () => {
    const r = (x: number) => 5 - x * Math.tan((1 * PI) / 180);
    const b = drafted([{ id: "c", type: "circle", center: [0, 0], radius: 5 }], 1);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo((PI * 10 * (r(0) ** 2 + r(0) * r(10) + r(10) ** 2)) / 3, 4);
  });

  it("a whole ellipse drafts exactly: each section is the ellipse offset in by h·tan(angle)", () => {
    // An inward offset by t of a convex curve has area A - P·t + π·t² (P its perimeter).
    const [a, b, H] = [10, 5, 10];
    const n = 20000;
    let P = 0;
    for (let i = 0; i < n; i++) {
      const th = ((i + 0.5) / n) * 2 * PI;
      P += Math.hypot(a * Math.sin(th), b * Math.cos(th)) * ((2 * PI) / n);
    }
    for (const [angle, outward] of [[1, false], [3, false], [2, true]] as const) {
      const k = (outward ? -1 : 1) * Math.tan((angle * PI) / 180);
      const exact = PI * a * b * H - P * k * (H * H) / 2 + (PI * k * k * H ** 3) / 3;
      const r = built(doc(sketch("s1", TOP, [ELLIPSE]), { id: "e1", op: "extrude", sketch: "s1", distance: H, draft: { angle, ...(outward ? { outward } : {}) } }));
      expect(r.errors).toEqual([]);
      expect(r.volume).toBeCloseTo(exact, 3);
    }
  });

  it("a spline with a round hole: the hole widens as the sides draw in", () => {
    const entities = [SPLINE, { id: "c", type: "circle", center: [10, 6], radius: 2 }];
    const plain = built(doc(sketch("s1", TOP, entities), { id: "e1", op: "extrude", sketch: "s1", distance: 10 })).volume;
    const b = drafted(entities, 2);
    expect(b.errors).toEqual([]);
    // The outer loop alone loses more than the hole's growth gives back: less than the prism.
    expect(b.volume).toBeLessThan(plain);
    const hole = (r: number) => (PI * 10 * (r * r + r * (r + 10 * Math.tan((2 * PI) / 180)) + (r + 10 * Math.tan((2 * PI) / 180)) ** 2)) / 3;
    const outer = drafted([SPLINE], 2).volume;
    expect(b.volume).toBeCloseTo(outer - hole(2), 3);
  });

  for (const [name, entities] of [["a whole ellipse", [ELLIPSE]], ["a closed spline", [SPLINE]], ["half an ellipse and a line", HALF]] as const) {
    it(`${name}: drafted, or refused with what to do instead (never "try a smaller angle")`, () => {
      const plain = built(doc(sketch("s1", TOP, entities as Raw[]), { id: "e1", op: "extrude", sketch: "s1", distance: 10 })).volume;
      for (const angle of [0.5, 1, 3]) {
        const b = drafted(entities as Raw[], angle);
        if (b.errors.length === 0) {
          // Tapered inwards: less than the straight prism, more than nothing.
          expect(b.volume).toBeLessThan(plain);
          expect(b.volume).toBeGreaterThan(plain * 0.5);
        } else {
          expect(b.errors).toEqual(["e1: draft: a draft is not available on ellipse or spline sides; draw the profile with lines and arcs, or use a loft"]);
        }
      }
    });
  }
});

describe("sweep: a sharp corner next to a curve in the path", () => {
  const DISC = sketch("prof", TOP, [{ id: "c1", type: "circle", center: [0, 0], radius: 5 }]);
  const tube = (entities: Raw[]) => built(doc(sketch("path", FRONT, entities), DISC, { id: "sw", op: "sweep", circle: { diameter: 2 }, path: { sketch: "path" } }));
  const line = (id: string, start: number[], end: number[]) => ({ id, type: "line", start, end });
  const SPLINE = { id: "sp", type: "spline", points: [[0, 0], [5, 15], [-5, 30], [0, 45]] };
  const CORNER = ["sw: the path has a sharp corner next to a curve, which the profile cannot turn: round the corner with a sketch fillet"];
  const ELLIPSE_ARC = { id: "el", type: "ellipse", center: [20, 0], major: [40, 0], minor: 15, startAngle: 90, endAngle: 180 };

  it("two lines at a corner sweep (the reference case)", () => {
    expect(tube([line("a", [0, 0], [0, 30]), line("b", [0, 30], [20, 40])]).errors).toEqual([]);
  });

  it("the spline alone sweeps", () => {
    expect(tube([SPLINE]).errors).toEqual([]);
  });

  it("an arc meeting a line at a corner is refused with the fix, not a raw kernel error", () => {
    // A quarter arc R28 up from the origin, then a line off at a right angle.
    expect(tube([{ id: "a", type: "arc", center: [28, 0], start: [0, 0], end: [28, 28], clockwise: true }, line("b", [28, 28], [28, 50])]).errors).toEqual(CORNER);
  });

  it("a spline or part of an ellipse meeting a line at a corner sweeps with a mitred corner: the curve's tube plus the line's", () => {
    // A round tube mitred at a corner keeps π·r²·L: the mitre adds on one side what it takes off the other.
    const spline = tube([SPLINE]).volume;
    for (const b of [tube([SPLINE, line("b", [0, 45], [20, 50])]), tube([line("b", [20, -5], [0, 0]), SPLINE])]) {
      expect(b.errors).toEqual([]);
      expect(b.volume).toBeCloseTo(spline + PI * Math.hypot(20, 5), 2);
    }
    const quarter = tube([ELLIPSE_ARC]).volume;
    const withLine = tube([ELLIPSE_ARC, line("b", [20, 15], [40, 30])]);
    expect(withLine.errors).toEqual([]);
    expect(withLine.volume).toBeCloseTo(quarter + PI * 25, 2);
  });
});

describe("pattern or mirror of an intersecting revolve", () => {
  const block = sketch("s1", TOP, [{ id: "r", type: "rect", center: [0, 0], w: 100, h: 100 }]);
  const rvSketch = sketch("s2", FRONT, [
    { id: "r", type: "rect", center: [10, 10], w: 20, h: 40 },
    { id: "ax", type: "line", start: [0, -10], end: [0, 40], construction: true },
  ]);
  const base = [block, { id: "e1", op: "extrude", sketch: "s1", distance: 20 }, rvSketch, { id: "rv", op: "revolve", sketch: "s2", axis: { line: "ax" }, operation: "intersect" }];

  it("the revolve builds; a pattern or mirror of it says it keeps an overlap", () => {
    expect(built(doc(...base)).errors).toEqual([]);
    const p = doc(...base, { id: "p", op: "linearPattern", feature: "rv", direction: [1, 0, 0], spacing: 30, count: 2 });
    expect(errorsOf(p)).toEqual([]);
    expect(built(p).errors).toEqual(['p: "rv" is an intersecting revolve: it keeps an overlap and adds no tool to repeat; pattern the bodies instead']);
    const m = doc(...base, { id: "m", op: "mirror", feature: "rv", plane: { type: "datum", normal: [1, 0, 0], origin: [30, 0, 0] } });
    expect(built(m).errors).toEqual(['m: "rv" is an intersecting revolve: it keeps an overlap and adds no tool to mirror; mirror the bodies instead']);
  });
});

describe("mass properties of spline bodies", () => {
  const pts: [number, number][] = [[0, 0], [20, 0], [20, 15], [0, 12]];
  const exact = Math.abs(splineArea(interpolate(pts, true))) * 10;

  it("volume and centroid agree with Measurements (the adaptive integration)", () => {
    const r = rebuild(doc(sketch("s1", TOP, [{ id: "sp", type: "spline", points: pts, closed: true }]), { id: "e1", op: "extrude", sketch: "s1", distance: 10 }), oc);
    try {
      expect(r.errors).toEqual([]);
      expect(r.measurements!.volume).toBeCloseTo(exact, 6);
      const mass = massProperties(oc, r.bodies, undefined);
      expect(mass.bodies[0].volume).toBeCloseTo(exact, 6);
      const c = scoped((s) => centroidOf(oc, s, r.bodies[0].shape));
      expect(c[0]).toBeCloseTo(mass.bodies[0].centre[0], 9);
      expect(c[1]).toBeCloseTo(mass.bodies[0].centre[1], 9);
      expect(c[2]).toBeCloseTo(5, 9);
    } finally {
      r.dispose();
    }
  });
});

describe("an extrude naming no body after a part started by revolve", () => {
  const rv = [
    sketch("s1", TOP, [
      { id: "r", type: "rect", center: [10, 10], w: 20, h: 20 },
      { id: "ax", type: "line", start: [0, 0], end: [0, 30], construction: true },
    ]),
    { id: "rv", op: "revolve", sketch: "s1", axis: { line: "ax" } },
  ];
  const disc = (x: number) => sketch("s2", TOP, [{ id: "c", type: "circle", center: [x, 10], radius: 5 }]);

  it("refuses starting body \"main\" over body \"rv\", and says how to add to it", () => {
    const b = built(doc(...rv, disc(0), { id: "e1", op: "extrude", sketch: "s2", distance: 20 }));
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]).toMatch(/^e1: names no body, so it starts body "main", but that overlaps body "rv" \(by [\d.]+ mm³\): add to it with "body": "rv", or start a separate body with "newBody"$/);
  });

  it("adds to rv when named, and starts a separate body where it does not overlap", () => {
    expect(built(doc(...rv, disc(0), { id: "e1", op: "extrude", sketch: "s2", distance: 20, body: "rv" })).errors).toEqual([]);
    const apart = built(doc(...rv, disc(60), { id: "e1", op: "extrude", sketch: "s2", distance: 20 }));
    expect(apart.errors).toEqual([]);
    expect(apart.bodies).toEqual(["rv", "main"]);
  });
});
