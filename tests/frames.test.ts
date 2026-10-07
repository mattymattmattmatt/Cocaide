// Phase J: frames built on nodes, joints that trim members, end caps and
// gussets, the cut list read from the trimmed bodies, and the weld table.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { measurementSummary } from "../src/kernel/inspect";
import { anglesText, cutList, cutListCSV, weldTableCSV } from "../src/weldment/cutlist";
import { addFramePath, outsideAlign, parsePaths } from "../src/weldment/frame";

const table: RawDocument = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
const A40 = 444; // SHS 40×40×3, mm²
const A50 = 564;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

function built(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    const m = r.measurements;
    return {
      ok: r.ok,
      errors: r.errors,
      volume: m ? r6(m.volume) : 0,
      bodies: new Map((m?.bodies ?? []).map((b) => [b.name, { volume: r6(b.volume), min: b.boundingBox!.min.map(r6), max: b.boundingBox!.max.map(r6), size: b.boundingBox!.size.map(r6) }])),
      members: m?.members ?? [],
      interference: m?.interference ?? [],
      summary: m ? measurementSummary(m) : null,
    };
  } finally {
    r.dispose();
  }
}

function must(r: ReturnType<typeof apply>): RawDocument {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const feature = (doc: RawDocument, id: string) => doc.features.find((f) => f.id === id)!;
const withFeatures = (features: Record<string, unknown>[]): RawDocument => ({ ...structuredClone(table), features });
const members = table.features.filter((f) => f.op === "member");

describe("the table frame: the Phase J acceptance", () => {
  it("builds 1200 × 600 × 900 outside, mitred at the top, with no interference between members", () => {
    const b = built(table);
    expect(b.errors).toEqual([]);
    expect(b.interference).toEqual([]);
    expect(b.bodies.size).toBe(8);
    // The outside of the frame is its nodes: 1200 × 600 × 900.
    const all = [...b.bodies.values()];
    expect([0, 1, 2].map((k) => Math.min(...all.map((x) => x.min[k])))).toEqual([0, 0, 0]);
    expect([0, 1, 2].map((k) => Math.max(...all.map((x) => x.max[k])))).toEqual([1200, 600, 900]);
    // Each member's volume is its section times its length at the centroid, 20 mm in from the outside.
    expect(b.bodies.get("rail_front")!.volume).toBeCloseTo(A40 * (1200 - 2 * 20), 6);
    expect(b.bodies.get("rail_right")!.volume).toBeCloseTo(A40 * (600 - 2 * 20), 6);
    expect(b.bodies.get("leg_a")!.volume).toBeCloseTo(A40 * 860, 6);
    expect(b.volume).toBeCloseTo(A40 * (2 * 1160 + 2 * 560 + 4 * 860), 6);
  });

  it("reads the cut list off the trimmed bodies: lengths and angles match the bodies measured another way", () => {
    const b = built(table);
    for (const m of b.members) {
      const body = b.bodies.get(m.body)!;
      const f = feature(table, m.id) as { from: string; to: string };
      const along = table.nodes && (table.nodes as Record<string, unknown>)[f.from] !== undefined ? axisOf(f.from, f.to) : -1;
      // Axis-aligned members: the length is the body's extent along its axis.
      expect(m.length).toBeCloseTo(body.size[along], 6);
      // The angle shows in the volume: a 45° mitre at both ends takes 2 × 20 mm off the centroid's length; a square end takes nothing.
      const cut = m.angles.reduce((t, a) => t + 20 * Math.tan((a * Math.PI) / 180), 0);
      expect(body.volume).toBeCloseTo(A40 * (m.length - cut), 3);
    }
    expect(cutList(b.members).map((i) => [i.designation, i.length, anglesText(i.angles), i.quantity, i.members])).toEqual([
      ["SHS 40x40x3", 1200, "45° / 45°", 2, ["rail_front", "rail_back"]],
      ["SHS 40x40x3", 860, "square", 4, ["leg_a", "leg_b", "leg_c", "leg_d"]],
      ["SHS 40x40x3", 600, "45° / 45°", 2, ["rail_right", "rail_left"]],
    ]);
    // The agent reads the same list.
    expect((b.summary as { cutList: unknown[] }).cutList[1]).toEqual({ item: 2, size: "SHS 40x40x3", length: 860, angles: [0, 0], quantity: 4, kgEach: 2.997444, members: ["leg_a", "leg_b", "leg_c", "leg_d"] });
  });

  it("switches every member to SHS 50×50×3: the outside stays, the legs shorten, the cut list follows", () => {
    const s50 = structuredClone(table);
    for (const f of s50.features) if (f.op === "member") f.size = "SHS 50x50x3";
    const b = built(s50);
    expect(b.errors).toEqual([]);
    expect(b.interference).toEqual([]);
    expect(b.volume).toBeCloseTo(A50 * (2 * 1150 + 2 * 550 + 4 * 850), 6);
    expect(cutList(b.members).map((i) => [i.designation, i.length, i.angles, i.quantity])).toEqual([
      ["SHS 50x50x3", 1200, [45, 45], 2],
      ["SHS 50x50x3", 850, [0, 0], 4],
      ["SHS 50x50x3", 600, [45, 45], 2],
    ]);
  });

  it("moves with its nodes: a wider table is longer rails, nothing else", () => {
    const wide = must(apply(table, { type: "setParameter", name: "frame_w", value: 1500 }));
    const items = cutList(built(wide).members);
    expect(items.map((i) => [i.length, i.quantity])).toEqual([
      [1500, 2],
      [860, 4],
      [600, 2],
    ]);
  });
});

/** The world axis two nodes of the example differ along. */
function axisOf(a: string, b: string): number {
  const nodes = validateDocument(table).nodes;
  const d = [0, 1, 2].map((k) => Math.abs(nodes[b][k] - nodes[a][k]));
  return d.indexOf(Math.max(...d));
}

describe("joints", () => {
  it("butts members against one that runs through, which is extended to cover them; a gap is left at the face", () => {
    const doc = withFeatures([
      ...members,
      { id: "j_a", op: "joint", node: "A", type: "butt", through: "leg_a", gap: 2 },
      { id: "j_b", op: "joint", node: "B", type: "butt", through: "rail_front" },
      { id: "j_c", op: "joint", node: "C", type: "mitre", members: ["rail_right", "rail_back"], gap: 2 },
      { id: "j_d", op: "joint", node: "D", type: "mitre", members: ["rail_back", "rail_left"] },
    ]);
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.interference).toEqual([]);
    const length = (id: string) => b.members.find((m) => m.id === id)!.length;
    // A: the leg runs up to the top; the rails stop 2 mm short of it.
    expect(length("leg_a")).toBe(900);
    expect(b.bodies.get("rail_front")!.min[0]).toBe(42);
    // B: the front rail runs through to 1200; the side rail and the leg stop at its faces.
    expect(length("rail_front")).toBe(1158);
    expect(b.bodies.get("rail_right")!.min[1]).toBe(40);
    expect(length("leg_b")).toBe(860);
    // C: a 2 mm gap across the mitre is 1 mm each side, √2 mm along each rail.
    expect(length("rail_right")).toBeCloseTo(600 - 40 - Math.SQRT2, 6);
    expect(length("leg_c")).toBe(858);
  });

  it("says why a joint can't be made, and makes none of it", () => {
    // Two members in line can be spliced square, but not butted.
    const line = withFeatures([
      { id: "a", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "E", to: "F" },
      { id: "b", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "F", to: [2400, 0, 0] },
      { id: "j", op: "joint", node: "F", type: "butt", through: "a" },
    ]);
    expect(built(line).errors).toEqual(["j: b runs along a at F: it can't butt against it"]);
    const splice = withFeatures([...line.features.slice(0, 2), { id: "j", op: "joint", node: "F", type: "mitre" }]);
    const s = built(splice);
    expect(s.errors).toEqual([]);
    expect(s.members.map((m) => [m.length, m.angles])).toEqual([
      [1200, [0, 0]],
      [1200, [0, 0]],
    ]);
    // Too sharp to mitre.
    const sharp = withFeatures([
      { id: "a", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "E", to: "F" },
      { id: "b", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "E", to: [1200, 50, 0] },
      { id: "j", op: "joint", node: "E", type: "mitre" },
    ]);
    expect(built(sharp).errors).toEqual(["j: a and b meet at 2.4°: too sharp to mitre"]);
  });

  it("validates joints: their node, their members, one joint a node", () => {
    const bad = withFeatures([
      ...members,
      { id: "j1", op: "joint", node: "A", type: "mitre" },
      { id: "j2", op: "joint", node: "A", type: "butt", through: "leg_a" },
      { id: "j3", op: "joint", node: "B", type: "butt", through: "rail_back" },
      { id: "j4", op: "joint", node: "Z", type: "mitre" },
      { id: "j5", op: "joint", node: "C", type: "mitre", members: ["rail_right", "leg_a"], gap: -1 },
      { id: "j6", op: "joint", node: "D", type: "corner" },
    ]);
    const errors = allErrors(validateDocument(bad));
    expect(errors).toContain("j1: members: 3 members end at A (rail_front, rail_left, leg_a): name the two to mitre");
    expect(errors).toContain("j3: through: rail_back neither ends at B nor passes through it");
    expect(errors).toContain("j4: node: must name a node (got \"Z\"; nodes: A, B, C, D, E, F, G, H)");
    expect(errors).toContain("j5: gap: must not be negative (got -1)");
    expect(errors).toContain('j6: type: must be "mitre" or "butt" (got "corner")');
    // j1 failed, so A has no joint yet and j2 is fine.
    expect(errors.filter((e) => e.startsWith("j2"))).toEqual([]);
    const twice = withFeatures([...members, { id: "j1", op: "joint", node: "A", type: "butt", through: "leg_a" }, { id: "j2", op: "joint", node: "A", type: "butt", through: "leg_a" }]);
    expect(allErrors(validateDocument(twice))).toEqual(["j2: node: A already has a joint (j1); a node has one"]);
  });
});

