// Which sketches the view draws: a sketch a feature uses is hidden once used,
// any other shown; the eye's `shown` overrides that, saves with the document,
// and an override equal to the default is dropped.

import { describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, toDocument, validateDocument } from "../src/doc/validate";
import { sketchAt } from "../src/ui/model/sketchPick";
import { hiddenSketches, showSketchPatch, sketchesOf, sketchShown, usedSketches } from "../src/ui/model/sketchDisplay";

const sketch = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  op: "sketch",
  plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
  entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 5 }],
  ...more,
});

const doc = (features: Record<string, unknown>[]): RawDocument => ({ version: 1, name: "t", units: "mm", features } as unknown as RawDocument);

describe("sketch visibility", () => {
  const base = [
    sketch("s1"),
    { id: "e1", op: "extrude", sketch: "s1", distance: 10 },
    sketch("s2"),
    { id: "c1", op: "cut", sketch: "s2", distance: 2 },
    sketch("s3"),
    sketch("s4"),
    { id: "r1", op: "revolve", sketch: "s4", axis: { datum: "X" }, suppressed: true },
  ];

  it("a sketch an extrude or cut uses is hidden; one nothing uses, or only a suppressed feature, is shown", () => {
    expect([...usedSketches(base)].sort()).toEqual(["s1", "s2"]);
    expect([...hiddenSketches(base)].sort()).toEqual(["s1", "s2"]);
  });

  it("revolve, sweep and loft use their sketches too", () => {
    const fs = [sketch("p"), sketch("q"), { id: "r", op: "revolve", sketch: "p", axis: { datum: "Y" } }, { id: "sw", op: "sweep", profile: "q", path: { sketch: "p" } }];
    expect(usedSketches(fs).has("p")).toBe(true);
    expect(sketchesOf(fs[2], fs)).toEqual(["p"]);
  });

  it("the eye overrides: a used sketch shown stays drawn, an unused one hidden is not", () => {
    const fs = base.map((f) => (f.id === "s1" ? { ...f, shown: true } : f.id === "s3" ? { ...f, shown: false } : f));
    const used = usedSketches(fs);
    expect(sketchShown(fs[0], used)).toBe(true);
    expect([...hiddenSketches(fs)].sort()).toEqual(["s2", "s3"]);
  });

  it("a sketch selected in the tree or used by the feature open is drawn whatever its eye says", () => {
    expect([...hiddenSketches(base, ["s2"])]).toEqual(["s1"]);
  });

  it("show and hide patches drop an override equal to the default", () => {
    expect(showSketchPatch(base, "s1", true)).toEqual({ shown: true });
    expect(showSketchPatch(base, "s1", false)).toEqual({ shown: null });
    expect(showSketchPatch(base, "s3", false)).toEqual({ shown: false });
    expect(showSketchPatch(base, "s3", true)).toEqual({ shown: null });
  });

  it("`shown` is kept in the document: valid true or false, refused otherwise, and a patch to null takes it out", () => {
    const d = doc([sketch("s1"), { id: "e1", op: "extrude", sketch: "s1", distance: 10 }]);
    const r = apply(d, { type: "updateFeature", id: "s1", patch: { shown: true } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateDocument(r.doc);
    expect(allErrors(v)).toEqual([]);
    expect((toDocument(v)!.features[0] as { shown?: boolean }).shown).toBe(true);
    const back = apply(r.doc, { type: "updateFeature", id: "s1", patch: { shown: null } });
    expect(back.ok && "shown" in back.doc.features[0]).toBe(false);
    expect(allErrors(validateDocument(doc([sketch("s1", { shown: "yes" })]))).join(" ")).toMatch(/shown.*must be true or false/);
  });
});

describe("a sketch right-clicked in the view", () => {
  it("is the one whose drawing passes nearest the pointer, within a few pixels", () => {
    const flat = (p: number[]): [number, number] => [p[0], p[1]];
    const sketches = [
      { id: "a", polylines: [{ points: [[0, 0, 0], [100, 0, 0], [100, 50, 0]] as [number, number, number][] }] },
      { id: "b", polylines: [], points: [{ at: [50, 20, 0] as [number, number, number] }] },
    ];
    expect(sketchAt(sketches, flat, 40, 3)).toBe("a");
    expect(sketchAt(sketches, flat, 103, 30)).toBe("a");
    expect(sketchAt(sketches, flat, 52, 21)).toBe("b");
    expect(sketchAt(sketches, flat, 40, 30)).toBeNull();
  });
});
