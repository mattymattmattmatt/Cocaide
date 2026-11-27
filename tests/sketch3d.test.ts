// The 3D sketch: points at coordinates or measured from earlier ones, lines
// between them, checked by validation; nodes that follow its points; members
// on its lines (a pitched frame) built by the real kernel, and moved by an
// edit of one offset.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { sketch3dPoint, sketch3dPositions } from "../src/geom/sketch3d";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { niceStep, rayPlane, snapToGrid, alongAxis, atLength } from "../src/ui/sketch3d/place";
import { membersFromSketch } from "../src/weldment/sketchFrame";

const table: RawDocument = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

/** A portal frame 2000 wide, posts 1500 high to the eaves, the ridge 300 above them. */
function portal(): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "portal",
    parameters: { eave: 1500 },
    profiles: structuredClone(table.profiles),
    features: [
      {
        id: "frame3d",
        op: "sketch3d",
        points: [
          { id: "p1", at: [0, 0, 0] },
          { id: "p2", from: "p1", by: [0, 0, "=eave"] },
          { id: "p3", from: "p2", by: [1000, 0, 300] },
          { id: "p4", from: "p3", by: [1000, 0, -300] },
          { id: "p5", from: "p4", by: [0, 0, "=-eave"] },
        ],
        lines: [
          { id: "l1", start: "p1", end: "p2" },
          { id: "l2", start: "p2", end: "p3" },
          { id: "l3", start: "p3", end: "p4" },
          { id: "l4", start: "p4", end: "p5" },
          { id: "l5", start: "p2", end: "p4", construction: true },
        ],
      },
    ],
  } as RawDocument;
}

describe("the 3D sketch", () => {
  it("places each point from the one it is measured from", () => {
    const r = sketch3dPositions([{ id: "a", at: [1, 2, 3] }, { id: "b", from: "a", by: [10, 0, 0] }, { id: "c", from: "b", by: [0, 0, -3] }]);
    expect(r.ok && Object.fromEntries(r.at)).toEqual({ a: [1, 2, 3], b: [11, 2, 3], c: [11, 2, 0] });
    // Unresolved expressions are not numbers: the point says so rather than guessing.
    expect(typeof sketch3dPoint(portal().features[0] as never, "p3.at")).toBe("string");
  });

  it("validates, and says what is wrong", () => {
    expect(allErrors(validateDocument(portal()))).toEqual([]);
    const bad = portal();
    const f = bad.features[0] as { points: Record<string, unknown>[]; lines: Record<string, unknown>[] };
    f.points.push({ id: "p6", from: "p9", by: [0, 0, 1] });
    f.lines.push({ id: "l6", start: "p1", end: "p1" });
    const errors = allErrors(validateDocument(bad)).join("\n");
    expect(errors).toContain('points[5].from: must name an earlier point (got "p9"');
    const bad2 = portal();
    (bad2.features[0] as { lines: Record<string, unknown>[] }).lines.push({ id: "l7", start: "p2", end: "p1" });
    expect(allErrors(validateDocument(bad2)).join("\n")).toContain("another line already joins p2 and p1");
  });

  it("a node follows one of its points, through expressions", () => {
    const doc = { ...portal(), nodes: { R: { sketch: "frame3d", point: "p3.at" }, M: { sketch: "frame3d", point: "l2.mid" } } } as RawDocument;
    const v = validateDocument(doc);
    expect(v.nodes).toEqual({ R: [1000, 0, 1800], M: [500, 0, 1650] });
  });

  it("members on its lines: shared nodes, the construction line left out, the knee and ridge mitred; an offset edited moves the frame", () => {
    const r = membersFromSketch(portal(), { size: "SHS 40x40x3", sketch: "frame3d", line: "centre" });
    if (!r.ok) throw new Error(r.error);
    expect(r.members).toHaveLength(4);
    expect(r.nodes).toHaveLength(5);
    expect(Object.values(r.doc.nodes as Record<string, { point: string }>).map((n) => n.point)).toEqual(["p1.at", "p2.at", "p3.at", "p4.at", "p5.at"]);
    expect(r.doc.features.filter((f) => f.op === "joint").map((j) => j.type)).toEqual(["mitre", "mitre", "mitre"]);
    const height = (doc: unknown) => {
      const b = rebuild(doc, oc);
      try {
        expect(b.errors).toEqual([]);
        expect(b.measurements!.bodies).toHaveLength(4);
        return Math.round(b.measurements!.boundingBox!.max[2]);
      } finally {
        b.dispose();
      }
    };
    // The ridge's centreline is at 1800; the mitred top of SHS 40 reaches a little above it.
    const before = height(r.doc);
    expect(before).toBeGreaterThan(1800);
    const raised = apply(r.doc, { type: "setParameter", name: "eave", value: 2000 });
    if (!raised.ok) throw new Error(raised.error);
    expect(height(raised.doc)).toBe(before + 500);
  });
});

