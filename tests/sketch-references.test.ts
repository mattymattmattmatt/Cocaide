// Sketch references to the model (Phase O, DESIGN §2.4): reference entities
// projected from model edges, axes and points; the sketch axes X and Y; the
// solver holding references as constants; and the rebuild solving a sketch
// that is dimensioned to a model edge, so it follows the edge.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, dependants, resolveSketch, type RawDocument } from "../src/doc/commands";
import { constraintEntities, constraintTargets, expressionFields, isConstruction } from "../src/doc/sketch";
import type { Constraint, SketchEntity, Vec3 } from "../src/doc/types";
import { allErrors, selectorBodies, validateDocument } from "../src/doc/validate";
import { featureDatumRefs } from "../src/features/datum";
import { AXIS_LINES, withAxes } from "../src/geom/axes";
import { checkConstraints } from "../src/geom/constraints";
import { planeFrame } from "../src/geom/frame";
import { buildProfile } from "../src/geom/profile";
import { isFullCircle, projectAxis, projectEdge, withProjection, type EdgeGeometry } from "../src/geom/projection";
import { sketchDof, sketchStatus, solveSketch, wouldOverDefine } from "../src/geom/solver";
import { loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { LocalKernel } from "../src/ask/kernel";
import { buildPacket } from "../src/ask/packet";
import { REFERENCE } from "../src/mcp/reference";
import { describeFaces } from "../src/kernel/topology";

const PI = Math.PI;
const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
/** 80 x 40 x 6 plate on z = 0, centred; a 6.6 hole through at [30, 0]. Its sketch dimensions the width (constraint 0). */
const bracket = example("bracket");
const add = (doc: RawDocument, ...f: Record<string, unknown>[]): RawDocument => ({ ...doc, features: [...doc.features, ...f] });
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const SIDE = (n: Vec3) => ({ type: "planar", normal: n, pick: "largest" });
/** The top face's edge on the side facing n. */
const topEdge = (n: Vec3) => ({ type: "edge", between: [TOP, SIDE(n)], pick: "all" });
const onTop = { type: "ref", ref: { face: TOP } };
const XY = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const close = (a: number[], b: number[], digits = 6) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], digits));

// ------------------------------------------------------------------ projection

