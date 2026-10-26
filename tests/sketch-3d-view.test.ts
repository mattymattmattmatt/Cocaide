// Sketching in the 3D view (Phase P wave 2A): the plane's affine map to the
// screen from the view's orthographic camera (and back), when the plane is
// facing, turned or edge-on; the plane's extent and the page's framing; what
// the pointer is on in a turned view as the sketch's stand-in (a model edge,
// its end, another sketch's entity, a round face's axis, a face to convert);
// the selection box in screen pixels; "Section at sketch plane".

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { SketchEntity, Vec2, Vec3 } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { planeFrame, to2D, to3D, type Frame } from "../src/geom/frame";
import { describeEdges, describeFaces, loadOC, rebuild, scoped, tessellate, type OC } from "../src/kernel";
import type { MeshData } from "../src/kernel/mesh";
import type { EdgeInfo, FaceInfo } from "../src/kernel/topology";
import { materialize, modelEdge, modelView, type ModelView } from "../src/ui/sketcher/model";
import { namer, referenceName } from "../src/ui/sketcher/names";
import {
  boxOf,
  EDGE_ON_DEG,
  flatMap,
  mapPoint,
  mapVector,
  planeBounds,
  planeMap,
  screenDistance,
  sketchPlaneSection,
  sketchWorldPoints,
  svgMatrix,
  toScreen,
  unmapPoint,
  visibleBounds,
  type ViewCamera,
} from "../src/ui/sketcher/planeView";
import { alongAxis, boxPick, cylinderOutline, nearer, otherSketchAt, PICK_PX, standInFor, type SceneHit } from "../src/ui/sketcher/scenePick";
import { facingFit, planeRect } from "../src/ui/viewport/sketchStage";
import { REFERENCE } from "../src/mcp/reference";

const close = (a: readonly number[], b: readonly number[], digits = 9) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i], digits));
};
const deg = (d: number) => (d * Math.PI) / 180;
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const n = Math.hypot(...a);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** Front (XZ), the plane y = 0 seen from -Y: x along +X, y along +Z. It runs through the bracket's hole axis (x = 30). */
const FRONT = planeFrame([0, -1, 0], [0, 0, 0], [1, 0, 0]);
/** On the bracket's top face (z = 6). */
const TOP6 = planeFrame([0, 0, 1], [0, 0, 6]);

/** An orthographic camera looking along `forward` (world), up as near `upHint` as it can be. */
function camera(forward: Vec3, upHint: Vec3, opts: { target?: Vec3; wpp?: number; width?: number; height?: number } = {}): ViewCamera {
  const f = norm(forward);
  const right = norm(cross(f, upHint));
  const up = cross(right, f);
  return { right, up, forward: f, target: opts.target ?? [0, 0, 0], wpp: opts.wpp ?? 0.25, width: opts.width ?? 800, height: opts.height ?? 600, sketches: true };
}

/** Square onto Front from -Y, as the sketch opens: right +X, up +Z. */
const facingFront = (target: Vec3 = [10, 0, 3], wpp = 0.5) => camera([0, 1, 0], [0, 0, 1], { target, wpp });
/** Front turned: the line of sight `tilt` degrees off the plane's normal (about Z), then lifted 20°. */
const turnedFront = (tilt = 35, lift = 20) => camera([Math.sin(deg(tilt)) * Math.cos(deg(lift)), Math.cos(deg(tilt)) * Math.cos(deg(lift)), -Math.sin(deg(lift))], [0, 0, 1], { target: [15, 0, 5], wpp: 0.2 });

// ------------------------------------------------------------------ the plane's map

