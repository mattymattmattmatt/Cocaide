// Members on a layout sketch's lines: nodes that follow sketch points (worked
// out from the sketch's plane with no kernel), members and corner joints made
// from picked lines in one change, and the frame following an edit of the
// sketch through a real rebuild.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { addSketchMembers, memberKind } from "../src/weldment/sketchFrame";
import { resolveNodeLink } from "../src/weldment/sketchNodes";

const table: RawDocument = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const line = (id: string, start: [number, number], end: [number, number]) => ({ id, type: "line", start, end });
/** A 1000 × 600 rectangle on Front with a post up the middle. */
function layout(plane: Record<string, unknown> = { type: "ref", ref: { datum: "Front" } }, extra: Record<string, unknown>[] = []): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "frame",
    profiles: structuredClone(table.profiles),
    features: [
      ...extra,
      {
        id: "layout",
        op: "sketch",
        plane,
        entities: [line("l1", [0, 0], [1000, 0]), line("l2", [1000, 0], [1000, 600]), line("l3", [1000, 600], [0, 600]), line("l4", [0, 600], [0, 0]), line("l5", [500, 0], [500, 600])],
      },
    ],
  } as RawDocument;
}

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return r as Extract<T, { ok: true }>;
}

describe("a node that follows a sketch point", () => {
  it("is where the point is on Front, on a flipped and offset Top, and on a plane feature offset from Right", () => {
    expect(resolveNodeLink(layout().features, { sketch: "layout", point: "l2.end" })).toEqual({ ok: true, at: [1000, 0, 600] });
    expect(resolveNodeLink(layout().features, { sketch: "layout", point: "l1.mid" })).toEqual({ ok: true, at: [500, 0, 0] });
    // Top offset 50 and flipped: x kept, y reversed.
    expect(resolveNodeLink(layout({ type: "ref", ref: { datum: "Top" }, offset: 50, flip: true }).features, { sketch: "layout", point: "l2.end" })).toEqual({ ok: true, at: [1000, -600, 50] });
    // A plane 200 along Right's normal (+X): the sketch's x is +Y, its y +Z.
    const onPlane = layout({ type: "ref", ref: { datum: "side" } }, [{ id: "side", op: "plane", mode: "offset", refs: [{ datum: "Right" }], distance: 200 }]);
    expect(resolveNodeLink(onPlane.features, { sketch: "layout", point: "l2.end" })).toEqual({ ok: true, at: [200, 1000, 600] });
  });

  it("says why when it can't be found, and that fails what uses the node, not the part", () => {
    const face = layout({ type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } });
    expect(resolveNodeLink(face.features, { sketch: "layout", point: "l1.end" })).toMatchObject({ ok: false, error: expect.stringContaining("on a face") });
    expect(resolveNodeLink(layout().features, { sketch: "layout", point: "l9.end" })).toMatchObject({ ok: false, error: expect.stringContaining("has no l9") });
    expect(resolveNodeLink(layout().features, { sketch: "nope", point: "l1.end" })).toMatchObject({ ok: false, error: expect.stringContaining('no sketch "nope"') });
    const doc = { ...layout(), nodes: { A: { sketch: "layout", point: "l9.start" }, B: [0, 0, 0] } } as RawDocument;
    doc.features.push({ id: "m", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "A", to: "B" });
    const v = validateDocument(doc);
    expect(v.headerErrors).toEqual([]);
    expect(v.nodeProblems.A).toContain("has no l9");
    expect(allErrors(v).join("\n")).toContain("node A follows layout's l9.start, but layout has no l9");
  });
});

