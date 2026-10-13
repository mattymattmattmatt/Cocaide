// The ellipse and spline sketch tools (Phase O wave 6): what the clicks build,
// the relations that hold an ellipse's axes, a spline closed on its first
// point, hit testing and handles, the dimensions drawn beside them, and the
// edit tools that don't take them saying so.

import { describe, expect, it } from "vitest";
import type { Constraint, EllipseEntity, SketchEntity, SplineEntity, Vec2 } from "../src/doc/types";
import { checkConstraints } from "../src/geom/constraints";
import { buildProfile } from "../src/geom/profile";
import { offsetEntities } from "../src/geom/sketchEdit/offset";
import { extendAt, splitAt, trimAt } from "../src/geom/sketchEdit/trim";
import { sketchStatus, solveSketch } from "../src/geom/solver";
import { dimensionShapes } from "../src/ui/sketcher/annotate";
import { distanceTo, handlesOf, inferPoint, smartDimension } from "../src/ui/sketcher/draft";
import { minorThrough, splineFrom } from "../src/ui/sketcher/tools/curves";
import { place, toolByName } from "../src/ui/sketcher/tools/run";
import type { Click } from "../src/ui/sketcher/tools/types";

const at = (...pts: Vec2[]): Click[] => pts.map((p) => ({ p, ref: null }));
const draw = (name: string, clicks: Click[], options = {}, trail?: Vec2[]) => {
  const made = place(toolByName(name)!, clicks, options, { entities: [], trail });
  if (!made) throw new Error(`${name} made nothing`);
  return made;
};

describe("Ellipse tool", () => {
  it("takes the minor radius from the third click: x²/a² + y²/b² = 1 through it", () => {
    // a = 30; the point (18, 12): 1 − (18/30)² = 0.64, so b = 12 / 0.8 = 15.
    expect(minorThrough([0, 0], [30, 0], [18, 12])).toBeCloseTo(15, 12);
    // Tilted by 90°: the same in its own frame.
    expect(minorThrough([0, 0], [0, 30], [-12, 18])).toBeCloseTo(15, 12);
  });

  it("builds the ellipse with its construction axes held to it, adding no freedom", () => {
    const made = draw("ellipse", at([0, 0], [30, 0], [0, 15]));
    const e = made.entities[0] as EllipseEntity;
    expect(e).toEqual({ id: "el1", type: "ellipse", center: [0, 0], major: [30, 0], minor: 15 });
    const axes = made.entities.slice(1);
    expect(axes.map((l) => l.type === "line" && l.construction)).toEqual([true, true]);
    expect(checkConstraints(made.entities, made.relations)).toEqual([]);
    // An ellipse alone has 5 (centre 2, major end 2, minor 1); its axes are bound to it.
    expect(sketchStatus(made.entities, made.relations).dof).toBe(5);
    expect(buildProfile(made.entities)).toMatchObject({ ok: true, area: expect.closeTo(Math.PI * 30 * 15, 9) });
    // Axes off: the ellipse alone.
    expect(draw("ellipse", at([0, 0], [30, 0], [0, 15]), { axes: "off" }).entities).toHaveLength(1);
  });

  it("builds a partial ellipse the way it was swept", () => {
    // a = 30; the start (18, 12) sets b = 15 and is at 53.130102°; the end (−18, 12) at 126.869898°.
    const t0 = (Math.atan2(0.8, 0.6) * 180) / Math.PI;
    const ccw = draw("ellipse-arc", at([0, 0], [30, 0], [18, 12], [-18, 12]), { axes: "off" }, [[10, 14.5], [0, 15], [-10, 14.5]]).entities[0] as EllipseEntity;
    expect(ccw.minor).toBeCloseTo(15, 9);
    expect(ccw.startAngle).toBeCloseTo(t0, 5);
    expect(ccw.endAngle).toBeCloseTo(180 - t0, 5);
    // Swept the other way (down through the lower half): stored counter-clockwise from the end to the start.
    const cw = draw("ellipse-arc", at([0, 0], [30, 0], [18, 12], [-18, 12]), { axes: "off" }, [[25, -8], [0, -15], [-30, 0]]).entities[0] as EllipseEntity;
    expect(cw.startAngle).toBeCloseTo(180 - t0, 5);
    expect(cw.endAngle).toBeCloseTo(t0, 5);
    // A partial ellipse is open: on its own it makes no profile, and says where.
    expect(buildProfile([ccw])).toMatchObject({ ok: false, error: expect.stringContaining("open") });
  });
});