describe("the sketch plane on the screen: an affine map from the orthographic camera", () => {
  it("facing the plane, it is the flat page: x right, y up, 1/wpp pixels per mm, the view's target in the middle", () => {
    const m = planeMap(facingFront(), FRONT);
    close([m.a, m.b, m.c, m.d], [2, 0, 0, -2]);
    // The plane's origin (world 0,0,0) is 10 mm left of and 3 mm below the target.
    close([m.e, m.f], [400 - 20, 300 + 6]);
    expect(m.scale).toBeCloseTo(2, 12);
    expect(m.facing).toBe(true);
    expect(m.edgeOn).toBe(false);
    close(mapPoint(m, [10, 3]), [400, 300]);
    expect(svgMatrix(m)).toBe("matrix(2 0 0 -2 380 306)");
    // The flat page before the view reports its camera is the same map.
    const flat = flatMap(10, 3, 2, 800, 600);
    close([flat.a, flat.b, flat.c, flat.d, flat.e, flat.f], [m.a, m.b, m.c, m.d, m.e, m.f]);
  });

  it("turned, a sketch point lands where the 3D view draws it, and the inverse map gives it back", () => {
    const cam = turnedFront();
    const m = planeMap(cam, FRONT);
    expect(m.facing).toBe(false);
    expect(m.edgeOn).toBe(false);
    for (const p of [[0, 0], [30, 6], [-40, 12.5], [7.25, -3]] as Vec2[]) {
      close(mapPoint(m, p), toScreen(cam, to3D(FRONT, p)), 9);
      close(unmapPoint(m, ...mapPoint(m, p))!, p, 9);
    }
    // A displacement maps without the offset.
    close(mapVector(m, [10, 0]), [mapPoint(m, [10, 0])[0] - m.e, mapPoint(m, [10, 0])[1] - m.f]);
    // Its local scale: the area shrinks with the cosine of the tilt.
    expect(m.facingCos).toBeCloseTo(Math.abs(cam.forward[1]), 12);
    expect(m.scale).toBeCloseTo(Math.sqrt(m.facingCos) / cam.wpp, 9);
    // The part of the plane the screen shows: the screen's corners mapped back.
    const seen = visibleBounds(m, 800, 600)!;
    for (const [x, y] of [[0, 0], [800, 0], [0, 600], [800, 600]]) {
      const p = unmapPoint(m, x, y)!;
      expect(p[0]).toBeGreaterThanOrEqual(seen.min[0] - 1e-9);
      expect(p[1]).toBeLessThanOrEqual(seen.max[1] + 1e-9);
    }
  });

  it("within 0.5° of square on it faces the plane; under 10° to the line of sight it is edge-on (drawing pauses); exactly edge-on it has no inverse", () => {
    // `off`: degrees between the line of sight and the plane's normal.
    const at = (off: number) => planeMap(camera([Math.sin(deg(off)), Math.cos(deg(off)), 0], [0, 0, 1]), FRONT);
    expect(at(0.3).facing).toBe(true);
    expect(at(1).facing).toBe(false);
    expect(at(90 - EDGE_ON_DEG - 1).edgeOn).toBe(false);
    expect(at(90 - EDGE_ON_DEG + 1).edgeOn).toBe(true);
    expect(at(85).edgeOn).toBe(true);
    const flat = at(90);
    expect(flat.edgeOn).toBe(true);
    expect(unmapPoint(flat, 400, 300)).toBeNull();
    expect(visibleBounds(flat, 800, 600)).toBeNull();
    // From behind (the normal pointing away), the map mirrors but the plane still faces the view.
    const behind = planeMap(camera([0, -1, 0], [0, 0, 1]), FRONT);
    expect(behind.facing).toBe(true);
    expect(behind.a * behind.d - behind.b * behind.c).toBeGreaterThan(0);
  });

  it("a screen point's distance from a screen polyline, and where along it", () => {
    expect(screenDistance([5, 3], [[0, 0], [10, 0]])).toEqual({ d: 3, segment: 0, t: 0.5 });
    expect(screenDistance([13, 4], [[0, 0], [10, 0], [10, 10]]).d).toBeCloseTo(3, 12);
    expect(screenDistance([3, 4], [[0, 0]]).d).toBe(5);
  });
});

// ------------------------------------------------------------------ framing and the plane drawn