describe("members from picked sketch lines", () => {
  const spec = { profile: "SHS", size: "SHS 40x40x3", line: "outside", corners: "mitre" } as const;
  const lines = ["l1", "l2", "l3", "l4", "l5"].map((entity) => ({ sketch: "layout", entity }));

  it("makes a member per line on shared nodes, mitres the corners and butts the post", () => {
    const r = must(addSketchMembers(layout(), { ...spec, lines }));
    expect(r.members).toHaveLength(5);
    // Four corners and the post's two ends: six nodes, each following a point of the sketch.
    expect(r.nodes).toHaveLength(6);
    expect(Object.values(r.doc.nodes as object).every((n) => "sketch" in n)).toBe(true);
    const joints = r.doc.features.filter((f) => f.op === "joint");
    expect(joints.filter((j) => j.type === "mitre")).toHaveLength(4);
    const butts = joints.filter((j) => j.type === "butt");
    // Named by how they run: the rails level, the sides and the middle post upright.
    expect(r.members).toEqual(["rail_1", "post_1", "rail_2", "post_2", "post_3"]);
    expect(butts.map((j) => j.through).sort()).toEqual(["rail_1", "rail_2"]);
    expect(butts).toHaveLength(2);
    expect(allErrors(validateDocument(r.doc))).toEqual([]);
    // Picked again: nothing new, and it says so.
    expect(addSketchMembers(r.doc, { ...spec, lines })).toEqual({ ok: false, error: "every line picked has a member on it already" });
  });

  it("butts the corners when asked, and refuses a line that isn't one", () => {
    const r = must(addSketchMembers(layout(), { ...spec, corners: "butt", lines: lines.slice(0, 4) }));
    expect(r.doc.features.filter((f) => f.op === "joint").every((j) => j.type === "butt")).toBe(true);
    const doc = layout();
    (doc.features[0].entities as unknown[]).push({ id: "c1", type: "circle", center: [0, 0], radius: 5 });
    expect(addSketchMembers(doc, { ...spec, lines: [{ sketch: "layout", entity: "c1" }] })).toMatchObject({ ok: false, error: expect.stringContaining("straight line") });
  });

  it("builds, and follows the sketch when a line moves", () => {
    const r = must(addSketchMembers(layout(), { ...spec, lines }));
    const size = (doc: unknown) => {
      const b = rebuild(doc, oc);
      try {
        expect(b.errors).toEqual([]);
        const box = b.measurements!.boundingBox!;
        return [box.size.map((x) => Math.round(x)), b.measurements!.bodies.length];
      } finally {
        b.dispose();
      }
    };
    // Outside: the lines are the frame's outside edges.
    expect(size(r.doc)).toEqual([[1000, 40, 600], 5]);
    // The right side moved out to 1200 (its two lines' ends together, as a solve would leave them).
    const moved = must(apply(r.doc, { type: "updateFeature", id: "layout", patch: { entities: [line("l1", [0, 0], [1200, 0]), line("l2", [1200, 0], [1200, 600]), line("l3", [1200, 600], [0, 600]), line("l4", [0, 600], [0, 0]), line("l5", [500, 0], [500, 600])] } }));
    expect(size(moved.doc)).toEqual([[1200, 40, 600], 5]);
  });

  it("keeps the links when the sketch is renamed, and the frame when it is deleted", () => {
    const r = must(addSketchMembers(layout(), { ...spec, lines }));
    // Deleted, the frame stays: its nodes keep their places as coordinates.
    const gone = must(apply(r.doc, { type: "deleteFeature", id: "layout" }));
    expect(gone.doc.nodes).toMatchObject({ A: [0, 0, 0], B: [1000, 0, 0], C: [1000, 0, 600] });
    expect(allErrors(validateDocument(gone.doc))).toEqual([]);
    const renamed = must(apply(r.doc, { type: "updateFeature", id: "layout", patch: { id: "frame_layout" } }));
    expect(Object.values(renamed.doc.nodes as Record<string, { sketch: string }>).every((n) => n.sketch === "frame_layout")).toBe(true);
    expect(allErrors(validateDocument(renamed.doc))).toEqual([]);
  });
});

describe("the agent's membersFromSketch", () => {
  it("takes all of a sketch's lines with just a size, and says what it needs when it can't", async () => {
    const { membersFromSketch } = await import("../src/weldment/sketchFrame");
    const r = membersFromSketch(layout(), { size: "SHS 50x50x3", sketch: "layout", corners: "butt" });
    if (!r.ok) throw new Error(r.error);
    expect(r.members).toHaveLength(5);
    expect(r.commands.filter((c) => c.type === "setNode")).toHaveLength(6);
    expect(r.doc.features.filter((f) => f.op === "member").every((m) => m.profile === "SHS" && m.size === "SHS 50x50x3")).toBe(true);
    expect(membersFromSketch(layout(), { size: "SHS 99x99x9", sketch: "layout" })).toMatchObject({ ok: false, error: expect.stringContaining("addLibraryProfile") });
    expect(membersFromSketch(layout(), { size: "SHS 40x40x3" })).toMatchObject({ ok: false, error: expect.stringContaining('name a "sketch"') });
  });
});

