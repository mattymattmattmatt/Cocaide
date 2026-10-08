// Phase M: the multibody tools. Mirror (a feature, or whole bodies, merged or
// not), split, move and copy, delete and keep; members that stay members
// through all of them; a material per body; a body saved as a part of its own.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { LocalKernel } from "../src/ask/kernel";
import { bodyPart, bodyPartFile } from "../src/doc/bodyPart";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { drawingChecks } from "../src/drafting/checks";
import { composeSheet } from "../src/drafting/compose";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { exportSTEP, getOC, loadOC, rebuild, type OC } from "../src/kernel";
import { cutList } from "../src/weldment/cutlist";

const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));
const stand = example("stand");
const table = example("table-frame");
const frameMembers = example("frame-members");
const XZ = { type: "datum", normal: [0, 1, 0], origin: [0, 0, 0] };
const YZ = { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] };
const BASE = 120 * 80 * 8 - 2 * Math.PI * 25 * 8;
const UPRIGHT = 57600;
const HOLE = Math.PI * 25 * 8;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0;
const add = (doc: RawDocument, ...features: Record<string, unknown>[]): RawDocument => ({ ...doc, features: [...doc.features, ...features] });

function built(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    const m = r.measurements;
    return {
      ok: r.ok,
      errors: r.errors,
      volume: m ? r3(m.volume) : 0,
      massKg: m ? Math.round(m.mass.kg * 1e5) / 1e5 : 0,
      material: m?.mass.material,
      bodies: (m?.bodies ?? []).map((b) => [b.name, r3(b.volume)]),
      holes: Object.fromEntries((m?.bodies ?? []).map((b) => [b.name, b.holeCount])),
      masses: Object.fromEntries((m?.bodies ?? []).map((b) => [b.name, [Math.round(b.massKg * 1e5) / 1e5, b.material]])),
      interference: m?.interference ?? [],
      cutList: cutList(m?.members ?? []).map((i) => [i.quantity, i.length, i.angles, i.members]),
    };
  } finally {
    r.dispose();
  }
}

function run(doc: RawDocument, ...cmds: Command[]): RawDocument {
  for (const cmd of cmds) {
    const r = apply(doc, cmd);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  }
  return doc;
}

const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));