describe("the plane drawn in 3D, the grid's extent and the page's framing", () => {
  it("the plane's extent: the part's box and the sketch seen square on, an eighth bigger (10 mm at least); round the origin with nothing", () => {
    const box = boxOf([[-40, -20, 0], [40, 20, 6]]);
    expect(box).toHaveLength(24);
    const b = planeBounds(TOP6, box);
    close(b.min, [-50, -30]);
    close(b.max, [50, 30]);
    expect(planeBounds(TOP6, [])).toEqual({ min: [-10, -10], max: [10, 10] });
    // A big part: an eighth of its size.
    const big = planeBounds(FRONT, boxOf([[0, -5, 0], [400, 5, 100]]));
    close(big.min, [-50, -50]);
    close(big.max, [450, 150]);
    // The 3D rectangle is the same extent, on the plane, counter-clockwise.
    const rect = planeRect(TOP6, box);
    close(rect.map((p) => to2D(TOP6, p)).flat(), [-50, -30, 50, -30, 50, 30, -50, 30]);
    rect.forEach((p) => expect(p[2]).toBeCloseTo(6, 12));
    expect(boxOf([])).toEqual([]);
  });

  it("a sketch opens at the zoom the flat page had: the part and the sketch take 1/1.4 of an 800 × 600 page; 120 mm across with nothing", () => {
    const empty = facingFit(TOP6, []);
    expect(empty.wpp).toBeCloseTo(0.2, 12);
    close(empty.center, [0, 0, 6]);
    const fit = facingFit(TOP6, boxOf([[-40, -20, 0], [40, 20, 6]]));
    // 80 × 40 seen square on: 80 × 1.4 / 800 wins over 40 × 1.4 / 600.
    expect(fit.wpp).toBeCloseTo((80 * 1.4) / 800, 12);
    close(fit.center, [0, 0, 6]);
    // Small things are framed as 20 mm at least.
    expect(facingFit(TOP6, [1, 1, 6]).wpp).toBeCloseTo((20 * 1.4) / 600, 12);
  });

  it("the sketch's points in the world leave out the long reference axes; the section at the sketch plane cuts in front of it", () => {
    const ents: SketchEntity[] = [
      { id: "l1", type: "line", start: [0, 0], end: [10, 0] },
      { id: "p1", type: "point", at: [5, 5] },
      { id: "ax", type: "line", start: [-500, 0], end: [500, 0], ref: { datum: "X" }, construction: true },
      { id: "fx", type: "line", start: [30, -500], end: [30, 500], ref: { face: { type: "cylinder", pick: "largest" } }, construction: true } as SketchEntity,
    ];
    const pts = sketchWorldPoints(ents, TOP6);
    expect(pts).toEqual([0, 0, 6, 10, 0, 6, 5, 5, 6]);
    const s = sketchPlaneSection(TOP6);
    expect(s.on).toBe(true);
    expect(s.planes).toHaveLength(1);
    close(s.planes[0].normal, [0, 0, 1]);
    close(s.planes[0].origin, [0, 0, 6]);
    expect(s.planes[0].offset).toBeGreaterThan(0);
    expect(s.planes[0].offset).toBeLessThan(0.01);
  });
});

// ------------------------------------------------------------------ the bracket, picked in a turned view

const bracket: RawDocument = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8"));
let oc: OC;
let part: { mesh: MeshData; faces: FaceInfo[]; edges: EdgeInfo[] };
let front: ModelView;
let top: ModelView;

/** Another sketch, 20 above Top: a 20 mm line along X from the origin, and a point. */
const ABOVE = planeFrame([0, 0, 1], [0, 0, 20]);
const other = { id: "sketch_9", ok: true, frame: ABOVE, entities: [{ id: "l1", type: "line", start: [0, 0], end: [20, 0] }, { id: "p1", type: "point", at: [-10, 5] }] as SketchEntity[] };

