// The shorthands an AI writes (src/doc/shorthand.ts): stored in the
// document's one form, and accepted by validation, so a plane by name, an
// axis by name, or a reference written where a direction goes just works.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { expandShorthands } from "../src/doc/shorthand";
import { allErrors, validateDocument } from "../src/doc/validate";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;

describe("shorthands", () => {
  it("a plane by name or unwrapped is a reference", () => {
    expect(expandShorthands({ op: "mirror", plane: "Right" }).plane).toEqual({ type: "ref", ref: { datum: "Right" } });
    expect(expandShorthands({ op: "sketch", plane: { datum: "Front", offset: 5 } }).plane).toEqual({ type: "ref", ref: { datum: "Front" }, offset: 5 });
    expect(expandShorthands({ op: "split", plane: { face: { type: "planar", normal: "+X", pick: "largest" } } }).plane).toEqual({ type: "ref", ref: { face: { type: "planar", normal: [1, 0, 0], pick: "largest" } } });
    // Written out, it stays.
    const out = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
    expect(expandShorthands({ op: "sketch", plane: out }).plane).toEqual(out);
  });

  it("an axis by name is a vector; a pattern's direction or axis given as a reference goes where references go", () => {
    expect(expandShorthands({ op: "extrude", direction: "-Z" }).direction).toEqual([0, 0, -1]);
    expect(expandShorthands({ op: "hole", face: { type: "planar", normal: "y", pick: "largest" } }).face).toEqual({ type: "planar", normal: [0, 1, 0], pick: "largest" });
    expect(expandShorthands({ op: "linearPattern", direction: { datum: "X" } })).toEqual({ op: "linearPattern", along: { datum: "X" } });
    expect(expandShorthands({ op: "circularPattern", axis: { datum: "Z" } }).axis).toEqual({ ref: { datum: "Z" } });
    expect(expandShorthands({ op: "circularPattern", axis: { origin: [0, 0, 0], direction: [0, 0, 1] } }).axis).toEqual({ origin: [0, 0, 0], direction: [0, 0, 1] });
  });

  it("go into the document in its one form, and validate", () => {
    const r = apply(bracket, { type: "addFeature", feature: { id: "m", op: "mirror", feature: "hole_1", plane: "Right" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.doc.features as Record<string, unknown>[]).find((f) => f.id === "m")!.plane).toEqual({ type: "ref", ref: { datum: "Right" } });
    expect(allErrors(validateDocument(r.doc))).toEqual([]);
    // Validation takes them as written too (a document edited by hand).
    const hand = { ...bracket, features: [...bracket.features, { id: "lp", op: "linearPattern", feature: "hole_1", direction: "-X", spacing: 20, count: 2 }, { id: "cp", op: "circularPattern", feature: "hole_1", axis: { datum: "Z" }, count: 2 }] };
    expect(allErrors(validateDocument(hand))).toEqual([]);
  });
});