describe("Phase M acceptance on the stand", () => {
  it("1. mirrors hole_1 about the XZ plane: the base has three holes and loses one hole's volume", () => {
    const b = built(add(stand, { id: "mirror_1", op: "mirror", plane: XZ, feature: "hole_1" }));
    expect(b.errors).toEqual([]);
    expect(b.holes).toEqual({ base: 3, upright: 0 });
    expect(b.volume).toBe(r3(BASE + UPRIGHT - HOLE));
  });

  it("2. moves the upright 30 mm along Y, then mirrors it: three bodies, 57,600 mm³ more, no interference", () => {
    const b = built(add(stand, { id: "move_1", op: "move", bodies: ["upright"], translate: [0, 30, 0] }, { id: "mirror_1", op: "mirror", plane: XZ, bodies: ["upright"] }));
    expect(b.errors).toEqual([]);
    expect(b.bodies).toEqual([
      ["base", r3(BASE)],
      ["upright", UPRIGHT],
      ["upright_mirror", UPRIGHT],
    ]);
    expect(b.volume).toBe(r3(BASE + 2 * UPRIGHT));
    expect(b.interference).toEqual([]);
  });

  it("3. splits the base at x = 0 into two equal halves that add up to it", () => {
    const b = built(add(stand, { id: "split_1", op: "split", body: "base", plane: YZ }));
    expect(b.errors).toEqual([]);
    expect(b.bodies).toEqual([
      ["base", r3(BASE / 2)],
      ["upright", UPRIGHT],
      ["base_split", r3(BASE / 2)],
    ]);
    expect(b.holes).toEqual({ base: 1, upright: 0, base_split: 1 });
  });

  it("4. keeps the base alone", () => {
    expect(built(add(stand, { id: "keep_1", op: "deleteBody", keep: ["base"] })).bodies).toEqual([["base", r3(BASE)]]);
    expect(built(add(stand, { id: "delete_1", op: "deleteBody", bodies: ["base"] })).bodies).toEqual([["upright", UPRIGHT]]);
  });

  it("5. the upright in aluminium weighs 0.15552 kg, and the part is the sum of its bodies", () => {
    const doc = run(stand, { type: "setBodyMaterial", body: "upright", material: { name: "aluminium 6061", densityKgPerM3: 2700 } });
    const b = built(doc);
    expect(b.masses).toEqual({ base: [0.59302, "steel (default)"], upright: [0.15552, "aluminium 6061"] });
    expect(b.massKg).toBe(0.74854);
    expect(b.material).toBe("steel (default), aluminium 6061");
    expect(run(doc, { type: "setBodyMaterial", body: "upright", material: null }).bodyMaterials).toBeUndefined();
  });

  it("6. the upright saved as a part rebuilds alone, in aluminium, and its STEP is one solid named upright", () => {
    const doc = run(stand, { type: "setBodyMaterial", body: "upright", material: { name: "aluminium 6061", densityKgPerM3: 2700 } });
    const r = bodyPart(doc, "upright");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.name).toBe("upright");
    expect(r.doc.material).toEqual({ name: "aluminium 6061", densityKgPerM3: 2700 });
    expect(r.doc.bodyMaterials).toBeUndefined();
    expect(r.doc.features.at(-1)).toEqual({ id: "keep_1", op: "deleteBody", keep: ["upright"] });
    expect(bodyPartFile(doc, "upright")).toBe("stand-upright.cocaide.json");
    const result = rebuild(r.doc, oc);
    try {
      expect(result.ok).toBe(true);
      expect(result.bodies.map((b) => b.name)).toEqual(["upright"]);
      expect(r3(result.measurements!.volume)).toBe(UPRIGHT);
      expect(Math.round(result.measurements!.mass.kg * 1e5) / 1e5).toBe(0.15552);
      const step = exportSTEP(oc, result.solid!, result.name, null, result.bodies);
      expect(step).toContain("PRODUCT('upright','upright'");
      expect(step.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(1);
    } finally {
      result.dispose();
    }
    expect(bodyPart(stand, "plinth")).toEqual({ ok: false, error: 'no body "plinth" (bodies: base, upright)' });
  });
});