beforeAll(async () => {
  oc = await loadOC();
  const r = rebuild(bracket, oc);
  try {
    const mesh = tessellate(oc, r.solid!);
    const topo = scoped((s) => {
      const f = describeFaces(oc, s, r.solid!);
      return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
    });
    part = { mesh, ...topo };
    front = modelView({ ...part, sketches: [other] }, FRONT);
    top = modelView(part, TOP6);
  } finally {
    r.dispose();
  }
});

const hit = (h: ReturnType<typeof standInFor>): SceneHit => {
  expect(h && "item" in h).toBe(true);
  return h as SceneHit;
};

describe("what the pointer is on in a turned view, as the sketch's stand-in", () => {
  it("a model edge off the plane is its stand-in ('@e<index>'), landing where the hit carried square onto the plane lands", () => {
    const cam = turnedFront();
    // The plate's top back edge: y = 20, z = 6, along X; not in Front.
    const edge = front.edges.find((e) => e.entity?.type === "line" && e.poly3.every((p) => Math.abs(p[1] - 20) < 1e-6 && Math.abs(p[2] - 6) < 1e-6))!;
    expect(edge.inPlane).toBe(false);
    const point: Vec3 = [12, 20, 6];
    const h = hit(standInFor({ kind: "edge", index: edge.index, point }, front, cam, toScreen(cam, point)));
    expect(h.item).toEqual({ kind: "entity", id: `@e${edge.index}` });
    expect(h.standIn).toBe(edge.entity);
    close(h.at, [12, 6]);
    expect(h.px).toBeCloseTo(0, 6);
    expect(h.model).toBe(true);
    expect(h.poly3).toBe(edge.poly3);
    // Its end (a vertex the view picked) is the stand-in's end.
    const v = hit(standInFor({ kind: "vertex", edge: edge.index, at: "start", point: edge.poly3[0] }, front, cam, toScreen(cam, edge.poly3[0])));
    expect(v.item).toEqual({ kind: "point", ref: `@e${edge.index}.start` });
    expect(v.at).toEqual((edge.entity as { start: Vec2 }).start);
    // Nothing, or a datum, is nothing.
    expect(standInFor(null, front, cam, [0, 0])).toBeNull();
    expect(standInFor({ kind: "datum", id: "Top", point: [0, 0, 0] }, front, cam, [0, 0])).toBeNull();
  });

  it("an edge the sketch can't reference (seen end-on) is a miss with the reason, for the tip", () => {
    const cam = camera([1, 1, -1], [0, 0, 1]);
    const upright = top.edges.find((e) => !e.entity)!;
    const m = standInFor({ kind: "edge", index: upright.index, point: upright.poly3[0] }, top, cam, [0, 0]);
    expect(m && "problem" in m && m.problem).toMatch(/square to the sketch plane/);
  });

  it("a round face stands for its axis when picking ('@f<face>'), with the cylinder's outline as the view shows it; drawing, it is nothing", () => {
    const cam = turnedFront();
    expect(front.axes).toHaveLength(1);
    const axis = front.axes[0];
    expect(axis.id).toBe(`@f${axis.axisOf!.face}`);
    const point: Vec3 = [30 - 3.3, 0.5, 2];
    const pick = { kind: "face" as const, index: axis.axisOf!.face, point };
    expect(standInFor(pick, front, cam, toScreen(cam, point))).toBeNull();
    const h = hit(standInFor(pick, front, cam, toScreen(cam, point), { axes: true }));
    expect(h.item).toEqual({ kind: "entity", id: axis.id });
    // The hole's axis, x = 30, drawn long enough to cross the part.
    const line = h.standIn as Extract<SketchEntity, { type: "line" }>;
    expect(line.type).toBe("line");
    expect(line.start[0]).toBeCloseTo(30, 9);
    expect(line.end[0]).toBeCloseTo(30, 9);
    expect(Math.abs(line.end[1] - line.start[1])).toBeGreaterThan(100);
    // A weak hit: an edge or another sketch's entity near the pointer wins.
    expect(h.px).toBe(PICK_PX);
    close(h.at, [30, 2]);
    expect(h.outline3).toHaveLength(2);
    for (const side of h.outline3!) for (const p of side) expect(Math.hypot(p[0] - 30, p[1])).toBeCloseTo(3.3, 9);
    // Seen from Top the axis is square to the sketch: a miss that says so.
    const fromTop = standInFor({ kind: "face", index: axis.axisOf!.face, point: [26.7, 0, 3] }, top, camera([1, 1, -1], [0, 0, 1]), [0, 0], { axes: true });
    expect(fromTop && "problem" in fromTop && fromTop.problem).toMatch(/square to the sketch plane/);
  });

  it("Convert Entities picks a face along the sketch, nothing else", () => {
    const cam = camera([1, 1, -1], [0, 0, 1]);
    const face = top.faces.find((f) => f.inPlane)!;
    const h = hit(standInFor({ kind: "face", index: face.index, point: [0, 0, 6] }, top, cam, [0, 0], { faces: true }));
    expect(h.item).toEqual({ kind: "face", index: face.index });
    expect(h.standIn).toBeNull();
    const notAlong = part.faces.find((f) => !top.faces.some((g) => g.index === f.index))!;
    expect(standInFor({ kind: "face", index: notAlong.index, point: [0, 0, 0] }, top, cam, [0, 0], { faces: true })).toBeNull();
  });

  it("another sketch's entities are hit on the screen: its ends and points first, then the entity; a model edge wins a near tie", () => {
    const cam = turnedFront();
    const mid = toScreen(cam, [10, 0, 20]);
    const h = otherSketchAt(front, cam, mid)!;
    expect(h.item).toEqual({ kind: "entity", id: "@s:sketch_9:l1" });
    expect(h.model).toBe(false);
    close(h.at, [10, 20]);
    expect(h.px).toBeCloseTo(0, 6);
    const end = toScreen(cam, [20, 0, 20]);
    expect(otherSketchAt(front, cam, [end[0] + 3, end[1]])!.item).toEqual({ kind: "point", ref: "@s:sketch_9:l1.end" });
    const pt = toScreen(cam, [-10, 5, 20]);
    expect(otherSketchAt(front, cam, pt)!.item).toEqual({ kind: "point", ref: "@s:sketch_9:p1.at" });
    expect(otherSketchAt(front, cam, [mid[0], mid[1] + 40])).toBeNull();
    expect(otherSketchAt(front, cam, mid, () => true)).toBeNull();
    // The model wins within 1.5 px; otherwise the nearer.
    const model = { ...h, model: true, px: 2 };
    const sketch = { ...h, px: 1 };
    expect(nearer(model, sketch)).toBe(model);
    expect(nearer({ ...model, px: 5 }, sketch)).toBe(sketch);
    expect(nearer(null, sketch)).toBe(sketch);
    expect(nearer(model, null)).toBe(model);
  });

  it("a round face's axis: the point of it nearest a hit, and the cylinder's outline square to the view (none looking along it)", () => {
    const c = front.axes[0].axisOf!;
    const near = alongAxis(c, [33, 2, 3]);
    close(near.slice(0, 2), [30, 0]);
    expect(near[2]).toBeCloseTo(3, 9);
    // Held within the face's length.
    expect(alongAxis(c, [30, 0, 50])[2]).toBeCloseTo(6, 9);
    expect(alongAxis(c, [30, 0, -50])[2]).toBeCloseTo(0, 9);
    expect(cylinderOutline(c, [0, 0, -1])).toEqual([]);
    const sides = cylinderOutline(c, [0, 1, 0]);
    expect(sides.map((l) => l[0][0]).sort((a, b) => a - b)).toEqual([expect.closeTo(26.7, 9), expect.closeTo(33.3, 9)]);
  });
});

