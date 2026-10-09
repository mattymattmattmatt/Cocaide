// Reference geometry, DatumRef (Phase O, DESIGN §2.1): one way to say "this
// plane, axis or point" everywhere. The document checks what it can (a
// default axis where a plane is needed, an id that is no reference feature);
// the kernel resolves the rest on the part as it stands, and says so plainly
// when a reference is the wrong kind.

import { readFileSync } from "node:fs";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { DatumRef, Vec3 } from "../src/doc/types";
import { allErrors, Checker, validateDatumRef, validateDocument, type ValidationResult } from "../src/doc/validate";
import {
  datumFeatureIds,
  datumPlaneDatum,
  datumRefsAt,
  datumSelectors,
  DEFAULT_DATUMS,
  facePlane,
  featureDatumRefs,
  frameAsDatumPlane,
  possibleKinds,
  refPlaneFrame,
  RESERVED_DATUMS,
  xDirProblem,
  type Datum,
  type PlaneDatum,
} from "../src/features/datum";
import { planeFrame } from "../src/geom/frame";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { resolveDatum, type DatumContext } from "../src/kernel/datum";

const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket"); // 80 x 40 x 6 plate on z = 0, centred; a 6.6 hole through at [30, 0]
const add = (doc: RawDocument, ...f: Record<string, unknown>[]): RawDocument => ({ ...doc, features: [...doc.features, ...f] });
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const FRONT = { type: "planar", normal: [0, -1, 0], pick: "largest" };
const sketchOn = (ref: unknown, extra: Record<string, unknown> = {}) => ({ id: "sk", op: "sketch", plane: { type: "ref", ref, ...extra }, entities: [] });
const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

describe("the default planes, axes and origin", () => {
  it("Top is XY (+Z), Front XZ (-Y), Right YZ (+X), each with the x axis the datum-plane rule gives it", () => {
    for (const name of ["Top", "Front", "Right"]) {
      const p = DEFAULT_DATUMS[name] as PlaneDatum;
      const rule = planeFrame(p.normal, p.origin);
      expect(p.xDir).toEqual(rule.x.map((x) => x + 0));
    }
    expect(DEFAULT_DATUMS.Top).toEqual({ kind: "plane", origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] });
    // Seen from the front, x runs right and y up (+Z); from the right, x runs along +Y and y up.
    close(planeFrame([0, -1, 0], [0, 0, 0]).y, [0, 0, 1]);
    close(planeFrame([1, 0, 0], [0, 0, 0]).y, [0, 0, 1]);
    expect(DEFAULT_DATUMS.Origin).toEqual({ kind: "point", at: [0, 0, 0] });
    expect(DEFAULT_DATUMS.Z).toEqual({ kind: "axis", origin: [0, 0, 0], direction: [0, 0, 1] });
    expect(RESERVED_DATUMS).toEqual(["Top", "Front", "Right", "Origin", "X", "Y", "Z"]);
  });

  it("their names are not feature ids", () => {
    expect(errorsOf(add(bracket, { id: "Top", op: "scale", factor: 2 }))).toEqual([
      'Top: id: "Top" names a default plane, axis or the origin (Top, Front, Right, Origin, X, Y, Z); give the feature another id',
    ]);
    expect(errorsOf(add(bracket, { id: "X", op: "scale", factor: 2 }))[0]).toMatch(/^X: id: "X" names a default plane/);
  });
});

