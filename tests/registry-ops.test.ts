// The registry end to end, with test-only ops put in it (vi.mock of the
// index files): "block" (a box with the operation fields new / add / remove /
// intersect, patternable), "probe" (reads a sketch's curves and profile the
// way a sweep or rib will), and "ghost" (validates, has no kernel). Nothing
// in src/ names them: every behaviour here comes through the registry hooks.

import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { scopeProblem } from "../src/doc/scope";
import { FEATURE_OPS } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { REFERENCE } from "../src/mcp/reference";
import { probed } from "./registry-fixtures-kernel";

vi.mock("../src/features/docIndex", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/features/docIndex")>();
  const { blockDef, probeDef, ghostDef } = await import("./registry-fixtures");
  return { DOC_DEFS: [...real.DOC_DEFS, blockDef, probeDef, ghostDef] };
});
vi.mock("../src/features/kernelIndex", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/features/kernelIndex")>();
  const { blockKernel, probeKernel } = await import("./registry-fixtures-kernel");
  return { KERNEL_DEFS: [...real.KERNEL_DEFS, blockKernel, probeKernel] };
});

const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket"); // 80 x 40 x 6 plate on z = 0, centred; a 6.6 hole through at [30, 0]
const stand = example("stand");
const empty: RawDocument = { version: 1, units: "mm", name: "blocks", features: [] };
const add = (doc: RawDocument, ...f: Record<string, unknown>[]): RawDocument => ({ ...doc, features: [...doc.features, ...f] });
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const block = (id: string, at: number[], size: number[], extra: Record<string, unknown> = {}) => ({ id, op: "block", at, size, ...extra });
const PART = 80 * 40 * 6 - Math.PI * 3.3 ** 2 * 6;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    return {
      errors: r.errors,
      features: r.features,
      volume: r.measurements?.volume ?? 0,
      bodies: (r.measurements?.bodies ?? []).map((b) => [b.name, Math.round(b.volume * 1e6) / 1e6]),
    };
  } finally {
    r.dispose();
  }
}

describe("a registry op is an op like any other", () => {
  it("is listed among the ops, documented for the agent, and validated by its def", () => {
    expect(FEATURE_OPS.slice(-3)).toEqual(["block", "probe", "ghost"]);
    expect(FEATURE_OPS).toEqual(expect.arrayContaining(["scale", "plane", "axis", "point"]));
    expect(REFERENCE).toContain("## block");
    expect(errorsOf(add(bracket, block("b", [0, 0, 0], [1, 1, -1])))).toEqual(["b: size: must be three lengths over 0"]);
    expect(errorsOf(add(bracket, { id: "x", op: "teleport" }))).toEqual([`x: op: unknown op "teleport" (supported: ${FEATURE_OPS.join(", ")})`]);
  });

  it("an op with a doc def but no kernel validates, then fails its rebuild clearly", () => {
    const doc = add(bracket, { id: "g", op: "ghost" });
    expect(errorsOf(doc)).toEqual([]);
    const b = built(doc);
    expect(b.features.at(-1)).toEqual({
      id: "g",
      op: "ghost",
      ok: false,
      error: 'g: op "ghost" has no kernel operation: the document accepts it, but nothing builds it yet (src/features/ghost/kernel.ts, listed in kernelIndex.ts)',
    });
    // The rest of the part is there.
    expect(b.volume).toBeCloseTo(PART, 6);
  });
});

