// plane: a reference plane (DESIGN §2.2), made from other reference geometry
// in one of six ways; it makes no body. Sketches, mirrors and splits stand on
// it by { "datum": "<id>" }, and it follows what it was made from: a plane
// offset from a face moves when the face does.

import type { DatumRef, FeatureBase } from "../../doc/types";
import { askFromRefs, checkModeRefs, datumRefsAt, modeTakes, type ModeSpec } from "../datum";
import type { FeatureDef } from "../defs";

export const PLANE_MODES = [
  "offset",
  "parallelThroughPoint",
  "angle",
  "threePoints",
  "midplane",
  "normalToEdge",
  "lineAndPoint",
  "twoLines",
  "perpendicular",
  "tangent",
  "betweenPoints",
  "bestFit",
  "centre",
] as const;
export type PlaneMode = (typeof PLANE_MODES)[number];

export interface PlaneFeature extends FeatureBase {
  op: "plane";
  /** How it is made (default "offset"). */
  mode: PlaneMode;
  /** What it is made from, in the mode's order. */
  refs: DatumRef[];
  /** offset: mm along the reference plane's normal (negative: behind it). Default 0. */
  distance?: number;
  /** angle: degrees about the axis, right-handed about its direction. */
  angle?: number;
  /** normalToEdge: where along the edge, 0 (its start, the default) to 1 (its end). */
  t?: number;
  /** tangent: on the far side of the cylinder (the side away from the plane's normal, or from the point). */
  back?: boolean;
  /** centre: the body whose middle it goes through (default the whole part). */
  body?: string;
  /** Turned over: the normal reversed (its x kept). */
  flip?: boolean;
}

const PLANE: { what: string; kinds: ["plane"] } = { what: "a plane (a default plane, a plane feature or a flat face)", kinds: ["plane"] };
const POINT: { what: string; kinds: ["point"] } = { what: "a point (a vertex, an edge's midpoint, a circle's centre, a point feature, the origin or [x, y, z])", kinds: ["point"] };
const LINE: { what: string; kinds: ["axis"] } = { what: "a straight line (a straight edge, an axis feature, X, Y or Z, or a sketch line)", kinds: ["axis"] };
/** The most points a best-fit plane takes. */
export const BEST_FIT_MAX = 8;

/** What each mode takes. */
export const PLANE_MODE_SPECS: Readonly<Record<PlaneMode, ModeSpec>> = {
  offset: { refs: [PLANE], fields: ["distance"], about: "parallel to a plane or flat face, `distance` mm along its normal" },
  angle: {
    refs: [PLANE, { what: "an axis in the plane or parallel to it (a straight edge, an axis feature, X, Y or Z)", kinds: ["axis"] }],
    fields: ["angle"],
    about: "through an axis, at `angle` degrees to a plane the axis lies in (or runs parallel to)",
  },
  threePoints: { refs: [POINT, POINT, POINT], fields: [], about: "through three points" },
  midplane: { refs: [PLANE, PLANE], fields: [], about: "half way between two parallel planes or faces, or the plane that halves the angle of two that meet" },
  normalToEdge: {
    refs: [{ what: "an edge (straight, round or curved), an axis, or a sketch's line, arc or circle", kinds: ["axis"], forms: ["edge", "datum", "sketch"], wholeEdge: true }, POINT],
    optional: 1,
    fields: ["t"],
    about: "square to an edge (or a sketch's line, arc or circle), at `t` along it (0 its start, 1 its end), or through a point refs[1]",
  },
  parallelThroughPoint: { refs: [PLANE, POINT], fields: [], about: "parallel to a plane, through a point (a face and an edge's midpoint: parallel to the face, through the middle of the edge)" },
  lineAndPoint: { refs: [LINE, POINT], fields: [], about: "through a straight line and a point off it" },
  twoLines: {
    refs: [LINE, { ...LINE, what: "a second straight line, crossing the first or parallel to it" }],
    fields: [],
    about: "through two straight lines that cross or run parallel (the plane holding both); two that do neither: through the first, parallel to the second",
  },
  perpendicular: {
    refs: [LINE, PLANE],
    fields: [],
    about: "through a straight line, square to a plane or flat face (an edge of a face and that face: the plane standing up along the edge)",
  },
  tangent: {
    refs: [
      { what: "a round face (a cylinder)", kinds: ["axis"], forms: ["face"] },
      { what: "a plane parallel to the cylinder's axis (the tangent plane is parallel to it), or a point (the plane touches the cylinder where the line from the axis through the point meets it)", kinds: ["plane", "point"] },
    ],
    fields: ["back"],
    about: "tangent to a cylinder: parallel to a plane, on the side its normal points to (back: the other side), or touching it nearest a point",
  },
  betweenPoints: { refs: [POINT, POINT], fields: [], about: "half way between two points, square to the line joining them (the plane of symmetry of two holes or vertices)" },
  bestFit: {
    refs: Array.from({ length: BEST_FIT_MAX }, (_, i) => (i === 0 ? POINT : { ...POINT, what: `point ${i + 1}` })),
    optional: BEST_FIT_MAX - 3,
    fields: [],
    about: `the plane that best fits 3 to ${BEST_FIT_MAX} points (least squares: the one nearest all of them; through them when they lie on one plane)`,
  },
  centre: {
    refs: [PLANE],
    fields: ["body"],
    about: "parallel to a plane, through the middle of the part (or of one body, `body`): the plane of symmetry of its bounding box",
  },
};