describe("what the document checks", () => {
  const check = (v: unknown, want?: Parameters<typeof validateDatumRef>[4], earlier = new Map([["ext_1", "extrude"], ["plane_1", "plane"], ["axis_1", "axis"]])) => {
    const c = new Checker("f");
    const ref = validateDatumRef(v, "axis", c, earlier, want);
    return { ref, errors: c.errors };
  };

  it("accepts each form, and keeps exactly what was written", () => {
    expect(check({ datum: "Top" }, "plane")).toEqual({ ref: { datum: "Top" }, errors: [] });
    expect(check({ datum: "plane_1" }, "plane")).toEqual({ ref: { datum: "plane_1" }, errors: [] });
    expect(check({ face: TOP }, ["plane", "axis"]).ref).toEqual({ face: TOP });
    expect(check({ edge: { type: "edge", kind: "circle", pick: "all" }, at: "center" }, "point").ref).toEqual({ edge: { type: "edge", kind: "circle", pick: "all" }, at: "center" });
    expect(check({ point: [1, 2, 3] }).ref).toEqual({ point: [1, 2, 3] });
  });

  it("refuses what cannot be the kind the field needs: Top is a plane, but an axis is needed here", () => {
    expect(check({ datum: "Top" }, "axis").errors).toEqual(["f: axis: Top is a plane, but an axis is needed here"]);
    expect(check({ datum: "X" }, "plane").errors).toEqual(["f: axis: X is an axis, but a plane is needed here"]);
    expect(check({ datum: "plane_1" }, ["axis", "point"]).errors).toEqual(["f: axis: plane_1 is a plane, but an axis or a point is needed here"]);
    expect(check({ point: [0, 0, 0] }, "plane").errors).toEqual(["f: axis: the point [0,0,0] is a point, but a plane is needed here"]);
    expect(check({ face: TOP }, "point").errors).toEqual(["f: axis: a face is a plane or an axis, but a point is needed here"]);
    expect(check({ edge: { type: "edge", pick: "longest" } }, "plane").errors).toEqual(["f: axis: an edge is an axis or a point, but a plane is needed here"]);
    expect(check({ edge: { type: "edge", pick: "longest" }, at: "mid" }, "axis").errors).toEqual(["f: axis: the middle of an edge is a point, but an axis is needed here"]);
  });

  it("refuses ids that are not an earlier plane, axis or point feature", () => {
    expect(check({ datum: "ext_1" }).errors).toEqual(['f: axis.datum: "ext_1" is an extrude, not a plane, axis or point']);
    expect(check({ datum: "plane_9" }).errors).toEqual(['f: axis.datum: "plane_9" is not a feature before this one (the defaults are Top, Front, Right, Origin, X, Y, Z)']);
    expect(check({ datum: "" }).errors).toEqual(['f: axis.datum: must name a default (Top, Front, Right, Origin, X, Y, Z) or an earlier plane, axis or point (got "")']);
    expect(check({ datum: "toString" }).errors).toEqual(['f: axis.datum: "toString" is not a feature before this one (the defaults are Top, Front, Right, Origin, X, Y, Z)']);
  });

  it("checks selectors with the selector rules, and the rest of the shape strictly", () => {
    expect(check({ face: { type: "planar", normal: [0, 0, 1] } }).errors).toEqual(['f: axis.face.pick: must be one of "largest", "smallest", "all" (got nothing)']);
    expect(check({ edge: { type: "edge", pick: "all" }, at: "top" }).errors).toEqual(['f: axis.at: must be "start", "end", "mid", "center" (got "top")']);
    expect(check({ datum: "Top", at: "start" }).errors).toEqual(['f: axis: unknown field "at" (allowed: datum)']);
    expect(check({ datum: "Top", face: TOP }).errors).toEqual(["f: axis: give one of datum, face, edge or point (got datum and face)"]);
    expect(check({}).errors).toEqual(["f: axis: needs one of datum, face, edge or point (got {})"]);
    expect(check("Top").errors).toEqual(['f: axis: must be a reference: { "datum": "Top" }, { "face": <face selector> }, { "edge": <edge selector> } or { "point": [x, y, z] } (got "Top")']);
    expect(check({ point: [0, 0] }).errors).toEqual(["f: axis.point: must be an array of 3 numbers (got [0,0])"]);
  });

  it("a reference to a later feature is a forward reference, refused", () => {
    const doc = add(bracket, sketchOn({ datum: "s2" }), { id: "s2", op: "scale", factor: 2 });
    expect(errorsOf(doc)).toEqual(['sk: plane.ref.datum: "s2" is not a feature before this one (the defaults are Top, Front, Right, Origin, X, Y, Z)']);
  });
});

