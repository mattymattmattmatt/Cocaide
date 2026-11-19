// Assemblies (src/doc/assembly.ts, src/assembly): checked strictly, edited
// by commands (a component's mates go with it, a part in use stays), and
// solved on real parts: two brackets mated hole to hole (concentric) and
// face to face (coincident) end up stacked with their holes in line.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { getOC, loadOC, rebuild } from "../src/kernel";
import { describeEdges, describeFaces } from "../src/kernel/topology";
import { scoped } from "../src/kernel/oc";
import { partDocument, placed, solveAssembly } from "../src/assembly/model";
import { composeScene } from "../src/assembly/scene";
import { placementOf, pointTo } from "../src/assembly/transform";
import type { Assembly, FaceSelector } from "../src/doc/types";
import type { RebuildView } from "../src/worker/protocol";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;

let view: RebuildView;
beforeAll(async () => {
  await loadOC();
  const r = rebuild(bracket, getOC());
  try {
    const topo = scoped((s) => {
      const f = describeFaces(getOC(), s, r.solid!);
      return { faces: f.infos, edges: describeEdges(getOC(), s, r.solid!, f.faces).infos };
    });
    view = { ok: true, name: "bracket", errors: [], features: [], sketches: [], measurements: null, mesh: null, faces: topo.faces, edges: topo.edges, bodies: [], datums: {} };
  } finally {
    r.dispose();
  }
}, 120_000);

const errorsOf = (assembly: unknown) => (validateDocument({ ...bracket, assembly }).assemblyErrors ?? []);
const TOP: FaceSelector = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const BOTTOM: FaceSelector = { type: "planar", normal: [0, 0, -1], pick: "largest" };
const HOLE: FaceSelector = { type: "cylindrical", radius: 3.3, pick: "largest" };