describe("the operation fields: new, add, remove, intersect", () => {
  it("with no body yet a block starts one, named by its id; with one body it adds to it", () => {
    expect(built(add(empty, block("block_1", [0, 0, 0], [10, 10, 10])))).toMatchObject({ errors: [], bodies: [["block_1", 1000]] });
    const b = built(add(bracket, block("b", [-40, -20, 6], [10, 10, 4])));
    expect(b.errors).toEqual([]);
    expect(b.bodies).toEqual([["main", Math.round((PART + 400) * 1e6) / 1e6]]);
  });

  it("remove cuts every body it reaches (or the listed ones); intersect keeps what the body and the tool share", () => {
    // A 10 x 10 corner block, centred on the plate's corner, through the thickness: a quarter of it is in the plate.
    const cut = built(add(bracket, block("b", [-45, -25, -1], [10, 10, 8], { operation: "remove" })));
    expect(cut.errors).toEqual([]);
    expect(cut.volume).toBeCloseTo(PART - 5 * 5 * 6, 6);
    // The left half of the plate (the hole is in the right half).
    const common = built(add(bracket, block("b", [-40, -20, 0], [40, 40, 10], { operation: "intersect" })));
    expect(common.errors).toEqual([]);
    expect(common.volume).toBeCloseTo(40 * 40 * 6, 6);
    const missed = built(add(bracket, block("b", [100, 0, 0], [5, 5, 5], { operation: "intersect" })));
    expect(missed.errors).toEqual(['b: the block does not overlap body "main": their common part is empty']);
  });

  it("new with a name makes another body; a name that is taken is refused before the rebuild", () => {
    const b = built(add(bracket, block("b", [0, 30, 0], [5, 5, 5], { operation: "new", newBody: "lug" })));
    expect(b.bodies.map(([n]) => n)).toEqual(["main", "lug"]);
    expect(errorsOf(add(bracket, block("b", [0, 30, 0], [5, 5, 5], { newBody: "main" })))).toEqual(['b: newBody: would make body "main", which is already a body']);
  });

  it("says which fields go with which operation, and which body when there are several", () => {
    expect(errorsOf(add(bracket, block("b", [0, 0, 0], [1, 1, 1], { bodies: ["main"] })))).toEqual(['b: bodies: lists the bodies to cut: it goes with "operation": "remove"']);
    expect(errorsOf(add(bracket, block("b", [0, 0, 0], [1, 1, 1], { operation: "add", newBody: "x" })))).toEqual(['b: newBody: names the new body: it goes with "operation": "new"']);
    expect(errorsOf(add(bracket, block("b", [0, 0, 0], [1, 1, 1], { operation: "glue" })))).toEqual(['b: operation: must be "new", "add", "remove", "intersect" (got "glue")']);
    expect(errorsOf(add(stand, block("b", [0, 0, 0], [1, 1, 1])))).toEqual(['b: body: the part has 2 bodies (base, upright); name the one to add to with "body"']);
    expect(errorsOf(add(stand, block("b", [0, 0, 0], [1, 1, 1], { body: "plate" })))).toEqual(['b: body: no body "plate" before this feature (bodies so far: base, upright)']);
    expect(errorsOf(add(empty, block("b", [0, 0, 0], [1, 1, 1], { operation: "add" })))).toEqual(['b: operation: there is no body to add to: nothing is built before this feature (use "operation": "new")']);
  });
});

describe("patterns and mirrors repeat a patternable registry op", () => {
  it("a pattern of a block that starts a body makes new bodies named after it", () => {
    const doc = add(empty, block("block_1", [0, 0, 0], [10, 10, 10]), { id: "p", op: "linearPattern", feature: "block_1", direction: [1, 0, 0], spacing: 20, count: 3 });
    expect(errorsOf(doc)).toEqual([]);
    expect(built(doc).bodies).toEqual([["block_1", 1000], ["block_1_2", 1000], ["block_1_3", 1000]]);
  });

  it("a pattern of a block added to the part adds the copies to it; a mirror of a cut block cuts the other side", () => {
    const pattern = built(add(bracket, block("b", [-40, -20, 6], [10, 10, 4]), { id: "p", op: "linearPattern", feature: "b", direction: [0, 1, 0], spacing: 15, count: 3 }));
    expect(pattern.errors).toEqual([]);
    expect(pattern.volume).toBeCloseTo(PART + 3 * 400, 6);
    const mirror = built(add(bracket, block("b", [-45, -25, -1], [10, 10, 8], { operation: "remove" }), { id: "m", op: "mirror", plane: { type: "ref", ref: { datum: "Right" } }, feature: "b" }));
    expect(mirror.errors).toEqual([]);
    expect(mirror.volume).toBeCloseTo(PART - 2 * 150, 6);
  });
});

