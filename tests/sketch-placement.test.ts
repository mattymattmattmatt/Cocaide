// Sketch placement by reference (Phase O, DESIGN §2.3) and open sketches.
// A sketch on a face is { "type": "ref", "ref": { "face": <selector> } }: it
// is resolved on every rebuild, so it follows the face when an earlier
// feature changes. Mirror and split planes take the same form. A sketch whose
// curves are not a closed profile still builds; what needs a profile says why
// it has none.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { selectorHealth } from "../src/agent/health";
import { runAsk } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { say, ScriptedModel, use } from "../src/ask/model";
import { apply, references, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { getOC, loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { describeFaces } from "../src/kernel/topology";

const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket"); // 80 x 40 x 6 plate on z = 0, centred; a 6.6 hole through at [30, 0]
const add = (doc: RawDocument, ...f: Record<string, unknown>[]): RawDocument => ({ ...doc, features: [...doc.features, ...f] });
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const onFace = (face: unknown, extra: Record<string, unknown> = {}) => ({ type: "ref", ref: { face }, ...extra });
const circle = (id: string, center: number[], radius: number) => ({ id, type: "circle", center, radius });
const rect = (id: string, center: number[], w: number, h: number) => ({ id, type: "rect", center, w, h });
const PI = Math.PI;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    const planes = r.solid
      ? scoped((s) => describeFaces(oc, s, r.solid!).infos.flatMap((f) => (f.type === "plane" && f.normal ? [{ normal: f.normal.map((x) => Math.round(x * 1e9) / 1e9 + 0), offset: Math.round(f.offset! * 1e9) / 1e9 + 0 }] : [])))
      : [];
    return {
      ok: r.ok,
      errors: r.errors,
      features: r.features,
      volume: r.measurements?.volume ?? 0,
      box: r.measurements?.boundingBox ?? null,
      bodies: (r.measurements?.bodies ?? []).map((b) => [b.name, b.volume] as const),
      holes: r.measurements?.holes ?? [],
      sketches: r.sketches,
      planes,
    };
  } finally {
    r.dispose();
  }
}