describe("members on a sketch on a face", () => {
  /** A 1200 × 800 × =t plate, and the frame's layout sketched on its top face. */
  function onPlate(t = 10): RawDocument {
    return {
      version: 1,
      units: "mm",
      name: "base",
      parameters: { t },
      profiles: structuredClone(table.profiles),
      features: [
        { id: "plate_sk", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 1200, h: 800 }] },
        { id: "plate", op: "extrude", sketch: "plate_sk", distance: "=t", direction: [0, 0, 1] },
        {
          id: "layout",
          op: "sketch",
          plane: { type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } },
          entities: [line("l1", [-500, -300], [500, -300]), line("l2", [500, -300], [500, 300]), line("l3", [500, 300], [-500, 300]), line("l4", [-500, 300], [-500, -300])],
        },
      ],
    } as RawDocument;
  }
  const framesAfter = (doc: RawDocument) => {
    const b = rebuild(doc, oc);
    try {
      return Object.fromEntries(b.sketches.map((k) => [k.id, k.frame]));
    } finally {
      b.dispose();
    }
  };
  const lowest = (doc: unknown) => {
    const b = rebuild(doc, oc);
    try {
      expect(b.errors).toEqual([]);
      const members = b.measurements!.bodies.filter((x) => x.name !== "main");
      expect(members).toHaveLength(4);
      return Math.round(Math.min(...members.map((x) => x.boundingBox!.min[2])) * 1000) / 1000;
    } finally {
      b.dispose();
    }
  };

  it("is placed from where the rebuild found the sketch, and follows the face when the plate gets thicker", () => {
    const doc = onPlate();
    // Without the sketch's frame, validation says it needs the rebuild (and doesn't guess).
    const linked = { ...doc, nodes: { A: { sketch: "layout", point: "l1.start" } } } as RawDocument;
    expect(validateDocument(linked).needsFrames).toEqual(["layout"]);
    const r = must(addSketchMembers(doc, { profile: "SHS", size: "SHS 40x40x3", line: "outside", corners: "mitre", lines: ["l1", "l2", "l3", "l4"].map((entity) => ({ sketch: "layout", entity })), frames: framesAfter(doc) }));
    expect(r.members).toHaveLength(4);
    // The members stand on the plate: their lines are on its top face.
    const sitting = lowest(r.doc);
    const thicker = apply(r.doc, { type: "setParameter", name: "t", value: 25 });
    if (!thicker.ok) throw new Error(thicker.error);
    expect(lowest(thicker.doc)).toBe(sitting + 15);
  });
});

describe("members named as they are picked", () => {
  it("takes each line's own member id, and refuses one already taken", () => {
    const named = ["l1", "l2", "l3", "l4"].map((entity, i) => ({ sketch: "layout", entity, id: ["rail_bottom", "post_right", "rail_top", "post_left"][i] }));
    const r = addSketchMembers(layout(), { profile: "SHS", size: "SHS 40x40x3", line: "centre", corners: "butt", lines: named });
    if (!r.ok) throw new Error(r.error);
    expect(r.members).toEqual(["rail_bottom", "post_right", "rail_top", "post_left"]);
    expect(r.doc.features.filter((f) => f.op === "joint").every((j) => typeof j.through === "string" && r.members.includes(j.through as string))).toBe(true);
    expect(addSketchMembers(r.doc, { profile: "SHS", size: "SHS 40x40x3", line: "centre", corners: "none", lines: [{ sketch: "layout", entity: "l5", id: "rail_top" }] })).toMatchObject({ ok: false, error: expect.stringContaining("taken") });
  });
});

describe("renaming a member of a frame", () => {
  it("carries the joints that name it", () => {
    const r = addSketchMembers(layout(), { profile: "SHS", size: "SHS 40x40x3", line: "outside", corners: "mitre", lines: ["l1", "l2", "l3", "l4", "l5"].map((entity) => ({ sketch: "layout", entity })) });
    if (!r.ok) throw new Error(r.error);
    const renamed = apply(r.doc, { type: "updateFeature", id: "rail_1", patch: { id: "bottom_rail" } });
    if (!renamed.ok) throw new Error(renamed.error);
    const joints = renamed.doc.features.filter((f) => f.op === "joint");
    expect(joints.some((j) => j.through === "bottom_rail")).toBe(true);
    expect(joints.some((j) => Array.isArray(j.members) && j.members.includes("bottom_rail"))).toBe(true);
    expect(JSON.stringify(joints)).not.toContain('"rail_1"');
    expect(allErrors(validateDocument(renamed.doc))).toEqual([]);
  });
});