describe("end caps and gussets", () => {
  it("caps a square end with a plate of the section's outline, and refuses a mitred one", () => {
    const doc = withFeatures([
      ...table.features,
      { id: "foot", op: "endCap", member: "leg_a", end: "start", thickness: 5 },
      { id: "bad", op: "endCap", member: "rail_front", end: "start", thickness: 5 },
    ]);
    const b = built(doc);
    expect(b.errors).toEqual(["bad: the start of rail_front is cut by corner_a; an end cap goes on a square end"]);
    expect(b.bodies.get("foot")).toMatchObject({ volume: 40 * 40 * 5, min: [0, 0, -5], max: [40, 40, 0] });
    expect(b.interference).toEqual([]);
  });

  it("sets a gusset in the inside corner, centred on the members, its corner clipped", () => {
    const doc = withFeatures([...table.features, { id: "g", op: "gusset", node: "A", members: ["leg_a", "rail_front"], size: 80, thickness: 5, chamfer: 10 }]);
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.bodies.get("g")).toEqual({ volume: (80 * 80 - 10 * 10) / 2 * 5, min: [40, 17.5, 780], max: [120, 22.5, 860], size: [80, 5, 80] });
    expect(b.interference).toEqual([]);
    const line = withFeatures([
      { id: "a", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "E", to: "F" },
      { id: "b", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "F", to: [2400, 0, 0] },
      { id: "g", op: "gusset", node: "F", members: ["a", "b"], size: 80, thickness: 5 },
    ]);
    expect(built(line).errors).toEqual(["g: a and b are in line at F: a gusset needs a corner"]);
  });

  it("validates them: a member before it, a node it is at, sizes that make sense", () => {
    const bad = withFeatures([
      { id: "cap", op: "endCap", member: "leg_a", end: "top", thickness: 0 },
      ...members,
      { id: "g", op: "gusset", node: "A", members: ["leg_a", "leg_b"], size: 50, thickness: 5, chamfer: 60 },
    ]);
    expect(allErrors(validateDocument(bad))).toEqual([
      'cap: member: no member "leg_a" before this feature',
      'cap: end: must be "start" (the member\'s from end) or "end" (got "top")',
      "cap: thickness: must be greater than 0 (got 0)",
      "g: members[1]: leg_b neither ends at A nor passes through it",
      "g: chamfer: must be less than the size (50)",
    ]);
  });
});

