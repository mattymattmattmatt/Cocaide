// Starter frame layouts: parameters and a layout sketch driven by them, ready
// for Members from sketch. The wall re-solves when its sizes change; the box
// and the portal become frames that build, and follow their parameters.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { frameTemplate, type TemplateSpec } from "../src/weldment/frameTemplates";
import { membersFromSketch } from "../src/weldment/sketchFrame";

const table: RawDocument = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const empty = (): RawDocument => ({ version: 1, units: "mm", name: "frame", profiles: structuredClone(table.profiles), features: [] }) as RawDocument;
function made(spec: TemplateSpec): { doc: RawDocument; sketch: string } {
  const t = frameTemplate(empty(), spec);
  if ("error" in t) throw new Error(t.error);
  let doc = empty();
  for (const c of t.commands) {
    const r = apply(doc, c);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  }
  return { doc, sketch: t.sketch };
}
const size = (doc: unknown) => {
  const b = rebuild(doc, oc);
  try {
    expect(b.errors).toEqual([]);
    return { bodies: b.measurements!.bodies.length, size: b.measurements!.boundingBox!.size.map((x) => Math.round(x)) };
  } finally {
    b.dispose();
  }
};
const framed = (doc: RawDocument, sketch: string, corners: "mitre" | "butt" = "butt") => {
  const r = membersFromSketch(doc, { size: "SHS 40x40x3", sketch, line: "outside", corners, runThrough: "posts" });
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("starter frame layouts", () => {
  it("a wall with two posts: a dimensioned sketch that re-solves when frame_w changes", () => {
    const { doc, sketch } = made({ kind: "wall", width: 1500, height: 900, posts: 2 });
    expect(allErrors(validateDocument(doc))).toEqual([]);
    const r = framed(doc, sketch);
    expect(r.members).toHaveLength(6);
    expect(size(r.doc)).toEqual({ bodies: 6, size: [1500, 40, 900] });
    const wider = apply(r.doc, { type: "setParameter", name: "frame_w", value: 2100 });
    if (!wider.ok) throw new Error(wider.error);
    // The sketch re-solved: the posts stay evenly spaced, at a third and two thirds.
    const ents = (wider.doc.features.find((f) => f.id === sketch)!.entities as { id: string; start: number[] }[]);
    expect(ents.find((e) => e.id === "post1")!.start[0]).toBeCloseTo(700, 6);
    expect(ents.find((e) => e.id === "post2")!.start[0]).toBeCloseTo(1400, 6);
    expect(size(wider.doc)).toEqual({ bodies: 6, size: [2100, 40, 900] });
  });

  it("a box: twelve members, the posts through at the corners", () => {
    const { doc, sketch } = made({ kind: "box", width: 1200, height: 750, depth: 600 });
    const r = framed(doc, sketch);
    expect(r.members.filter((m) => m.startsWith("post"))).toHaveLength(4);
    expect(r.members.filter((m) => m.startsWith("rail"))).toHaveLength(8);
    expect(r.doc.features.filter((f) => f.op === "joint").every((j) => String(j.through).startsWith("post"))).toBe(true);
    expect(size(r.doc)).toEqual({ bodies: 12, size: [1200, 600, 750] });
    const taller = apply(r.doc, { type: "setParameter", name: "frame_h", value: 900 });
    if (!taller.ok) throw new Error(taller.error);
    expect(size(taller.doc).size).toEqual([1200, 600, 900]);
  });

  it("a pitched portal in two bays, mitred", () => {
    const { doc, sketch } = made({ kind: "portal", width: 3000, height: 2200, rise: 500, bays: 2, bay: 1500 });
    const r = framed(doc, sketch, "mitre");
    // Three portals of four members, and two bays of eave rails and ridge.
    expect(r.members).toHaveLength(3 * 4 + 2 * 3);
    expect(r.warnings).toEqual([]);
    const s = size(r.doc);
    expect(s.bodies).toBe(18);
    // The lines are the outside: three portals over 3000 mm, 3000 wide.
    expect([s.size[0], s.size[1]]).toEqual([3000, 3000]);
  });

  it("says what is wrong with a size", () => {
    expect(frameTemplate(empty(), { kind: "box", width: 1000, height: 700 })).toEqual({ error: "the depth must be more than 0" });
  });
});

describe("a corner's arrangement order", () => {
  it("trims each member to the ones before it, and builds; a bad order says why", () => {
    const { doc, sketch } = made({ kind: "box", width: 1200, height: 750, depth: 600 });
    const r = framed(doc, sketch);
    const v = validateDocument(r.doc);
    // The corner at the top of the first post: rail along x, then the one along y, then the post under them.
    const corner = r.doc.features.find((f) => f.op === "joint" && JSON.stringify(v.nodes[String(f.node)]) === JSON.stringify([0, 0, 750]))!;
    const members = v.features.flatMap((x) => (x.feature?.op === "member" ? [x.feature as unknown as { id: string; fromNode?: string; toNode?: string; from: number[]; to: number[] }] : []));
    const at = members.filter((m) => m.fromNode === corner.node || m.toNode === corner.node);
    const alongX = at.find((m) => Math.abs(m.to[0] - m.from[0]) > 1)!.id;
    const alongY = at.find((m) => Math.abs(m.to[1] - m.from[1]) > 1)!.id;
    const post = at.find((m) => Math.abs(m.to[2] - m.from[2]) > 1)!.id;
    const ordered = apply(r.doc, { type: "updateFeature", id: String(corner.id), patch: { through: alongX, order: [alongX, alongY, post] } });
    if (!ordered.ok) throw new Error(ordered.error);
    expect(size(ordered.doc)).toEqual({ bodies: 12, size: [1200, 600, 750] });
    const bad = apply(r.doc, { type: "updateFeature", id: String(corner.id), patch: { through: alongX, order: [alongY, alongX] } });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("starts with the member that runs through") });
  });
});