describe("ends that nearly meet", () => {
  const spec = { profile: "SHS", size: "SHS 40x40x3", line: "centre", corners: "butt" } as const;
  /** The rectangle, with the middle post stopping `short` mm below the top rail's line. */
  const withPost = (short: number) => {
    const doc = layout();
    (doc.features[0].entities as Record<string, unknown>[])[4] = line("l5", [500, 0], [500, 600 - short]);
    return addSketchMembers(doc, { ...spec, lines: ["l1", "l2", "l3", "l4", "l5"].map((entity) => ({ sketch: "layout", entity })) });
  };

  it("joins a post that stops inside the rail's section, and builds", () => {
    const r = must(withPost(15));
    expect(r.warnings).toEqual([]);
    // The post's top, 15 mm under the rail's line: butted against the rail.
    const nodes = validateDocument(r.doc).nodes;
    const top = r.doc.features.find((f) => f.op === "joint" && JSON.stringify(nodes[String(f.node)]) === JSON.stringify([500, 0, 585]));
    expect(top).toMatchObject({ type: "butt", through: "rail_2" });
    const b = rebuild(r.doc, oc);
    try {
      expect(b.errors).toEqual([]);
    } finally {
      b.dispose();
    }
  });

  it("says when a post stops short of the rail, rather than leaving it unjoined without a word", () => {
    const r = must(withPost(60));
    expect(r.warnings).toEqual(["post_3 ends 60 mm from rail_2, so it isn't joined to it: take its sketch line onto rail_2's"]);
  });
});

describe("sketches that disagree at a shared corner", () => {
  it("warns on the member that has left its own sketch line", () => {
    const doc = layout();
    doc.features.push({ id: "side", op: "sketch", plane: { type: "ref", ref: { datum: "Right" } }, entities: [line("s1", [0, 0], [800, 0])] });
    const r = must(addSketchMembers(doc, { profile: "SHS", size: "SHS 40x40x3", line: "centre", corners: "butt", lines: [...["l1", "l2", "l3", "l4"].map((entity) => ({ sketch: "layout", entity })), { sketch: "side", entity: "s1" }] }));
    const side = r.doc.features.find((f) => (f.along as { sketch?: string })?.sketch === "side")!;
    const warningsOf = (d: unknown) => {
      const b = rebuild(d, oc);
      try {
        return b.features.find((f) => f.id === side.id)?.warnings ?? [];
      } finally {
        b.dispose();
      }
    };
    expect(warningsOf(r.doc)).toEqual([]);
    // The front sketch's corner moves 100 mm along: the side member's end goes with it, its own line doesn't.
    const moved = apply(r.doc, { type: "updateFeature", id: "layout", patch: { entities: [line("l1", [100, 0], [1000, 0]), line("l2", [1000, 0], [1000, 600]), line("l3", [1000, 600], [100, 600]), line("l4", [100, 600], [100, 0]), line("l5", [500, 0], [500, 600])] } });
    if (!moved.ok) throw new Error(moved.error);
    expect(warningsOf(moved.doc)).toEqual([`${side.id}: ${side.id} is 100 mm off its sketch line (side's s1): its end follows a corner another sketch moved; move the line to match, or put the member on it again`]);
  });
});

describe("ends near another member's end", () => {
  it("a post's foot under a rail's end is not trimmed to the rail", () => {
    // The rectangle on Front, posts down past the bottom rail to a foot 20 mm under it (as a frame's posts stand on plates).
    const doc = layout();
    (doc.features[0].entities as Record<string, unknown>[]).splice(0, 5, line("bottom", [0, 20], [1000, 20]), line("right", [1000, 0], [1000, 600]), line("top", [1000, 600], [0, 600]), line("left", [0, 600], [0, 0]));
    const r = must(addSketchMembers(doc, { profile: "SHS", size: "SHS 40x40x3", line: "centre", corners: "butt", runThrough: "posts", lines: ["bottom", "right", "top", "left"].map((entity) => ({ sketch: "layout", entity })) }));
    const nodes = validateDocument(r.doc).nodes;
    // No joint at the posts' feet: nothing meets them there.
    const feet = r.doc.features.filter((f) => f.op === "joint" && nodes[String(f.node)]?.[2] === 0);
    expect(feet).toEqual([]);
  });
});