describe("renames and scopes go through the registry hooks", () => {
  it('renaming a body a block starts ("operation": "new", named by its id) names it, and its pattern copies follow', () => {
    const doc = add(empty, block("block_1", [0, 0, 0], [10, 10, 10], { operation: "new" }), { id: "p", op: "linearPattern", feature: "block_1", direction: [1, 0, 0], spacing: 20, count: 2 });
    const r = apply(doc, { type: "renameBody", from: "block_1", to: "crate" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.features[0]).toEqual(block("block_1", [0, 0, 0], [10, 10, 10], { operation: "new", newBody: "crate" }));
    expect(validateDocument(r.doc).bodies).toEqual(["crate", "crate_2"]);
  });

  it("a block's body field follows a rename", () => {
    const doc = add(stand, block("b", [0, 0, 8], [5, 5, 5], { body: "base" }));
    const r = apply(doc, { type: "renameBody", from: "base", to: "plate" });
    expect(r.ok && r.doc.features.at(-1)).toEqual(block("b", [0, 0, 8], [5, 5, 5], { body: "plate" }));
  });

  it("a body: scope covers a block that names only that body", () => {
    const scope = ["body:base"];
    expect(scopeProblem(stand, { type: "addFeature", feature: block("b", [0, 0, 8], [5, 5, 5], { body: "base" }) }, scope)).toBeNull();
    expect(scopeProblem(stand, { type: "addFeature", feature: block("b", [0, 0, 8], [5, 5, 5], { operation: "remove", bodies: ["base"] }) }, scope)).toBeNull();
    expect(scopeProblem(stand, { type: "addFeature", feature: block("b", [0, 0, 8], [5, 5, 5], { operation: "remove" }) }, scope)).not.toBeNull();
    expect(scopeProblem(stand, { type: "addFeature", feature: block("b", [0, 0, 8], [5, 5, 5], { body: "upright" }) }, scope)).not.toBeNull();
  });
});

describe("an op that reads a sketch's curves (a sweep path, a rib line)", () => {
  beforeEach(() => {
    probed.length = 0;
  });
  const path = { id: "path", op: "sketch", plane: { type: "ref", ref: { datum: "Front" } }, entities: [{ id: "l1", type: "line", start: [0, 0], end: [10, 0] }, { id: "a1", type: "arc", center: [10, 5], start: [10, 0], end: [15, 5] }] };

  it("gets the curves, the frame and why they are no profile; ctx.profile refuses them for a closed-profile use", () => {
    const b = built(add(bracket, path, { id: "p", op: "probe", sketch: "path" }));
    expect(b.errors).toEqual([]);
    expect(probed).toEqual([{ id: "p", entities: 2, open: 'profile is open at [0, 0] (start of "l1")', frameZ: [0, -1, 0], profile: 'sketch "path" has no closed profile to probe: profile is open at [0, 0] (start of "l1")' }]);
  });

  it("a closed sketch is a profile; a suppressed one is missing, and says so", () => {
    built(add(bracket, { id: "p", op: "probe", sketch: "sketch_1" }));
    expect(probed.at(-1)).toMatchObject({ entities: 1, open: undefined, profile: "closed" });
    built(add(bracket, { ...path, suppressed: true }, { id: "p", op: "probe", sketch: "path" }));
    expect(probed.at(-1)).toMatchObject({ entities: 2, open: undefined, frameZ: undefined, profile: 'sketch "path" is suppressed, so there is no profile to probe' });
  });

  it("what it references cannot be deleted from under it", () => {
    const doc = add(bracket, path, { id: "p", op: "probe", sketch: "path" });
    expect(apply(doc, { type: "deleteFeature", id: "path" })).toEqual({ ok: false, error: "deleteFeature: path is used by p; delete or change it first" });
    expect(apply(doc, { type: "reorderFeature", id: "p", index: 0 })).toEqual({ ok: false, error: "reorderFeature: p uses path, which would come after it" });
  });
});