describe("nodes", () => {
  it("validates nodes and the members on them", () => {
    const bad = withFeatures([
      { id: "a", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "A", to: "Q" },
      { id: "b", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "A", to: "A" },
      { id: "c", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "A", to: "B", align: [2, 0] },
    ]);
    (bad.nodes as Record<string, unknown>)["1x"] = [0, 0, 0];
    (bad.nodes as Record<string, unknown>).Z = ["=frame_q", 0, 0];
    expect(allErrors(validateDocument(bad))).toEqual([
      "document: nodes.1x: a node name is letters, digits and _ and starts with a letter",
      'document: nodes.Z[0]: unknown parameter "frame_q" in "=frame_q"',
      "a: to: no node \"Q\" (nodes: A, B, C, D, E, F, G, H)",
      "b: to: nodes A and A are the same point",
      "c: align: must be two numbers from -1 to 1, a place on the section's envelope (got [2,0])",
    ]);
  });

  it("moves, renames and removes nodes; what names them follows, and what uses them keeps them", () => {
    // Raising one corner tilts its rails; the joints still fit them, and the leg under it grows.
    let doc = must(apply(table, { type: "setNode", name: "A", at: [0, 0, 950] }));
    const raised = built(doc);
    expect(raised.errors).toEqual([]);
    expect(raised.interference).toEqual([]);
    expect(raised.members.find((m) => m.id === "leg_a")!.length).toBeGreaterThan(900);
    expect(raised.members.find((m) => m.id === "rail_front")!.angles[0]).not.toBe(45);
    doc = must(apply(table, { type: "renameNode", from: "A", to: "corner_front_left" }));
    expect(Object.keys(doc.nodes as object)[0]).toBe("corner_front_left");
    expect(feature(doc, "rail_front")).toMatchObject({ from: "corner_front_left" });
    expect(feature(doc, "rail_left")).toMatchObject({ to: "corner_front_left" });
    expect(feature(doc, "corner_a")).toMatchObject({ node: "corner_front_left" });
    expect(built(doc).volume).toBeCloseTo(built(table).volume, 6);
    const used = apply(table, { type: "setNode", name: "A", at: null });
    expect(used.ok || used.error).toBe("setNode: A is used by rail_front, rail_left, leg_a, corner_a");
    expect(apply(table, { type: "renameNode", from: "A", to: "B" })).toEqual({ ok: false, error: 'renameNode: a node "B" already exists' });
    const param = apply(table, { type: "deleteParameter", name: "frame_h" });
    expect(param.ok || param.error).toBe("deleteParameter: frame_h is used by node A, node B, node C, node D");
    const spare = must(apply(table, { type: "setNode", name: "X", at: ["=frame_w / 2", 0, 0] }));
    expect(validateDocument(spare).nodes.X).toEqual([600, 0, 0]);
    expect((must(apply(spare, { type: "setNode", name: "X", at: null })).nodes as object)).not.toHaveProperty("X");
  });

  it("keeps joints after their members: deleting or moving a member a joint uses is refused", () => {
    const del = apply(table, { type: "deleteFeature", id: "rail_front" });
    expect(del.ok || del.error).toBe("deleteFeature: rail_front is used by corner_a, corner_b; delete or change them first");
    const up = apply(table, { type: "reorderFeature", id: "corner_a", index: 0 });
    expect(up.ok || up.error).toBe("reorderFeature: corner_a uses rail_left, which would come after it");
  });

  it("scopes node moves: the node's token, or every feature on it, or a new node with +", () => {
    const users = ["rail_front", "rail_left", "leg_a", "corner_a"];
    expect(apply(table, { type: "setNode", name: "A", at: [0, 0, 950] }, { writeScope: ["node:A"] }).ok).toBe(true);
    expect(apply(table, { type: "setNode", name: "A", at: [0, 0, 950] }, { writeScope: users }).ok).toBe(true);
    const out = apply(table, { type: "setNode", name: "A", at: [0, 0, 950] }, { writeScope: users.slice(1) });
    expect(out.ok || out.error).toBe('writeScope: setNode "A" is outside the scope [rail_left, leg_a, corner_a]');
    expect(apply(table, { type: "setNode", name: "X", at: [0, 0, 0] }, { writeScope: ["+"] }).ok).toBe(true);
    // A parameter that moves nodes moves the features on them.
    const p = apply(table, { type: "setParameter", name: "frame_w", value: 1500 }, { writeScope: ["rail_front"] });
    expect(p.ok || p.error).toMatch(/^writeScope: setParameter "frame_w" is outside the scope/);
    // A joint on bodies in scope.
    const j = { id: "j", op: "joint", node: "E", type: "butt", through: "leg_a" };
    const noJoint = withFeatures([...members, { id: "e2", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "E", to: "F" }]);
    expect(apply(noJoint, { type: "addFeature", feature: j }, { writeScope: ["body:leg_a", "body:e2"] }).ok).toBe(true);
    expect(apply(noJoint, { type: "addFeature", feature: j }, { writeScope: ["body:leg_a"] }).ok).toBe(false);
  });
});

