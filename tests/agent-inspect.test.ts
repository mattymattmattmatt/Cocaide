// The AI's inspection tools (src/ask/tools/inspect.ts) on the real kernel:
// every face and edge listed with a selector that picks it alone, filters,
// convex and concave edges, measuring between things, a sketch in full, a
// face's frame, the datums, the part summary; and the same tools through the
// right-click agent (with a screenshot coming back as an image) and the MCP
// session.

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { runAsk } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { ScriptedModel, say, use } from "../src/ask/model";
import { planBatch } from "../src/ask/tools/batch";
import { edgeShape, facePlane, getSketch, listDatums, listEdges, listFaces, measureBetween, partSummary } from "../src/ask/tools/inspect";
import type { RawDocument } from "../src/doc/commands";
import { getOC, loadOC } from "../src/kernel";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
let kernel: LocalKernel;
/** An 80 x 40 x 6 plate with a 20 x 20 x 10 boss on top and the bracket's hole. */
let bossed: RawDocument;

beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
  const p = await planBatch(bracket, kernel, [
    { tool: "sketchProfile", sketch: "sk_boss", plane: { type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } }, shapes: [{ rect: { center: [-20, 0], width: 20, height: 20 } }] },
    { tool: "addFeature", feature: { id: "boss", op: "extrude", sketch: "sk_boss", distance: 10 } },
  ]);
  if (!p.ok) throw new Error(p.error);
  bossed = p.doc;
});

type Row = Record<string, unknown> & { selector: unknown };

describe("listFaces", () => {
  it("gives every face a selector that picks it alone, largest first", async () => {
    const r = await listFaces(bracket, kernel, {});
    expect(r.ok).toBe(true);
    const faces = r.faces as Row[];
    // A box with a hole: 6 sides and the hole's wall.
    expect(r.matched).toBe(7);
    expect(faces[0]).toMatchObject({ type: "plane" });
    expect(faces[0].area).toBeCloseTo(80 * 40 - Math.PI * 3.3 ** 2, 5);
    for (const f of faces) {
      const s = await kernel.select(bracket, f.selector);
      expect(s.ok && s.indices.length, JSON.stringify(f.selector)).toBe(1);
    }
    const wall = faces.find((f) => f.type === "cylinder")!;
    expect(wall).toMatchObject({ radius: 3.3, concave: true, madeBy: "hole_1" });
  });

  it("filters by normal, by the feature that made it, and sorts by distance from a point", async () => {
    const up = await listFaces(bossed, kernel, { normal: [0, 0, 1] });
    expect((up.faces as Row[]).map((f) => f.offset)).toEqual([6, 16]);
    const top = (up.faces as Row[])[0];
    // A flat face carries its sketch frame: the world origin projected onto it, x along X.
    expect(top.frame).toMatchObject({ origin: [0, 0, 6], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1], box2D: [[-40, -20], [40, 20]] });
    const boss = await listFaces(bossed, kernel, { madeBy: "boss" });
    expect(boss.matched).toBe(5); // four sides and the top
    expect((boss.faces as Row[]).every((f) => f.madeBy === "boss")).toBe(true);
    const near = await listFaces(bossed, kernel, { near: [-20, 0, 16], limit: 1 });
    expect(near).toMatchObject({ matched: 12, shown: 1 });
    expect((near.faces as Row[])[0]).toMatchObject({ normal: [0, 0, 1], offset: 16 });
    expect((await listFaces(bossed, kernel, { madeBy: "nope" })).error).toMatch(/madeBy: no feature "nope"/);
  });
});