export const def: FeatureDef<PlaneFeature> = {
  op: "plane",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "mode", "refs", "distance", "angle", "t", "back", "body", "flip"]);
    const mode = raw.mode === undefined ? "offset" : x.oneOf(raw, "mode", "", PLANE_MODES);
    if (!mode) return null;
    const refs = checkModeRefs(raw, c, x, "plane", mode, PLANE_MODE_SPECS);
    const distance = raw.distance === undefined ? undefined : c.num(raw, "distance", "", {});
    let angle: number | undefined;
    if (mode === "angle") {
      if (raw.angle === undefined) c.fail("angle", "needed: degrees to turn the plane about the axis refs[1] (0 lies in refs[0])");
      else angle = c.num(raw, "angle", "", {});
    }
    let t: number | undefined;
    if (raw.t !== undefined && mode === "normalToEdge") {
      t = c.num(raw, "t", "", {});
      if (t !== undefined && (t < 0 || t > 1)) c.fail("t", `must be from 0 (the edge's start) to 1 (its end) (got ${t})`);
      if (Array.isArray(raw.refs) && raw.refs.length > 1) c.fail("t", "give t or a point refs[1] to place the plane, not both");
      else if (refs?.[0] && "datum" in refs[0]) c.fail("t", `${refs[0].datum} is an axis, endless: place the plane with a point refs[1] instead (without one it goes through the axis's origin)`);
    }
    const flip = x.bool(raw, "flip", "");
    const back = x.bool(raw, "back", "");
    let body: string | undefined;
    if (raw.body !== undefined) {
      if (typeof raw.body !== "string" || !raw.body.trim()) c.fail("body", `must be a body's name (got ${x.describe(raw.body)})`);
      else body = raw.body;
    }
    if (c.errors.length || !refs) return null;
    return {
      id: raw.id as string,
      op: "plane",
      mode,
      refs,
      ...(distance !== undefined ? { distance } : {}),
      ...(angle !== undefined ? { angle } : {}),
      ...(t !== undefined ? { t } : {}),
      ...(back ? { back } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(flip ? { flip } : {}),
    };
  },
  datumRefs: (raw) => datumRefsAt(raw, "refs"),
  measurementKeys: ["distance", "angle", "t"],
  askFrom: (f, target, k) => askFromRefs(f, target, k, "plane"),
  reference: `## plane
{ "id": "plane_1", "op": "plane", "mode": "offset", "refs": [{ "datum": "Top" }], "distance": 20 }
A reference plane: it makes no body. Sketches stand on it ("plane": { "type": "ref", "ref": { "datum": "plane_1" } }),
mirrors and splits too, and other planes, axes and points can be made from it. It follows what it was made from (a
plane offset from a face moves when an earlier feature moves the face). "refs" are references (see References below);
"flip": true turns it over (normal reversed). "mode" (default "offset") and what each takes:
${PLANE_MODES.map((m) => `  "${m}": ${PLANE_MODE_SPECS[m].about}; refs: ${modeTakes(PLANE_MODE_SPECS[m])}`).join("\n")}
Signs: an offset "distance" is along the reference's normal (Top's is +Z), negative goes behind it. An "angle" turns the
plane right-handed about the axis's direction (thumb along it): 30 about X from Top gives the normal [0, -0.5, 0.866].
threePoints: the normal is (p2 - p1) x (p3 - p1), x runs from p1 to p2. midplane of two faces of a 6 mm plate: z = 3.
Examples:
  { "id": "plane_2", "op": "plane", "mode": "angle", "refs": [{ "datum": "Top" }, { "edge": { "type": "edge", "kind": "line", "direction": [1,0,0], "pick": "all", "near": [0,-20,6] } }], "angle": 30 }
  { "id": "mid", "op": "plane", "mode": "midplane", "refs": [{ "face": { "type": "planar", "normal": [0,0,1], "pick": "largest" } }, { "face": { "type": "planar", "normal": [0,0,-1], "pick": "largest" } }] }
  { "id": "across", "op": "plane", "mode": "normalToEdge", "refs": [{ "edge": { "type": "edge", "kind": "line", "pick": "longest" } }], "t": 0.5 }
  Parallel to the top face, through the middle of an edge (a point may be an edge's "mid", a circle's "center", a vertex's "start"/"end"):
  { "id": "half", "op": "plane", "mode": "parallelThroughPoint", "refs": [{ "face": { "type": "planar", "normal": [0,0,1], "pick": "largest" } }, { "edge": { "type": "edge", "kind": "line", "direction": [0,0,1], "pick": "longest" }, "at": "mid" }] }
  { "id": "stand", "op": "plane", "mode": "perpendicular", "refs": [{ "edge": { "type": "edge", "kind": "line", "direction": [1,0,0], "pick": "all", "near": [0,-20,6] } }, { "face": { "type": "planar", "normal": [0,0,1], "pick": "largest" } }] }
  { "id": "touch", "op": "plane", "mode": "tangent", "refs": [{ "face": { "type": "cylinder", "pick": "largest" } }, { "datum": "Front" }] }
  { "id": "sym", "op": "plane", "mode": "betweenPoints", "refs": [{ "edge": { "type": "edge", "kind": "circle", "pick": "all", "near": [-30,0,6] }, "at": "center" }, { "edge": { "type": "edge", "kind": "circle", "pick": "all", "near": [30,0,6] }, "at": "center" }] }
  { "id": "middle", "op": "plane", "mode": "centre", "refs": [{ "datum": "Right" }] }   (the part's plane of symmetry across X)
Sketch on it, then extrude: the body sits on the plane.
  { "id": "sketch_2", "op": "sketch", "plane": { "type": "ref", "ref": { "datum": "plane_1" } }, "entities": [{ "id": "c1", "type": "circle", "center": [0,0], "radius": 5 }] }
A plane that cannot be made says what to pick instead (an angle axis not in the plane, three points on one line).
`,
};