describe("a frame made in groups, as a person would", () => {
  /** A door opening on Front: two trimmers up to a lintel line, a cripple from it to the top plate. */
  const opening = (): RawDocument =>
    ({
      version: 1,
      units: "mm",
      name: "opening",
      profiles: structuredClone(table.profiles),
      features: [
        { id: "wall", op: "sketch", plane: { type: "ref", ref: { datum: "Front" } }, entities: [line("top", [0, 1200], [1000, 1200]), line("t0", [200, 0], [200, 800]), line("t1", [800, 0], [800, 800]), line("lintel", [150, 800], [850, 800]), line("c0", [500, 800], [500, 1200])] },
      ],
    }) as RawDocument;
  const add = (doc: RawDocument, lines: string[], extra: Record<string, unknown> = {}) =>
    must(addSketchMembers(doc, { profile: "SHS", size: "SHS 40x40x3", line: "centre", corners: "butt", runThrough: "rails", lines: lines.map((entity) => ({ sketch: "wall", entity })), ...extra }));

  it("joins studs to a lintel added after them, and puts a second lintel beside the first", () => {
    let doc = add(opening(), ["top"]).doc;
    doc = add(doc, ["t0", "t1", "c0"]).doc;
    // The lintel last: the trimmers' tops and the cripple's foot on its line are joined to it now.
    const lintel = add(doc, ["lintel"], { align: [1, 0] });
    const v = validateDocument(lintel.doc);
    const throughLintel = lintel.doc.features.filter((f) => f.op === "joint" && f.through === lintel.members[0]);
    expect(throughLintel.map((j) => v.nodes[String(j.node)])).toEqual(expect.arrayContaining([[200, 0, 800], [800, 0, 800], [500, 0, 800]]));
    // A second lintel on the same line, on the other side of it: it goes in; the same one again doesn't.
    const second = add(lintel.doc, ["lintel"], { align: [-1, 0] });
    expect(second.members).toHaveLength(1);
    expect(addSketchMembers(second.doc, { profile: "SHS", size: "SHS 40x40x3", line: "centre", corners: "butt", align: [-1, 0], lines: [{ sketch: "wall", entity: "lintel" }] })).toMatchObject({ ok: false, error: expect.stringContaining("already") });
  });

  it("puts a doubled lintel's two leaves on one line with no joint between them, and butts both to the kings", () => {
    // The lintel line from king to king; the kings drawn after.
    const doc = opening();
    (doc.features[0].entities as Record<string, unknown>[]).push(line("king_l", [130, 0], [130, 1200]), line("king_r", [870, 0], [870, 1200]));
    (doc.features[0].entities as Record<string, unknown>[]).find((e) => e.id === "lintel")!.start = [130, 800];
    (doc.features[0].entities as Record<string, unknown>[]).find((e) => e.id === "lintel")!.end = [870, 800];
    const a = add(doc, ["lintel"], { align: [1, 0] });
    const b = add(a.doc, ["lintel"], { align: [-1, 0] });
    expect(b.joints).toEqual([]);
    const kings = add(b.doc, ["king_l", "king_r"]);
    const v = validateDocument(kings.doc);
    const atEnds = kings.doc.features.filter((f) => f.op === "joint" && [[130, 0, 800], [870, 0, 800]].some((p) => JSON.stringify(v.nodes[String(f.node)]) === JSON.stringify(p)));
    expect(atEnds).toHaveLength(2);
    const built = rebuild(kings.doc, oc);
    try {
      expect(built.errors).toEqual([]);
    } finally {
      built.dispose();
    }
  });

  it("doesn't butt a trimmer against the king stud beside it", () => {
    // A king stud full height 20 mm beside the left trimmer: the trimmer's top is inside the stud's section reach.
    const doc = opening();
    (doc.features[0].entities as Record<string, unknown>[]).push(line("bottom", [0, 0], [1000, 0]), line("king", [180, 0], [180, 1200]));
    const studs = add(add(doc, ["top", "bottom"]).doc, ["t0", "t1", "king"]);
    const v = validateDocument(studs.doc);
    const king = studs.doc.features.find((f) => f.op === "member" && (f.along as { entity: string }).entity === "king")!;
    expect(studs.doc.features.filter((f) => f.op === "joint" && f.through === king.id)).toEqual([]);
    // The lintel after: the trimmers' tops butt against it.
    const lintel = add(studs.doc, ["lintel"]);
    const tops = lintel.doc.features.filter((f) => f.op === "joint" && f.through === lintel.members[0]).map((j) => v.nodes[String(j.node)] ?? validateDocument(lintel.doc).nodes[String(j.node)]);
    expect(tops).toEqual(expect.arrayContaining([[200, 0, 800], [800, 0, 800]]));
    const b = rebuild(lintel.doc, oc);
    try {
      expect(b.errors).toEqual([]);
    } finally {
      b.dispose();
    }
  });

  it("says nothing of a nogging picked before the studs it runs between, and joins it when they come", () => {
    // A nogging between the trimmers, 40 mm short of the lintel line above it: its ends are on the trimmers' lines.
    const doc = opening();
    (doc.features[0].entities as Record<string, unknown>[]).push(line("nog", [200, 760], [800, 760]));
    const nogs = add(add(doc, ["lintel"]).doc, ["nog"]);
    expect(nogs.warnings).toEqual([]);
    const studs = add(nogs.doc, ["t0", "t1"]);
    const v = validateDocument(studs.doc);
    const atNogEnds = studs.doc.features.filter((f) => f.op === "joint" && [[200, 0, 760], [800, 0, 760]].some((p) => JSON.stringify(v.nodes[String(f.node)]) === JSON.stringify(p)));
    expect(atNogEnds).toHaveLength(2);
  });
});