describe("the assembly in the document", () => {
  it("is checked strictly", () => {
    expect(errorsOf({ components: [{ id: "a", part: "self" }] })).toEqual([]);
    expect(errorsOf({ components: [{ id: "a", part: "nope" }] })[0]).toMatch(/part: must be "self" \(this part\) or a key of assembly.parts/);
    expect(errorsOf({ components: [{ id: "a", part: "self" }, { id: "a", part: "self" }] })[0]).toMatch(/"a" is another component's id/);
    const two = [{ id: "a", part: "self" }, { id: "b", part: "self" }];
    expect(errorsOf({ components: two, mates: [{ id: "m", type: "distance", a: { component: "a", face: TOP }, b: { component: "b", face: TOP } }] })[0]).toMatch(/a distance mate needs the distance/);
    expect(errorsOf({ components: two, mates: [{ id: "m", type: "coincident", a: { component: "a", face: TOP }, b: { component: "a", face: BOTTOM } }] })[0]).toMatch(/mates two things of one component/);
    expect(errorsOf({ components: two, mates: [{ id: "m", type: "glue", a: { component: "a", face: TOP }, b: { component: "b", face: TOP } }] })[0]).toMatch(/type: must be "coincident"/);
    expect(errorsOf({ components: two, mates: [{ id: "m", type: "coincident", a: { component: "a", datum: "Top" }, b: { component: "b", datum: "Sideways" } }] })[0]).toMatch(/datum: must be "Top"/);
    // The assembly never stops the part: the part's features are as they were.
    expect(validateDocument({ ...bracket, assembly: { components: [{ id: "a", part: "nope" }] } }).features.every((f) => f.errors.length === 0)).toBe(true);
  });

  it("is edited by commands: a component's mates go with it; a part in use stays", () => {
    const part = { ...bracket, name: "other" };
    let doc = bracket as RawDocument;
    const step = (cmd: Parameters<typeof apply>[1]) => {
      const r = apply(doc, cmd);
      if (!r.ok) throw new Error(r.error);
      doc = r.doc;
    };
    step({ type: "setAssemblyPart", key: "other", part });
    step({ type: "setComponent", id: "a", component: { part: "self", fixed: true } });
    step({ type: "setComponent", id: "b", component: { part: "other", at: [100, 0, 0] } });
    step({ type: "setMate", id: "m", mate: { type: "coincident", a: { component: "a", face: TOP }, b: { component: "b", face: BOTTOM } } });
    expect(allErrors(validateDocument(doc))).toEqual([]);
    expect(apply(doc, { type: "setAssemblyPart", key: "other", part: null })).toMatchObject({ ok: false, error: expect.stringMatching(/b uses part "other": remove it first/) });
    step({ type: "setComponent", id: "b", component: null });
    expect((doc.assembly as Assembly).mates).toBeUndefined();
    step({ type: "setAssemblyPart", key: "other", part: null });
    expect((doc.assembly as Assembly).parts).toBeUndefined();
    // A command that breaks the assembly is refused.
    expect(apply(doc, { type: "setComponent", id: "c", component: { part: "missing" } })).toMatchObject({ ok: false });
    // The assembly changes nothing of the part: its document for the components has no assembly or drawing.
    expect(partDocument(doc as Record<string, unknown>, "self")).not.toHaveProperty("assembly");
  });
});

describe("solved on real parts", () => {
  it("two brackets, hole to hole and face to face: stacked, holes in line, the first never moving", () => {
    const asm: Assembly = {
      components: [
        { id: "a", part: "self", fixed: true },
        { id: "b", part: "self", at: [150, 40, 30], rotation: [10, 5, 80] },
      ],
      mates: [
        { id: "c1", type: "concentric", a: { component: "a", face: HOLE }, b: { component: "b", face: HOLE } },
        { id: "m1", type: "coincident", a: { component: "a", face: TOP }, b: { component: "b", face: BOTTOM } },
      ],
    };
    const views = new Map([["self", view]]);
    const s = solveAssembly(asm, views);
    expect(s.mates.map((m) => [m.id, m.ok])).toEqual([
      ["c1", true],
      ["m1", true],
    ]);
    const done = placed(asm, s.placements);
    expect(done.components[0]).toEqual({ id: "a", part: "self", fixed: true });
    const P = placementOf(done.components[1]);
    // The hole's axis (x = 30, y = 0 on the part) is in line: the same x, y on both.
    const hole = pointTo(P, [30, 0, 0]);
    expect(hole[0]).toBeCloseTo(30, 5);
    expect(hole[1]).toBeCloseTo(0, 5);
    // Its bottom is on the first's top (z = 6).
    expect(pointTo(P, [0, 0, 0])[2]).toBeCloseTo(6, 5);
    // Solved again, nothing moves.
    expect(solveAssembly(done, views).solved).toBe(true);
  });

  it("says when a mate's face can't be found any more", () => {
    const asm: Assembly = {
      components: [{ id: "a", part: "self", fixed: true }, { id: "b", part: "self" }],
      mates: [{ id: "c1", type: "concentric", a: { component: "a", face: { type: "cylindrical", radius: 9, pick: "largest" } }, b: { component: "b", face: HOLE } }],
    };
    const s = solveAssembly(asm, new Map([["self", view]]));
    expect(s.solved).toBe(false);
    expect(s.mates[0].problem).toMatch(/a: the face selector matched 0 faces/);
  });

  it("composes the scene: each component a body, its faces moved and named for it", () => {
    const sc = composeScene([
      { id: "a", placement: placementOf({}), view },
      { id: "b", placement: placementOf({ at: [100, 0, 0] }), view },
      { id: "c", placement: placementOf({}), view, hidden: true },
    ]);
    expect(sc.view.bodies.map((b) => b.name)).toEqual(["a", "b"]);
    expect(sc.view.faces.length).toBe(2 * view.faces.length);
    const top = view.faces.find((f) => f.normal?.[2] === 1 && f.area > 1000)!;
    const moved = sc.view.faces[view.faces.length + top.index];
    expect(moved.body).toBe("b");
    expect(moved.centroid[0]).toBeCloseTo(top.centroid[0] + 100, 9);
    expect(sc.faceOwner[view.faces.length + top.index]).toEqual({ component: "b", local: top.index });
  });
});
