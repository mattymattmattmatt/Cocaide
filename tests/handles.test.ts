// Drag handles for every feature (Phase P wave 2): where each sits for its
// value, and the value a drag to a place gives back (value ↔ position round
// trips through the same ray maths the view uses), on real parts rebuilt in
// node: a box, a revolve about Z, a fillet and a chamfer on the box's edge, a
// shell, a draft, the bracket's hole, its linear and circular patterns.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { Vec3 } from "../src/doc/types";
import { add3, dot3, len3, scale3, sub3 } from "../src/geom/vec";
import { loadOC, rebuild, scoped, tessellate, type OC } from "../src/kernel";
import { describeEdges, describeFaces } from "../src/kernel/topology";
import { arcPoints, beginDrag, dragValue, featureHandles, handlePatch, handleText, handleTip, moveDrag, sketchAnchor, type HandleSpec } from "../src/ui/evaluate/handles";
import type { RebuildView } from "../src/worker/protocol";
import { example } from "./ui-fixtures";

type Raw = Record<string, unknown>;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

/** The view the worker sends, with its mesh. */
function fullView(doc: RawDocument): RebuildView {
  const r = rebuild(doc, oc);
  try {
    const topo = r.solid
      ? scoped((s) => {
          const f = describeFaces(oc, s, r.solid!);
          return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
        })
      : { faces: [], edges: [] };
    return { ok: r.ok, name: r.name, errors: r.errors, features: r.features, sketches: r.sketches, measurements: r.measurements, mesh: r.solid ? tessellate(oc, r.solid) : null, faces: topo.faces, edges: topo.edges, bodies: r.bodies.map(({ name, faces, edges }) => ({ name, faces, edges })), datums: r.datums };
  } finally {
    r.dispose();
  }
}

const box = (...features: Raw[]): RawDocument => ({
  version: 1,
  units: "mm",
  name: "box",
  features: [
    { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 20 }], constraints: [] },
    { id: "ext_1", op: "extrude", sketch: "s1", distance: 10 },
    ...features,
  ],
});

/** A ray through `p` from the side (square to `along`): what the pointer's ray is over a point on an arrow. */
function sideRay(p: Vec3, along: Vec3): [Vec3, Vec3] {
  const side: Vec3 = Math.abs(along[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const perp = sub3(side, scale3(along, dot3(side, along)));
  return [add3(p, scale3(perp, 100 / len3(perp))), scale3(perp, -1 / len3(perp))];
}

/** A ray straight down an axis through `p` (an arc seen face on, a face seen square). */
const downRay = (p: Vec3, axis: Vec3): [Vec3, Vec3] => [add3(p, scale3(axis, 100)), scale3(axis, -1)];

/** Grabs the handle where it is and drags it to where `value` puts it: the value the drag reads there. */
function roundTrip(h: HandleSpec, value: number | [number, number]): number | [number, number] | null {
  const ray = (p: Vec3) => (h.kind === "angle" ? downRay(p, h.axis!) : h.kind === "point" ? downRay(p, h.frame!.z) : sideRay(p, h.dir));
  const g = beginDrag(h, ...ray(handleTip(h)))!;
  expect(g).not.toBeNull();
  // An arc is dragged round in small steps (so it can pass ±180°), as a hand would.
  if (h.kind === "angle" && typeof value === "number") {
    let v: ReturnType<typeof moveDrag> = null;
    const n = 24;
    for (let i = 1; i <= n; i++) v = moveDrag(g, ...ray(handleTip(h, h.value + ((value - h.value) * i) / n)));
    return v as number;
  }
  return moveDrag(g, ...ray(handleTip(h, value)));
}

const byKey = (hs: HandleSpec[], key: string) => hs.find((h) => h.key === key)!;
const near = (a: Vec3, b: Vec3, d = 6) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], d));