describe("members along a path", () => {
  it("reads paths of nodes, and puts members on the outside of the frame", () => {
    expect(parsePaths("A B C D A, A E;F->B")).toEqual([["A", "B", "C", "D", "A"], ["A", "E"], ["F", "B"]]);
    // A rail along +X at the top front edge: the frame's middle is behind it (+Y) and below it, so the line is its top outside edge.
    expect(outsideAlign([0, 0, 900], [1200, 0, 900], [600, 300, 450])).toEqual([-1, 1]);
    expect(outsideAlign([1200, 0, 0], [1200, 0, 900], [600, 300, 450])).toEqual([1, -1]);
    expect(outsideAlign([0, 0, 0], [1, 0, 0], [0.5, 0, 0])).toBeUndefined();
  });

  it("builds the table frame from two paths, the same as the example", () => {
    const blank = withFeatures([]);
    const top = addFramePath(blank, { profile: "SHS", size: "SHS 40x40x3", path: "A B C D A", line: "outside", mitre: true });
    if (!top.ok) throw new Error(top.error);
    expect(top.members).toEqual(["AB", "BC", "CD", "DA"]);
    expect(top.joints).toEqual(["corner_B", "corner_C", "corner_D", "corner_A"]);
    const legs = addFramePath(top.doc, { profile: "SHS", size: "SHS 40x40x3", path: "E A, F B, G C, H D", line: "outside", mitre: true });
    if (!legs.ok) throw new Error(legs.error);
    expect(legs.joints).toEqual([]);
    const b = built(legs.doc);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(built(table).volume, 6);
    expect(cutList(b.members).map((i) => [i.length, i.angles, i.quantity])).toEqual(cutList(built(table).members).map((i) => [i.length, i.angles, i.quantity]));
    // Names that are taken get a number; a path through a node twice in a row, or an unknown node, is refused.
    const again = addFramePath(legs.doc, { profile: "SHS", size: "SHS 40x40x3", path: "A B", line: "centre", mitre: false });
    expect(again.ok && again.members).toEqual(["AB_2"]);
    expect(addFramePath(blank, { profile: "SHS", size: "SHS 40x40x3", path: "A A", line: "centre", mitre: false })).toEqual({ ok: false, error: 'A follows itself in "A A"' });
    expect(addFramePath(blank, { profile: "SHS", size: "SHS 40x40x3", path: "A Q", line: "centre", mitre: false })).toEqual({ ok: false, error: "no node Q (nodes: A, B, C, D, E, F, G, H)" });
  });
});

