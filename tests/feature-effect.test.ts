// A feature session's preview, kernel side (Phase P wave 2): the material a
// feature adds and removes, from the part just before it and just after it.
// Expected volumes are worked out by hand: a boss is its prism, a cut its
// hole, a fillet's sliver along a convex edge is (1 − π/4)·r²·L.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { featureEffect } from "../src/kernel/featureEffect";
import { documentBefore, documentThrough, Recent } from "../src/worker/before";

type Raw = Record<string, unknown>;

/** A 40 × 20 box on Top, 10 tall (z = 0..10), then the features. */
const box = (...features: Raw[]): RawDocument => ({
  version: 1,
  units: "mm",
  name: "box",
  features: [
    { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 40, h: 20 }], constraints: [] },
    { id: "ext_1", op: "extrude", sketch: "s1", distance: 10 },
    ...features,
  ],
});

const boss = [
  { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] }, entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 5 }], constraints: [] },
  { id: "ext_2", op: "extrude", sketch: "s2", distance: 4 },
];
const hole = { id: "cut_1", op: "cut", sketch: "s2", distance: 6, direction: [0, 0, -1] };
const fillet = { id: "fillet_1", op: "fillet", edges: { type: "edge", kind: "line", direction: [1, 0, 0], length: 40, onFace: { type: "planar", normal: [0, 0, 1], pick: "largest" }, pick: "all" }, radius: 2 };

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

/** The added and removed volumes of `feature` in `doc`, as the worker works them out. */
function effectOf(doc: RawDocument, feature: string) {
  const before = rebuild(documentBefore(doc, feature), oc);
  const after = rebuild(documentThrough(doc, feature), oc);
  try {
    return scoped((s) => {
      const e = featureEffect(oc, s, before.solid, after.solid);
      return { added: e.addedVolume, removed: e.removedVolume, hasAdded: !!e.added, hasRemoved: !!e.removed };
    });
  } finally {
    before.dispose();
    after.dispose();
  }
}

describe("the material a feature adds and removes", () => {
  it("a boss adds its cylinder and removes nothing", () => {
    const e = effectOf(box(...boss), "ext_2");
    expect(e.added).toBeCloseTo(Math.PI * 25 * 4, 3);
    expect(e.hasRemoved).toBe(false);
    expect(e.removed).toBe(0);
  });

  it("a cut removes its hole and adds nothing", () => {
    const e = effectOf(box(boss[0], hole), "cut_1");
    expect(e.removed).toBeCloseTo(Math.PI * 25 * 6, 3);
    expect(e.hasAdded).toBe(false);
  });

  it("a fillet on the two long top edges removes a sliver of (1 − π/4)·r²·L each", () => {
    const e = effectOf(box(fillet), "fillet_1");
    expect(e.removed).toBeCloseTo(2 * (1 - Math.PI / 4) * 4 * 40, 2);
    expect(e.added).toBe(0);
  });

  it("the first feature adds the whole part; a later feature's effect ignores the features after it", () => {
    expect(effectOf(box(), "ext_1").added).toBeCloseTo(40 * 20 * 10, 3);
    // The boss in the middle of history: the cut after it does not count.
    const e = effectOf(box(...boss, { ...hole, sketch: "s1", distance: 3 }), "ext_2");
    expect(e.added).toBeCloseTo(Math.PI * 25 * 4, 3);
  });

  it("documentThrough keeps the features up to and including one (the document itself when it is the last)", () => {
    const doc = box(...boss);
    expect(documentThrough(doc, "ext_2")).toBe(doc);
    const through = documentThrough({ ...doc, rollback: "ext_2", drawing: { sheet: {} } }, "s2") as RawDocument;
    expect(through.features.map((f) => f.id)).toEqual(["s1", "ext_1", "s2"]);
    expect(through.rollback).toBeUndefined();
    expect(through.drawing).toBeUndefined();
    expect(documentThrough(doc, "nope")).toBe(doc);
  });

  it("the cache frees what it drops (the worker keeps rebuilds of the part before a session's feature)", () => {
    const freed: string[] = [];
    const cache = new Recent<string>(2, (v) => freed.push(v));
    cache.set("a", "A");
    cache.set("b", "B");
    cache.get("a");
    cache.set("c", "C");
    expect(freed).toEqual(["B"]);
    cache.set("a", "A2");
    expect(freed).toEqual(["B", "A"]);
    cache.clear();
    expect(freed.sort()).toEqual(["A", "A2", "B", "C"]);
  });
});