describe("extrude", () => {
  it("stands its depth arrow off the origin's axes, inside the profile; the drag reads the depth back", () => {
    const view = fullView(box());
    const anchor = sketchAnchor(view, "s1")!;
    expect(Math.hypot(anchor.at[0], anchor.at[1])).toBeGreaterThan(1);
    expect(Math.abs(anchor.at[0])).toBeLessThan(20);
    expect(Math.abs(anchor.at[1])).toBeLessThan(10);
    const doc = box();
    const hs = featureHandles(doc.features[1], doc.features[1], view);
    const depth = byKey(hs, "distance");
    expect(handleTip(depth)[2]).toBeCloseTo(10, 9);
    expect(roundTrip(depth, 17)).toBe(17);
    expect(handlePatch(depth, doc.features[1], 17)).toEqual({ distance: 17 });
    // Reverse: a flip button whose patch turns the direction round.
    const flip = hs.find((h) => h.kind === "flip")!;
    expect(handlePatch(flip, doc.features[1], 0)).toEqual({ direction: [0, 0, -1] });
  });

  it("a draft is an arc at the profile's side: straight up at 0, leaning in as it grows; the drag reads the angle", () => {
    const doc = box();
    const f = { ...doc.features[1], draft: { angle: 3 } };
    const view = fullView(box());
    const h = byKey(featureHandles(f, f, view), "draft.angle");
    expect(h.kind).toBe("angle");
    // At 0 the ball is straight up the wall from the profile's side; at 10° it leans in (toward the profile's middle).
    const up = handleTip(h, 0);
    expect(up[2]).toBeCloseTo(h.radius!, 6);
    const leant = handleTip(h, 10);
    expect(Math.abs(leant[0])).toBeLessThan(Math.abs(up[0]));
    expect(roundTrip(h, 7)).toBe(7);
    expect(handleText(h, 7)).toBe("7°");
    expect(handlePatch(h, f, 7)).toEqual({ draft: { angle: 7 } });
  });
});

describe("revolve", () => {
  it("an arc about the axis through the profile: 360 is a full turn, written as no angle at all", () => {
    const doc: RawDocument = {
      version: 1,
      units: "mm",
      name: "ring",
      features: [
        { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [20, 5], w: 6, h: 10 }], constraints: [] },
        { id: "rev", op: "revolve", sketch: "s1", axis: { datum: "Z" }, angle: 90 },
      ],
    };
    const view = fullView(doc);
    const h = byKey(featureHandles(doc.features[1], doc.features[1], view), "angle");
    expect(h.kind).toBe("angle");
    expect(h.radius).toBeGreaterThan(15);
    // At 0 the ball is on the profile; a quarter turn about +Z takes +X to +Y.
    const at0 = handleTip(h, 0);
    const at90 = handleTip(h, 90);
    expect(Math.atan2(at0[1], at0[0])).toBeCloseTo(0, 6);
    expect(Math.atan2(at90[1], at90[0])).toBeCloseTo(Math.PI / 2, 6);
    expect(roundTrip(h, 270)).toBe(270);
    expect(handlePatch(h, doc.features[1], 360)).toEqual({ angle: null });
    expect(handlePatch(h, doc.features[1], 180)).toEqual({ angle: 180 });
    expect(arcPoints(h, 90, 4)).toHaveLength(5);
  });
});