describe("an offset L: an end wall's raked plate over the front wall's top plate end", () => {
  it("trims only the one the spec doesn't run through, never both", () => {
    const doc = layout();
    (doc.features[0].entities as Record<string, unknown>[]).splice(0, 5, line("plate", [0, 0], [1000, 0]));
    // On Right, 15 mm in from the plate's end, falling away from it: its start 4 mm above the plate's line.
    doc.features.push({ id: "end", op: "sketch", plane: { type: "ref", ref: { datum: "Right" }, offset: 15 }, entities: [line("rake", [0, 4], [800, -76])] } as never);
    const r = must(addSketchMembers(doc, { profile: "SHS", size: "SHS 40x40x3", line: "centre", corners: "butt", runThrough: "longer", lines: [{ sketch: "layout", entity: "plate" }, { sketch: "end", entity: "rake" }] }));
    const plate = r.doc.features.find((f) => f.op === "member" && (f.along as { entity: string }).entity === "plate")!;
    const rake = r.doc.features.find((f) => f.op === "member" && (f.along as { entity: string }).entity === "rake")!;
    const joints = r.doc.features.filter((f) => f.op === "joint");
    expect(joints.filter((j) => j.through === rake.id)).toEqual([]);
    expect(joints.filter((j) => j.through === plate.id)).toHaveLength(1);
    // The plate's end, left free by that choice, is no near miss.
    expect(r.warnings).toEqual([]);
  });

  it("is still a T when only one end is near the other: an end wall's bottom plate against the front plate's side", () => {
    const doc = layout();
    (doc.features[0].entities as Record<string, unknown>[]).splice(0, 5, line("plate", [0, 0], [600, 0]));
    // Starting 15 mm off the plate's line, 15 mm in from its end, and running away from it: longer than the plate.
    doc.features.push({ id: "end", op: "sketch", plane: { type: "ref", ref: { datum: "Right" }, offset: 15 }, entities: [line("side", [15, 0], [800, 0])] } as never);
    const r = must(addSketchMembers(doc, { profile: "SHS", size: "SHS 40x40x3", line: "centre", corners: "butt", runThrough: "longer", lines: [{ sketch: "layout", entity: "plate" }, { sketch: "end", entity: "side" }] }));
    const plate = r.doc.features.find((f) => f.op === "member" && (f.along as { entity: string }).entity === "plate")!;
    expect(r.doc.features.filter((f) => f.op === "joint")).toEqual([expect.objectContaining({ type: "butt", through: plate.id })]);
  });
});

describe("how a line runs", () => {
  it("names by a loose 10°, and filters by a tight one: a skillion's raked plate is a rail, but not level", () => {
    // 191 mm of fall across a 2000 mm end wall: 5.5°.
    expect(memberKind([0, 0, 2391], [0, 2000, 2200])).toBe("rail");
    expect(memberKind([0, 0, 2391], [0, 2000, 2200], 1)).toBe("brace");
    expect(memberKind([0, 0, 0], [0, 0, 2000], 1)).toBe("post");
    expect(memberKind([0, 0, 0], [5000, 0, 0], 1)).toBe("rail");
  });
});