describe("drawing on a work plane", () => {
  it("steps suit the zoom, the ray meets the plane through the point drawn from, and the grid snaps from it", () => {
    expect(niceStep(0.1)).toBe(2);
    expect(niceStep(0.7)).toBe(10);
    expect(niceStep(3)).toBe(50);
    expect(rayPlane([0, -100, 50], [0, 1, -1], [0, 0, 0], "XY")).toEqual([0, -50, 0]);
    expect(rayPlane([0, -100, 50], [1, 0, 0], [0, 0, 0], "XY")).toBeNull();
    expect(snapToGrid([97, 3, 41], [5, 5, 40], "XZ", 10)).toEqual([95, 5, 40]);
  });
});

describe("3D sketch points that follow other sketches", () => {
  /** A gable rafter on Front, and a purlin from halfway up it running 2000 back. */
  const doc = (ridge = 1800): RawDocument =>
    ({
      version: 1,
      units: "mm",
      name: "roof",
      profiles: structuredClone(table.profiles),
      features: [
        { id: "gable", op: "sketch", plane: { type: "ref", ref: { datum: "Front" } }, entities: [{ id: "r1", type: "line", start: [0, 1500], end: [1000, ridge] }] },
        {
          id: "purlins",
          op: "sketch3d",
          points: [
            { id: "p1", at: { sketch: "gable", point: "r1", t: 0.5 } },
            { id: "p2", from: "p1", by: [0, 2000, 0] },
            { id: "p3", at: { sketch: "gable", point: "r1.end" } },
          ],
          lines: [{ id: "l1", start: "p1", end: "p2" }],
        },
      ],
    }) as RawDocument;

  it("are where the other sketch puts them, and move with it", () => {
    const placed = (d: RawDocument) => (validateDocument(d).features.find((f) => f.id === "purlins")?.feature as { placed: Record<string, number[]> }).placed;
    expect(placed(doc())).toEqual({ p1: [500, 0, 1650], p2: [500, 2000, 1650], p3: [1000, 0, 1800] });
    // The ridge 200 higher: halfway up the rafter is 100 higher, and the purlin with it.
    expect(placed(doc(2000))).toEqual({ p1: [500, 0, 1750], p2: [500, 2000, 1750], p3: [1000, 0, 2000] });
  });

  it("say what is wrong when what they follow is gone", () => {
    const d = doc();
    (d.features[1] as { points: Record<string, unknown>[] }).points[0].at = { sketch: "gable", point: "r9", t: 0.5 };
    expect(allErrors(validateDocument(d)).join("\n")).toContain("gable has no r9");
  });

  it("members on its lines follow the gable too", () => {
    const r = membersFromSketch(doc(), { size: "SHS 40x40x3", sketch: "purlins", line: "centre" });
    if (!r.ok) throw new Error(r.error);
    const moved = { ...r.doc, features: r.doc.features.map((f) => (f.id === "gable" ? { ...f, entities: [{ id: "r1", type: "line", start: [0, 1500], end: [1000, 2000] }] } : f)) };
    const m = (d: unknown) => validateDocument(d).features.find((f) => f.feature?.op === "member")!.feature as unknown as { from: number[] };
    expect(m(r.doc).from).toEqual([500, 0, 1650]);
    expect(m(moved).from).toEqual([500, 0, 1750]);
  });
});