describe("fillet and chamfer", () => {
  const edge = { type: "edge", kind: "line", direction: [1, 0, 0], length: 40, onFace: { type: "planar", normal: [0, 0, 1], pick: "largest" }, pick: "all" };

  it("a fillet's radius arrow runs from an edge into a face beside it: its tip is where the round meets that face", () => {
    const view = fullView(box());
    const f = { id: "fillet_1", op: "fillet", edges: edge, radius: 2 };
    const h = byKey(featureHandles(f, f, view), "radius");
    // From the middle of a long top edge (y = ±10, z = 10), into the top (toward y = 0) or down the side.
    const tip = handleTip(h);
    expect(Math.abs(h.origin[1])).toBeCloseTo(10, 6);
    expect(h.origin[2]).toBeCloseTo(10, 6);
    expect(len3(sub3(tip, h.origin))).toBeCloseTo(2, 9);
    expect(roundTrip(h, 4)).toBe(4);
    expect(handlePatch(h, f, 4)).toEqual({ radius: 4 });
  });

  it("a variable fillet has its start radius near the edge's start and its end radius near its end", () => {
    const view = fullView(box());
    const f = { id: "fillet_1", op: "fillet", edges: edge, radius: 1, radius2: 3 };
    const hs = featureHandles(f, f, view);
    const r1 = byKey(hs, "radius");
    const r2 = byKey(hs, "radius2");
    expect(Math.abs(r1.origin[0] - r2.origin[0])).toBeCloseTo(40 * 0.7, 6);
    expect(len3(sub3(handleTip(r2), r2.origin))).toBeCloseTo(3, 9);
  });

  it("a chamfer of two distances has an arrow on each face; distance–angle, an arc", () => {
    const view = fullView(box());
    const two = { id: "ch", op: "chamfer", edges: edge, distance: 1, distance2: 2 };
    const hs = featureHandles(two, two, view);
    expect(dot3(byKey(hs, "distance").dir, byKey(hs, "distance2").dir)).toBeCloseTo(0, 6);
    expect(roundTrip(byKey(hs, "distance2"), 3)).toBe(3);
    const angled = { id: "ch", op: "chamfer", edges: edge, distance: 2, angle: 30 };
    const a = byKey(featureHandles(angled, angled, view), "angle");
    expect(a.kind).toBe("angle");
    expect(roundTrip(a, 45)).toBe(45);
  });
});

describe("shell and draft", () => {
  it("a shell's wall arrow goes in from the face it removes; outward walls, out", () => {
    const view = fullView(box());
    const f = { id: "sh", op: "shell", faces: [{ type: "planar", normal: [0, 0, 1], pick: "largest" }], thickness: 2 };
    const h = byKey(featureHandles(f, f, view), "thickness");
    near(h.dir, [0, 0, -1]);
    expect(handleTip(h)[2]).toBeCloseTo(8, 6);
    expect(roundTrip(h, 3)).toBe(3);
    const out = byKey(featureHandles({ ...f, outward: true }, f, view), "thickness");
    near(out.dir, [0, 0, 1]);
  });

  it("a draft's angle is an arc on the first face drafted, about the line where it meets the neutral plane", () => {
    const view = fullView(box());
    const f = { id: "dr", op: "draft", faces: [{ type: "planar", normal: [1, 0, 0], pick: "largest" }], neutral: { datum: "Top" }, angle: 2 };
    const h = byKey(featureHandles(f, f, view), "angle");
    expect(h.kind).toBe("angle");
    near(h.zero!, [0, 0, 1]);
    // Leaning in: the ball moves toward −X (into the part) as the angle grows.
    expect(handleTip(h, 10)[0]).toBeLessThan(handleTip(h, 0)[0]);
    expect(roundTrip(h, 5)).toBe(5);
  });
});