describe("a sketch on a face follows the face", () => {
  /** A boss on the top face (default direction: out of it) and a pocket cut into it (the sketch flipped, so it cuts down). */
  const withFaceFeatures = add(
    bracket,
    { id: "sk_boss", op: "sketch", plane: onFace(TOP), entities: [circle("c1", [-20, 0], 5)] },
    { id: "boss", op: "extrude", sketch: "sk_boss", distance: 4 },
    { id: "sk_pocket", op: "sketch", plane: onFace(TOP, { flip: true }), entities: [circle("c1", [10, 0], 4)] },
    { id: "pocket", op: "cut", sketch: "sk_pocket", distance: 2 },
  );
  // plate minus the through hole, plus the boss (r5 x 4), minus the pocket (r4 x 2)
  const volume = (t: number) => 80 * 40 * t - PI * 3.3 ** 2 * t + PI * 25 * 4 - PI * 16 * 2;

  it("builds on the top face as it is: the boss stands on z = 6, the pocket's floor is at z = 4", () => {
    const b = built(withFaceFeatures);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(volume(6), 6);
    expect(b.box!.max[2]).toBeCloseTo(6 + 4, 9);
    expect(b.planes).toContainEqual({ normal: [0, 0, 1], offset: 4 });
    // The overlay is drawn on the face's plane: its frame and its points.
    const boss = b.sketches.find((s) => s.id === "sk_boss")!;
    expect(boss.frame).toEqual({ origin: [0, 0, 6], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
    expect(boss.polylines[0].points.every((p) => Math.abs(p[2] - 6) < 1e-9)).toBe(true);
    const pocket = b.sketches.find((s) => s.id === "sk_pocket")!;
    expect(pocket.frame.z.map((x) => x + 0)).toEqual([0, 0, -1]);
  });

  it("ext_1 from 6 to 10 mm: the boss and the pocket move up with the top face", () => {
    const r = apply(withFaceFeatures, { type: "updateFeature", id: "ext_1", patch: { distance: 10 } });
    expect(r.ok).toBe(true);
    const b = built(r.ok && r.doc);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(volume(10), 6);
    expect(b.box!.max[2]).toBeCloseTo(10 + 4, 9);
    expect(b.planes).toContainEqual({ normal: [0, 0, 1], offset: 8 });
    expect(b.planes).not.toContainEqual({ normal: [0, 0, 1], offset: 4 });
    expect(b.sketches.find((s) => s.id === "sk_boss")!.frame.origin).toEqual([0, 0, 10]);
  });

  it("a face that is not there fails the sketch, with the selector's own message; its extrude says why it has no profile", () => {
    const b = built(add(bracket, { id: "sk", op: "sketch", plane: onFace({ ...TOP, offset: 99 }), entities: [circle("c1", [0, 0], 5)] }, { id: "e", op: "extrude", sketch: "sk", distance: 4 }));
    expect(b.errors).toEqual(["sk: plane.ref.face: selector matched 0 faces (wanted 1 planar face normal +Z at offset 99)", 'e: sketch "sk" failed, so there is no profile to extrude']);
    expect(b.sketches.map((s) => s.id)).toEqual(["sketch_1"]);
  });

  it("validate reports the health of the face selector a sketch stands on", () => {
    const doc = add(bracket, { id: "sk", op: "sketch", plane: onFace(TOP), entities: [circle("c1", [0, 0], 5)] }, { id: "sk2", op: "sketch", plane: onFace({ type: "planar", normal: [0, 0, 1], pick: "all" }), entities: [] });
    const health = selectorHealth(doc, oc).filter((h) => h.feature.startsWith("sk"));
    expect(health).toEqual([
      { feature: "sk", path: "plane.ref.face", matched: 1, ok: true },
      { feature: "sk2", path: "plane.ref.face", matched: 1, ok: true },
    ]);
  });
});

describe("a sketch on a default plane, offset, flipped or turned", () => {
  const block = (plane: unknown) => add(bracket, { id: "sk", op: "sketch", plane, entities: [rect("r1", [20, 0], 4, 2)] }, { id: "e", op: "extrude", sketch: "sk", distance: 5, newBody: "block" });
  const blockBox = (plane: unknown) => {
    const b = built(block(plane));
    expect(b.errors).toEqual([]);
    const r = rebuild(block(plane), oc);
    try {
      return r.measurements!.bodies.find((x) => x.name === "block")!.boundingBox!;
    } finally {
      r.dispose();
    }
  };

  it("{ datum: Front } is the Front plane written out", () => {
    expect(blockBox({ type: "ref", ref: { datum: "Front" } })).toEqual(blockBox({ type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] }));
    // Front: x along +X, y up (+Z); extruded 5 toward -Y.
    const box = blockBox({ type: "ref", ref: { datum: "Front" } });
    expect(box.min.map((x) => Math.round(x * 1e9) / 1e9 + 0)).toEqual([18, -5, -1]);
  });

  it("offset moves it along the normal; flip turns it over (the extrude goes the other way)", () => {
    expect(blockBox({ type: "ref", ref: { datum: "Top" }, offset: 10 })).toMatchObject({ min: [18, -1, 10], max: [22, 1, 15] });
    // Flipped: x kept, y reversed, normal -Z.
    expect(blockBox({ type: "ref", ref: { datum: "Top" }, offset: 10, flip: true })).toMatchObject({ min: [18, -1, 5], max: [22, 1, 10] });
  });

  it("xDir turns its x axis: the rect's 2D x runs along world +Y", () => {
    const box = blockBox({ type: "ref", ref: { datum: "Top" }, xDir: [0, 1, 0] });
    expect([...box.min, ...box.max].map((x) => Math.round(x * 1e9) / 1e9 + 0)).toEqual([-1, 18, 0, 1, 22, 5]);
  });

  it("an xDir along the reference's normal is refused when it resolves", () => {
    const b = built(block({ type: "ref", ref: { datum: "Top" }, xDir: [0, 0, 2] }));
    expect(b.errors[0]).toBe("sk: plane.xDir: must not be parallel to the plane normal (Top has normal +Z)");
  });
});

describe("validation of planes", () => {
  const sk = (plane: unknown) => add(bracket, { id: "sk", op: "sketch", plane, entities: [] });

  it("a plane by reference must be plane-like, and is checked strictly", () => {
    expect(errorsOf(sk({ type: "ref", ref: { datum: "X" } }))).toEqual(["sk: plane.ref: X is an axis, but a plane is needed here"]);
    expect(errorsOf(sk({ type: "ref", ref: { datum: "ext_1" } }))).toEqual(['sk: plane.ref.datum: "ext_1" is an extrude, not a plane, axis or point']);
    expect(errorsOf(sk({ type: "ref", ref: { edge: { type: "edge", pick: "longest" } } }))).toEqual(["sk: plane.ref: an edge is an axis or a point, but a plane is needed here"]);
    expect(errorsOf(sk({ type: "ref", ref: { datum: "Top" }, flip: "yes", offset: "x", extra: 1 }))).toEqual([
      'sk: plane: unknown field "extra" (allowed: type, ref, offset, flip, xDir)',
      'sk: plane.offset: must be a number (got "x")',
      'sk: plane.flip: must be true or false (got "yes")',
    ]);
    expect(errorsOf(sk({ type: "plane" }))).toEqual(['sk: plane.type: must be "datum" (written out) or "ref" (by reference) (got "plane")']);
    expect(errorsOf(sk("Top"))).toEqual(['sk: plane: must be a plane: { "type": "datum", "normal": [x, y, z], "origin": [x, y, z] } or { "type": "ref", "ref": { "face": <face selector> } } (got "Top")']);
  });

  it("an offset may be an expression", () => {
    const doc = { ...sk({ type: "ref", ref: { datum: "Top" }, offset: "=h * 2" }), parameters: { h: 3 } };
    expect(errorsOf(doc)).toEqual([]);
    expect(validateDocument(doc).features[3].feature).toMatchObject({ plane: { type: "ref", ref: { datum: "Top" }, offset: 6 } });
  });

  it("mirror and split planes keep their xDir now, and take a reference too", () => {
    const mirror = { id: "m", op: "mirror", plane: { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0], xDir: [0, 1, 0] }, feature: "hole_1" };
    expect(errorsOf(add(bracket, mirror))).toEqual([]);
    expect(validateDocument(add(bracket, mirror)).features[3].feature).toMatchObject({ plane: { xDir: [0, 1, 0] } });
    expect(errorsOf(add(bracket, { ...mirror, plane: { ...mirror.plane, xDir: [2, 0, 0] } }))).toEqual(["m: plane.xDir: must not be parallel to the plane normal"]);
    expect(errorsOf(add(bracket, { id: "x", op: "split", body: "main", plane: { type: "ref", ref: { datum: "Z" } } }))).toEqual(["x: plane.ref: Z is an axis, but a plane is needed here"]);
  });

  it("body names in a reference's selectors must be bodies before it", () => {
    const doc = add(example("stand"), { id: "sk", op: "sketch", plane: onFace({ ...TOP, body: "plate" }), entities: [] });
    expect(errorsOf(doc)).toEqual(['sk: plane.ref.face.body: no body "plate" before this feature (bodies so far: base, upright)']);
  });
});