describe("projecting model edges into a sketch plane", () => {
  const top = planeFrame([0, 0, 1], [0, 0, 6]);
  const line = (start: Vec3, end: Vec3): EdgeGeometry => ({ kind: "line", start, end, mid: start.map((x, i) => (x + end[i]) / 2) as Vec3, length: Math.hypot(...start.map((x, i) => end[i] - x)), direction: [0, 0, 0] });
  /** A circle about `axis` through `center`, from angle 0 for `sweep` radians (start along `u`, a unit vector square to the axis). */
  const circle = (center: Vec3, r: number, axis: Vec3, u: Vec3, sweep = 2 * PI): EdgeGeometry => {
    const v: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
    const at = (t: number) => center.map((c, i) => c + r * (Math.cos(t) * u[i] + Math.sin(t) * v[i])) as Vec3;
    return { kind: "circle", start: at(0), end: at(sweep), mid: at(sweep / 2), length: r * sweep, radius: r, center, axis };
  };

  it("a straight edge in a tilted plane projects square onto the sketch: its drop along the normal is lost", () => {
    // From [10, 0, 0] up a 30° slope to [10 + 20 cos 30°, 0, 20 sin 30°]: seen from above, 20 cos 30° long.
    const c = Math.cos(PI / 6);
    const r = projectEdge(line([10, 0, 0], [10 + 20 * c, 0, 10]), top);
    expect(r.ok).toBe(true);
    if (!r.ok || r.shape.type !== "line") return;
    close(r.shape.start, [10, 0]);
    close(r.shape.end, [10 + 20 * c, 0]);
  });

  it("into a tilted sketch plane: the sketch's own x and y", () => {
    // A sketch on a plane through the origin tilted 45° about X: its y axis runs up the slope.
    const tilted = planeFrame([0, -Math.SQRT1_2, Math.SQRT1_2], [0, 0, 0]);
    const r = projectEdge(line([0, 0, 0], [0, 10, 10]), tilted);
    expect(r.ok && r.shape.type === "line").toBe(true);
    if (!r.ok || r.shape.type !== "line") return;
    close(r.shape.start, [0, 0]);
    close(r.shape.end, [0, 10 * Math.SQRT2]); // the edge lies in the plane: its full length
  });

  it("an edge square to the sketch projects to a point: refused, with what to do instead", () => {
    const r = projectEdge(line([5, 5, 0], [5, 5, 6]), top);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/square to the sketch plane, so it projects to a point; reference one of its ends with a point/) });
  });

  it("a circle facing the sketch: a circle about its projected centre", () => {
    const r = projectEdge(circle([30, 0, 0], 3.3, [0, 0, 1], [1, 0, 0]), top);
    expect(r).toEqual({ ok: true, shape: { type: "circle", center: [30, 0], radius: 3.3 } });
  });

  it("an arc facing the sketch: counter-clockwise about +Z, clockwise about -Z", () => {
    const ccw = projectEdge(circle([0, 0, 0], 5, [0, 0, 1], [1, 0, 0], PI / 2), top);
    expect(ccw.ok && ccw.shape).toMatchObject({ type: "arc", center: [0, 0] });
    if (!ccw.ok || ccw.shape.type !== "arc") return;
    close(ccw.shape.start, [5, 0]);
    close(ccw.shape.end, [0, 5]);
    expect(ccw.shape.clockwise).toBeUndefined();
    const cw = projectEdge(circle([0, 0, 0], 5, [0, 0, -1], [1, 0, 0], PI / 2), top);
    if (!cw.ok || cw.shape.type !== "arc") throw new Error("not an arc");
    close(cw.shape.end, [0, -5]);
    expect(cw.shape.clockwise).toBe(true);
  });

  it("a circle seen edge-on: a line across its diameter", () => {
    // A hole's rim in a side wall (axis +Y), seen from above.
    const r = projectEdge(circle([10, -20, 3], 2, [0, 1, 0], [1, 0, 0]), top);
    expect(r.ok && r.shape.type).toBe("line");
    if (!r.ok || r.shape.type !== "line") return;
    const xs = [r.shape.start[0], r.shape.end[0]].sort((a, b) => a - b);
    close(xs, [8, 12]);
    close([r.shape.start[1], r.shape.end[1]], [-20, -20]);
  });

  it("a half circle seen edge-on: the line spans only where the arc reaches", () => {
    // From +x round to -x over +z: seen from above it spans the whole diameter.
    const over = projectEdge(circle([0, 0, 0], 2, [0, -1, 0], [1, 0, 0], PI), top);
    if (!over.ok || over.shape.type !== "line") throw new Error("not a line");
    close([over.shape.start[0], over.shape.end[0]].sort((a, b) => a - b), [-2, 2]);
    // A quarter from +x to +z: from x = 0 to x = 2.
    const quarter = projectEdge(circle([0, 0, 0], 2, [0, -1, 0], [1, 0, 0], PI / 2), top);
    if (!quarter.ok || quarter.shape.type !== "line") throw new Error("not a line");
    close([quarter.shape.start[0], quarter.shape.end[0]].sort((a, b) => a - b), [0, 2]);
  });

  it("a tilted circle would be an ellipse: refused, saying what can be referenced", () => {
    const n = Math.SQRT1_2;
    const r = projectEdge(circle([0, 0, 0], 4, [n, 0, n], [n, 0, -n]), top);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/tilted to the sketch plane, so it would project to an ellipse; a sketch can reference straight edges, circular edges facing the sketch/) });
  });

  it("a freeform edge is refused the same way", () => {
    const r = projectEdge({ kind: "other", start: [0, 0, 0], end: [1, 1, 0], mid: [0.6, 0.4, 0], length: 1.6 }, top);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/freeform curve .* which a sketch can't reference; a sketch can reference straight edges/) });
  });

  it("an axis: a long segment through where it passes nearest the sketch origin; square to the sketch it is refused", () => {
    const r = projectAxis([5, 7, 3], [0, 1, 0], top, 100);
    expect(r.ok && r.shape).toEqual({ type: "line", start: [5, -100], end: [5, 100] });
    expect(projectAxis([0, 0, 0], [0, 0, 1], top, 100)).toEqual({ ok: false, error: expect.stringMatching(/square to the sketch plane/) });
  });

  it("the projection becomes the entity's numbers, if it is the right kind of entity", () => {
    const ref = { edge: { type: "edge" as const, pick: "all" as const } };
    const c = withProjection({ id: "c1", type: "circle", center: [0, 0], radius: 1, ref }, { type: "circle", center: [3, 4], radius: 2 }, '"c1"');
    expect(c).toEqual({ id: "c1", type: "circle", center: [3, 4], radius: 2, ref });
    const arc = withProjection({ id: "a1", type: "arc", center: [0, 0], start: [1, 0], end: [0, 1], clockwise: true, ref }, { type: "arc", center: [0, 0], start: [2, 0], end: [0, 2] }, '"a1"');
    expect(arc).toEqual({ id: "a1", type: "arc", center: [0, 0], start: [2, 0], end: [0, 2], ref });
    expect(withProjection({ id: "c1", type: "circle", center: [0, 0], radius: 1, ref }, { type: "arc", center: [0, 0], start: [2, 0], end: [0, 2] }, '"c1"')).toBe(
      '"c1" is a circle, but what it references projects to an arc (part of a circle); reference it with an arc',
    );
    expect(isFullCircle(circle([0, 0, 0], 1, [0, 0, 1], [1, 0, 0]))).toBe(true);
    expect(isFullCircle(circle([0, 0, 0], 1, [0, 0, 1], [1, 0, 0], PI))).toBe(false);
  });
});