describe("pure helpers", () => {
  it("what a reference can be, before the model is known", () => {
    const earlier = new Map([["p", "plane"], ["e", "extrude"]]);
    expect(possibleKinds({ datum: "Right" })).toEqual(["plane"]);
    expect(possibleKinds({ datum: "p" }, earlier)).toEqual(["plane"]);
    expect(possibleKinds({ datum: "e" }, earlier)).toEqual([]);
    expect(possibleKinds({ face: TOP as never })).toEqual(["plane", "axis"]);
    expect(possibleKinds({ edge: { type: "edge", pick: "all" } })).toEqual(["axis", "point"]);
    expect(possibleKinds({ edge: { type: "edge", pick: "all" }, at: "end" })).toEqual(["point"]);
    expect(possibleKinds({ point: [0, 0, 0] })).toEqual(["point"]);
  });

  it("a face's plane: the global origin projected onto it, the outward normal, x by the datum-plane rule", () => {
    expect(facePlane([0, 0, 1], [5, 5, 6])).toEqual({ kind: "plane", origin: [0, 0, 6], normal: [0, 0, 1], xDir: [1, 0, 0] });
    const side = facePlane([1, 0, 0], [40, 3, 2]);
    close(side.origin, [40, 0, 0]);
    close(side.xDir, [0, 1, 0]);
    // An inclined face: origin = n (n . p) for a unit n.
    const n: Vec3 = [0, Math.SQRT1_2, Math.SQRT1_2];
    close(facePlane([0, 1, 1], [0, 0, 10]).origin, [0, 5, 5]);
    close(facePlane([0, 1, 1], [0, 0, 10]).normal, n);
  });

  it("a reference plane's frame: offset along the normal, flipped, or x along xDir", () => {
    const top = DEFAULT_DATUMS.Top as PlaneDatum;
    expect(refPlaneFrame(top)).toEqual(planeFrame([0, 0, 1], [0, 0, 0]));
    close(refPlaneFrame(top, { offset: 10 }).origin, [0, 0, 10]);
    const flipped = refPlaneFrame(top, { flip: true, offset: 10 });
    close(flipped.origin, [0, 0, 10]); // the offset is along the plane's own normal, before the flip
    close(flipped.z, [0, 0, -1]);
    close(flipped.x, [1, 0, 0]);
    close(flipped.y, [0, -1, 0]);
    const turned = refPlaneFrame(top, { xDir: [1, 1, 5] }); // projected onto the plane
    close(turned.x, [Math.SQRT1_2, Math.SQRT1_2, 0]);
    close(turned.y, [-Math.SQRT1_2, Math.SQRT1_2, 0]);
    expect(xDirProblem([0, 0, 1], [0, 0, -2])).toBe("must not be parallel to the plane normal");
    expect(xDirProblem([0, 0, 1], [0, 0, 0])).toBe("must not be the zero vector");
    expect(xDirProblem([0, 0, 1], [1, 0, 1])).toBeNull();
  });

  it("frames and written-out planes go both ways, for the sketcher", () => {
    const f = refPlaneFrame(DEFAULT_DATUMS.Front as PlaneDatum, { offset: 5 });
    const p = frameAsDatumPlane(f);
    expect(p.type).toBe("datum");
    const back = datumPlaneDatum(p);
    close(back.origin, [0, -5, 0]);
    close(back.normal, [0, -1, 0]);
    close(back.xDir, [1, 0, 0]);
  });

  it("finds the references in a feature's fields, with their paths", () => {
    const raw = {
      plane: { type: "ref", ref: { datum: "plane_1" } },
      axis: { edge: { type: "edge", pick: "all", body: "base" } },
      refs: [{ datum: "Top" }, { face: TOP }, "junk"],
      other: { datum: "nope" },
    };
    const found = datumRefsAt(raw, "plane", "axis", "refs");
    expect(found.map((r) => r.path)).toEqual(["plane.ref", "axis", "refs[0]", "refs[1]"]);
    expect(found[0].ref).toBe(raw.plane.ref);
    expect(datumFeatureIds(found)).toEqual(["plane_1"]);
    expect(datumSelectors(found)).toEqual([
      { path: "axis.edge", edge: raw.axis.edge },
      { path: "refs[1].face", face: TOP },
    ]);
  });

  it("knows where the built-in ops hold references (and the fields later waves give them)", () => {
    const paths = (raw: Record<string, unknown>) => featureDatumRefs(raw).map((r) => r.path);
    expect(paths({ op: "sketch", plane: { type: "ref", ref: { face: TOP } }, entities: [{ id: "l1", ref: { edge: {} } }, { id: "l2" }] })).toEqual(["plane.ref", "entities[0].ref"]);
    expect(paths({ op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [] })).toEqual([]);
    expect(paths({ op: "mirror", plane: { type: "ref", ref: { datum: "Right" } } })).toEqual(["plane.ref"]);
    expect(paths({ op: "cut", upTo: { face: TOP }, direction2: { extent: "upToFace", upTo: { datum: "p" } } })).toEqual(["upTo", "direction2.upTo"]);
    expect(paths({ op: "linearPattern", along: { edge: {} } })).toEqual(["along"]);
    expect(paths({ op: "circularPattern", axis: { ref: { datum: "Z" } } })).toEqual(["axis.ref"]);
    expect(paths({ op: "circularPattern", axis: { origin: [0, 0, 0], direction: [0, 0, 1] } })).toEqual([]);
    expect(featureDatumRefs({ op: "scale" }, () => [{ path: "x", ref: { datum: "Top" } }])).toEqual([{ path: "x", ref: { datum: "Top" } }]);
  });
});