describe("listEdges", () => {
  it("tells convex edges from concave ones, and gives one selector for all of them", async () => {
    const vertical = await listEdges(bossed, kernel, { direction: [0, 0, 1] });
    const rows = vertical.edges as Row[];
    // Four plate corners and four boss corners, all outside corners.
    expect(rows).toHaveLength(8);
    expect(rows.every((e) => e.corner === "convex")).toBe(true);
    const base = await listEdges(bossed, kernel, { madeBy: "boss", corner: "concave" });
    // Where the boss meets the plate: four inside corners.
    expect(base.matched).toBe(4);
    for (const e of base.edges as Row[]) expect(e.mid![2 as never]).toBe(6);
    // One query for the four ("the edges of the boss's ... "), or one selector each when no single query picks just them.
    const sel = base.allSelector;
    const picks = await Promise.all((Array.isArray(sel) ? sel : [sel]).map((x) => kernel.select(bossed, x)));
    expect(new Set(picks.flatMap((p) => (p.ok ? p.indices : []))).size).toBe(4);
    // The hole's rim on the top face is convex; seams are never listed.
    const rims = await listEdges(bracket, kernel, { kind: "circle" });
    expect(rims.matched).toBe(2);
    expect((rims.edges as Row[]).map((e) => e.corner)).toEqual(["convex", "convex"]);
    const t = (await kernel.topology(bracket))!;
    expect(t.edges.filter((e) => e.seam).every((e) => edgeShape(t, e) === undefined)).toBe(true);
  });

  it("onFace takes a face selector; a bad one says why", async () => {
    const r = await listEdges(bracket, kernel, { onFace: { type: "planar", normal: [0, 0, 1], pick: "largest" } });
    expect(r.matched).toBe(5); // four sides of the top and the hole's rim
    expect((await listEdges(bracket, kernel, { onFace: { type: "planar", normal: [0, 0, 1], pick: "sideways" } })).ok).toBe(false);
  });
});

describe("measureBetween", () => {
  it("two parallel faces: the gap, the angle 0, and the closest points", async () => {
    const r = await measureBetween(bracket, kernel, { a: { type: "planar", normal: [0, 0, 1], pick: "largest" }, b: { type: "planar", normal: [0, 0, -1], pick: "largest" } });
    expect(r).toMatchObject({ ok: true, distance: 6, angle: 0, parallel: true, normalsAngle: 180 });
  });

  it("a face and a datum plane, a point and an axis, an edge and an edge", async () => {
    expect(await measureBetween(bracket, kernel, { a: { type: "planar", normal: [1, 0, 0], pick: "largest" }, b: { datum: "Right" } })).toMatchObject({ distance: 40, angle: 0 });
    const top = { type: "planar", normal: [0, 0, 1], pick: "largest" };
    expect(await measureBetween(bracket, kernel, { a: top, b: { type: "planar", normal: [1, 0, 0], pick: "largest" } })).toMatchObject({ angle: 90, perpendicular: true });
    // The hole's wall to the Z axis: its axis is 30 from it.
    const hole = await measureBetween(bracket, kernel, { a: { type: "cylindrical", radius: 3.3, pick: "all" }, b: { datum: "Z" } });
    expect(hole).toMatchObject({ axisDistance: 30, distance: 30 - 3.3, parallel: true });
    expect((await measureBetween(bracket, kernel, { a: [0, 0, 20], b: [3, 4, 20] })).distance).toBe(5);
  });

  it("a sketch point, in the world", async () => {
    // r1's centre is the origin of a sketch on Top.
    const r = await measureBetween(bossed, kernel, { a: { sketch: "sk_boss", point: "p1.at" }, b: [-20, 0, 6] });
    expect(r.distance).toBe(0);
  });

  it("refuses a selector that picks more than one thing", async () => {
    const r = await measureBetween(bracket, kernel, { a: { type: "edge", pick: "all" }, b: [0, 0, 0] });
    expect(r.error).toMatch(/must pick exactly one/);
  });
});