// ------------------------------------------------------------------ document

describe("reference entities in the document", () => {
  const sketch = (entities: unknown[], constraints?: unknown[], plane: unknown = onTop) => ({ id: "sk", op: "sketch", plane, entities, ...(constraints ? { constraints } : {}) });
  const ok = (entities: unknown[], constraints?: unknown[]) => expect(errorsOf(add(bracket, sketch(entities, constraints)))).toEqual([]);
  const bad = (entities: unknown[], constraints?: unknown[]) => errorsOf(add(bracket, sketch(entities, constraints)));
  const L = (ref: unknown, extra: Record<string, unknown> = {}) => ({ id: "l1", type: "line", start: [40, -20], end: [40, 20], ref, ...extra });

  it("a line takes a straight edge or an axis; a circle and an arc a circular edge; a point a point of one, a point feature or the Origin", () => {
    ok([L({ edge: topEdge([1, 0, 0]) }), { id: "c1", type: "circle", center: [30, 0], radius: 3.3, ref: { edge: { type: "edge", kind: "circle", radius: 3.3, pick: "all" } } }]);
    ok([L({ datum: "Y" })]);
    ok([{ id: "a1", type: "arc", center: [0, 0], start: [1, 0], end: [0, 1], ref: { edge: { type: "edge", kind: "circle", pick: "all" } } }]);
    ok([{ id: "p1", type: "point", at: [40, 20], ref: { edge: topEdge([1, 0, 0]), at: "end" } }]);
    ok([{ id: "p1", type: "point", at: [30, 0], ref: { edge: { type: "edge", kind: "circle", radius: 3.3, pick: "all" } } }]); // a circle's centre
    ok([{ id: "p1", type: "point", at: [0, 0], ref: { datum: "Origin" } }]);
  });

  it("refuses references an entity can't be, saying what it can take", () => {
    expect(bad([L({ datum: "Top" })])).toEqual([
      'sk: entities[0] "l1" ref: a line references a straight edge ({ "edge": <selector> }) or an axis ({ "datum": "Z" } or an axis feature), not Top, a plane',
    ]);
    expect(bad([L({ edge: topEdge([1, 0, 0]), at: "start" })])[0]).toMatch(/a line references .*, not a point of an edge \("at": "start"\); use a point entity for that/);
    expect(bad([{ id: "c1", type: "circle", center: [0, 0], radius: 1, ref: { edge: { type: "edge", kind: "line", pick: "all" } } }])[0]).toMatch(/a circle references a whole circular edge .*, not a straight edge/);
    expect(bad([{ id: "c1", type: "circle", center: [0, 0], radius: 1, ref: { face: TOP } }])[0]).toMatch(/not a face \(pick one of its edges\)/);
    expect(bad([{ id: "p1", type: "point", at: [0, 0], ref: { edge: { type: "edge", kind: "line", pick: "all" } } }])[0]).toMatch(/a point references .*, not a straight edge without "at" \(say which point of it\)/);
    // A rect or a slot takes no ref: one message, saying what can (not a garbled "references undefined").
    expect(bad([{ id: "r1", type: "rect", center: [0, 0], w: 1, h: 1, ref: { datum: "X" } }])).toEqual([
      'sk: entities[0] "r1" ref: a rect can\'t reference the model (lines, circles, arcs and points can); remove ref, or reference the edges with lines (Convert Entities)',
    ]);
    expect(bad([L({ edge: { type: "edge", pick: "most" } })])[0]).toMatch(/l1" ref\.edge\.pick/);
  });

  it("a reference to a feature after the sketch, or one that isn't there, is refused", () => {
    const doc = add(bracket, sketch([L({ datum: "axis_1" })]), { id: "axis_1", op: "axis", mode: "twoPoints", refs: [{ point: [0, 0, 0] }, { point: [0, 0, 1] }] });
    expect(errorsOf(doc)).toEqual(['sk: entities[0] "l1" ref.datum: "axis_1" is not a feature before this one (the defaults are Top, Front, Right, Origin, X, Y, Z)']);
  });

  it("a reference is construction unless it says construction: false (a converted entity)", () => {
    expect(isConstruction({ ref: { datum: "X" } })).toBe(true);
    expect(isConstruction({ ref: { datum: "X" }, construction: false })).toBe(false);
    expect(isConstruction({})).toBe(false);
    // So only converted references make a profile.
    const ref = { datum: "X" };
    const square = (extra: Record<string, unknown>): SketchEntity[] => [
      { id: "l1", type: "line", start: [0, 0], end: [1, 0], ref, ...extra },
      { id: "l2", type: "line", start: [1, 0], end: [1, 1], ref, ...extra },
      { id: "l3", type: "line", start: [1, 1], end: [0, 1], ref, ...extra },
      { id: "l4", type: "line", start: [0, 1], end: [0, 0], ref, ...extra },
    ];
    expect(buildProfile(square({}))).toEqual({ ok: true, regions: [], area: 0 });
    expect(buildProfile(square({ construction: false }))).toMatchObject({ ok: true, area: 1 });
  });

  it("the sketch axes X and Y stand for lines wherever a line may be named", () => {
    const c1 = { id: "c1", type: "circle", center: [10, 5], radius: 2 };
    ok(
      [c1, { id: "l2", type: "line", start: [0, 0], end: [10, 10] }],
      [
        { type: "distance", point: "c1.center", line: "Y", value: 10 },
        { type: "angle", entities: ["l2", "X"], value: 45 },
        { type: "parallel", entities: ["Y", "l2"] },
        { type: "symmetric", points: ["l2.start", "l2.end"], line: "X" },
        { type: "pointOn", point: "c1.center", entity: "X" },
        { type: "tangent", entities: ["c1", "X"] },
        { type: "collinear", entities: ["l2", "Y"] },
        { type: "perpendicular", entities: ["X", "l2"] },
      ],
    );
  });

  it("but not where a sketch entity is needed, nor both at once; and no entity may be called X or Y", () => {
    const c1 = { id: "c1", type: "circle", center: [10, 5], radius: 2 };
    expect(bad([c1], [{ type: "distance", entity: "X", value: 3 }])[0]).toMatch(/entity "X" is the sketch's X axis; this constraint needs line or slot of the sketch/);
    expect(bad([c1], [{ type: "horizontal", entity: "Y" }])[0]).toMatch(/entity "Y" is the sketch's Y axis/);
    expect(bad([c1], [{ type: "equal", entities: ["X", "Y"] }])[0]).toMatch(/is the sketch's X axis/);
    expect(bad([c1], [{ type: "perpendicular", entities: ["X", "Y"] }])[0]).toMatch(/relates the sketch's two axes to each other/);
    expect(bad([c1], [{ type: "coincident", points: ["X.start", "c1.center"] }])[0]).toMatch(/point ref "X.start" must be "origin" or "<entity>.<point>"/);
    expect(bad([{ id: "X", type: "line", start: [0, 0], end: [1, 0] }])[0]).toMatch(/"X" names the sketch's X axis \(X and Y are taken\); give the entity another id/);
  });

  it("a reference entity can't be fixed: it follows the model already", () => {
    expect(bad([L({ datum: "Y" })], [{ type: "fix", entity: "l1" }])[0]).toMatch(/"l1" is a reference entity: it follows the model already/);
    expect(bad([L({ datum: "Y" })], [{ type: "fix", point: "l1.start" }])[0]).toMatch(/"l1.start" is a point of a reference entity/);
  });

  it("a weldment profile has no model to reference", () => {
    const profile = { name: "P", entities: [L({ datum: "Y" })], parameters: {}, sizes: [{ designation: "P1", values: {} }], anchor: "origin", tags: [] };
    const v = validateDocument({ ...bracket, profiles: { P: profile } });
    expect(v.headerErrors[0]).toMatch(/a weldment profile is drawn on its own, with no model to reference; remove ref/);
  });

  it("references are the feature's references: a plane, axis or point feature it names can't be deleted or renamed, and body renames reach its selectors", () => {
    const doc = add(
      bracket,
      { id: "axis_1", op: "axis", mode: "twoPoints", refs: [{ point: [0, 0, 0] }, { point: [0, 1, 0] }] },
      sketch([L({ datum: "axis_1" }), { id: "c1", type: "circle", center: [30, 0], radius: 3.3, ref: { edge: { type: "edge", kind: "circle", radius: 3.3, pick: "all", body: "main" } } }]),
    );
    expect(errorsOf(doc)).toEqual([]);
    expect(featureDatumRefs(doc.features[4]).map((r) => r.path)).toEqual(["plane.ref", "entities[0].ref", "entities[1].ref"]);
    expect(dependants(doc.features, "axis_1")).toEqual(["sk"]);
    const del = apply(doc, { type: "deleteFeature", id: "axis_1" });
    expect(del).toEqual({ ok: false, error: "deleteFeature: axis_1 is used by sk; delete or change it first" });
    // The selector names the body: it joins the body checks, and follows a rename.
    expect(selectorBodies(validateDocument(doc).features[4].feature!)).toContainEqual(["entities[1].ref.edge.body", "main"]);
    const renamed = apply(doc, { type: "renameBody", from: "main", to: "plate" });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    const sk = renamed.doc.features.find((f) => f.id === "sk") as { entities: { ref: { edge: { body: string } } }[] };
    expect(sk.entities[1].ref.edge.body).toBe("plate");
  });

  it("the axes are no entities: constraintEntities leaves them out, constraintTargets keeps them", () => {
    const k: Constraint = { type: "distance", point: "c1.center", line: "X", value: 3 };
    expect(constraintEntities(k)).toEqual(["c1"]);
    expect(constraintTargets(k)).toEqual(["c1", "X"]);
  });

  it("expressionFields lists the entity numbers written as expressions", () => {
    expect(expressionFields([{ id: "c1", type: "circle", center: ["=a", 2], radius: "=b / 2" }, { id: "l1", start: [0, 0] }])).toEqual(["c1.center.0", "c1.radius"]);
  });

  it("editing a sketch in the document solves it with its references where they were last projected", () => {
    const doc = add(bracket, sketch([L({ edge: topEdge([1, 0, 0]) }), { id: "c1", type: "circle", center: [30, 0], radius: 3 }], [{ type: "distance", point: "c1.center", line: "l1", value: 10 }]));
    const r = apply(doc, { type: "setDimension", sketch: "sk", index: 0, value: 15 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sk = r.doc.features.find((f) => f.id === "sk") as { entities: SketchEntity[] };
    expect(sk.entities[0]).toEqual(L({ edge: topEdge([1, 0, 0]) })); // the reference did not move
    expect((sk.entities[1] as { center: number[] }).center[0]).toBeCloseTo(25, 9);
  });
});

// ------------------------------------------------------------------ solver

describe("the solver holds references and the axes as constants", () => {
  const ref = { edge: { type: "edge" as const, pick: "all" as const } };
  const edge: SketchEntity = { id: "e1", type: "line", start: [40, -20], end: [40, 20], ref };
  const c1: SketchEntity = { id: "c1", type: "circle", center: [25, 3], radius: 3 };

  it("a reference counts no degrees of freedom, and never moves", () => {
    expect(sketchDof([edge], [])).toBe(0);
    expect(sketchDof([edge, c1], [])).toBe(3);
    const ks: Constraint[] = [
      { type: "distance", point: "c1.center", line: "e1", value: 10 },
      { type: "distance", point: "c1.center", line: "X", value: 0 },
      { type: "diameter", entity: "c1", value: 6 },
    ];
    const r = solveSketch([edge, c1], ks);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entities[0]).toEqual(edge);
    close((r.entities[1] as { center: number[] }).center, [30, 0], 9);
    expect(r.dof).toBe(0);
    // Nothing is left free: the sketch is fully defined, references included.
    const st = sketchStatus(r.entities, ks);
    expect(st.dof).toBe(0);
    expect([...st.free]).toEqual([]);
  });

  it("the circle follows the reference when it moves", () => {
    const ks: Constraint[] = [
      { type: "distance", point: "c1.center", line: "e1", value: 10 },
      { type: "distance", point: "c1.center", line: "X", value: 0 },
    ];
    const moved: SketchEntity = { ...edge, start: [50, -20], end: [50, 20] } as SketchEntity;
    const r = solveSketch([moved, { ...c1, center: [30, 0] } as SketchEntity], ks);
    expect(r.ok && (r.entities[1] as { center: number[] }).center.map((x) => Math.round(x * 1e9) / 1e9)).toEqual([40, 0]);
  });

  it("a relation between references only gives no equation (the model holds it), and adds nothing", () => {
    const other: SketchEntity = { id: "e2", type: "line", start: [40, 20], end: [-40, 20], ref };
    const corner: Constraint = { type: "coincident", points: ["e1.end", "e2.start"] };
    expect(solveSketch([edge, other], [corner]).ok).toBe(true);
    expect(wouldOverDefine([edge, other, c1], [], corner)).toBe(true);
    // Off by a model tolerance, it still solves; the check measures it as it is.
    const off: SketchEntity = { ...other, start: [40, 20 + 5e-7] } as SketchEntity;
    expect(solveSketch([edge, off], [corner]).ok).toBe(true);
  });

  it("dragging a reference is refused; dragging what is tied to it is not", () => {
    expect(solveSketch([edge, c1], [], { drag: [{ handle: "e1.start", to: [0, 0] }] })).toEqual({ ok: false, error: '"e1" is a reference to the model: it moves when the model does, and can\'t be dragged' });
    const r = solveSketch([edge, c1], [{ type: "distance", point: "c1.center", line: "e1", value: 15 }], { drag: [{ handle: "c1.center", to: [25, 10] }] });
    expect(r.ok && (r.entities[1] as { center: number[] }).center.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([25, 10]);
  });

  it("the axes: a point dimensioned from X and Y, a line at an angle to X; checks see them too", () => {
    const p: SketchEntity = { id: "p1", type: "point", at: [3, 4] };
    const l: SketchEntity = { id: "l1", type: "line", start: [0, 0], end: [5, 1] };
    const ks: Constraint[] = [
      { type: "distance", point: "p1.at", line: "Y", value: 12 },
      { type: "distance", point: "p1.at", line: "X", value: 7 },
      { type: "angle", entities: ["X", "l1"], value: 30 },
    ];
    const r = solveSketch([p, l], ks);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entities.map((e) => e.id)).toEqual(["p1", "l1"]); // the axes never come back as entities
    close((r.entities[0] as { at: number[] }).at, [12, 7], 9);
    const u = r.entities[1] as { start: number[]; end: number[] };
    expect((Math.atan2(u.end[1] - u.start[1], u.end[0] - u.start[0]) * 180) / PI).toBeCloseTo(30, 6);
    expect(checkConstraints(r.entities, ks)).toEqual([]);
    expect(checkConstraints([p, l], ks)).toHaveLength(3);
    // A point on the X axis loses one freedom; the axes themselves have none.
    expect(sketchDof([p], [{ type: "pointOn", point: "p1.at", entity: "X" }])).toBe(1);
    expect(withAxes([p]).map((e) => e.id)).toEqual(["p1", "X", "Y"]);
    expect(AXIS_LINES.Y.end).toEqual([0, 1]);
  });

  it("a sketch that changes nothing solves to itself", () => {
    const r = resolveSketch({ id: "s", op: "sketch", plane: XY, entities: [edge, c1], constraints: [] }, {});
    expect(r).toEqual({ ok: true, feature: { id: "s", op: "sketch", plane: XY, entities: [edge, c1], constraints: [] } });
  });
});

// ------------------------------------------------------------------ rebuild

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    const cylinders = r.solid
      ? scoped((s) => describeFaces(oc, s, r.solid!).infos.flatMap((f) => (f.type === "cylinder" && f.cylinder ? [{ radius: f.cylinder.radius, origin: f.cylinder.origin }] : [])))
      : [];
    return { ok: r.ok, errors: r.errors, volume: r.measurements?.volume ?? 0, sketches: r.sketches, cylinders, features: r.features };
  } finally {
    r.dispose();
  }
}

describe("the rebuild projects references and solves the sketch around them", () => {
  /** On the top face: the right-hand edge as a reference, a Ø6 circle 10 mm in from it on the X axis, cut through. */
  const holeFromEdge = add(
    bracket,
    {
      id: "sk_hole",
      op: "sketch",
      plane: onTop,
      entities: [
        { id: "l1", type: "line", start: [40, -20], end: [40, 20], ref: { edge: topEdge([1, 0, 0]) } },
        { id: "c1", type: "circle", center: [30, 0], radius: 3 },
      ],
      constraints: [
        { type: "distance", point: "c1.center", line: "l1", value: 10 },
        { type: "distance", point: "c1.center", line: "X", value: 0 },
        { type: "diameter", entity: "c1", value: 6 },
      ],
    },
    { id: "cut_1", op: "cut", sketch: "sk_hole", extent: "throughAll", direction: [0, 0, -1] },
  );
  // The plate without its own hole, so the only hole is the one cut from the sketch.
  const plate = { ...holeFromEdge, features: holeFromEdge.features.filter((f) => f.id !== "hole_1") };
  const holeX = (b: ReturnType<typeof built>) => b.cylinders.filter((c) => Math.abs(c.radius - 3) < 1e-9).map((c) => Math.round(c.origin[0] * 1e6) / 1e6);
  const vol = (w: number) => w * 40 * 6 - PI * 9 * 6;

  it("a circle 10 mm from a model edge: the hole is cut 10 mm in from the edge", () => {
    const b = built(plate);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(vol(80), 6);
    expect(holeX(b)).toEqual([30]);
    // The overlay carries the solved entities, the reference marked; the reference is construction (dashed).
    const sk = b.sketches.find((s) => s.id === "sk_hole")!;
    expect(sk.entities.map((e) => e.id)).toEqual(["l1", "c1"]);
    expect(sk.polylines.filter((p) => p.reference).every((p) => p.construction)).toBe(true);
    expect(sk.polylines.some((p) => p.reference)).toBe(true);
  });

  it("make the plate 100 wide: the edge moves 10 mm, and the circle and the hole cut from it follow", () => {
    const r = apply(plate, { type: "setDimension", sketch: "sketch_1", index: 0, value: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = built(r.doc);
    expect(b.errors).toEqual([]);
    expect(holeX(b)).toEqual([40]);
    expect(b.volume).toBeCloseTo(vol(100), 6);
    const sk = b.sketches.find((s) => s.id === "sk_hole")!;
    const [l1, c1] = sk.entities as unknown as [{ start: number[]; end: number[] }, { center: number[] }];
    expect([l1.start[0], l1.end[0]].map((x) => Math.round(x * 1e9) / 1e9)).toEqual([50, 50]);
    close(c1.center, [40, 0], 9);
    // The document still holds what it was given: the rebuild is what follows the model.
    expect((r.doc.features.find((f) => f.id === "sk_hole") as { entities: { center?: number[] }[] }).entities[1].center).toEqual([30, 0]);
  });

  it("an axis and the Origin as references: a point 15 from the Y axis's projection and 17 from the Origin", () => {
    const doc = add(bracket, {
      id: "sk",
      op: "sketch",
      plane: onTop,
      entities: [
        { id: "ax", type: "line", start: [0, -1], end: [0, 1], ref: { datum: "Y" } },
        { id: "o", type: "point", at: [9, 9], ref: { datum: "Origin" } },
        { id: "p1", type: "point", at: [10, 3] },
      ],
      constraints: [
        { type: "distance", point: "p1.at", line: "ax", value: 15 },
        { type: "distance", points: ["o.at", "p1.at"], value: 17 },
      ],
    });
    const b = built(doc);
    expect(b.errors).toEqual([]);
    const sk = b.sketches.find((s) => s.id === "sk")!;
    const [ax, o, p1] = sk.entities as unknown as [{ start: number[]; end: number[] }, { at: number[] }, { at: number[] }];
    expect(ax.start[0]).toBeCloseTo(0, 9);
    expect(Math.abs(ax.end[1] - ax.start[1])).toBeGreaterThan(100); // long enough to cross the part
    close(o.at, [0, 0], 9);
    close(p1.at, [15, 8], 7); // 15² + 8² = 17²
    // Point entities are drawn in the 3D overlay too: at the face, z = 6.
    close(sk.points.map((p) => p.at[2]), [6, 6, 6], 9);
    expect(sk.points.map((p) => !!p.reference)).toEqual([true, false]);
  });

  it("a reference that no longer finds its edge fails the sketch, naming the entity and what to re-pick", () => {
    const doc = add(bracket, {
      id: "sk",
      op: "sketch",
      plane: onTop,
      entities: [{ id: "l1", type: "line", start: [40, -20], end: [40, 20], ref: { edge: { type: "edge", kind: "line", length: 999, pick: "all" } } }],
    });
    const b = built(doc);
    expect(b.errors).toEqual([
      'sk: entities[0].ref.edge: selector matched 0 edges (wanted line edges length 999). The sketch\'s reference "l1" (a model edge) no longer finds what it projects: open the sketch and re-pick it, or delete "l1"',
    ]);
  });

  it("a reference before any solid, or to a tilted circle, fails with what can be referenced", () => {
    const first = {
      version: 1,
      units: "mm",
      name: "empty",
      features: [{ id: "sk", op: "sketch", plane: XY, entities: [{ id: "l1", type: "line", start: [0, 0], end: [1, 0], ref: { edge: topEdge([1, 0, 0]) } }] }],
    };
    expect(built(first).errors[0]).toMatch(/^sk: entities\[0\]\.ref\.edge: there is no solid before this sketch to take an edge from\. The sketch's reference "l1"/);
    // The bracket's hole rim seen from a plane tilted 45° about X.
    const tilted = add(bracket, {
      id: "sk",
      op: "sketch",
      plane: { type: "datum", normal: [0, -Math.SQRT1_2, Math.SQRT1_2], origin: [0, 0, 0] },
      entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 1, ref: { edge: { type: "edge", kind: "circle", radius: 3.3, onFace: TOP, pick: "all" } } }],
    });
    expect(built(tilted).errors[0]).toMatch(/^sk: entities\[0\]\.ref: the circular edge \(radius 3\.3\) is tilted to the sketch plane, so it would project to an ellipse/);
  });

  it("relations that can't hold with the references where they are now fail the sketch, saying so", () => {
    // The circle tied 10 from the right edge and 10 from the left: fine at width 20 only.
    const doc = add(bracket, {
      id: "sk",
      op: "sketch",
      plane: onTop,
      entities: [
        { id: "l1", type: "line", start: [40, -20], end: [40, 20], ref: { edge: topEdge([1, 0, 0]) } },
        { id: "l2", type: "line", start: [-40, -20], end: [-40, 20], ref: { edge: topEdge([-1, 0, 0]) } },
        { id: "p1", type: "point", at: [30, 0] },
      ],
      constraints: [
        { type: "distance", point: "p1.at", line: "l1", value: 10 },
        { type: "distance", point: "p1.at", line: "l2", value: 10 },
      ],
    });
    expect(built(doc).errors[0]).toMatch(/^sk: its relations and dimensions can't all hold with its references where the model puts them now/);
  });

  it("converted edges of a face, joined where they meet, extrude to the face's outline: the top face's loops, hole and all", () => {
    const sides: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
    ];
    // Stored numbers are stale on purpose (a plate 1 x 1): the rebuild projects the edges where they are.
    const lines = sides.map((n, i) => ({ id: `l${i + 1}`, type: "line", start: [0, 0], end: [1, i], ref: { edge: topEdge(n) }, construction: false }));
    const rim = { id: "c1", type: "circle", center: [0, 0], radius: 1, ref: { edge: { type: "edge", kind: "circle", radius: 3.3, onFace: TOP, pick: "all" } }, construction: false };
    const doc = add(bracket, { id: "sk", op: "sketch", plane: onTop, entities: [...lines, rim] }, { id: "up", op: "extrude", sketch: "sk", distance: 10 });
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo((80 * 40 - PI * 3.3 ** 2) * 16, 4);
  });
});

describe("the AI sees references as references", () => {
  const doc = add(bracket, {
    id: "sk",
    op: "sketch",
    plane: onTop,
    entities: [
      { id: "l1", type: "line", start: [40, -20], end: [40, 20], ref: { edge: topEdge([1, 0, 0]) } },
      { id: "c1", type: "circle", center: [30, 0], radius: 3 },
    ],
    constraints: [{ type: "distance", point: "c1.center", line: "l1", value: 10 }],
  });

  it("the sketch's packet lists its references, what each references, and the axes", async () => {
    const p = await buildPacket(doc, { kind: "feature", id: "sk" }, new LocalKernel(() => oc));
    const m = p.measurements as { references: Record<string, unknown>[]; axes: string };
    expect(m.references).toEqual([
      expect.objectContaining({ entity: "l1", type: "line", construction: true, references: expect.stringMatching(/^the model edge \(edges between the planar face normal \+Z.* and the planar face normal \+X/) }),
    ]);
    expect(m.axes).toMatch(/"X" and "Y"/);
  });

  it("an entity's packet says it is a reference that follows the model", async () => {
    const p = await buildPacket(doc, { kind: "entity", sketch: "sk", entity: "l1" }, new LocalKernel(() => oc));
    expect((p as unknown as { reference: { follows: string } }).reference.follows).toMatch(/^the model: projected again on every rebuild/);
    expect((p.parent as { entities: string }).entities).toMatch(/^l1 line \(reference to the model edge .*\), c1 circle$/);
  });

  it("when the model has moved, the packets say where the rebuild put the sketch, not only the numbers written", async () => {
    // The plate 100 wide: the edge is at x = 50 now, so the circle 10 from it is at x = 40; the document still says 30.
    const r = apply(doc, { type: "setDimension", sketch: "sketch_1", index: 0, value: 100 });
    if (!r.ok) throw new Error(r.error);
    const kernel = new LocalKernel(() => oc);
    const p = await buildPacket(r.doc, { kind: "feature", id: "sk" }, kernel);
    const now = (p.measurements as { now: { note: string; entities: { id: string; center?: number[]; start?: number[] }[] } }).now;
    expect(now.note).toMatch(/^the model has moved since these numbers were written/);
    expect(now.entities.map((e) => e.id)).toEqual(["l1", "c1"]);
    expect(now.entities[0].start).toEqual([50, -20]);
    expect(now.entities[1].center).toEqual([40, 0]);
    const e = await buildPacket(r.doc, { kind: "entity", sketch: "sk", entity: "c1" }, kernel);
    expect(e.measurements).toEqual({ radius: 3, diameter: 6, center: [40, 0] });
    // Where nothing has moved, there is nothing to say.
    const same = await buildPacket(doc, { kind: "feature", id: "sk" }, kernel);
    expect((same.measurements as { now?: unknown }).now).toBeUndefined();
  });

  it("the reference documents references, the axes and a worked example", () => {
    expect(REFERENCE).toContain('"X" and "Y"');
    expect(REFERENCE).toContain("follows the model");
    expect(REFERENCE).toContain('"ref": { "edge":');
    expect(REFERENCE).toContain('"construction": false');
  });

  it("the worked example builds as written: the hole 12 in from the right-hand edge, and it follows the edge", () => {
    const text = REFERENCE.slice(REFERENCE.indexOf("Worked example: a hole 12 mm"));
    const sketch = JSON.parse(text.slice(text.indexOf('{ "id": "sk_hole"'), text.indexOf('{ "id": "cut_1"')).trim());
    const cut = JSON.parse(text.slice(text.indexOf('{ "id": "cut_1"'), text.indexOf("}\n", text.indexOf('{ "id": "cut_1"')) + 1));
    const doc = add(bracket, sketch, cut);
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.cylinders.filter((c) => Math.abs(c.radius - 3) < 1e-9).map((c) => Math.round(c.origin[0] * 1e6) / 1e6)).toEqual([28]);
    expect(sketchDof(b.sketches.find((s) => s.id === "sk_hole")!.entities, sketch.constraints)).toBe(0);
    const wider = apply(doc, { type: "setDimension", sketch: "sketch_1", index: 0, value: 100 });
    expect(wider.ok).toBe(true);
    if (!wider.ok) return;
    expect(built(wider.doc).cylinders.filter((c) => Math.abs(c.radius - 3) < 1e-9).map((c) => Math.round(c.origin[0] * 1e6) / 1e6)).toEqual([38]);
  });
});