describe("Phase M acceptance: members stay members", () => {
  it("7. half the table frame, its legs mirrored about x = 600, is the table frame again, with the same cut list", () => {
    const half = { ...table, features: table.features.filter((f) => f.id !== "leg_b" && f.id !== "leg_c") };
    const b = built(add(half, { id: "mirror_legs", op: "mirror", plane: { type: "datum", normal: [1, 0, 0], origin: ["=frame_w / 2", 0, 0] }, bodies: ["leg_a", "leg_d"] }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBe(3054720);
    expect(b.interference).toEqual([]);
    expect(b.cutList).toEqual([
      [2, 1200, [45, 45], ["rail_front", "rail_back"]],
      [4, 860, [0, 0], ["leg_a", "leg_d", "leg_a_mirror", "leg_d_mirror"]],
      [2, 600, [45, 45], ["rail_right", "rail_left"]],
    ]);
  });

  it("8. a pattern of a member is in the cut list, and so are a mirrored, moved, copied and split one", () => {
    expect(built(add(frameMembers, { id: "pattern_1", op: "linearPattern", feature: "leg", direction: [0, 1, 0], spacing: 200, count: 3 })).cutList).toEqual([
      [3, 900, [0, 0], ["leg", "leg_2", "leg_3"]],
      [1, 600, [0, 0], ["rail"]],
    ]);
    // A copy turned to lie flat is still 900 long, measured along its own line.
    const turned = built(add(frameMembers, { id: "copy_1", op: "move", bodies: ["leg"], rotate: { axis: { origin: [0, 0, 0], direction: [1, 0, 0] }, angle: 90 }, translate: [0, 300, 0], copy: true }));
    expect(turned.cutList).toEqual([
      [2, 900, [0, 0], ["leg", "leg_copy"]],
      [1, 600, [0, 0], ["rail"]],
    ]);
    // Split in two, a member is two lengths.
    const halves = built(add(frameMembers, { id: "split_1", op: "split", body: "rail", plane: { type: "datum", normal: [1, 0, 0], origin: [400, 0, 0] } }));
    expect(halves.cutList).toEqual([
      [1, 900, [0, 0], ["leg"]],
      [2, 300, [0, 0], ["rail", "rail_split"]],
    ]);
    // Combined with other material, it is no longer a length of stock.
    const combined = built(add(table, { id: "combine_1", op: "combine", operation: "add", target: "rail_front", tools: ["leg_a"] }));
    expect(combined.errors).toEqual([]);
    expect(combined.cutList).toEqual([
      [1, 1200, [45, 45], ["rail_back"]],
      [3, 860, [0, 0], ["leg_b", "leg_c", "leg_d"]],
      [2, 600, [45, 45], ["rail_right", "rail_left"]],
    ]);
  });

  it("a drawing of the mirrored frame balloons the mirrored legs' item, and its checks pass", async () => {
    const half = { ...table, features: table.features.filter((f) => f.id !== "leg_b" && f.id !== "leg_c") };
    const doc = add(half, { id: "mirror_legs", op: "mirror", plane: { type: "datum", normal: [1, 0, 0], origin: [600, 0, 0] }, bodies: ["leg_a", "leg_d"] });
    const kernel = new LocalKernel(getOC);
    const c = await kernel.check(doc);
    const drawn = run(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS)) });
    const views = validateDocument(drawn).drawing!.views.map((v) => ({ id: v.id, look: v.look }));
    const geometry = await kernel.project(drawn, views);
    const sheet = composeSheet(drawn, { measurements: c.measurements, geometry })!;
    expect(sheet.annotations.filter((a) => a.type === "balloon").map((a) => a.text)).toEqual(["1", "2", "3"]);
    expect(drawingChecks(sheet, drawn, c.measurements, geometry).filter((x) => !x.ok)).toEqual([]);
  });
});

