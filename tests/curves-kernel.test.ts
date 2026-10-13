// Ellipses and splines in the kernel: the edges are the curves the sketch
// shows, so extrudes and revolves of them have the volumes worked out here
// from the exact 2D areas (Pappus for a revolve).

import { beforeAll, describe, expect, it } from "vitest";
import type { CocaideDocument, Feature, SketchEntity, Vec2 } from "../src/doc/types";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { buildProfile } from "../src/geom/profile";
import { interpolate, splineArea } from "../src/geom/spline";
import type { RawDocument } from "../src/doc/commands";
import { LocalKernel } from "../src/ask/kernel";
import { buildPacket } from "../src/ask/packet";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const sketch = (entities: SketchEntity[], id = "s1"): Feature =>
  ({ id, op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities }) as Feature;

function build(features: Feature[]) {
  const doc: CocaideDocument = { version: 1, units: "mm", name: "curves", features } as CocaideDocument;
  const r = rebuild(doc, oc);
  const out = { errors: r.errors, volume: r.measurements?.volume ?? 0 };
  r.dispose();
  return out;
}

const extrude = (h: number): Feature => ({ id: "e1", op: "extrude", sketch: "s1", distance: h }) as Feature;

describe("ellipse solids", () => {
  it("extrudes a whole ellipse to πabh", () => {
    const r = build([sketch([{ id: "el1", type: "ellipse", center: [5, 5], major: [35, 5], minor: 20 }]), extrude(10)]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(Math.PI * 30 * 20 * 10, 6);
  });

  it("extrudes a tilted ellipse whose drawn minor radius is the longer one", () => {
    const r = build([sketch([{ id: "el1", type: "ellipse", center: [0, 0], major: [6, 8], minor: 25 }]), extrude(4)]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(Math.PI * 10 * 25 * 4, 6);
  });

  it("extrudes half an ellipse closed by its major axis", () => {
    const r = build([
      sketch([
        { id: "el1", type: "ellipse", center: [0, 0], major: [30, 0], minor: 20, startAngle: 0, endAngle: 180 },
        { id: "l1", type: "line", start: [-30, 0], end: [30, 0] },
      ]),
      extrude(5),
    ]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo((Math.PI * 30 * 20 * 5) / 2, 6);
  });

  it("cuts an elliptical hole through a plate", () => {
    const plate = sketch([{ id: "r1", type: "rect", center: [0, 0], w: 100, h: 80 }]);
    const hole = sketch([{ id: "el1", type: "ellipse", center: [0, 0], major: [0, 25], minor: 10 }], "s2");
    const r = build([plate, extrude(8), hole, { id: "c1", op: "cut", sketch: "s2", extent: "throughAll" } as Feature]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo((100 * 80 - Math.PI * 25 * 10) * 8, 5);
  });

  it("revolves a half ellipse about its major axis into a spheroid: 4/3·π·a·b²", () => {
    const r = build([
      sketch([
        { id: "el1", type: "ellipse", center: [0, 0], major: [30, 0], minor: 12, startAngle: 0, endAngle: 180 },
        { id: "ax", type: "line", start: [-30, 0], end: [30, 0] },
      ]),
      { id: "rv", op: "revolve", sketch: "s1", axis: { line: "ax" } } as Feature,
    ]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo((4 / 3) * Math.PI * 30 * 12 * 12, 3);
  });
});

describe("spline solids", () => {
  const pts: Vec2[] = [[0, 0], [30, -5], [40, 20], [10, 30], [-8, 12]];

  it("extrudes a closed spline to its exact area times the height", () => {
    const area = Math.abs(splineArea(interpolate(pts, true)));
    const r = build([sketch([{ id: "sp1", type: "spline", points: pts, closed: true }]), extrude(6)]);
    expect(r.errors).toEqual([]);
    expect(r.volume / (area * 6)).toBeCloseTo(1, 7);
  });

  it("extrudes an open spline closed by lines (its ends clamped to tangents)", () => {
    const entities: SketchEntity[] = [
      { id: "sp1", type: "spline", points: [[0, 0], [10, 8], [25, 5], [40, 12]], endTangent: -30 },
      { id: "b1", type: "line", start: [40, 12], end: [40, -10] },
      { id: "b2", type: "line", start: [40, -10], end: [0, -10] },
      { id: "b3", type: "line", start: [0, -10], end: [0, 0] },
    ];
    const p = buildProfile(entities);
    if (!p.ok) throw new Error(p.error);
    const r = build([sketch(entities), extrude(3)]);
    expect(r.errors).toEqual([]);
    expect(r.volume / (p.area * 3)).toBeCloseTo(1, 7);
  });

  it("revolves a spline profile about a line (Pappus: area × 2π × centroid distance)", () => {
    const entities: SketchEntity[] = [
      { id: "sp1", type: "spline", points: [[10, 0], [18, 10], [12, 25], [10, 40]] },
      { id: "l1", type: "line", start: [10, 40], end: [0, 40] },
      { id: "ax", type: "line", start: [0, 40], end: [0, 0] },
      { id: "l2", type: "line", start: [0, 0], end: [10, 0] },
    ];
    const r = build([sketch(entities), { id: "rv", op: "revolve", sketch: "s1", axis: { line: "ax" } } as Feature]);
    expect(r.errors).toEqual([]);
    // ∫ π x² dy along the outline: integrate the spline numerically (dense) for the expected volume.
    const c = interpolate([[10, 0], [18, 10], [12, 25], [10, 40]]);
    let v = 0;
    for (const [p0, p1, p2, p3] of c.spans) {
      const n = 4000;
      for (let k = 0; k < n; k++) {
        const at = (u: number): Vec2 => {
          const w = 1 - u;
          return [0, 1].map((i) => w * w * w * p0[i] + 3 * w * w * u * p1[i] + 3 * w * u * u * p2[i] + u * u * u * p3[i]) as Vec2;
        };
        const a = at(k / n);
        const b = at((k + 1) / n);
        const x = (a[0] + b[0]) / 2;
        v += Math.PI * x * x * (b[1] - a[1]);
      }
    }
    expect(r.volume / v).toBeCloseTo(1, 5);
  });
});

describe("the AI's packets", () => {
  const doc = {
    version: 1,
    units: "mm",
    name: "curves",
    features: [
      {
        id: "s1",
        op: "sketch",
        plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
        entities: [
          { id: "el1", type: "ellipse", center: [0, 0], major: [0, 30], minor: 15 },
          { id: "sp1", type: "spline", points: [[50, 0], [80, -10], [100, 10], [80, 30], [55, 25]], closed: true },
          { id: "sp2", type: "spline", points: [[-60, 0], [-50, 10], [-40, 0]] },
        ],
      },
    ],
  } as unknown as RawDocument;

  it("measure an ellipse: radii, tilt, length round and area", async () => {
    const p = await buildPacket(doc, { kind: "entity", sketch: "s1", entity: "el1" }, new LocalKernel(() => oc));
    expect(p.measurements).toMatchObject({ majorRadius: 30, minorRadius: 15, majorAxisAngleDeg: 90, center: [0, 0], minorEnd: [-15, 0], area: 1413.716694 });
    // Ramanujan: π(a + b)(1 + 3h/(10 + √(4 − 3h))), h = ((a − b)/(a + b))².
    const h = (15 / 45) ** 2;
    expect((p.measurements as { length: number }).length).toBeCloseTo(Math.PI * 45 * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))), 3);
  });

  it("measure a spline: its points, length, and an open one's end directions or a closed one's area", async () => {
    const closed = await buildPacket(doc, { kind: "entity", sketch: "s1", entity: "sp1" }, new LocalKernel(() => oc));
    const pts: Vec2[] = [[50, 0], [80, -10], [100, 10], [80, 30], [55, 25]];
    expect(closed.measurements).toMatchObject({ points: 5, closed: true });
    expect((closed.measurements as { area: number }).area).toBeCloseTo(Math.abs(splineArea(interpolate(pts, true))), 5);
    const open = await buildPacket(doc, { kind: "entity", sketch: "s1", entity: "sp2" }, new LocalKernel(() => oc));
    // Symmetric about x = −50: it leaves rising and arrives falling at the same angle.
    const m = open.measurements as { startTangentDeg: number; endTangentDeg: number };
    expect(m.startTangentDeg).toBeGreaterThan(0);
    expect(m.endTangentDeg).toBeCloseTo(-m.startTangentDeg, 6);
  });
});
