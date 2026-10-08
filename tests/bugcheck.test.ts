// The bug check after Phases L and M: renames that the drawing and the bodies'
// materials follow, holes that go where their bodies go, members copied from
// where they started, and a projection that is not redone for a sheet edit.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { drawingChecks } from "../src/drafting/checks";
import { composeSheet, holeText } from "../src/drafting/compose";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { getOC, loadOC, rebuild, type OC } from "../src/kernel";
import { cutList } from "../src/weldment/cutlist";

const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));
const stand = example("stand");
const table = example("table-frame");
const frameMembers = example("frame-members");
const XZ = { type: "datum", normal: [0, 1, 0], origin: [0, 0, 0] };
const YZ = { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] };
const ALU = { name: "aluminium 6061", densityKgPerM3: 2700 };

let oc: OC;
let kernel: LocalKernel;
beforeAll(async () => {
  oc = await loadOC();
  kernel = new LocalKernel(getOC);
});

const add = (doc: RawDocument, ...features: Record<string, unknown>[]): RawDocument => ({ ...doc, features: [...doc.features, ...features] });

function run(doc: RawDocument, ...cmds: Command[]): RawDocument {
  for (const cmd of cmds) {
    const r = apply(doc, cmd);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  }
  return doc;
}

function holesOf(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    expect(r.errors).toEqual([]);
    return r.holes;
  } finally {
    r.dispose();
  }
}

function cutOf(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    expect(r.errors).toEqual([]);
    return cutList(r.measurements!.members).map((i) => [i.quantity, i.length, i.members]);
  } finally {
    r.dispose();
  }
}

async function sheetOf(doc: RawDocument) {
  const c = await kernel.check(doc);
  const views = validateDocument(doc).drawing!.views.map((v) => ({ id: v.id, look: v.look }));
  const geometry = await kernel.project(doc, views);
  const sheet = composeSheet(doc, { measurements: c.measurements, geometry })!;
  return { sheet, checks: drawingChecks(sheet, doc, c.measurements, geometry) };
}

describe("renames", () => {
  it("a member's body renamed: its balloon and dimension still find it, and read the same", async () => {
    const c = await kernel.check(table);
    let doc = run(table, { type: "setDrawing", drawing: planDrawing(table, c.measurements, await kernel.project(table, DEFAULT_VIEWS), { date: "2026-10-08" }) });
    doc = run(
      doc,
      { type: "setAnnotation", id: "b99", annotation: { type: "balloon", view: "front", member: "leg_a" } },
      { type: "setAnnotation", id: "d99", annotation: { type: "dimension", view: "front", member: "leg_a" } },
    );
    doc = run(doc, { type: "renameBody", from: "leg_a", to: "corner_post" });
    const { sheet, checks } = await sheetOf(doc);
    const said = (id: string) => sheet.annotations.find((a) => a.id === id)!;
    expect([said("b99").problem, said("b99").text]).toEqual([undefined, "2"]);
    expect([said("d99").problem, said("d99").text]).toEqual([undefined, "860"]);
    expect(checks.filter((x) => !x.ok)).toEqual([]);
  });

  it("a member renamed by its id carries its body's material and welds with it", () => {
    let doc = run(
      frameMembers,
      { type: "setBodyMaterial", body: "rail", material: ALU },
      { type: "setWeld", id: "w1", weld: { between: ["leg", "rail"], type: "fillet", size: 3, length: 160 } },
    );
    doc = run(doc, { type: "updateFeature", id: "rail", patch: { id: "beam" } });
    expect(doc.bodyMaterials).toEqual({ beam: ALU });
    expect((doc.welds as { between: string[] }[])[0].between).toEqual(["leg", "beam"]);
    expect(allErrors(validateDocument(doc))).toEqual([]);
  });

  it("a body renamed: a body derived from a body derived from it follows too", () => {
    const doc = add(
      stand,
      { id: "mirror_1", op: "mirror", plane: XZ, bodies: ["upright"] },
      { id: "split_1", op: "split", body: "upright_mirror", plane: YZ },
      { id: "move_1", op: "move", bodies: ["upright_mirror_split"], translate: [0, 0, 10] },
    );
    expect(allErrors(validateDocument(doc))).toEqual([]);
    const renamed = run(doc, { type: "renameBody", from: "upright", to: "post" });
    expect(renamed.features.slice(-3)).toEqual([
      { id: "mirror_1", op: "mirror", plane: XZ, bodies: ["post"] },
      { id: "split_1", op: "split", body: "post_mirror", plane: YZ },
      { id: "move_1", op: "move", bodies: ["post_mirror_split"], translate: [0, 0, 10] },
    ]);
  });
});