describe("the kernel resolves references on the part as it stands", () => {
  /** The bracket built, as a resolving context; `datums` adds reference features. */
  function withBracket<T>(fn: (ctx: DatumContext) => T, datums: Record<string, Datum> = {}, v?: ValidationResult): T {
    const r = rebuild(bracket, oc);
    try {
      const bodies = new Map<string, TopoDS_Shape>(r.bodies.map((b) => [b.name, b.shape]));
      return fn({ oc, v: v ?? validateDocument(bracket), bodies, datums: new Map(Object.entries(datums)), missing: (id, what) => `${what} "${id}" failed` });
    } finally {
      r.dispose();
    }
  }
  const resolveIn = (ref: DatumRef, want: "plane" | "axis" | "point" | "any") => withBracket((ctx) => resolveDatum(ctx, ref, want as "any", "axis"));
  const failure = (ref: DatumRef, want: "plane" | "axis" | "point" | "any") => {
    try {
      resolveIn(ref, want);
    } catch (e) {
      return (e as Error).message;
    }
    return "resolved";
  };

  it("defaults and points are what they are", () => {
    expect(resolveIn({ datum: "Right" }, "plane")).toEqual({ kind: "plane", origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] });
    expect(resolveIn({ datum: "Y" }, "axis")).toEqual({ kind: "axis", origin: [0, 0, 0], direction: [0, 1, 0] });
    expect(resolveIn({ point: [1, 2, 3] }, "point")).toEqual({ kind: "point", at: [1, 2, 3] });
    expect(failure({ datum: "Top" }, "axis")).toBe("axis: Top is a plane, but an axis is needed here");
    expect(failure({ point: [1, 2, 3] }, "plane")).toBe("axis: the point [1, 2, 3] is a point, but a plane is needed here");
  });

  it("a planar face is its plane: the top face at z = 6, the +X side face at x = 40", () => {
    expect(resolveIn({ face: TOP as never }, "plane")).toEqual({ kind: "plane", origin: [0, 0, 6], normal: [0, 0, 1], xDir: [1, 0, 0] });
    const side = resolveIn({ face: { type: "planar", normal: [1, 0, 0], pick: "largest" } }, "plane") as PlaneDatum;
    close(side.origin, [40, 0, 0]);
    close(side.normal, [1, 0, 0]);
    close(side.xDir, [0, 1, 0]);
    expect(failure({ face: TOP as never }, "axis")).toBe("axis: the planar face normal +Z is a plane, but an axis is needed here");
  });

  it("a cylindrical face is its axis: the hole's wall gives the line through [30, 0] along Z", () => {
    const a = resolveIn({ face: { type: "cylindrical", radius: 3.3, pick: "all" } }, "axis");
    expect(a.kind).toBe("axis");
    if (a.kind !== "axis") return;
    expect(Math.abs(a.direction[2])).toBeCloseTo(1, 9);
    close([a.origin[0], a.origin[1]], [30, 0]);
  });

  it("a face selector that picks nothing, or several, says so with the field's path", () => {
    expect(failure({ face: { type: "planar", normal: [0, 0, 1], offset: 99, pick: "largest" } }, "plane")).toBe(
      "axis.face: selector matched 0 faces (wanted 1 planar face normal +Z at offset 99)",
    );
    expect(failure({ face: { type: "planar", normal: [0, 0, 1], pick: "all" } }, "plane")).toBe("resolved");
    expect(failure({ face: { type: "planar", normal: [1, 0, 0], pick: "all" } }, "plane")).toBe("resolved");
  });

  it("a straight edge is an axis from its start to its end; with at, a point of it", () => {
    const edge = { type: "edge", kind: "line", direction: [1, 0, 0], between: [TOP, FRONT], pick: "all" } as const;
    const a = resolveIn({ edge: edge as never }, "axis");
    if (a.kind !== "axis") throw new Error("not an axis");
    expect(Math.abs(a.direction[0])).toBeCloseTo(1, 9);
    close([a.origin[1], a.origin[2]], [-20, 6]);
    expect(resolveIn({ edge: edge as never, at: "mid" }, "point")).toEqual({ kind: "point", at: [0, -20, 6] });
    const ends = [resolveIn({ edge: edge as never, at: "start" }, "point"), resolveIn({ edge: edge as never, at: "end" }, "point")].map((p) => (p.kind === "point" ? p.at[0] : NaN));
    expect(ends.sort((x, y) => x - y)).toEqual([-40, 40]);
    expect(failure({ edge: edge as never }, "point")).toBe('axis: the straight edge is an axis, but a point is needed here; give "at": "start", "end" or "mid" for a point of it');
    expect(failure({ edge: edge as never, at: "center" }, "point")).toBe('axis.at: "center" is a circular edge\'s centre, but the edge is a straight edge; use "mid" for its middle');
    expect(failure({ edge: edge as never }, "plane")).toMatch(/^axis: the edge \(line edges parallel to \+X between the planar face normal \+Z and the planar face normal -Y\) is an axis, but a plane is needed here$/);
  });

  it("a circular edge is its axis, or its centre where a point is needed", () => {
    const rim = { type: "edge", kind: "circle", radius: 3.3, onFace: TOP, pick: "all" } as const;
    const a = resolveIn({ edge: rim as never }, "axis");
    if (a.kind !== "axis") throw new Error("not an axis");
    close(a.origin, [30, 0, 6]);
    expect(Math.abs(a.direction[2])).toBeCloseTo(1, 9);
    expect(resolveIn({ edge: rim as never }, "any").kind).toBe("axis");
    const c = resolveIn({ edge: rim as never }, "point");
    if (c.kind !== "point") throw new Error("not a point");
    close(c.at, [30, 0, 6]);
    const centre = resolveIn({ edge: rim as never, at: "center" }, "point");
    if (centre.kind !== "point") throw new Error("not a point");
    close(centre.at, [30, 0, 6]);
    const start = resolveIn({ edge: rim as never, at: "start" }, "point");
    if (start.kind !== "point") throw new Error("not a point");
    expect(Math.hypot(start.at[0] - 30, start.at[1])).toBeCloseTo(3.3, 9);
  });

  it("an edge selector must pick exactly one edge", () => {
    expect(failure({ edge: { type: "edge", kind: "line", direction: [1, 0, 0], pick: "all" } }, "axis")).toBe(
      'axis.edge: selector matched 4 edges (wanted 1 of line edges parallel to +X); add "near", or pick "longest" or "shortest"',
    );
    expect(failure({ edge: { type: "edge", kind: "line", direction: [1, 0, 0], pick: "longest" } }, "axis")).toBe(
      "axis.edge: selector matched 4 edges tied for longest (wanted 1 of line edges parallel to +X (longest))",
    );
    expect(failure({ edge: { type: "edge", kind: "circle", radius: 9, pick: "all" } }, "axis")).toBe("axis.edge: selector matched 0 edges (wanted circle edges radius 9)");
  });

  it("a reference feature resolves to what it made; a failed or suppressed one says so", () => {
    const made: Record<string, Datum> = { axis_1: { kind: "axis", origin: [1, 1, 0], direction: [0, 0, 1] } };
    expect(withBracket((ctx) => resolveDatum(ctx, { datum: "axis_1" }, "axis"), made)).toEqual(made.axis_1);
    expect(() => withBracket((ctx) => resolveDatum(ctx, { datum: "axis_1" }, "plane", "plane.ref"), made)).toThrow("plane.ref: axis_1 is an axis, but a plane is needed here");
    const v = { features: [{ index: 0, id: "plane_1", op: "plane", feature: null, errors: [] }] } as unknown as ValidationResult;
    expect(() => withBracket((ctx) => resolveDatum(ctx, { datum: "plane_1" }, "plane"), {}, v)).toThrow('plane "plane_1" failed, so there is no plane to use');
  });

  it("with no solid yet, a face or an edge cannot be had", () => {
    const ctx: DatumContext = { oc, v: validateDocument(bracket), bodies: new Map(), datums: new Map(), missing: (id) => id };
    expect(() => resolveDatum(ctx, { face: TOP as never }, "plane", "plane.ref")).toThrow("plane.ref: there is no solid before this feature to take a face from");
    expect(resolveDatum(ctx, { datum: "Front" }, "plane").normal).toEqual([0, -1, 0]);
  });
});