describe("mirror and split about a plane by reference", () => {
  it("mirrors hole_1 about Right (the YZ plane), and about Right offset 10", () => {
    const b = built(add(bracket, { id: "m", op: "mirror", plane: { type: "ref", ref: { datum: "Right" } }, feature: "hole_1" }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(80 * 40 * 6 - 2 * PI * 3.3 ** 2 * 6, 6);
    const off = built(add(bracket, { id: "m", op: "mirror", plane: { type: "ref", ref: { datum: "Right" }, offset: 10 }, feature: "hole_1" }));
    // x = 30 mirrored about x = 10 is x = -10.
    expect(off.holes.map((h) => Math.round(h.axisPoint[0] * 1e6) / 1e6).sort((a, c) => a - c)).toEqual([-10, 30]);
  });

  it("splits the bracket on Right: the piece the normal points to (+X, with the hole) is main_split; flipped, it is the other", () => {
    const half = 40 * 40 * 6;
    const hole = PI * 3.3 ** 2 * 6;
    const b = built(add(bracket, { id: "x", op: "split", body: "main", plane: { type: "ref", ref: { datum: "Right" } } }));
    expect(b.errors).toEqual([]);
    expect(b.bodies.map(([n, v]) => [n, Math.round(v * 1e6) / 1e6])).toEqual([["main", half], ["main_split", Math.round((half - hole) * 1e6) / 1e6]]);
    const flipped = built(add(bracket, { id: "x", op: "split", body: "main", plane: { type: "ref", ref: { datum: "Right" }, flip: true } }));
    expect(flipped.bodies.map(([n, v]) => [n, Math.round(v * 1e6) / 1e6])).toEqual([["main", Math.round((half - hole) * 1e6) / 1e6], ["main_split", half]]);
  });

  it("a split plane on a face: the +X side face offset 10 back into the part", () => {
    const b = built(add(bracket, { id: "x", op: "split", body: "main", plane: onFace({ type: "planar", normal: [1, 0, 0], pick: "largest" }, { offset: -10 }) }));
    expect(b.errors).toEqual([]);
    // x = 40 - 10 = 30 cuts through the hole's axis: the 10 mm slice keeps half the hole.
    const slice = 10 * 40 * 6 - (PI * 3.3 ** 2 * 6) / 2;
    expect(b.bodies.find(([n]) => n === "main_split")![1]).toBeCloseTo(slice, 6);
  });
});

describe("the document follows references", () => {
  it("a sketch standing on a plane feature references it: deleting or moving that feature after it is refused", () => {
    expect(references({ id: "sk", op: "sketch", plane: { type: "ref", ref: { datum: "plane_1" }, offset: 2 }, entities: [] })).toEqual(["plane_1"]);
  });

  it("renaming a body renames it in the face selector a sketch stands on", () => {
    const doc = add(example("stand"), { id: "sk", op: "sketch", plane: onFace({ ...TOP, body: "base" }), entities: [circle("c1", [0, 0], 5)] });
    expect(errorsOf(doc)).toEqual([]);
    const r = apply(doc, { type: "renameBody", from: "base", to: "plate" });
    expect(r.ok && r.doc.features.at(-1)!.plane).toEqual(onFace({ ...TOP, body: "plate" }));
    // The original is untouched.
    expect(doc.features.at(-1)!.plane).toEqual(onFace({ ...TOP, body: "base" }));
  });
});

describe("open sketches", () => {
  const lines = [
    { id: "l1", type: "line", start: [0, 0], end: [10, 0] },
    { id: "l2", type: "line", start: [10, 0], end: [10, 10] },
  ];

  it("an open chain is a good sketch that carries why it is no profile; a closed one carries nothing", () => {
    const b = built(add(bracket, { id: "path", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: lines }));
    expect(b.errors).toEqual([]);
    expect(b.features.at(-1)).toEqual({ id: "path", op: "sketch", ok: true });
    const path = b.sketches.find((s) => s.id === "path")!;
    expect(path.ok).toBe(true);
    expect(path.open).toBe('profile is open at [0, 0] (start of "l1")');
    expect(b.sketches.find((s) => s.id === "sketch_1")!.open).toBeUndefined();
  });

  it("crossing curves are a sketch too; the cut that needs a profile names the crossing", () => {
    const crossing = [rect("r1", [0, 0], 10, 10), rect("r2", [5, 0], 10, 4)];
    const b = built(add(bracket, { id: "sk", op: "sketch", plane: onFace(TOP), entities: crossing }, { id: "c", op: "cut", sketch: "sk", distance: 1, direction: [0, 0, -1] }));
    expect(b.features.map((f) => f.ok)).toEqual([true, true, true, true, false]);
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]).toMatch(/^c: sketch "sk" has no closed profile to cut: .*profiles must not cross or touch$/);
  });

  it("constraints that do not hold still fail the sketch itself", () => {
    const b = built(add(bracket, { id: "sk", op: "sketch", plane: onFace(TOP), entities: lines, constraints: [{ type: "distance", entity: "l1", value: 12 }] }));
    expect(b.features.at(-1)!.ok).toBe(false);
    expect(b.errors[0]).toMatch(/^sk: /);
  });
});