describe("Spline tool", () => {
  it("takes every click as a point; a repeated click finishes, a last one on the first point closes", () => {
    expect(splineFrom(at([0, 0], [10, 5], [10, 5], [20, 0]), "sp1")).toEqual({ id: "sp1", type: "spline", points: [[0, 0], [10, 5], [20, 0]] });
    expect(splineFrom(at([0, 0], [20, 0], [20, 20], [0, 20], [0, 0]), "sp1")).toEqual({ id: "sp1", type: "spline", points: [[0, 0], [20, 0], [20, 20], [0, 20]], closed: true });
    // Back on the first after only one other point is no loop.
    expect(splineFrom(at([0, 0], [20, 0], [0, 0]), "sp1")?.closed).toBeUndefined();
    expect(splineFrom(at([0, 0]), "sp1")).toBeNull();
  });

  it("puts each click's snap on the point it made", () => {
    const made = place(toolByName("spline")!, [{ p: [0, 0], ref: "origin" }, ...at([10, 5], [20, 0])], {}, { entities: [] })!;
    expect(made.inferred).toContainEqual({ type: "coincident", points: ["sp1.p0", "origin"] });
  });
});

describe("in the sketcher", () => {
  const E: EllipseEntity = { id: "el1", type: "ellipse", center: [0, 0], major: [30, 0], minor: 15, startAngle: 0, endAngle: 180 };
  const S: SplineEntity = { id: "sp1", type: "spline", points: [[0, 0], [10, 8], [25, 5], [40, 12]] };

  it("has a handle at every named point", () => {
    expect(handlesOf(E).map((h) => h.ref)).toEqual(["el1.center", "el1.major", "el1.minorEnd", "el1.start", "el1.end"]);
    expect(handlesOf(S).map((h) => [h.ref, h.point])).toEqual([["sp1.p0", [0, 0]], ["sp1.p1", [10, 8]], ["sp1.p2", [25, 5]], ["sp1.p3", [40, 12]]]);
  });

  it("hits the curve itself (an arc only along its part), and snaps a point onto it", () => {
    expect(distanceTo(E, [0, 16])).toBeCloseTo(1, 9);
    // Below: the lower half is not drawn, so the nearer end counts.
    expect(distanceTo(E, [0, -15])).toBeCloseTo(Math.hypot(30, 15), 9);
    expect(distanceTo(S, [10, 8])).toBeLessThan(1e-9);
    const snap = inferPoint([{ ...E, startAngle: undefined, endAngle: undefined }], [10, 14.5], 1);
    expect(snap?.on).toEqual({ type: "pointOn", entity: "el1" });
    expect(Math.hypot(snap!.p[0] / 30, snap!.p[1] / 15)).toBeCloseTo(1, 9);
  });

  it("offers its two radii to Smart Dimension, the one clicked nearer first", () => {
    const whole: EllipseEntity = { id: "el1", type: "ellipse", center: [0, 0], major: [30, 0], minor: 15 };
    const offers = smartDimension([whole], [{ kind: "entity", id: "el1" }], [1, 15]);
    expect(offers[0].testId).toBe("c-minor-radius");
    expect(offers[0].make(15)).toEqual({ type: "distance", points: ["el1.center", "el1.minorEnd"], value: 15 });
    expect(smartDimension([whole], [{ kind: "entity", id: "el1" }], [29, 1])[0].testId).toBe("c-major-radius");
  });

  it("draws dimensions to a spline's points (its points field is a list, not a point)", () => {
    const k: Constraint = { type: "distance", points: ["sp1.p0", "sp1.p3"], value: Math.hypot(40, 12) };
    const shapes = dimensionShapes([S], [k], 1);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].text).toContain("41.761");
  });

  it("drags a minor end: the minor radius follows, the centre and major radius stay", () => {
    const whole: EllipseEntity = { id: "el1", type: "ellipse", center: [0, 0], major: [30, 0], minor: 15 };
    const r = solveSketch([whole], [{ type: "horizontal", entity: "el1" }], { drag: [{ handle: "el1.minorEnd", from: [0, 15], to: [0, 20] }] });
    expect(r.ok).toBe(true);
    const e = (r as { entities: SketchEntity[] }).entities[0] as EllipseEntity;
    expect(e.center[0]).toBeCloseTo(0, 6);
    expect(e.major[0]).toBeCloseTo(30, 6);
    expect(e.minor).toBeCloseTo(20, 4);
  });
});

describe("edit tools that don't take curves say so", () => {
  const state = {
    entities: [
      { id: "el1", type: "ellipse", center: [0, 0], major: [30, 0], minor: 15 },
      { id: "sp1", type: "spline", points: [[0, 0], [10, 8], [25, 5]] },
      { id: "l1", type: "line", start: [-40, 0], end: [40, 0] },
    ] as SketchEntity[],
    constraints: [],
  };
  it("trim, extend and split", () => {
    expect(trimAt(state, "el1", [0, 15])).toMatch(/^el1 is an ellipse: it can't be trimmed/);
    expect(extendAt(state, "sp1", [25, 5])).toMatch(/^sp1 is a spline: it can't be extended/);
    expect(splitAt(state, "sp1", [10, 8])).toMatch(/^sp1 is a spline: it can't be split/);
  });
  it("offset", () => {
    expect(offsetEntities(state, ["el1"], { distance: 2, side: 1 })).toMatch(/el1 is an ellipse: offset takes lines, arcs and circles/);
  });
});