describe("drawing along an axis, and a typed length", () => {
  it("the pointer's ray nearest the axis through the point drawn from: how far up (or along) it is", () => {
    // Looking down 45° at the Z axis through (100, 0, 0) from in front: the ray passes (100, 0, 300) at its nearest.
    const o: [number, number, number] = [100, -1000, 1300];
    const d: [number, number, number] = [0, 1, -1];
    expect(alongAxis(o, d, [100, 0, 0], 2)).toBeCloseTo(300, 9);
    // Along X from the same point: the ray crosses x = 100 only, so nearest at 0 along it.
    expect(alongAxis(o, d, [100, 0, 0], 0)).toBeCloseTo(0, 9);
    // A ray along the axis itself: nothing to find.
    expect(alongAxis([0, 0, 0], [0, 0, 1], [0, 0, 0], 2)).toBeNull();
  });
  it("a typed length: that far from the point drawn from, toward the pointer", () => {
    expect(atLength([0, 0, 0], [0, 0, 37], 800)).toEqual([0, 0, 800]);
    expect(atLength([10, 0, 0], [13, 4, 0], 10)).toEqual([16, 8, 0]);
    expect(atLength([1, 1, 1], [1, 1, 1], 5)).toBeNull();
  });
});

describe("a 3D sketch's points and lines as references", () => {
  const withPost = (height: number) => ({
    version: 1, units: "mm", name: "refs",
    features: [
      { id: "s3", op: "sketch3d", points: [{ id: "p1", at: [100, 0, 0] }, { id: "p2", from: "p1", by: [0, 0, height] }, { id: "p3", at: [-200, 150, 0] }], lines: [{ id: "l1", start: "p1", end: "p2" }, { id: "l2", start: "p1", end: "p3" }] },
      // A plane parallel to Top through the post's top (by the point, and by the line's end), an axis along the post.
      { id: "level", op: "plane", mode: "parallelThroughPoint", refs: [{ datum: "Top" }, { sketch: "s3", entity: "p2" }] },
      { id: "level2", op: "plane", mode: "parallelThroughPoint", refs: [{ datum: "Top" }, { sketch: "s3", entity: "l1", at: "end" }] },
      { id: "post", op: "axis", mode: "edge", refs: [{ sketch: "s3", entity: "l1" }] },
      // A sketch on Top tied to the 3D sketch's floor points: a line from p3 to p1.
      { id: "floor", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: [
        { id: "l1", type: "line", start: [-200, 150], end: [100, 0] },
        { id: "a", type: "point", at: [-200, 150], ref: { sketch: "s3", entity: "p3" } },
        { id: "b", type: "point", at: [100, 0], ref: { sketch: "s3", entity: "p1" } },
      ], constraints: [{ type: "coincident", points: ["l1.start", "a.at"] }, { type: "coincident", points: ["l1.end", "b.at"] }] },
    ],
  });
  it("validate, build, and follow the 3D sketch: a plane through its point, an axis along its line, a sketch on its points", () => {
    for (const h of [500, 800]) {
      const doc = withPost(h);
      expect(allErrors(validateDocument(doc))).toEqual([]);
      const b = rebuild(doc, oc);
      try {
        expect(b.errors.filter((e) => !/no solid/.test(e))).toEqual([]);
        expect(b.datums.level).toMatchObject({ kind: "plane", normal: [0, 0, 1] });
        expect((b.datums.level as { origin: number[] }).origin[2]).toBeCloseTo(h, 6);
        expect((b.datums.level2 as { origin: number[] }).origin[2]).toBeCloseTo(h, 6);
        expect(b.datums.post).toMatchObject({ kind: "axis" });
        expect((b.datums.post as { direction: number[] }).direction.map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 0, 1]);
      } finally {
        b.dispose();
      }
    }
  });
  it("a reference to a point or line the 3D sketch hasn't: says what it has", () => {
    const doc = withPost(500);
    (doc.features[1] as { refs: unknown[] }).refs[1] = { sketch: "s3", entity: "p9" };
    const b = rebuild(doc, oc);
    try {
      expect(b.errors.join(" ")).toMatch(/s3 has no point or line "p9" \(its points: p1, p2, p3; its lines: l1, l2\)/);
    } finally {
      b.dispose();
    }
  });
});
