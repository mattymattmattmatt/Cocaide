// Wave 5 follow-up from Wave 3: a face picked in the view gets a selector
// that does not depend on where the face is. Faces facing the same way are
// told apart by their level along the normal (rank: 1 the furthest out, -1
// the furthest in) before their offset, so a hole, a sketch or an extrude
// "up to" that face keeps finding it when the face moves (a taller boss).

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { selectorHealth } from "../src/agent/health";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { describeWanted, rankWords, selectFaces } from "../src/kernel/selectors";
import { faceSelectorFor } from "../src/kernel/synthesize";
import { describeEdges, describeFaces, type EdgeInfo, type FaceInfo } from "../src/kernel/topology";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const square = (id: string, c: [number, number], w: number) => ({ id, type: "rect", center: c, w, h: w });

/**
 * An 80 x 40 x 6 plate with two square bosses on it: a 20 mm one `tall` high
 * at x = -20 and a 10 mm one 5 high at x = 20. Three levels face +Z: the
 * plate (largest), the small boss (smallest) and the big boss, between them
 * in area and highest: only its rank tells it apart without its offset.
 */
function stepped(tall: number, ...more: Record<string, unknown>[]): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "stepped",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: 80, h: 40 }] },
      { id: "plate", op: "extrude", sketch: "s1", distance: 6 },
      { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] }, entities: [square("a", [-20, 0], 20)] },
      { id: "big", op: "extrude", sketch: "s2", distance: tall },
      { id: "s3", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] }, entities: [square("b", [20, 0], 10)] },
      { id: "small", op: "extrude", sketch: "s3", distance: 5 },
      ...more,
    ],
  };
}

function topology(doc: RawDocument): { faces: FaceInfo[]; edges: EdgeInfo[]; errors: string[]; volume: number } {
  const r = rebuild(doc, oc);
  try {
    const t = scoped((s) => {
      const { faces, infos } = describeFaces(oc, s, r.solid!);
      return { faces: infos, edges: describeEdges(oc, s, r.solid!, faces).infos };
    });
    return { ...t, errors: r.errors, volume: r.measurements?.volume ?? 0 };
  } finally {
    r.dispose();
  }
}

const PLATE = 80 * 40 * 6;
const SMALL = 10 * 10 * 5;
const big = (tall: number) => 20 * 20 * tall;