describe("getSketch, facePlane, listDatums, partSummary", () => {
  it("a sketch in full: frame, labelled constraints, status and profile", async () => {
    const r = await getSketch(bossed, kernel, { id: "sk_boss" });
    expect(r).toMatchObject({ ok: true, built: true, frame: { origin: [0, 0, 6], normal: [0, 0, 1] }, status: { state: "full", dof: 0, fullyDefined: true }, profile: { closed: true, regions: 1, area: 400 } });
    const ks = r.constraints as Record<string, unknown>[];
    expect(ks.every((k, i) => k.index === i && typeof k.label === "string")).toBe(true);
    expect(ks.filter((k) => k.name)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "distance", name: "d1", measured: 20 })]));
    const under = await getSketch(bracket, kernel, { id: "sketch_1" });
    expect(under.status).toMatchObject({ state: "under", fullyDefined: false });
    expect((await getSketch(bracket, kernel, { id: "ext_1" })).error).toMatch(/is a extrude, not a sketch/);
  });

  it("a face's frame, as a sketch plane that follows it and as a datum", async () => {
    const r = await facePlane(bracket, kernel, { face: { type: "planar", normal: [1, 0, 0], pick: "largest" }, offset: 2, points: [[40, 10, 3]] });
    expect(r).toMatchObject({ ok: true, plane: { type: "ref", ref: { face: { type: "planar", normal: [1, 0, 0] } }, offset: 2 }, frame: { origin: [42, 0, 0], x: [0, 1, 0], y: [0, 0, 1] }, points2D: [[10, 3]] });
    expect((await facePlane(bracket, kernel, { face: { type: "cylindrical", pick: "all" } })).error).toMatch(/needs a flat one/);
  });

  it("the datums and the part at a glance", async () => {
    const d = await listDatums(bracket, kernel);
    expect((d.defaults as Record<string, unknown>).Front).toEqual({ kind: "plane", origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] });
    const s = await partSummary(bossed, kernel);
    expect(s.measurements).toMatchObject({ holeCount: 1, boundingBox: { size: [80, 40, 16] } });
    expect((s.bodies as Record<string, unknown>[])[0]).toMatchObject({ name: "main", madeBy: expect.arrayContaining(["ext_1", "boss"]) });
    expect((s.features as Record<string, unknown>[]).map((f) => f.id)).toEqual(["sketch_1", "ext_1", "hole_1", "sk_boss", "boss"]);
  });
});

describe("the tools in both hosts", () => {
  it("the right-click agent: listFaces in an explain ask, and a screenshot comes back as an image", async () => {
    const model = new ScriptedModel([() => [use("listFaces", { normal: [0, 0, 1] }), use("screenshot", { view: "top" })], () => [say("Two faces face up.")]]);
    const r = await runAsk({ doc: bossed, target: { kind: "feature", id: "boss" }, text: "what faces face up?", model, kernel });
    expect(r.outcome).toBe("answer");
    expect(r.calls.map((c) => [c.tool, c.ok])).toEqual([
      ["listFaces", true],
      ["screenshot", true],
    ]);
    const results = model.requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(JSON.parse(results[0].content as string).matched).toBe(2);
    const shot = results[1].content as Anthropic.ContentBlockParam[];
    expect(shot.map((b) => b.type)).toEqual(["text", "image"]);
    expect(JSON.parse((shot[0] as Anthropic.TextBlockParam).text)).toMatchObject({ ok: true, view: "top", width: 640, height: 480 });
  });

  it("the MCP session serves the same tools", async () => {
    const s = await AgentSession.open({ doc: bossed });
    try {
      const faces = (await s.call("listFaces", { madeBy: "boss" })).result;
      expect(faces.matched).toBe(5);
      const gap = (await s.call("measureBetween", { a: { type: "planar", normal: [0, 0, 1], rank: 1, pick: "largest" }, b: { datum: "Top" } })).result;
      expect(gap.distance).toBe(16);
      expect((await s.call("getSketch", { id: "sk_boss" })).result.status).toMatchObject({ fullyDefined: true });
      expect((await s.call("reference", { section: "revolve" })).result.text).toMatch(/^## revolve/);
      expect((await s.call("reference", {})).result.sections).toMatch(/Ops \(one section each\): sketch, extrude\/cut/);
    } finally {
      s.close();
    }
  });
});