describe("the tools' rules", () => {
  it("validates them strictly", () => {
    const bad = (f: Record<string, unknown>) => errorsOf(add(stand, f));
    expect(bad({ id: "m", op: "mirror", plane: XZ, feature: "hole_1", bodies: ["base"] })).toEqual(['m: mirrors either one "feature" or a list of "bodies"']);
    expect(bad({ id: "m", op: "mirror", plane: XZ, feature: "sketch_1" })).toEqual(['m: feature: "sketch_1" is a sketch; a mirror repeats an extrude, cut, hole or member']);
    expect(bad({ id: "m", op: "mirror", plane: XZ, feature: "hole_1", merge: true })).toEqual(['m: merge: merges a mirrored body into itself: it goes with "bodies"']);
    expect(bad({ id: "m", op: "mirror", plane: XZ, bodies: ["base", "upright"], newBody: "pair" })).toEqual(["m: newBody: names one new body; with several, each is <name>_mirror"]);
    expect(bad({ id: "m", op: "mirror", plane: { type: "datum", normal: [0, 0, 0], origin: [0, 0, 0] }, bodies: ["base"] })).toEqual(["m: plane.normal: must not be the zero vector"]);
    expect(bad({ id: "s", op: "split", body: "plinth", plane: YZ })).toEqual(['s: body: no body "plinth" before this feature (bodies so far: base, upright)']);
    expect(bad({ id: "s", op: "split", body: "base", plane: YZ, newBody: "upright" })).toEqual(['s: newBody: would make body "upright", which is already a body']);
    expect(bad({ id: "mv", op: "move", bodies: ["upright"] })).toEqual(['mv: needs "translate", "rotate" or both']);
    expect(bad({ id: "mv", op: "move", bodies: ["upright"], translate: [0, 1, 0], newBody: "x" })).toEqual(['mv: newBody: names a copy: it goes with "copy": true']);
    expect(bad({ id: "d", op: "deleteBody", bodies: ["base", "upright"] })).toEqual(["d: bodies: would delete every body: nothing of the part would be left"]);
    expect(bad({ id: "d", op: "deleteBody", keep: ["base", "upright"] })).toEqual(["d: keep: keeps every body: there is nothing to delete"]);
    expect(bad({ id: "d", op: "deleteBody" })).toEqual(['d: names the bodies to delete ("bodies") or the ones to keep ("keep")']);
    // After a delete, the body is gone for the features that follow.
    expect(errorsOf(add(stand, { id: "d", op: "deleteBody", bodies: ["upright"] }, { id: "m", op: "mirror", plane: XZ, bodies: ["upright"] }))).toEqual([
      'm: bodies[0]: no body "upright" before this feature (bodies so far: base)',
    ]);
    // Two copies that would take one name.
    expect(errorsOf(add(stand, { id: "m1", op: "mirror", plane: XZ, bodies: ["upright"] }, { id: "m2", op: "mirror", plane: YZ, bodies: ["upright"] }))).toEqual([
      'm2: bodies: would make body "upright_mirror", which is already a body; name the new body with newBody',
    ]);
  });

  it("says what is wrong when the kernel can't do it", () => {
    expect(built(add(stand, { id: "s", op: "split", body: "base", plane: { type: "datum", normal: [1, 0, 0], origin: [200, 0, 0] } })).errors).toEqual(['s: the plane misses body "base": it lies wholly behind it']);
    expect(built(add(stand, { id: "m", op: "mirror", plane: XZ, bodies: ["upright"], merge: true })).errors).toEqual(['m: the mirror of "upright" adds nothing: it is already symmetric about the plane']);
    const away = add(stand, { id: "mv", op: "move", bodies: ["upright"], translate: [0, 30, 0] }, { id: "m", op: "mirror", plane: XZ, bodies: ["upright"], merge: true });
    expect(built(away).errors).toEqual(['m: the mirror of "upright" doesn\'t touch it: merged, they would be one body of separate solids. Leave merge off to make "upright_mirror"']);
    // A U-shape split across its arms leaves two pieces on one side.
    const u = add(stand, { id: "c", op: "combine", operation: "add", target: "base", tools: ["upright"] }, { id: "s", op: "split", body: "base", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 30] } });
    expect(built(u).ok).toBe(true);
  });

  it("merges a mirrored half into a whole", () => {
    const half = add(stand, { id: "s", op: "split", body: "base", plane: YZ, newBody: "right" }, { id: "d", op: "deleteBody", bodies: ["right"] });
    const b = built(add(half, { id: "m", op: "mirror", plane: YZ, bodies: ["base"], merge: true }));
    expect(b.errors).toEqual([]);
    expect(b.bodies).toEqual([
      ["base", r3(BASE)],
      ["upright", UPRIGHT],
    ]);
  });

  it("renames follow: through the tools, their implicit names, and the bodies' materials", () => {
    let doc = add(
      stand,
      { id: "mirror_1", op: "mirror", plane: XZ, bodies: ["upright"] },
      { id: "hole_2", op: "hole", face: { type: "planar", normal: [0, -1, 0], pick: "largest", body: "upright_mirror" }, center: [0, 40], diameter: 6, depth: "through", bodies: ["upright_mirror"] },
    );
    doc = run(doc, { type: "setBodyMaterial", body: "upright_mirror", material: { name: "aluminium", densityKgPerM3: 2700 } });
    const renamed = run(doc, { type: "renameBody", from: "upright", to: "post" });
    expect(renamed.features.slice(-2)).toEqual([
      { id: "mirror_1", op: "mirror", plane: XZ, bodies: ["post"] },
      { id: "hole_2", op: "hole", face: { type: "planar", normal: [0, -1, 0], pick: "largest", body: "post_mirror" }, center: [0, 40], diameter: 6, depth: "through", bodies: ["post_mirror"] },
    ]);
    expect(renamed.bodyMaterials).toEqual({ post_mirror: { name: "aluminium", densityKgPerM3: 2700 } });
    expect(built(renamed).bodies.map((b) => b[0])).toEqual(["base", "post", "post_mirror"]);
    // Renaming the mirror's body names it on the mirror.
    const named = run(doc, { type: "renameBody", from: "upright_mirror", to: "back" });
    expect(named.features.at(-2)).toEqual({ id: "mirror_1", op: "mirror", plane: XZ, bodies: ["upright"], newBody: "back" });
    expect(named.features.at(-1)!.bodies).toEqual(["back"]);
    expect(named.bodyMaterials).toEqual({ back: { name: "aluminium", densityKgPerM3: 2700 } });
    // Deleting what makes the body takes its material with it.
    const gone = run(doc, { type: "deleteFeature", id: "hole_2" }, { type: "deleteFeature", id: "mirror_1" });
    expect(gone.bodyMaterials).toBeUndefined();
  });

  it("a material for a body that doesn't exist is refused", () => {
    expect(apply(stand, { type: "setBodyMaterial", body: "plinth", material: { densityKgPerM3: 1000 } })).toEqual({ ok: false, error: 'setBodyMaterial: no body "plinth" (bodies: base, upright)' });
    expect(apply(stand, { type: "setBodyMaterial", body: "upright", material: { densityKgPerM3: -1 } })).toEqual({
      ok: false,
      error: "setBodyMaterial rejected: document: bodyMaterials.upright.densityKgPerM3: must be greater than 0 (got -1)",
    });
  });

  it("scopes them to bodies: a body's ask may split, move or mirror it, or set its material, and nothing else", () => {
    const scope = { writeScope: ["body:upright"] };
    expect(apply(stand, { type: "addFeature", feature: { id: "s", op: "split", body: "upright", plane: YZ } }, scope).ok).toBe(true);
    expect(apply(stand, { type: "addFeature", feature: { id: "mv", op: "move", bodies: ["upright"], translate: [0, 10, 0] } }, scope).ok).toBe(true);
    expect(apply(stand, { type: "addFeature", feature: { id: "m", op: "mirror", plane: XZ, bodies: ["upright"] } }, scope).ok).toBe(true);
    expect(apply(stand, { type: "setBodyMaterial", body: "upright", material: { densityKgPerM3: 2700 } }, scope).ok).toBe(true);
    expect(apply(stand, { type: "addFeature", feature: { id: "s", op: "split", body: "base", plane: YZ } }, scope).ok).toBe(false);
    expect(apply(stand, { type: "addFeature", feature: { id: "k", op: "deleteBody", keep: ["upright"] } }, scope).ok).toBe(false);
    expect(apply(stand, { type: "setBodyMaterial", body: "base", material: { densityKgPerM3: 2700 } }, scope)).toEqual({
      ok: false,
      error: 'writeScope: setBodyMaterial "base" is outside the scope [body:upright]',
    });
  });

  it("an agent sets a body's material and saves a body as a part, over the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cocaide-bodies-"));
    const s = await AgentSession.open({ doc: stand, outDir: dir });
    expect((await s.call("setBodyMaterial", { body: "upright", material: { name: "aluminium 6061", densityKgPerM3: 2700 } })).result).toMatchObject({ ok: true, revision: 1 });
    const saved = await s.call("saveBody", { body: "upright" });
    expect(saved.result).toMatchObject({ ok: true, file: join(dir, "stand-upright.cocaide.json"), body: "upright" });
    const part = JSON.parse(readFileSync(saved.result.file as string, "utf8"));
    expect(part).toMatchObject({ name: "upright", material: { name: "aluminium 6061", densityKgPerM3: 2700 } });
    expect((await s.call("saveBody", { body: "plinth" })).result).toMatchObject({ ok: false, error: 'saveBody: no body "plinth" (bodies: base, upright)' });
    s.close();
  });
});