describe("a round face's axis as a sketch reference", () => {
  it("picked, it becomes a construction line referencing the face ({ face }: its axis), named for what it is; the rebuild projects it", () => {
    const id = front.axes[0].id;
    expect(namer([], front).entity(id)).toBe("axis of a round face (Ø6.6)");
    const made = materialize([id], front, []);
    expect(typeof made).not.toBe("string");
    if (typeof made === "string") return;
    expect(made.added).toHaveLength(1);
    const ref = made.added[0];
    expect(ref.type).toBe("line");
    expect(ref.ref && "face" in ref.ref).toBe(true);
    expect(ref.construction).toBeUndefined();
    expect(referenceName(ref)).toBe("axis of a round face");
    // Picked again, it is the same reference.
    const again = materialize([id], front, made.entities);
    expect(typeof again !== "string" && again.added).toEqual([]);
    // In the document: valid, and the rebuild draws it along the hole's axis.
    const d = { ...bracket, features: [...bracket.features, { id: "sk", op: "sketch", plane: { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] }, entities: made.entities, constraints: [] }] };
    expect(allErrors(validateDocument(d))).toEqual([]);
    const r = rebuild(d, oc);
    try {
      expect(r.errors).toEqual([]);
      const e = r.sketches.find((s) => s.id === "sk")!.entities[0] as Extract<SketchEntity, { type: "line" }>;
      expect(e.start[0]).toBeCloseTo(30, 6);
      expect(e.end[0]).toBeCloseTo(30, 6);
    } finally {
      r.dispose();
    }
    // A face is no circle's reference.
    const bad = { ...d, features: [...bracket.features, { id: "sk", op: "sketch", plane: { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] }, entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 1, ref: ref.ref }] }] };
    expect(allErrors(validateDocument(bad)).join("\n")).toMatch(/a face \(pick one of its edges\)/);
    expect(REFERENCE).toMatch(/"ref": \{ "face": <cylindrical face selector> \}/);
  });

  it("the stand-in is found by its id, as other stand-ins are", () => {
    const axis = front.axes[0];
    expect(modelEdge(front, axis.id)).toBe(axis);
    expect(modelEdge(front, `${axis.id}.start`)).toBe(axis);
    expect(modelEdge(front, "@f999")).toBeUndefined();
  });
});

