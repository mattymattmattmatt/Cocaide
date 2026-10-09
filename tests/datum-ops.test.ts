// Reference geometry features (DESIGN §2.2): plane, axis and point. The
// constructions on plain frames, worked out by hand; what the document
// refuses, and how it says what to pick instead; and the kernel resolving
// them on the bracket (an 80 x 40 x 6 plate on z = 0, centred, with a 6.6 mm
// hole through at [30, 0]), following the part when an earlier feature changes.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { Vec3 } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import {
  anglePlane,
  axisPlanePoint,
  DEFAULT_DATUMS,
  flipPlane,
  midPlane,
  offsetPlane,
  planeDatum,
  planesLine,
  rotateAbout,
  threePointPlane,
  throughPointPlane,
  twoPointAxis,
  type AxisDatum,
  type Datum,
  type PlaneDatum,
} from "../src/features/datum";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { REFERENCE } from "../src/mcp/reference";

const bracket: RawDocument = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8"));
const empty: RawDocument = { version: 1, units: "mm", name: "datums", features: [] };
const add = (doc: RawDocument, ...f: Record<string, unknown>[]): RawDocument => ({ ...doc, features: [...doc.features, ...f] });
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const Top = DEFAULT_DATUMS.Top as PlaneDatum;
const Front = DEFAULT_DATUMS.Front as PlaneDatum;
const Right = DEFAULT_DATUMS.Right as PlaneDatum;
const Xaxis = DEFAULT_DATUMS.X as AxisDatum;
const Zaxis = DEFAULT_DATUMS.Z as AxisDatum;
const s30 = Math.sin(Math.PI / 6);
const c30 = Math.cos(Math.PI / 6);
const close = (a: readonly number[], b: readonly number[], digits = 9) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(x, `[${i}] of [${a.join(", ")}]`).toBeCloseTo(b[i], digits));
};
const closePlane = (p: Datum | undefined, origin: Vec3, normal: Vec3, xDir?: Vec3) => {
  expect(p?.kind).toBe("plane");
  const q = p as PlaneDatum;
  close(q.origin, origin);
  close(q.normal, normal);
  if (xDir) close(q.xDir, xDir);
};

/** Selectors on the bracket. */
const TOP_FACE = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const BOTTOM_FACE = { type: "planar", normal: [0, 0, -1], pick: "largest" };
const HOLE_FACE = { type: "cylindrical", radius: 3.3, pick: "all" };
/** The plate's long top front edge, y = -20, z = 6, x from -40 to 40. */
const FRONT_TOP_EDGE = { type: "edge", kind: "line", direction: [1, 0, 0], pick: "all", near: [0, -20, 6] };
/** The hole's rim on the top face. */
const HOLE_RIM = { type: "edge", kind: "circle", radius: 3.3, pick: "all", near: [30, 0, 6] };

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(doc: RawDocument) {
  const r = rebuild(doc, oc);
  try {
    return { ok: r.ok, errors: r.errors, datums: r.datums, features: r.features, volume: r.measurements?.volume ?? 0, box: r.measurements?.boundingBox ?? null };
  } finally {
    r.dispose();
  }
}