describe("hole", () => {
  it("its centre is a point on its face, dragged in the face's plane (whole millimetres), writing the centre; its depth an arrow into the part", () => {
    const doc = example("bracket");
    const view = fullView(doc);
    const hole = { ...doc.features[2], depth: 4 };
    const hs = featureHandles(hole, hole, view);
    const c = hs.find((h) => h.kind === "point")!;
    near(handleTip(c), [30, 0, 6]);
    expect(roundTrip(c, [12, -5])).toEqual([12, -5]);
    expect(handlePatch(c, hole, [12, -5])).toEqual({ center: [12, -5], centers: null });
    const depth = byKey(hs, "depth");
    near(depth.dir, [0, 0, -1]);
    expect(roundTrip(depth, 3)).toBe(3);
    // Several centres: one point each, writing its own.
    const two = { ...hole, center: undefined, centers: [[30, 0], [-30, 0]] };
    const points = featureHandles(two, two, view).filter((h) => h.kind === "point");
    expect(points).toHaveLength(2);
    expect(handlePatch(points[1], two, [-20, 5])).toEqual({ centers: [[30, 0], [-20, 5]], center: null });
  });

  it("a centre given by an expression is locked, and says why", () => {
    const doc = example("bracket");
    const view = fullView(doc);
    const resolved = doc.features[2];
    const c = featureHandles(resolved, { ...resolved, center: ["=x", 0] }, view).find((h) => h.kind === "point")!;
    expect(c.locked).toMatch(/expression =x/);
  });
});

describe("patterns", () => {
  it("a linear pattern's spacing is the second copy; its count's knob sits past the last and moves a copy per spacing", () => {
    const doc = example("bracket");
    const view = fullView(doc);
    const p = { id: "pattern_1", op: "linearPattern", feature: "hole_1", direction: [0, 1, 0], spacing: 8, count: 3 };
    const hs = featureHandles(p, p, view, doc.features);
    const spacing = byKey(hs, "spacing");
    near(handleTip(spacing), [30, 8, 6]);
    expect(roundTrip(spacing, 12)).toBe(12);
    const count = byKey(hs, "count");
    // Past the last copy (at 2 spacings): 2.4 spacings out.
    near(handleTip(count), [30, 8 * 2.4, 6]);
    expect(roundTrip(count, 5)).toBe(5);
    expect(dragValue(count, 3, -100)).toBe(2);
    expect(handlePatch(count, p, 5)).toEqual({ count: 5 });
    expect(handleText(count, 5)).toBe("5");
  });

  it("a circular pattern's spacing is the angle to the second copy, its count past the last; spacing that closes the turn is a full turn", () => {
    const doc = example("bracket");
    const view = fullView(doc);
    const p = { id: "circular_1", op: "circularPattern", feature: "hole_1", axis: { ref: { datum: "Z" } }, count: 4 };
    const hs = featureHandles(p, p, view, doc.features);
    const spacing = byKey(hs, "angle");
    expect(spacing.value).toBe(90);
    near(handleTip(spacing), [0, 30, 6]);
    expect(roundTrip(spacing, 60)).toBe(60);
    expect(handlePatch(spacing, p, 60)).toEqual({ angle: 180 });
    expect(handlePatch(spacing, p, 90)).toEqual({ angle: null });
    const count = hs.find((h) => h.key === "count")!;
    expect(roundTrip(count, 6)).toBe(6);
  });
});

describe("plane", () => {
  it("an offset plane's arrow reads its distance back", () => {
    const doc = box({ id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 15 });
    const view = fullView(doc);
    const h = byKey(featureHandles(doc.features[2], doc.features[2], view), "distance");
    expect(handleTip(h)[2]).toBeCloseTo(15, 9);
    expect(roundTrip(h, 22)).toBe(22);
  });
});

describe("snapping", () => {
  it("follows the steps in Settings (a length step of 5, an angle step of 5°), Shift a tenth of them", () => {
    const view = fullView(box());
    const doc = box();
    const depth = byKey(featureHandles(doc.features[1], doc.features[1], view), "distance");
    expect(dragValue(depth, 10, 3.2, false, { length: 5, angle: 5 })).toBe(15);
    expect(dragValue(depth, 10, 3.2, true, { length: 5, angle: 5 })).toBe(13);
    const f = { ...doc.features[1], draft: { angle: 3 } };
    const draft = byKey(featureHandles(f, f, view), "draft.angle");
    expect(dragValue(draft, 3, 8, false, { length: 1, angle: 5 })).toBe(10);
    expect(dragValue(draft, 3, 80)).toBe(45);
  });
});