describe("holes go where their bodies go", () => {
  it("a mirrored hole is one more of it", () => {
    const [h] = holesOf(add(stand, { id: "mirror_1", op: "mirror", plane: XZ, feature: "hole_1" }));
    expect(holeText(h)).toEqual(["3× Ø10 THRU"]);
  });

  it("moved with its body, a hole's entry moves; turned, its axis turns", () => {
    const [moved] = holesOf(add(stand, { id: "move_1", op: "move", bodies: ["base"], translate: [0, 0, -100] }));
    expect([moved.entry, moved.axis]).toEqual([
      [40, 25, -92],
      [0, 0, -1],
    ]);
    const [turned] = holesOf(add(stand, { id: "move_1", op: "move", bodies: ["base"], rotate: { axis: { origin: [0, 0, -50], direction: [1, 0, 0] }, angle: 180 } }));
    expect([turned.entry.map((x) => Math.round(x * 1e6) / 1e6 + 0), turned.axis]).toEqual([
      [40, -25, -108],
      [0, 0, 1],
    ]);
  });

  it("a deleted body's holes are gone; a copied or mirrored body's are twice as many", () => {
    expect(holesOf(add(stand, { id: "delete_1", op: "deleteBody", bodies: ["base"] }))).toEqual([]);
    expect(holesOf(add(stand, { id: "keep_1", op: "deleteBody", keep: ["upright"] }))).toEqual([]);
    expect(holesOf(add(stand, { id: "delete_1", op: "deleteBody", bodies: ["upright"] }))).toHaveLength(1);
    const [copied] = holesOf(add(stand, { id: "copy_1", op: "move", bodies: ["base"], translate: [0, 0, -50], copy: true }));
    expect(holeText(copied)).toEqual(["4× Ø10 THRU"]);
    const [mirrored] = holesOf(add(stand, { id: "mirror_1", op: "mirror", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, -10] }, bodies: ["base"] }));
    expect(holeText(mirrored)).toEqual(["4× Ø10 THRU"]);
    // Split, then one piece deleted: the hole may be in the piece that is left.
    expect(holesOf(add(stand, { id: "split_1", op: "split", body: "base", plane: YZ }, { id: "delete_1", op: "deleteBody", bodies: ["base"] }))).toHaveLength(1);
  });
});

describe("members copied from where they started", () => {
  it("a pattern of a member that was then turned copies the member as it was made, and measures it so", () => {
    const doc = add(
      frameMembers,
      { id: "move_1", op: "move", bodies: ["leg"], rotate: { axis: { origin: [0, 0, 0], direction: [1, 0, 0] }, angle: 90 } },
      { id: "pattern_1", op: "linearPattern", feature: "leg", direction: [0, 1, 0], spacing: 200, count: 2 },
    );
    expect(cutOf(doc)).toEqual([
      [2, 900, ["leg", "leg_2"]],
      [1, 600, ["rail"]],
    ]);
  });

  it("a pattern of a member that was then combined is still lengths of stock", () => {
    const doc = add(
      table,
      { id: "combine_1", op: "combine", operation: "add", target: "rail_front", tools: ["leg_a"] },
      { id: "pattern_1", op: "linearPattern", feature: "leg_a", direction: [0, 1, 0], spacing: 200, count: 2 },
    );
    const legs = cutOf(doc).find((i) => i[1] === 860)!;
    expect(legs).toEqual([4, 860, ["leg_b", "leg_c", "leg_d", "leg_a_2"]]);
  });
});

describe("the projection", () => {
  it("is not redone for a sheet edit: the same look of the same part is the same lines", async () => {
    const c = await kernel.check(table);
    const doc = run(table, { type: "setDrawing", drawing: planDrawing(table, c.measurements, await kernel.project(table, DEFAULT_VIEWS), { date: "2026-10-08" }) });
    const a = (await kernel.project(doc, [{ id: "front", look: "front" }]))!;
    const edited = run(doc, { type: "setSheet", patch: { title: "frame" } });
    const b = (await kernel.project(edited, [{ id: "elevation", look: "front" }]))!;
    expect(b.views[0].id).toBe("elevation");
    expect(b.views[0].bodies).toBe(a.views[0].bodies);
    // A different part is projected afresh.
    const c2 = (await kernel.project(stand, [{ id: "front", look: "front" }]))!;
    expect(c2.views[0].bodies).not.toBe(a.views[0].bodies);
  });
});