describe("the right-click ask from a face", () => {
  it("adds a sketch on that face by reference (and its extrude); a sketch on another face is refused", async () => {
    await loadOC();
    const kernel = new LocalKernel(getOC);
    const topo = (await kernel.topology(bracket))!;
    const topFace = topo.faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99);
    const bottom = { type: "planar", normal: [0, 0, -1], pick: "largest" };
    const sketch = (face: unknown, extra: Record<string, unknown> = {}) => ({ op: "sketch", plane: onFace(face, extra), entities: [circle("c1", [-20, 0], 5)] });
    const model = new ScriptedModel([
      () => [use("addFeature", { feature: sketch(bottom) })],
      () => [use("addFeature", { feature: sketch(TOP, { offset: 2 }) })],
      () => [use("addFeature", { feature: sketch(TOP) })],
      () => [use("addFeature", { feature: { op: "extrude", sketch: "sketch_2", distance: 4 } })],
      () => [say("Added a boss on the face.")],
    ]);
    const r = await runAsk({ doc: bracket, target: { kind: "face", index: topFace }, text: "add a 10 mm boss here, 4 tall", model, kernel });
    expect(r.calls.map((c) => c.ok)).toEqual([false, false, true, true]);
    expect(r.calls[0].error).toBe('the sketch must lie on the face you right-clicked: plane { "type": "ref", "ref": { "face": <the packet\'s face selector> } }, no offset');
    expect(r.proposal!.changes).toEqual([
      { id: "sketch_2", kind: "added" },
      { id: "extrude_1", kind: "added" },
    ]);
  });

  it("a sketch on a face has the feature that made the face as its parent in the packet", async () => {
    const kernel = new LocalKernel(getOC);
    const doc = add(bracket, { id: "sk", op: "sketch", plane: onFace(TOP), entities: [circle("c1", [-20, 0], 5)] });
    const model = new ScriptedModel([() => [say("It is a circle on the top face.")]]);
    await runAsk({ doc, target: { kind: "feature", id: "sk" }, text: "what is this sketch on?", model, kernel });
    const content = model.requests[0].messages[0].content as { type: string; text?: string }[];
    const text = content.find((b) => b.type === "text")!.text!;
    const packet = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    expect(packet.parent.id).toBe("ext_1");
  });
});