describe("constructions on frames (worked out by hand)", () => {
  it("offset: Top moved 10 along its normal is z = 10; negative goes behind; x kept", () => {
    closePlane(offsetPlane(Top, 10), [0, 0, 10], [0, 0, 1], [1, 0, 0]);
    closePlane(offsetPlane(Front, 5), [0, -5, 0], [0, -1, 0], [1, 0, 0]);
    closePlane(offsetPlane(Top, -4), [0, 0, -4], [0, 0, 1]);
  });

  it("flip turns the normal over and keeps x; parallel through a point keeps the normal", () => {
    closePlane(flipPlane(Top), [0, 0, 0], [0, 0, -1], [1, 0, 0]);
    closePlane(throughPointPlane(Top, [5, 5, 7]), [0, 0, 7], [0, 0, 1], [1, 0, 0]);
    closePlane(throughPointPlane(Right, [12, 3, -1]), [12, 0, 0], [1, 0, 0], [0, 1, 0]);
  });

  it("angle: 30° about X from Top has the normal [0, -sin 30°, cos 30°] (right-handed about the axis)", () => {
    closePlane(anglePlane(Top, Xaxis, 30)!, [0, 0, 0], [0, -s30, c30], [1, 0, 0]);
    closePlane(anglePlane(Top, Xaxis, -30)!, [0, 0, 0], [0, s30, c30]);
    // About -X, the same angle turns the other way.
    closePlane(anglePlane(Top, { kind: "axis", origin: [0, 0, 0], direction: [-1, 0, 0] }, 30)!, [0, 0, 0], [0, s30, c30]);
    // 90° about X from Top is the plane y = 0 seen from -Y: Front.
    closePlane(anglePlane(Top, Xaxis, 90)!, [0, 0, 0], [0, -1, 0], [1, 0, 0]);
    expect(rotateAbout([1, 0, 0], [0, 0, 1], 90)).toEqual([0, 1, 0]);
  });

  it("angle about an axis parallel to the plane goes through the axis; an axis out of the plane makes none", () => {
    // The axis along X at z = 5: the plane turns about it, so it passes through z = 5.
    closePlane(anglePlane(Top, { kind: "axis", origin: [7, 0, 5], direction: [1, 0, 0] }, 90)!, [0, 0, 5], [0, -1, 0]);
    expect(anglePlane(Top, Zaxis, 30)).toBeNull();
    expect(anglePlane(Top, { kind: "axis", origin: [0, 0, 0], direction: [1, 0, 1] }, 30)).toBeNull();
  });

  it("three points: the normal is (p2 - p1) x (p3 - p1), x from p1 toward p2; points on one line make none", () => {
    closePlane(threePointPlane([0, 0, 6], [10, 0, 6], [0, 10, 6])!, [0, 0, 6], [0, 0, 1], [1, 0, 0]);
    closePlane(threePointPlane([0, 0, 0], [0, 10, 0], [10, 0, 0])!, [0, 0, 0], [0, 0, -1], [0, 1, 0]);
    // Through [10,0,0], [0,10,0], [0,0,10]: the normal is [1,1,1]/sqrt(3).
    const k = 1 / Math.sqrt(3);
    closePlane(threePointPlane([10, 0, 0], [0, 10, 0], [0, 0, 10])!, [10, 0, 0], [k, k, k]);
    expect(threePointPlane([0, 0, 0], [5, 5, 5], [10, 10, 10])).toBeNull();
    expect(threePointPlane([0, 0, 0], [0, 0, 0], [10, 0, 0])).toBeNull();
  });

  it("midplane: half way between the two faces of a 6 mm plate is z = 3", () => {
    const top = planeDatum([0, 0, 6], [0, 0, 1]);
    const bottom = planeDatum([0, 0, 0], [0, 0, -1]);
    closePlane(midPlane(top, bottom), [0, 0, 3], [0, 0, 1], [1, 0, 0]);
    closePlane(midPlane(bottom, top), [0, 0, 3], [0, 0, -1]);
    // Facing the same way, too.
    closePlane(midPlane(planeDatum([0, 0, 2], [0, 0, 1]), planeDatum([0, 0, 8], [0, 0, 1])), [0, 0, 5], [0, 0, 1]);
  });

  it("midplane of planes that meet: the bisector through their line", () => {
    // Top and Right (normals +Z, +X) meet along Y; at 90° the plane of equal distance, z = x, normal [-1, 0, 1]/sqrt(2).
    const h = Math.SQRT1_2;
    closePlane(midPlane(Top, Right), [0, 0, 0], [-h, 0, h]);
    // Top and Top turned 60° about X: the bisector is Top turned 30°.
    closePlane(midPlane(Top, anglePlane(Top, Xaxis, 60)!), [0, 0, 0], [0, -s30, c30]);
    // A box edge: faces x = 10 (+X) and z = 6 (+Z) meet in the line x = 10, z = 6.
    const m = midPlane(planeDatum([10, 0, 0], [1, 0, 0]), planeDatum([0, 0, 6], [0, 0, 1]));
    close(m.normal, [h, 0, -h]);
    close(m.origin, [10, 0, 6]);
  });

  it("two planes meet in a line along n1 x n2: Top and Front in X, Front and Right in Z; parallel ones in none", () => {
    expect(planesLine(Top, Front)).toEqual({ kind: "axis", origin: [0, 0, 0], direction: [1, 0, 0] });
    expect(planesLine(Front, Right)).toEqual({ kind: "axis", origin: [0, 0, 0], direction: [0, 0, 1] });
    // z = 10 and x = 5: along Z x X = +Y, through [5, 0, 10].
    const l = planesLine(planeDatum([0, 0, 10], [0, 0, 1]), planeDatum([5, 0, 0], [1, 0, 0]))!;
    close(l.origin, [5, 0, 10]);
    close(l.direction, [0, 1, 0]);
    expect(planesLine(Top, offsetPlane(Top, 5))).toBeNull();
    expect(planesLine(Top, flipPlane(Top))).toBeNull();
  });

  it("an axis crosses a plane at one point; one parallel to it never does", () => {
    close(axisPlanePoint(Zaxis, offsetPlane(Top, 10))!, [0, 0, 10]);
    // Through [1, 2, 3] along [1, 1, 1]: it reaches z = 0 three steps back, at [-2, -1, 0].
    close(axisPlanePoint({ kind: "axis", origin: [1, 2, 3], direction: [1, 1, 1] }, Top)!, [-2, -1, 0]);
    expect(axisPlanePoint(Xaxis, Top)).toBeNull();
    expect(twoPointAxis([1, 1, 1], [1, 1, 5])).toEqual({ kind: "axis", origin: [1, 1, 1], direction: [0, 0, 1] });
    expect(twoPointAxis([1, 1, 1], [1, 1, 1])).toBeNull();
  });
});

