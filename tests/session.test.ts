// The rules of a feature session (Phase P wave 2, src/ui/model/session.ts):
// its name, a pending feature's patches, what the panel says it still needs,
// why OK can't keep it yet, a tree click during it, and the question asked
// before something that needs it finished. The document side (the
// transaction) is tests/transactions.test.ts.

import { describe, expect, it } from "vitest";
import { addCommand, guardText, mergePatch, neededText, okProblem, pendingWords, sessionFeature, sessionLabel, treeClick, type FeatureSession } from "../src/ui/model/session";

const create = (more: Partial<FeatureSession> = {}): FeatureSession => ({ id: "fillet_2", originalId: "fillet_2", kind: "create", op: "fillet", previous: null, ...more });
const edit: FeatureSession = { id: "ext_1", originalId: "ext_1", kind: "edit", op: "extrude", previous: "ext_1" };

describe("a feature session's rules", () => {
  it("is named for what OK makes of it", () => {
    expect(sessionLabel(create())).toBe("Add fillet_2");
    expect(sessionLabel(edit)).toBe("Edit ext_1");
  });

  it("merges a pending feature's patches as updateFeature does (null takes a key away), and adds it with addFeature", () => {
    const f = { id: "fillet_2", op: "fillet", radius: 1, faces: [{ type: "planar" }] };
    const next = mergePatch(f, { edges: { type: "edge", pick: "all" }, faces: null });
    expect(next).toEqual({ id: "fillet_2", op: "fillet", radius: 1, edges: { type: "edge", pick: "all" } });
    // The patch is copied: changing it later does not reach the feature.
    const patch = { edges: { type: "edge" } };
    const merged = mergePatch(f, patch);
    patch.edges.type = "changed";
    expect((merged.edges as { type: string }).type).toBe("edge");
    expect(addCommand(next)).toEqual({ type: "addFeature", feature: next });
    expect(sessionFeature(create({ pending: f }), [])).toBe(f);
    expect(sessionFeature(edit, [{ id: "ext_1", op: "extrude" }])).toEqual({ id: "ext_1", op: "extrude" });
  });

  it("says what a pending feature needs in the panel's words, the validator's only when the panel has none", () => {
    const words = pendingWords("addFeature rejected: fillet_2: edges: needed: the edges to treat; fillet_2: radius: must be over 0", "fillet_2");
    expect(words).toBe("edges: needed: the edges to treat; radius: must be over 0");
    const pending = create({ pending: { id: "fillet_2", op: "fillet" }, pendingProblem: words });
    expect(neededText(pending, "Pick edges to fillet")).toBe("pick edges to fillet");
    expect(neededText(pending, null)).toBe(words);
    expect(okProblem(pending, "Pick edges to fillet")).toBe("fillet_2 isn't in the part yet: pick edges to fillet in the view (or Cancel it).");
    expect(okProblem(pending)).toBe(`fillet_2 isn't complete yet (${words}): pick what it needs in the view, or Cancel it.`);
    // In the document already: OK can keep it.
    expect(okProblem(create(), "Pick edges to fillet")).toBeNull();
  });

  it("a tree click: the open feature, nothing; one its active field takes, a pick; else ask first", () => {
    expect(treeClick(edit, "ext_1", false)).toEqual({ kind: "same" });
    expect(treeClick(create({ op: "linearPattern", id: "pattern_1" }), "hole_1", true)).toEqual({ kind: "pick" });
    expect(treeClick(edit, "hole_1", false)).toEqual({ kind: "ask" });
  });

  it("asks before something else in plain words: keep or drop, then what waits", () => {
    expect(guardText(create(), { what: "open Chamfer", then: () => undefined })).toBe("Add fillet_2 is still open. OK keeps fillet_2, Cancel drops it; then open Chamfer.");
    expect(guardText(edit, { what: "select hole_1", then: () => undefined })).toBe("Edit ext_1 is still open. OK keeps the changes to ext_1, Cancel puts it back as it was; then select hole_1.");
    // Not complete yet: it can only be dropped.
    expect(guardText(create({ pending: {} }), { what: "start the sketch", then: () => undefined, noKeep: "fillet_2 isn't in the part yet" })).toBe(
      "Add fillet_2 is still open. It isn't complete yet. Cancel drops it; then start the sketch.",
    );
    // It fails: what keeping it means, in the answer's own words.
    expect(guardText(edit, { what: "select hole_1", then: () => undefined, failing: "radius 30 is too large" })).toBe(
      "Edit ext_1 is still open. It fails now: radius 30 is too large. Keep it with the error, Cancel puts it back as it was; then select hole_1.",
    );
    // Asked by OK itself: nothing else waits ("then carry on" is not a thing to say).
    const onOk = guardText(create(), { what: "carry on", then: () => undefined, failing: "radius 30 is too large for the 6 mm face beside it", onOk: true });
    expect(onOk).toBe("fillet_2 fails: radius 30 is too large for the 6 mm face beside it. Keep it with the error (it stays in the tree, marked, for you to fix), or go back and change it.");
    expect(onOk).not.toContain("carry on");
  });
});
