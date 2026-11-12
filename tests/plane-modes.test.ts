// The newer ways to make a reference plane, on plain frames (worked out by
// hand) and on the bracket (an 80 x 40 x 6 plate on z = 0, centred, with a
// 6.6 mm hole through at [30, 0]): through a line and a point, through two
// lines, through a line square to a plane, tangent to a cylinder, half way
// between two points, best fit through points, and the part's centre plane.
// Then the selection-first Plane tool choosing them, and midpoint snapping.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { Vec3 } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { bestFitPlane, betweenPointsPlane, DEFAULT_DATUMS, lineAndPointPlane, perpendicularPlane, tangentPlane, twoLinesPlane, type AxisDatum, type Datum, type PlaneDatum } from "../src/features/datum";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { snapPoints } from "../src/ui/Viewport";

const bracket: RawDocument = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8"));
const X = DEFAULT_DATUMS.X as AxisDatum;
const Z = DEFAULT_DATUMS.Z as AxisDatum;
const Top = DEFAULT_DATUMS.Top as PlaneDatum;
const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((x, i) => expect(x, `[${i}] of [${a.join(", ")}]`).toBeCloseTo(b[i], digits));
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** The plane's signed distance at a point, to check where it is without caring which point is its origin. */
const at = (p: PlaneDatum, q: Vec3) => (q[0] - p.origin[0]) * p.normal[0] + (q[1] - p.origin[1]) * p.normal[1] + (q[2] - p.origin[2]) * p.normal[2];

const FRONT_TOP_EDGE = { type: "edge", kind: "line", direction: [1, 0, 0], pick: "all", near: [0, -20, 6] };
const HOLE_RIM = { type: "edge", kind: "circle", radius: 3.3, pick: "all", near: [30, 0, 6] };
const HOLE_WALL = { type: "cylindrical", radius: 3.3, pick: "all" };
const TOP_FACE = { type: "planar", normal: [0, 0, 1], pick: "largest" };

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function plane(feature: Record<string, unknown>): { datum: Datum | undefined; errors: unknown[] } {
  const doc = { ...bracket, features: [...bracket.features, { id: "p", op: "plane", ...feature }] };
  const r = rebuild(doc, oc);
  try {
    return { datum: r.datums.p, errors: r.errors };
  } finally {
    r.dispose();
  }
}
function built(feature: Record<string, unknown>): PlaneDatum {
  const r = plane(feature);
  expect(r.errors).toEqual([]);
  expect(r.datum?.kind).toBe("plane");
  return r.datum as PlaneDatum;
}

describe("constructions on frames", () => {
  it("through a line and a point off it; none through a point on it", () => {
    const p = lineAndPointPlane(X, [0, 5, 5])!;
    close(p.normal, unit([0, -5, 5]));
    close(p.xDir, [1, 0, 0]);
    expect(at(p, [7, 5, 5])).toBeCloseTo(0, 9);
    expect(lineAndPointPlane(X, [12, 0, 0])).toBeNull();
  });

  it("through two lines: crossing (X and Z: the XZ plane), parallel (holding both), the same line (none)", () => {
    close(twoLinesPlane(X, Z)!.normal, [0, -1, 0]);
    const p = twoLinesPlane(X, { kind: "axis", origin: [0, 0, 4], direction: [-1, 0, 0] })!;
    expect(Math.abs(p.normal[1])).toBeCloseTo(1, 9);
    expect(twoLinesPlane(X, { kind: "axis", origin: [5, 0, 0], direction: [1, 0, 0] })).toBeNull();
  });

  it("through a line, square to a plane; none when the line is square to it", () => {
    const p = perpendicularPlane({ kind: "axis", origin: [0, -20, 6], direction: [1, 0, 0] }, Top)!;
    close(p.normal, [0, -1, 0]);
    expect(at(p, [0, -20, 0])).toBeCloseTo(0, 9);
    expect(perpendicularPlane(Z, Top)).toBeNull();
  });

  it("half way between two points, square to the line joining them", () => {
    const p = betweenPointsPlane([0, 0, 0], [10, 0, 0])!;
    close(p.origin, [5, 0, 0]);
    close(p.normal, [1, 0, 0]);
    expect(betweenPointsPlane([1, 2, 3], [1, 2, 3])).toBeNull();
  });

  it("best fit: exact through points on one plane, nearest through scattered ones, none for a line", () => {
    const flat = bestFitPlane([[0, 0, 6], [10, 0, 6], [10, 10, 6], [0, 10, 6]])!;
    close(flat.plane.normal, [0, 0, 1]);
    expect(flat.worst).toBeCloseTo(0, 9);
    const rough = bestFitPlane([[0, 0, 0], [10, 0, 0.2], [10, 10, 0], [0, 10, 0.2]])!;
    close(rough.plane.origin, [5, 5, 0.1]);
    expect(rough.worst).toBeCloseTo(0.1, 6);
    expect(bestFitPlane([[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]])).toBeNull();
  });

  it("tangent to a cylinder, on the side asked", () => {
    const p = tangentPlane(Z, 5, [0, -1, 0])!;
    close(p.normal, [0, -1, 0]);
    close(p.origin, [0, -5, 0]);
    expect(tangentPlane(Z, 5, [0, 0, 1])).toBeNull();
  });
});