describe("what the document refuses, and what it says to pick", () => {
  const plane = (extra: Record<string, unknown>) => ({ id: "plane_1", op: "plane", ...extra });

  it("an offset plane needs only a plane; the mode defaults to offset and the distance to 0", () => {
    expect(errorsOf(add(bracket, plane({ refs: [{ datum: "Top" }], distance: 10 })))).toEqual([]);
    const v = validateDocument(add(empty, plane({ refs: [{ datum: "Front" }] })));
    expect(v.features[0].feature).toEqual({ id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Front" }] });
  });

  it("a reference of the wrong kind: Top is a plane, but an axis is needed here", () => {
    expect(errorsOf(add(bracket, plane({ mode: "angle", refs: [{ datum: "Top" }, { datum: "Top" }], angle: 30 })))).toEqual([
      "plane_1: refs[1]: Top is a plane, but an axis is needed here",
    ]);
    expect(errorsOf(add(bracket, plane({ refs: [{ datum: "X" }] })))).toEqual(["plane_1: refs[0]: X is an axis, but a plane is needed here"]);
    expect(errorsOf(add(empty, { id: "a", op: "axis", mode: "pointNormal", refs: [{ datum: "Top" }, { datum: "Origin" }] }))).toEqual([
      "a: refs[0]: Top is a plane, but a point is needed here",
      "a: refs[1]: Origin is a point, but a plane is needed here",
    ]);
  });

  it("the wrong number of references names what the mode takes", () => {
    expect(errorsOf(add(bracket, plane({ mode: "threePoints", refs: [{ point: [0, 0, 0] }] })))).toEqual([
      'plane_1: refs: mode "threePoints" takes 3 references (a point (a vertex, a point feature, the origin or [x, y, z]), then a point (a vertex, a point feature, the origin or [x, y, z]), then a point (a vertex, a point feature, the origin or [x, y, z])), got 1',
    ]);
    expect(errorsOf(add(bracket, plane({ mode: "angle", refs: [{ datum: "Top" }], angle: 10 })))[0]).toMatch(/^plane_1: refs: mode "angle" takes 2 references \(a plane .*, then an axis in the plane or parallel to it .*\), got 1$/);
    expect(errorsOf(add(bracket, plane({ mode: "normalToEdge", refs: [] })))[0]).toMatch(/^plane_1: refs: mode "normalToEdge" takes 1 or 2 references \(an edge .*, then optionally a point .*\), got 0$/);
    expect(errorsOf(add(bracket, plane({ refs: { datum: "Top" } })))).toEqual([
      'plane_1: refs: must be a list: mode "offset" takes 1 reference (a plane (a default plane, a plane feature or a flat face)) (got {"datum":"Top"})',
    ]);
  });

  it("numbers another mode uses are refused; an angle plane needs its angle; t is 0 to 1", () => {
    expect(errorsOf(add(bracket, plane({ mode: "angle", refs: [{ datum: "Top" }, { datum: "X" }], angle: 30, distance: 5 })))).toEqual([
      'plane_1: distance: only mode "offset" uses it (this plane is mode "angle"); remove it',
    ]);
    expect(errorsOf(add(bracket, plane({ mode: "angle", refs: [{ datum: "Top" }, { datum: "X" }] })))).toEqual([
      "plane_1: angle: needed: degrees to turn the plane about the axis refs[1] (0 lies in refs[0])",
    ]);
    const edge = { edge: FRONT_TOP_EDGE };
    expect(errorsOf(add(bracket, plane({ mode: "normalToEdge", refs: [edge], t: 1.5 })))).toEqual(["plane_1: t: must be from 0 (the edge's start) to 1 (its end) (got 1.5)"]);
    expect(errorsOf(add(bracket, plane({ mode: "normalToEdge", refs: [edge, { point: [0, -20, 6] }], t: 0.5 })))).toEqual([
      "plane_1: t: give t or a point refs[1] to place the plane, not both",
    ]);
    expect(errorsOf(add(bracket, plane({ mode: "normalToEdge", refs: [{ edge: FRONT_TOP_EDGE, at: "start" }] })))).toEqual([
      "plane_1: refs[0]: the start of an edge is a point, but an axis is needed here",
    ]);
    expect(errorsOf(add(bracket, { id: "p", op: "point", mode: "onEdge", refs: [{ edge: FRONT_TOP_EDGE, at: "end" }] }))).toEqual([
      'p: refs[0].at: mode "onEdge" takes the whole edge here: leave "at" out',
    ]);
    expect(errorsOf(add(bracket, plane({ mode: "sideways", refs: [{ datum: "Top" }] })))[0]).toMatch(/^plane_1: mode: must be "offset", "angle", /);
  });

  it("an axis or a point names its mode; forms a mode does not take are refused", () => {
    expect(errorsOf(add(bracket, { id: "a", op: "axis", refs: [{ datum: "Top" }, { datum: "Front" }] }))).toEqual([
      'a: mode: needed: "twoPoints", "edge", "cylinder", "twoPlanes", "pointNormal"',
    ]);
    expect(errorsOf(add(bracket, { id: "a", op: "axis", mode: "cylinder", refs: [{ edge: HOLE_RIM }] }))).toEqual([
      'a: refs[0]: mode "cylinder" takes a cylindrical or conical face here, written { "face": <face selector> } (got an edge)',
    ]);
    expect(errorsOf(add(bracket, { id: "p", op: "point", mode: "coords" }))).toEqual(["p: at: needed: the point's [x, y, z] in mm"]);
    expect(errorsOf(add(bracket, { id: "p", op: "point", mode: "coords", at: [1, 2, 3], refs: [{ datum: "Origin" }] }))).toEqual(['p: refs: mode "coords" takes no references; remove them']);
    expect(errorsOf(add(bracket, { id: "p", op: "point", mode: "center", refs: [{ datum: "Top" }] }))).toEqual([
      'p: refs[0]: mode "center" takes a circular edge (its centre) or a face (its centre of area) here, written { "edge": <edge selector> } or { "face": <face selector> } (got Top)',
    ]);
  });

  it("references are to earlier features; their ids are reserved names; renames follow them", () => {
    expect(errorsOf(add(bracket, plane({ refs: [{ datum: "plane_2" }] }), { id: "plane_2", op: "plane", refs: [{ datum: "Top" }] }))).toEqual([
      'plane_1: refs[0].datum: "plane_2" is not a feature before this one (the defaults are Top, Front, Right, Origin, X, Y, Z)',
    ]);
    expect(errorsOf(add(bracket, { id: "Right", op: "plane", refs: [{ datum: "Top" }] }))[0]).toMatch(/^Right: id: "Right" names a default plane/);
    expect(errorsOf(add(bracket, plane({ refs: [{ datum: "ext_1" }] })))).toEqual(['plane_1: refs[0].datum: "ext_1" is an extrude, not a plane, axis or point']);
  });

  it("each op documents itself for the agent, with its modes, signs and an example of sketching on it", () => {
    for (const op of ["plane", "axis", "point"]) expect(REFERENCE).toContain(`## ${op}\n`);
    expect(REFERENCE).toContain('"angle": through an axis, at `angle` degrees to a plane');
    expect(REFERENCE).toContain("30 about X from Top gives the normal [0, -0.5, 0.866]");
    expect(REFERENCE).toContain('"plane": { "type": "ref", "ref": { "datum": "plane_1" } }');
    expect(REFERENCE).toContain('"twoPlanes": where two planes meet');
    expect(REFERENCE).toContain('"intersection": where an axis crosses a plane');
  });
});

describe("the kernel builds them on the part as it stands", () => {
  it("an offset plane from Top by 10 sits at z = 10; it makes no body and is a success", () => {
    const r = built(add(bracket, { id: "plane_1", op: "plane", refs: [{ datum: "Top" }], distance: 10 }));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.features.at(-1)).toEqual({ id: "plane_1", op: "plane", ok: true });
    expect(r.datums).toEqual({ plane_1: { kind: "plane", origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] } });
    expect(r.volume).toBeCloseTo(80 * 40 * 6 - Math.PI * 3.3 ** 2 * 6, 6);
  });

  it("in an empty part too: only the default planes are needed", () => {
    const r = built(add(empty, { id: "plane_1", op: "plane", mode: "angle", refs: [{ datum: "Top" }, { datum: "X" }], angle: 30 }, { id: "flipped", op: "plane", refs: [{ datum: "plane_1" }], distance: 5, flip: true }));
    expect(r.errors).toEqual(["document: no solid; add an extrude"]);
    closePlane(r.datums.plane_1, [0, 0, 0], [0, -s30, c30], [1, 0, 0]);
    closePlane(r.datums.flipped, [0, -5 * s30, 5 * c30], [0, s30, -c30], [1, 0, 0]);
  });

  it("three points, from the corners of the plate (vertices) and a point feature", () => {
    const corner = (at: "start" | "end") => ({ edge: FRONT_TOP_EDGE, at });
    const r = built(add(bracket, { id: "far", op: "point", mode: "coords", at: [0, 20, 6] }, { id: "plane_1", op: "plane", mode: "threePoints", refs: [corner("start"), corner("end"), { datum: "far" }] }));
    expect(r.errors).toEqual([]);
    // The plate's top face, from whichever way the edge runs: its normal is +Z or -Z.
    const p = r.datums.plane_1 as PlaneDatum;
    close(p.normal.map(Math.abs), [0, 0, 1]);
    expect(p.origin[2]).toBeCloseTo(6, 9);
    expect(Math.abs(p.origin[0])).toBeCloseTo(40, 9);
  });

  it("midplane between the two faces of the 6 mm plate: z = 3", () => {
    const r = built(add(bracket, { id: "mid", op: "plane", mode: "midplane", refs: [{ face: TOP_FACE }, { face: BOTTOM_FACE }] }));
    expect(r.errors).toEqual([]);
    closePlane(r.datums.mid, [0, 0, 3], [0, 0, 1], [1, 0, 0]);
  });

  it("normal to an edge: at t along it, or through a point; square to a round edge too", () => {
    const r = built(
      add(
        bracket,
        { id: "middle", op: "plane", mode: "normalToEdge", refs: [{ edge: FRONT_TOP_EDGE }], t: 0.5 },
        { id: "start", op: "plane", mode: "normalToEdge", refs: [{ edge: FRONT_TOP_EDGE }] },
        { id: "through", op: "plane", mode: "normalToEdge", refs: [{ edge: FRONT_TOP_EDGE }, { point: [10, -20, 6] }] },
        { id: "rim", op: "plane", mode: "normalToEdge", refs: [{ edge: HOLE_RIM }] },
        { id: "zplane", op: "plane", mode: "normalToEdge", refs: [{ datum: "Z" }, { point: [1, 2, 3] }] },
      ),
    );
    expect(r.errors).toEqual([]);
    const middle = r.datums.middle as PlaneDatum;
    close(middle.origin, [0, -20, 6]);
    close(middle.normal.map(Math.abs), [1, 0, 0]);
    // At its start: an end of the edge, the normal along the edge toward its other end.
    const start = r.datums.start as PlaneDatum;
    expect(Math.abs(start.origin[0])).toBeCloseTo(40, 9);
    expect(Math.sign(start.normal[0])).toBe(-Math.sign(start.origin[0]));
    closePlane(r.datums.through, [10, -20, 6], middle.normal);
    // On the hole's rim: through a point 3.3 from the centre, square to the rim there (so the normal is level).
    const rim = r.datums.rim as PlaneDatum;
    expect(Math.hypot(rim.origin[0] - 30, rim.origin[1])).toBeCloseTo(3.3, 6);
    expect(rim.origin[2]).toBeCloseTo(6, 9);
    expect(rim.normal[2]).toBeCloseTo(0, 9);
    expect(rim.normal[0] * (rim.origin[0] - 30) + rim.normal[1] * rim.origin[1]).toBeCloseTo(0, 6);
    closePlane(r.datums.zplane, [1, 2, 3], [0, 0, 1]);
  });

  it("parallel through a point, and at an angle about a plate edge", () => {
    const r = built(
      add(
        bracket,
        { id: "high", op: "plane", mode: "parallelThroughPoint", refs: [{ datum: "Top" }, { edge: HOLE_RIM, at: "center" }] },
        { id: "tilted", op: "plane", mode: "angle", refs: [{ face: TOP_FACE }, { edge: FRONT_TOP_EDGE }], angle: 90 },
      ),
    );
    expect(r.errors).toEqual([]);
    closePlane(r.datums.high, [0, 0, 6], [0, 0, 1], [1, 0, 0]);
    // The top face turned 90° about its front edge (along ±X at y = -20, z = 6) stands upright through that edge.
    const tilted = r.datums.tilted as PlaneDatum;
    close(tilted.normal.map(Math.abs), [0, 1, 0]);
    expect(tilted.origin[1]).toBeCloseTo(-20, 9);
    expect(tilted.origin[2]).toBeCloseTo(6, 9);
  });

  it("an axis from two planes: Top and Front meet in X; Front and Right in Z; from a cylinder, an edge, two points", () => {
    const r = built(
      add(
        bracket,
        { id: "x", op: "axis", mode: "twoPlanes", refs: [{ datum: "Top" }, { datum: "Front" }] },
        { id: "z", op: "axis", mode: "twoPlanes", refs: [{ datum: "Front" }, { datum: "Right" }] },
        { id: "hole", op: "axis", mode: "cylinder", refs: [{ face: HOLE_FACE }] },
        { id: "along", op: "axis", mode: "edge", refs: [{ edge: FRONT_TOP_EDGE }], flip: true },
        { id: "rim", op: "axis", mode: "edge", refs: [{ edge: HOLE_RIM }] },
        { id: "diag", op: "axis", mode: "twoPoints", refs: [{ datum: "Origin" }, { point: [0, 3, 4] }] },
        { id: "up", op: "axis", mode: "pointNormal", refs: [{ point: [5, 5, 5] }, { face: TOP_FACE }] },
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.datums.x).toEqual({ kind: "axis", origin: [0, 0, 0], direction: [1, 0, 0] });
    expect(r.datums.z).toEqual({ kind: "axis", origin: [0, 0, 0], direction: [0, 0, 1] });
    for (const id of ["hole", "rim"]) {
      const a = r.datums[id] as AxisDatum;
      close(a.direction.map(Math.abs), [0, 0, 1]);
      close(a.origin.slice(0, 2), [30, 0]);
    }
    const along = r.datums.along as AxisDatum;
    close(along.direction.map(Math.abs), [1, 0, 0]);
    // Flipped: it runs from the edge's end back toward its start.
    expect(Math.sign(along.direction[0])).toBe(Math.sign(along.origin[0]));
    close((r.datums.diag as AxisDatum).origin, [0, 0, 0]);
    close((r.datums.diag as AxisDatum).direction, [0, 0.6, 0.8]);
    expect(r.datums.up).toEqual({ kind: "axis", origin: [5, 5, 5], direction: [0, 0, 1] });
  });

  it("points: where an axis crosses a plane, a circular edge's centre, a face's centre, along an edge", () => {
    const r = built(
      add(
        bracket,
        { id: "hole", op: "axis", mode: "cylinder", refs: [{ face: HOLE_FACE }] },
        { id: "plane_1", op: "plane", refs: [{ datum: "Top" }], distance: 10 },
        { id: "cross", op: "point", mode: "intersection", refs: [{ datum: "hole" }, { datum: "plane_1" }] },
        { id: "zcross", op: "point", mode: "intersection", refs: [{ datum: "Z" }, { face: TOP_FACE }] },
        { id: "rim", op: "point", mode: "center", refs: [{ edge: HOLE_RIM }] },
        { id: "face", op: "point", mode: "center", refs: [{ face: BOTTOM_FACE }] },
        { id: "mid", op: "point", mode: "onEdge", refs: [{ edge: FRONT_TOP_EDGE }] },
        { id: "quarter", op: "point", mode: "onEdge", refs: [{ edge: FRONT_TOP_EDGE }], t: 0.25 },
      ),
    );
    expect(r.errors).toEqual([]);
    const at = (id: string) => (r.datums[id] as { at: Vec3 }).at;
    close(at("cross"), [30, 0, 10]);
    close(at("zcross"), [0, 0, 6]);
    close(at("rim"), [30, 0, 6]);
    // The bottom face is the plate less the hole: its centre of area sits a little left of the middle.
    const holeArea = Math.PI * 3.3 ** 2;
    close(at("face"), [(-holeArea * 30) / (80 * 40 - holeArea), 0, 0], 6);
    close(at("mid"), [0, -20, 6]);
    expect(Math.abs(at("quarter")[0])).toBeCloseTo(20, 9);
  });

  it("what cannot be made says what to pick instead", () => {
    const r = built(
      add(
        bracket,
        { id: "tilt", op: "plane", mode: "angle", refs: [{ datum: "Top" }, { datum: "Z" }], angle: 30 },
        { id: "line", op: "plane", mode: "threePoints", refs: [{ point: [0, 0, 0] }, { point: [1, 1, 1] }, { point: [2, 2, 2] }] },
        { id: "parallel", op: "axis", mode: "twoPlanes", refs: [{ datum: "Top" }, { face: TOP_FACE }] },
        { id: "same", op: "axis", mode: "twoPoints", refs: [{ datum: "Origin" }, { point: [0, 0, 0] }] },
        { id: "never", op: "point", mode: "intersection", refs: [{ datum: "X" }, { datum: "Top" }] },
        { id: "straight", op: "point", mode: "center", refs: [{ edge: FRONT_TOP_EDGE }] },
        { id: "flat", op: "axis", mode: "cylinder", refs: [{ face: TOP_FACE }] },
      ),
    );
    expect(r.errors).toEqual([
      'tilt: refs[1]: Z runs +Z, out of Top (normal +Z): pick an edge or axis that lies in the plane or runs parallel to it, or use mode "normalToEdge" for a plane square to it',
      "line: refs: the three points lie on one line (or two are the same point), so no one plane goes through them: pick a third point off the line through the other two",
      "parallel: refs: Top and the planar face normal +Z are parallel (normal +Z), so they never meet in a line: pick two planes that cross (Front and Right meet in the Z axis)",
      "same: refs: both points are [0, 0, 0]: pick two different points",
      "never: refs: X runs +X, parallel to Top (normal +Z), so it never crosses it: pick a plane the axis passes through",
      'straight: refs[0]: the edge is straight, so it has no centre: use mode "onEdge" (t 0.5 is its middle), or pick a circular edge',
      "flat: refs[0]: the planar face normal +Z is a plane, but an axis is needed here",
    ]);
    // The part itself is untouched.
    expect(r.volume).toBeCloseTo(80 * 40 * 6 - Math.PI * 3.3 ** 2 * 6, 6);
  });

  it("a face reference needs a solid before it; a failed or suppressed plane leaves nothing for what uses it", () => {
    const r = built(add(empty, { id: "p", op: "plane", refs: [{ face: TOP_FACE }] }));
    expect(r.errors).toContain("p: refs[0]: there is no solid before this feature to take a face from");
    const s = built(
      add(
        bracket,
        { id: "plane_1", op: "plane", refs: [{ datum: "Top" }], distance: 10, suppressed: true },
        { id: "sk", op: "sketch", plane: { type: "ref", ref: { datum: "plane_1" } }, entities: [] },
      ),
    );
    expect(s.errors).toEqual(['sk: plane "plane_1" is suppressed, so there is no plane to use']);
  });
});

describe("they follow the model", () => {
  const withPlate = (depth: number, ...more: Record<string, unknown>[]): RawDocument => ({
    ...bracket,
    features: [...bracket.features.map((f) => (f.id === "ext_1" ? { ...f, distance: depth } : f)), ...more],
  });

  it("a plane on a face moves with the face when the earlier extrude gets deeper", () => {
    const plane = { id: "plane_1", op: "plane", refs: [{ face: TOP_FACE }], distance: 5 };
    closePlane(built(withPlate(6, plane)).datums.plane_1, [0, 0, 11], [0, 0, 1], [1, 0, 0]);
    closePlane(built(withPlate(10, plane)).datums.plane_1, [0, 0, 15], [0, 0, 1], [1, 0, 0]);
  });

  it("a sketch on an offset plane, extruded: the body sits at the plane's offset", () => {
    const doc = add(
      empty,
      { id: "plane_1", op: "plane", refs: [{ datum: "Top" }], distance: 10 },
      { id: "sk", op: "sketch", plane: { type: "ref", ref: { datum: "plane_1" } }, entities: [{ id: "r1", type: "rect", center: [5, 0], w: 20, h: 10 }] },
      { id: "ext", op: "extrude", sketch: "sk", distance: 4 },
    );
    const r = built(doc);
    expect(r.errors).toEqual([]);
    expect(r.box!.min.map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([-5, -5, 10]);
    expect(r.box!.max.map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([15, 5, 14]);
    expect(r.volume).toBeCloseTo(20 * 10 * 4, 6);
  });

  it("a hole's axis and a point on it follow the hole when the sketch moves it", () => {
    const moved = { ...bracket, features: bracket.features.map((f) => (f.id === "hole_1" ? { ...f, center: [-20, 5] } : f)) };
    const r = built(add(moved, { id: "ax", op: "axis", mode: "cylinder", refs: [{ face: HOLE_FACE }] }, { id: "pt", op: "point", mode: "intersection", refs: [{ datum: "ax" }, { datum: "Top" }] }));
    expect(r.errors).toEqual([]);
    close((r.datums.pt as { at: Vec3 }).at, [-20, 5, 0]);
  });
});
