// Members on a layout sketch's lines: nodes that follow sketch points (worked
// out from the sketch's plane with no kernel), members and corner joints made
// from picked lines in one change, and the frame following an edit of the
// sketch through a real rebuild.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { addSketchMembers } from "../src/weldment/sketchFrame";
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
    expect(r.members).toEqual(["AB", "BC", "CD", "DA", "EF"]);
    expect(butts.map((j) => j.through).sort()).toEqual(["AB", "CD"]);
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