// ------------------------------------------------------------------ the selection box

describe("the selection box, in screen pixels", () => {
  const ents: SketchEntity[] = [
    { id: "l1", type: "line", start: [0, 0], end: [10, 0] },
    { id: "c1", type: "circle", center: [50, 0], radius: 5 },
    { id: "p1", type: "point", at: [20, 20] },
  ];
  it("left to right takes what is wholly inside; right to left also what it crosses", () => {
    expect(boxPick(ents, [-1, -1], [11, 1])).toEqual([{ kind: "entity", id: "l1" }]);
    expect(boxPick(ents, [-1, -1], [5, 1])).toEqual([]);
    expect(boxPick(ents, [5, 1], [-1, -1])).toEqual([{ kind: "entity", id: "l1" }]);
    // Crossing the circle's rim with no point inside the box.
    expect(boxPick(ents, [56, -1], [54, 1]).map((i) => (i as { id: string }).id)).toEqual(["c1"]);
    expect(boxPick(ents, [19, 19], [21, 21])).toEqual([{ kind: "entity", id: "p1" }]);
  });

  it("through the plane's map: a box over the turned sketch takes what it covers on the screen", () => {
    const m = planeMap(turnedFront(), FRONT);
    const on = (p: Vec2) => mapPoint(m, p);
    const [a, b] = [on([0, 0]), on([10, 0])];
    const pad = 2;
    const lo: Vec2 = [Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad];
    const hi: Vec2 = [Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad];
    expect(boxPick(ents, lo, hi, on)).toEqual([{ kind: "entity", id: "l1" }]);
  });
});

/** Frames are what the doc's planes make: Front's x is +X, its y +Z. */
it("Front's frame is x along +X, y along +Z (the tests above lean on it)", () => {
  const f: Frame = FRONT;
  close(f.x, [1, 0, 0]);
  close(f.y, [0, 0, 1]);
});
