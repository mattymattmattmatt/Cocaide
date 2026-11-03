// Dimensioning and relating to a model edge in a sketch (as a fabricator
// expects from a desktop CAD sketcher): what is under the pointer — a point
// wins over the edge or line it is on only right by it, so the middle of a
// short edge seen zoomed out is still the edge; an edge seen end-on stands
// for the point it projects to; a sketch hidden under the part is not
// hovered — and the dimension made: a line's parallel distance to a model
// edge, a point's distance to one, each with the reference the sketch keeps.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { Constraint, SketchEntity, Vec2, Vec3 } from "../src/doc/types";
import { isConstruction } from "../src/doc/sketch";
import { withAxes } from "../src/geom/axes";
import { planeFrame } from "../src/geom/frame";
import { solveSketch } from "../src/geom/solver";
import { describeEdges, describeFaces, loadOC, rebuild, scoped, tessellate, type OC } from "../src/kernel";
import { smartDimension, suggestions } from "../src/ui/sketcher/draft";
import { materialize, modelEntities, modelIdsOf, modelView, renamed, type ModelView } from "../src/ui/sketcher/model";
import { toScreen, type ViewCamera } from "../src/ui/sketcher/planeView";
import { behind, edgeAtVertex, entityLength, otherSketchAt, otherSketchMiss, pointWins, standInFor, VERTEX_NEAR_PX, type SceneHit } from "../src/ui/sketcher/scenePick";

const bracket: RawDocument = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8"));
/** Front (XZ), y = 0 seen from −Y: x along +X, y along +Z. */
const FRONT = planeFrame([0, -1, 0], [0, 0, 0], [1, 0, 0]);
/** The bracket's top face, z = 6. */
const TOP6 = planeFrame([0, 0, 1], [0, 0, 6]);

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const n = Math.hypot(...a);
  return [a[0] / n, a[1] / n, a[2] / n];
};
function camera(forward: Vec3, upHint: Vec3, wpp: number, target: Vec3 = [0, 0, 0]): ViewCamera {
  const f = norm(forward);
  const right = norm(cross(f, upHint));
  return { right, up: cross(right, f), forward: f, target, wpp, width: 800, height: 600, sketches: true };
}

let oc: OC;
let front: ModelView;
let top: ModelView;
/** Under the part: the bracket's base sketch, its rectangle as lines (z = 0). */
const base = { id: "base", ok: true, frame: planeFrame([0, 0, 1], [0, 0, 0]), entities: [{ id: "l1", type: "line", start: [-40, -20], end: [40, -20] }, { id: "r1", type: "rect", center: [0, 0], w: 80, h: 40 }] as SketchEntity[] };

beforeAll(async () => {
  oc = await loadOC();
  const r = rebuild(bracket, oc);
  try {
    const mesh = tessellate(oc, r.solid!);
    const topo = scoped((s) => {
      const f = describeFaces(oc, s, r.solid!);
      return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
    });
    front = modelView({ mesh, ...topo }, FRONT);
    top = modelView({ mesh, ...topo, sketches: [base] }, TOP6);
  } finally {
    r.dispose();
  }
});

describe("a point wins over the edge it is on only right by it", () => {
  it("nothing else under the pointer: a point within reach", () => {
    expect(pointWins(7, null, 7)).toBe(true);
    expect(pointWins(7.5, null, 7)).toBe(false);
  });

  it("on a long edge: within VERTEX_NEAR_PX of its end; beyond that, the edge", () => {
    expect(VERTEX_NEAR_PX).toBe(5);
    expect(pointWins(4.9, { d: 0, lengthPx: 300 })).toBe(true);
    expect(pointWins(5.5, { d: 0, lengthPx: 300 })).toBe(false);
  });

  it("on a short edge (6 mm at 2 px/mm: 12 px): only within a quarter of it, 3 px; its middle is the edge", () => {
    expect(pointWins(2.9, { d: 0, lengthPx: 12 })).toBe(true);
    expect(pointWins(6, { d: 0, lengthPx: 12 })).toBe(false);
    // A tiny edge still lets its ends be picked, within 2 px.
    expect(pointWins(1.9, { d: 0, lengthPx: 4 })).toBe(true);
  });

  it("the pointer beyond the edge's end (as near the point as the edge): the point", () => {
    expect(pointWins(6, { d: 6, lengthPx: 300 })).toBe(true);
  });

  it("lengths: a line's, a circle's circumference", () => {
    expect(entityLength({ id: "l", type: "line", start: [0, 0], end: [3, 4] })).toBeCloseTo(5, 9);
    expect(entityLength({ id: "c", type: "circle", center: [0, 0], radius: 2 })).toBeCloseTo(4 * Math.PI, 1);
  });
});

describe("in a turned view, zoomed out", () => {
  /** Front turned 35° about Z and lifted 20°, 0.5 mm a pixel: the bracket's 6 mm upright edges are about 12 px long. */
  const cam = camera([Math.sin(0.61) * Math.cos(0.35), Math.cos(0.61) * Math.cos(0.35), -Math.sin(0.35)], [0, 0, 1], 0.5, [15, 0, 5]);
  const upright = () => front.edges.find((e) => e.entity?.type === "line" && e.poly3.every((p) => Math.abs(p[0] - 40) < 1e-6 && Math.abs(p[1] + 20) < 1e-6))!;

  it("the view picked the vertex, the pointer is on the middle of the upright edge: the edge", () => {
    const e = upright();
    const corner: Vec3 = e.poly3[0];
    const mid: Vec3 = [40, -20, 3];
    const local = toScreen(cam, mid);
    const lengthPx = Math.hypot(...(toScreen(cam, e.poly3[0]).map((x, i) => x - toScreen(cam, e.poly3[1])[i]) as [number, number]));
    expect(lengthPx).toBeLessThan(16);
    const h = standInFor({ kind: "vertex", edge: e.index, at: "start", point: corner }, front, cam, local) as SceneHit;
    expect(h.item).toEqual({ kind: "entity", id: e.id });
    expect(h.at[0]).toBeCloseTo(40, 6);
    expect(h.at[1]).toBeCloseTo(3, 1);
    expect(edgeAtVertex(front, cam, local, corner)!.item).toEqual(h.item);
  });

  it("right by the vertex: the vertex, as before", () => {
    const e = upright();
    const corner: Vec3 = e.poly3[0];
    const [x, y] = toScreen(cam, corner);
    const h = standInFor({ kind: "vertex", edge: e.index, at: "start", point: corner }, front, cam, [x + 1, y]) as SceneHit;
    expect(h.item.kind).toBe("point");
  });
});

