// Phase H: one part, many named bodies. The example is a base plate with an
// upright plate standing on it (examples/stand.cocaide.json).

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { buildPacket, scopeFor } from "../src/ask/packet";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { exportSTEP, getOC, importSTEP, loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { measurementSummary } from "../src/kernel/inspect";
import { countSubShapes } from "../src/kernel/topology";

const stand: RawDocument = JSON.parse(readFileSync(new URL("../examples/stand.cocaide.json", import.meta.url), "utf8"));
const bracket: RawDocument = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8"));
const BASE = 120 * 80 * 8 - 2 * Math.PI * 5 ** 2 * 8;
const UPRIGHT = 120 * 8 * 60;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    const m = r.measurements!;
    return {
      ok: r.ok,
      errors: r.errors,
      bodies: m ? m.bodies.map((b) => ({ name: b.name, volume: Math.round(b.volume * 1000) / 1000, holes: b.holeCount, size: b.boundingBox!.size })) : [],
      interference: m?.interference ?? [],
      volume: m?.volume ?? 0,
      solids: m?.solids ?? 0,
    };
  } finally {
    r.dispose();
  }
}

function must(r: ReturnType<typeof apply>): RawDocument {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const feature = (doc: RawDocument, id: string) => doc.features.find((f) => f.id === id)!;

describe("a part of named bodies", () => {
  it("rebuilds as two named solids, each measured, and reports no interference where they only touch", () => {
    const b = built(stand);
    expect(b.errors).toEqual([]);
    expect(b.bodies).toEqual([
      { name: "base", volume: r3(BASE), holes: 2, size: [120, 80, 8] },
      { name: "upright", volume: UPRIGHT, holes: 0, size: [120, 8, 60] },
    ]);
    expect(b.interference).toEqual([]);
    expect(b.solids).toBe(2);
    expect(b.volume).toBeCloseTo(BASE + UPRIGHT, 6);
  });

  it("reports the overlap when one body is pushed into another", () => {
    // A thicker base: the upright still stands at 8, so 2 mm of it is inside the base.
    const doc = must(apply(stand, { type: "setParameter", name: "base_t", value: 10 }));
    expect(built(doc).interference).toEqual([{ bodies: ["base", "upright"], volume: 120 * 8 * 2 }]);
  });

  it("a hole scoped to the base leaves the upright whole; unscoped, it drills every body it reaches", () => {
    expect(built(stand).bodies[1].volume).toBe(UPRIGHT);
    const through = must(
      apply(stand, {
        type: "addFeature",
        feature: { id: "hole_2", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest", body: "upright" }, center: [0, 0], diameter: 6, depth: "through" },
      }),
    );
    const b = built(through);
    expect(b.errors).toEqual([]);
    // Drilled down from the top of the upright, through it and on into the base.
    expect(b.bodies.map((x) => [x.name, x.holes])).toEqual([
      ["base", 3],
      ["upright", 1],
    ]);
    expect(b.bodies[1].volume).toBeCloseTo(UPRIGHT - Math.PI * 9 * 60, 3);
  });

  it("a listed body that loses nothing is an error, not a silent no-op", () => {
    const doc = structuredClone(stand);
    (feature(doc, "hole_1") as { bodies: string[] }).bodies = ["base", "upright"];
    expect(built(doc).errors).toEqual(['hole_1: removed no material from body "upright"', 'pattern_1: feature "hole_1" failed, so there is nothing to repeat']);
  });

  it("STEP keeps the names: one assembly, one named solid per body", () => {
    const r = rebuild(stand, oc);
    try {
      const text = exportSTEP(oc, r.solid!, r.name, null, r.bodies);
      for (const name of ["stand", "base", "upright"]) expect(text).toContain(`PRODUCT('${name}','${name}'`);
      const back = importSTEP(oc, text);
      scoped((s) => expect(countSubShapes(oc, s, back, "solid")).toBe(2));
      back.delete();
    } finally {
      r.dispose();
    }
  });

  it("combine adds bodies into one whose volume is the sum", () => {
    const doc = must(apply(stand, { type: "addFeature", feature: { id: "combine_1", op: "combine", operation: "add", target: "base", tools: ["upright"] } }));
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.bodies).toHaveLength(1);
    expect(b.bodies[0].name).toBe("base");
    expect(b.bodies[0].volume).toBeCloseTo(BASE + UPRIGHT, 3);
    expect(b.solids).toBe(1);
    // The upright is gone: nothing after the combine may name it.
    const after = apply(doc, { type: "addFeature", feature: { id: "hole_3", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [0, 30], diameter: 4, depth: 3, bodies: ["upright"] } });
    expect(after).toEqual({ ok: false, error: 'addFeature rejected: hole_3: bodies[0]: no body "upright" before this feature (bodies so far: base)' });
  });

  it("subtract and common", () => {
    const pushed = structuredClone(stand);
    (feature(pushed, "sketch_2") as { entities: { center: unknown[] }[] }).entities[0].center = [0, "=upright_z + upright_h / 2 - 2"];
    const sub = built(must(apply(pushed, { type: "addFeature", feature: { id: "c", op: "combine", operation: "subtract", target: "base", tools: ["upright"] } })));
    expect(sub.bodies[0].volume).toBeCloseTo(BASE - 120 * 8 * 2, 3);
    const common = built(must(apply(pushed, { type: "addFeature", feature: { id: "c", op: "combine", operation: "common", target: "base", tools: ["upright"] } })));
    expect(common.bodies[0].volume).toBeCloseTo(120 * 8 * 2, 3);
    // Touching bodies have nothing in common.
    expect(built(must(apply(stand, { type: "addFeature", feature: { id: "c", op: "combine", operation: "common", target: "base", tools: ["upright"] } }))).errors).toEqual([
      'c: "base" and "upright" don\'t overlap: their common part is empty',
    ]);
  });

  it("a pattern of a new body makes new bodies, named after it", () => {
    const doc = must(
      apply(
        must(
          apply(stand, {
            type: "addFeature",
            feature: { id: "sketch_3", op: "sketch", plane: { type: "datum", normal: [0, 0, -1], origin: [0, 0, 0] }, entities: [{ id: "c1", type: "circle", center: [-50, 30], radius: 4 }] },
          }),
        ),
        { type: "addFeature", feature: { id: "ext_3", op: "extrude", sketch: "sketch_3", distance: 20, newBody: "foot" } },
      ),
    );
    const feet = must(apply(doc, { type: "addFeature", feature: { id: "pattern_2", op: "linearPattern", feature: "ext_3", direction: [1, 0, 0], spacing: 50, count: 3 } }));
    const b = built(feet);
    expect(b.errors).toEqual([]);
    expect(b.bodies.map((x) => x.name)).toEqual(["base", "upright", "foot", "foot_2", "foot_3"]);
    expect(b.bodies[4].volume).toBeCloseTo(Math.PI * 16 * 20, 3);
  });

  it("selectors can name a body", () => {
    // The largest +Z face of the part is the base's top, whole under the upright: bodies don't trim each other.
    const hole = (body?: string) => ({ id: "hole_2", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest", ...(body ? { body } : {}) }, center: [0, 0], diameter: 4, depth: 5 });
    const holes = (doc: RawDocument) => built(doc).bodies.map((b) => b.holes);
    expect(holes(must(apply(stand, { type: "addFeature", feature: hole() })))).toEqual([3, 0]);
    expect(holes(must(apply(stand, { type: "addFeature", feature: hole("upright") })))).toEqual([2, 1]);
    const missing = { ...hole("upright"), face: { type: "planar", normal: [0, 0, -1], pick: "largest", body: "upright", offset: 99 } };
    expect(built(must(apply(stand, { type: "addFeature", feature: missing }))).errors).toEqual([
      'hole_2: selector matched 0 faces (wanted 1 planar face normal -Z at offset 99 of body "upright")',
    ]);
  });
});

describe("bodies in the document", () => {
  it("a name that doesn't exist is an error, never a new body", () => {
    const doc = structuredClone(stand);
    (feature(doc, "hole_1") as { bodies: string[] }).bodies = ["bsae"];
    expect(allErrors(validateDocument(doc))).toEqual(['hole_1: bodies[0]: no body "bsae" before this feature (bodies so far: base, upright)']);
    (feature(doc, "hole_1") as { bodies: string[] }).bodies = ["base"];
    (feature(doc, "ext_2") as Record<string, unknown>).newBody = "base";
    expect(allErrors(validateDocument(doc))).toContain('ext_2: newBody: a body "base" already exists; use "body" to add to it');
    const both = structuredClone(stand);
    Object.assign(feature(both, "ext_2"), { body: "base" });
    expect(allErrors(validateDocument(both))).toEqual(["ext_2: give body (add to it) or newBody (start one), not both"]);
  });

  it("an extrude that names no body adds to main, as every document before Phase H did", () => {
    expect(validateDocument(bracket).bodies).toEqual(["main"]);
    expect(built(bracket).bodies.map((b) => b.name)).toEqual(["main"]);
  });

  it("renaming a body follows every reference to it", () => {
    const doc = must(apply(stand, { type: "renameBody", from: "base", to: "plate" }));
    expect(feature(doc, "ext_1").newBody).toBe("plate");
    expect(feature(doc, "hole_1")).toMatchObject({ face: { body: "plate" }, bodies: ["plate"] });
    expect(built(doc).bodies.map((b) => b.name)).toEqual(["plate", "upright"]);
    expect(apply(stand, { type: "renameBody", from: "base", to: "upright" })).toEqual({ ok: false, error: 'renameBody: a body "upright" already exists' });
    // The default body gets its name where it is made.
    const named = must(apply(bracket, { type: "renameBody", from: "main", to: "bracket" }));
    expect(feature(named, "ext_1").newBody).toBe("bracket");
    expect(built(named).bodies.map((b) => b.name)).toEqual(["bracket"]);
  });

  it("a write scope of one body: features that touch only it, never another", () => {
    const scope = ["body:base"];
    const cut = (bodies?: string[]) => ({
      type: "addFeature" as const,
      feature: { id: "hole_2", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest", body: "base" }, center: [-40, -25], diameter: 4, depth: 3, ...(bodies ? { bodies } : {}) },
    });
    expect(apply(stand, cut(["base"]), { writeScope: scope }).ok).toBe(true);
    expect(apply(stand, cut(), { writeScope: scope })).toEqual({ ok: false, error: 'writeScope: addFeature "hole_2" is outside the scope [body:base]' });
    expect(apply(stand, cut(["base", "upright"]), { writeScope: scope }).ok).toBe(false);
    expect(apply(stand, { type: "updateFeature", id: "ext_2", patch: { distance: 10 } }, { writeScope: scope }).ok).toBe(false);
    expect(apply(stand, { type: "renameBody", from: "base", to: "plate" }, { writeScope: scope }).ok).toBe(true);
    expect(apply(stand, { type: "renameBody", from: "upright", to: "web" }, { writeScope: scope }).ok).toBe(false);
  });
});

describe("the agent and bodies", () => {
  it("right-click a body: the packet is that body, and the scope is its features and new features on it alone", async () => {
    const kernel = new LocalKernel(getOC);
    expect(scopeFor(stand, { kind: "body", name: "base" })).toEqual(["ext_1", "hole_1", "pattern_1", "body:base"]);
    const packet = await buildPacket(stand, { kind: "body", name: "upright" }, kernel);
    expect(packet.target).toEqual({ kind: "body", name: "upright", label: "body upright" });
    expect(packet.writeScope).toEqual(["ext_2", "body:upright"]);
    expect(packet.body).toEqual({ name: "upright", volume: UPRIGHT, massKg: 0.45216, size: [120, 8, 60], holeCount: 0 });
    expect(packet.children).toEqual([{ id: "ext_2", op: "extrude", sketch: "sketch_2", distance: "=upright_t", newBody: "upright", ok: true }]);
    expect(packet.measurements).toEqual({ otherBodies: ["base"], interference: [] });
    // The scope holds: a cut of the base is outside it.
    const cutBase = { type: "addFeature" as const, feature: { id: "hole_9", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest", body: "base" }, center: [0, 30], diameter: 4, depth: 3, bodies: ["base"] } };
    expect(apply(stand, cutBase, { writeScope: packet.writeScope }).ok).toBe(false);
  });

  it("an agent's selectors can name a body: measure and select know which body each face is", async () => {
    const kernel = new LocalKernel(getOC);
    const top = { type: "planar", normal: [0, 0, 1], pick: "largest" };
    const faces = async (selector: unknown) => {
      const r = await kernel.select(stand, selector);
      return r.ok && r.kind === "faces" ? r.faces.map((f) => [f.body, Math.round(f.area)]) : r;
    };
    expect(await faces({ ...top, body: "upright" })).toEqual([["upright", 120 * 8]]);
    expect(await faces(top)).toEqual([["base", Math.round(120 * 80 - 2 * Math.PI * 25)]]);
    expect((await kernel.topology(stand))!.faces.every((f) => f.body === "base" || f.body === "upright")).toBe(true);
  });

  it("measurements tell the agent about every body and every overlap", () => {
    const r = rebuild(stand, oc);
    try {
      const m = measurementSummary(r.measurements!);
      expect(m.bodies).toEqual([
        { name: "base", volume: Math.round(BASE * 1e6) / 1e6, size: [120, 80, 8], holeCount: 2 },
        { name: "upright", volume: UPRIGHT, size: [120, 8, 60], holeCount: 0 },
      ]);
      expect(m).not.toHaveProperty("interference");
    } finally {
      r.dispose();
    }
    const one = rebuild(bracket, oc);
    try {
      expect(measurementSummary(one.measurements!)).not.toHaveProperty("bodies");
    } finally {
      one.dispose();
    }
  });
});