describe("rank: a face's level along its normal", () => {
  it("picks the big boss's top as the outermost face facing +Z, and the plate's as the innermost", () => {
    const { faces } = topology(stepped(10));
    const at = (z: number) => faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99 && Math.abs(f.offset! - z) < 1e-6);
    expect(faceSelectorFor(faces, at(16))).toEqual({ ok: true, selector: { type: "planar", normal: [0, 0, 1], rank: 1, pick: "largest" } });
    // The plate's top is the largest; the small boss's the smallest: no rank needed.
    expect(faceSelectorFor(faces, at(6))).toEqual({ ok: true, selector: { type: "planar", normal: [0, 0, 1], pick: "largest" } });
    expect(faceSelectorFor(faces, at(11))).toEqual({ ok: true, selector: { type: "planar", normal: [0, 0, 1], pick: "smallest" } });
    // Counted from the inside: -1 is the plate, -2 the small boss, -3 the big boss.
    const rank = (r: number) => selectFaces(faces, { type: "planar", normal: [0, 0, 1], rank: r, pick: "all" }).matches.map((f) => f.offset);
    expect([rank(1), rank(2), rank(3), rank(4)]).toEqual([[16], [11], [6], []]);
    expect([rank(-1), rank(-2), rank(-3), rank(-4)]).toEqual([[6], [11], [16], []]);
  });

  it("keeps finding the face when it moves: a hole on the big boss survives a taller boss", () => {
    const { faces } = topology(stepped(10));
    const top = faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99 && Math.abs(f.offset! - 16) < 1e-6);
    const s = faceSelectorFor(faces, top);
    if (!s.ok) throw new Error(s.error);
    const hole = { id: "h", op: "hole", face: s.selector, center: [-20, 0], diameter: 6, depth: 4 };
    const HOLE = Math.PI * 9 * 4; // r 3, 4 deep
    const before = topology(stepped(10, hole));
    expect(before.errors).toEqual([]);
    expect(before.volume).toBeCloseTo(PLATE + big(10) + SMALL - HOLE, 6);
    // 20 high now: the face is at z = 26, and still the outermost.
    const after = topology(stepped(20, hole));
    expect(after.errors).toEqual([]);
    expect(after.volume).toBeCloseTo(PLATE + big(20) + SMALL - HOLE, 6);
    // The selector written with the offset fails the same change: what the rank is for.
    const pinned = { ...hole, face: { type: "planar", normal: [0, 0, 1], offset: 16, pick: "largest" } };
    expect(topology(stepped(20, pinned)).errors).toEqual(["h: selector matched 0 faces (wanted 1 planar face normal +Z at offset 16)"]);
  });

  it("keeps a sketch on that face, and an extrude up to it, following the face", () => {
    const { faces } = topology(stepped(10));
    const top = faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99 && Math.abs(f.offset! - 16) < 1e-6);
    const s = faceSelectorFor(faces, top);
    if (!s.ok) throw new Error(s.error);
    // A 6 mm post from the plate up to the boss's top, then a 4 mm square pin on the boss (a rank counts the levels
    // there are at its feature's place in the history: after the pin, the pin's top would be the outermost).
    const more = [
      { id: "s5", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] }, entities: [square("d", [0, 10], 6)] },
      { id: "post", op: "extrude", sketch: "s5", extent: "upToFace", upTo: { face: s.selector } },
      { id: "s4", op: "sketch", plane: { type: "ref", ref: { face: s.selector } }, entities: [square("c", [-20, 0], 4)] },
      { id: "pin", op: "extrude", sketch: "s4", distance: 3 },
    ];
    for (const tall of [10, 20]) {
      const t = topology(stepped(tall, ...more));
      expect(t.errors).toEqual([]);
      expect(t.volume).toBeCloseTo(PLATE + big(tall) + SMALL + 4 * 4 * 3 + 6 * 6 * tall, 6);
    }
  });

  it("is told apart from the edges it bounds: an edge picked on the boss's top follows it too", () => {
    const { faces, edges } = topology(stepped(10));
    const top = faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99 && Math.abs(f.offset! - 16) < 1e-6);
    const s = faceSelectorFor(faces, top);
    expect(s.ok && s.selector).toMatchObject({ rank: 1 });
    // Every edge on that face is found by a selector that names the face by its rank, not its offset.
    const rim = edges.flatMap((e, i) => (e.faces.includes(top) ? [i] : []));
    expect(rim).toHaveLength(4);
  });

  it("validate's selector health says an offset is fragile and a rank is not", () => {
    const hole = (face: Record<string, unknown>) => ({ id: "h", op: "hole", face, center: [-20, 0], diameter: 6, depth: 4 });
    expect(selectorHealth(stepped(10, hole({ type: "planar", normal: [0, 0, 1], offset: 16, pick: "largest" })), oc)).toEqual([
      { feature: "h", path: "face", matched: 1, ok: true, note: "picks by offset: if the face moves along its normal it is lost; a rank (1 = the outermost level) keeps finding it" },
    ]);
    expect(selectorHealth(stepped(10, hole({ type: "planar", normal: [0, 0, 1], rank: 1, pick: "largest" })), oc)).toEqual([{ feature: "h", path: "face", matched: 1, ok: true }]);
  });

  it("validates strictly and reads well", () => {
    const errorsOf = (face: Record<string, unknown>) =>
      allErrors(validateDocument(stepped(10, { id: "h", op: "hole", face, center: [0, 0], diameter: 5, depth: "through" })));
    expect(errorsOf({ type: "planar", normal: [0, 0, 1], rank: 0, pick: "largest" })).toEqual([
      "h: face.rank: must be a whole number other than 0: 1 the level furthest out along the normal, -1 the furthest in (got 0)",
    ]);
    expect(errorsOf({ type: "planar", normal: [0, 0, 1], rank: 1.5, pick: "largest" })).toEqual([
      "h: face.rank: must be a whole number other than 0: 1 the level furthest out along the normal, -1 the furthest in (got 1.5)",
    ]);
    expect(errorsOf({ type: "planar", normal: [0, 0, 1], rank: 1, offset: 16, pick: "largest" })).toEqual(["h: face: give offset or rank, not both"]);
    expect(errorsOf({ type: "planar", normal: [0, 0, 1], rank: -2, pick: "largest" })).toEqual([]);
    expect(describeWanted({ type: "planar", normal: [0, 0, 1], rank: 1, pick: "largest" }, 1)).toBe("1 planar face normal +Z, outermost along it");
    expect([1, 2, 3, 4, 11, 12, 21, -1, -2, -13].map(rankWords)).toEqual([
      "outermost",
      "2nd from outermost",
      "3rd from outermost",
      "4th from outermost",
      "11th from outermost",
      "12th from outermost",
      "21st from outermost",
      "innermost",
      "2nd from innermost",
      "13th from innermost",
    ]);
  });
});