describe("another sketch hidden behind the part is not under the pointer", () => {
  it("behind the face the view picked, by more than a few pixels: hidden; on it: not", () => {
    const cam = camera([0.3, 0.6, -0.74], [0, 0, 1], 0.2);
    const hidden = behind([0, -10, 6], cam);
    // The base sketch's line at z = 0 is 6 mm behind the top face along the line of sight (the view looks down).
    expect(hidden([0, -10, 0])).toBe(true);
    expect(hidden([0, -10, 6])).toBe(false);
    expect(behind(null, cam)([0, 0, -100])).toBe(false);
  });

  it("hovering the top face over the base sketch: no tip about its rectangle, no hit on its line", () => {
    const cam = camera([0.3, 0.6, -0.74], [0, 0, 1], 0.2);
    // A point of the top face (z = 6) that lies, on screen, on the base sketch's front line (z = 0, y = −20).
    const onLine: Vec3 = [0, -20, 0];
    const local = toScreen(cam, onLine);
    // The top face seen there: walk back along the line of sight to z = 6.
    const t = (6 - onLine[2]) / -cam.forward[2];
    const face: Vec3 = [onLine[0] - cam.forward[0] * t, onLine[1] - cam.forward[1] * t, 6];
    expect(otherSketchAt(top, cam, local)).not.toBeNull();
    expect(otherSketchAt(top, cam, local, () => false, behind(face, cam))).toBeNull();
    expect(otherSketchMiss(top, cam, toScreen(cam, [10, 20, 0]), behind([10, 20 - 8, 6], cam))).toBeNull();
  });
});

describe("Smart Dimension and Add Relations with a model edge (on the top face)", () => {
  const own: SketchEntity = { id: "l1", type: "line", start: [-20, 6], end: [20, 6] };
  const frontEdge = () => top.edges.find((e) => e.inPlane && e.entity?.type === "line" && Math.abs((e.entity as { start: Vec2 }).start[1] + 20) < 1e-9)!;
  const pool = () => withAxes([own, ...modelEntities(top)]);

  it("a sketch line and a parallel model edge: their distance, with the edge made a construction reference; the dimension drives the line", () => {
    const edge = frontEdge();
    const offers = smartDimension(pool(), [{ kind: "entity", id: "l1" }, { kind: "entity", id: edge.id }]);
    const k = offers[0].make(12) as Constraint & { lines: [string, string] };
    expect(k).toMatchObject({ type: "distance", value: 12 });
    expect(offers[0].value).toBeCloseTo(26, 9);
    expect(k.lines).toContain(edge.id);
    // The stand-in goes into the sketch as a reference that finds the edge again.
    expect(modelIdsOf(k)).toEqual([edge.id]);
    const made = materialize(modelIdsOf(k), top, [own]);
    if (typeof made === "string") throw new Error(made);
    const ref = made.entities.find((e) => e.ref)!;
    expect(ref.type).toBe("line");
    expect(isConstruction(ref)).toBe(true);
    expect((ref.ref as { edge: unknown }).edge).toBeTruthy();
    const lifted = renamed(k, made.ids) as typeof k;
    expect(lifted.lines).toContain(ref.id);
    expect(lifted.lines).not.toContain(edge.id);
    const solved = solveSketch(made.entities, [{ type: "horizontal", entity: "l1" }, lifted]);
    if (!solved.ok) throw new Error(solved.error);
    const l1 = solved.entities.find((e: SketchEntity) => e.id === "l1") as { start: Vec2 };
    expect(l1.start[1]).toBeCloseTo(-8, 6);
  });

  it("a sketch point and a model edge: the point's distance to it", () => {
    const right = top.edges.find((e) => e.inPlane && e.entity?.type === "line" && Math.abs((e.entity as { start: Vec2 }).start[0] - 40) < 1e-9)!;
    const offers = smartDimension(pool(), [{ kind: "point", ref: "l1.end" }, { kind: "entity", id: right.id }]);
    expect(offers[0].make(5)).toMatchObject({ type: "distance", point: "l1.end", line: right.id, value: 5 });
    expect(offers[0].value).toBeCloseTo(20, 9);
  });

  it("Add Relations: a line with a model edge offers parallel, collinear and the rest; a point with it, on the edge", () => {
    const edge = frontEdge();
    const lineOffers = suggestions(pool(), [{ kind: "entity", id: "l1" }, { kind: "entity", id: edge.id }]).filter((o) => o.value === undefined).map((o) => o.label);
    expect(lineOffers).toEqual(expect.arrayContaining(["Parallel", "Collinear"]));
    const pointOffers = suggestions(pool(), [{ kind: "point", ref: "l1.start" }, { kind: "entity", id: edge.id }]).filter((o) => o.value === undefined).map((o) => o.make(0).type);
    expect(pointOffers).toContain("pointOn");
  });
});