describe("the cut list and the weld table", () => {
  it("writes CSV", () => {
    const items = cutList(built(table).members);
    expect(cutListCSV(items).split("\r\n")).toEqual([
      "Item,Profile,Size,Length (mm),End 1 (deg),End 2 (deg),Qty,kg each,kg total,Members",
      "1,SHS,SHS 40x40x3,1200.0,45.0,45.0,2,4.043,8.086,rail_front rail_back",
      "2,SHS,SHS 40x40x3,860.0,0.0,0.0,4,2.997,11.990,leg_a leg_b leg_c leg_d",
      "3,SHS,SHS 40x40x3,600.0,45.0,45.0,2,1.952,3.904,rail_right rail_left",
      "",
    ]);
    expect(weldTableCSV([{ id: "w1", between: ["a", "b"], type: "fillet", size: 3, length: 160, allRound: true, note: 'grind flush, "both sides"' }])).toBe(
      'Weld,Between,Type,Size (mm),Length (mm),All round,Note\r\nw1,a + b,fillet,3,160,yes,"grind flush, ""both sides"""\r\n',
    );
    expect(anglesText([45, 0])).toBe("45° / square");
  });

  it("keeps welds as notes on bodies: validated, renamed with their bodies, added and removed by id", () => {
    let doc = must(apply(table, { type: "setWeld", id: "w1", weld: { between: ["leg_a", "rail_front"], type: "fillet", size: 3, length: 160, allRound: true } }));
    expect(doc.welds).toEqual([{ between: ["leg_a", "rail_front"], type: "fillet", size: 3, length: 160, allRound: true, id: "w1" }]);
    doc = must(apply(doc, { type: "renameBody", from: "leg_a", to: "post_a" }));
    expect((doc.welds as { between: string[] }[])[0].between).toEqual(["post_a", "rail_front"]);
    const bad = apply(doc, { type: "setWeld", id: "w2", weld: { between: ["nothing"], type: "spot", size: 0, length: 10 } });
    expect(bad.ok || bad.error).toBe(
      'setWeld rejected: document: welds[1].between[0]: no body "nothing" (bodies: rail_front, rail_right, rail_back, rail_left, post_a, leg_b, leg_c, leg_d); document: welds[1].type: must be "fillet", "butt", "plug" (got "spot"); document: welds[1].size: must be greater than 0 (got 0)',
    );
    doc = must(apply(doc, { type: "setWeld", id: "w1", weld: null }));
    expect(doc).not.toHaveProperty("welds");
    // A weld is a note: the solid doesn't change.
    expect(built(doc).volume).toBeCloseTo(built(table).volume, 6);
  });
});