describe("on the bracket", () => {
  it("parallel to the top face, through the middle of a vertical edge: z = 3", () => {
    const corner = { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all", near: [40, 20, 3] };
    const p = built({ mode: "parallelThroughPoint", refs: [{ face: TOP_FACE }, { edge: corner, at: "mid" }] });
    expect(at(p, [0, 0, 3])).toBeCloseTo(0, 6);
  });

  it("through the front top edge and the origin", () => {
    const p = built({ mode: "lineAndPoint", refs: [{ edge: FRONT_TOP_EDGE }, { datum: "Origin" }] });
    expect(at(p, [0, 0, 0])).toBeCloseTo(0, 6);
    expect(at(p, [33, -20, 6])).toBeCloseTo(0, 6);
  });

  it("through two lines: the front top edge and X (parallel)", () => {
    const p = built({ mode: "twoLines", refs: [{ edge: FRONT_TOP_EDGE }, { datum: "X" }] });
    expect(at(p, [-17, 0, 0])).toBeCloseTo(0, 6);
    expect(at(p, [12, -20, 6])).toBeCloseTo(0, 6);
  });

  it("standing square to the top face along its front edge: y = -20; refused for a line square to the face", () => {
    const p = built({ mode: "perpendicular", refs: [{ edge: FRONT_TOP_EDGE }, { face: TOP_FACE }] });
    close(p.normal.map(Math.abs) as Vec3, [0, 1, 0]);
    expect(at(p, [0, -20, 0])).toBeCloseTo(0, 6);
    expect(plane({ mode: "perpendicular", refs: [{ datum: "Z" }, { face: TOP_FACE }] }).errors.join(" ")).toMatch(/square to/);
  });

  it("tangent to the hole: parallel to Front on its side (y = -3.3), the far side, and nearest a point", () => {
    const front = built({ mode: "tangent", refs: [{ face: HOLE_WALL }, { datum: "Front" }] });
    close(front.normal, [0, -1, 0]);
    expect(at(front, [30, -3.3, 0])).toBeCloseTo(0, 6);
    const back = built({ mode: "tangent", refs: [{ face: HOLE_WALL }, { datum: "Front" }], back: true });
    expect(at(back, [30, 3.3, 0])).toBeCloseTo(0, 6);
    const near = built({ mode: "tangent", refs: [{ face: HOLE_WALL }, { point: [40, 0, 3] }] });
    close(near.normal, [1, 0, 0]);
    expect(at(near, [33.3, 0, 0])).toBeCloseTo(0, 6);
    // A plane the axis doesn't run along: said plainly.
    expect(plane({ mode: "tangent", refs: [{ face: HOLE_WALL }, { datum: "Top" }] }).errors.join(" ")).toMatch(/not parallel to the cylinder's axis/);
    expect(plane({ mode: "tangent", refs: [{ face: TOP_FACE }, { datum: "Front" }] }).errors.join(" ")).toMatch(/cylindrical face/);
  });

  it("half way between the hole's centre and the origin", () => {
    const p = built({ mode: "betweenPoints", refs: [{ edge: HOLE_RIM, at: "center" }, { datum: "Origin" }] });
    expect(at(p, [15, 0, 3])).toBeCloseTo(0, 6);
    close(p.normal.map(Math.abs) as Vec3, unit([30, 0, 6]));
  });

  it("best fit through four points", () => {
    const p = built({ mode: "bestFit", refs: [{ point: [0, 0, 0] }, { point: [10, 0, 0.2] }, { point: [10, 10, 0] }, { point: [0, 10, 0.2] }] });
    close(p.origin, [5, 5, 0.1]);
    expect(allErrors(validateDocument({ ...bracket, features: [...bracket.features, { id: "p", op: "plane", mode: "bestFit", refs: [{ point: [0, 0, 0] }, { point: [1, 0, 0] }] }] })).join(" ")).toMatch(/takes 3 or 8 references/);
  });

  it("the part's centre planes: x = 0 across Right, y = 0 across Front, z = 3 across Top", () => {
    expect(at(built({ mode: "centre", refs: [{ datum: "Right" }] }), [0, 7, 1])).toBeCloseTo(0, 6);
    expect(at(built({ mode: "centre", refs: [{ datum: "Front" }] }), [9, 0, 1])).toBeCloseTo(0, 6);
    expect(at(built({ mode: "centre", refs: [{ datum: "Top" }] }), [9, 4, 3])).toBeCloseTo(0, 6);
    expect(plane({ mode: "centre", refs: [{ datum: "Top" }], body: "nope" }).errors.join(" ")).toMatch(/no body "nope"/);
  });

  it("a field one mode uses is refused on another", () => {
    const errs = allErrors(validateDocument({ ...bracket, features: [...bracket.features, { id: "p", op: "plane", mode: "offset", refs: [{ datum: "Top" }], back: true }] }));
    expect(errs.join(" ")).toMatch(/back: only mode "tangent" uses it/);
  });
});

describe("snapping to midpoints and centres", () => {
  it("is on when points are asked for without both faces and edges, off otherwise", () => {
    expect(snapPoints(new Set(["vertices"]))).toBe(true);
    expect(snapPoints(new Set(["vertices", "edges", "planes"]))).toBe(true);
    expect(snapPoints(new Set(["faces", "vertices"]))).toBe(true);
    expect(snapPoints(new Set(["faces", "edges", "vertices", "planes"]))).toBe(false);
    expect(snapPoints(new Set())).toBe(false);
  });
});
