// Feature sessions in the document layer (Phase P wave 2): a transaction
// gathers a session's changes into one undo step ("Add fillet_2"), or none
// when nothing changed; rollback puts the document back exactly as it was,
// with no undo step; undo and redo step inside it; undo at its start closes
// it, undone whole (so redo brings it back). Real commands on a real document,
// so the texts are what the app records.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { formatDocument } from "../src/doc/format";
import {
  beginTransaction,
  canRedo,
  canUndo,
  commitTransaction,
  createHistory,
  inTransaction,
  record,
  redo,
  redoLabel,
  relabelTransaction,
  rollbackTransaction,
  transactionChanged,
  undo,
  undoLabel,
  undoOutOf,
  settleTransaction,
  type History,
} from "../src/doc/history";
import { commandLabel } from "../src/ui/useDocument";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;

/** The text after a command (it must be accepted). */
function after(text: string, cmd: Command): string {
  const r = apply(JSON.parse(text), cmd, { user: true });
  if (!r.ok) throw new Error(r.error);
  return formatDocument(r.doc);
}

/** Applies a command and records it, as useDocument.dispatch does; a refused one changes nothing. */
function dispatch(h: History, cmd: Command): { h: History; error: string | null } {
  const r = apply(JSON.parse(h.present), cmd, { user: true });
  if (!r.ok) return { h, error: r.error };
  return { h: record(h, formatDocument(r.doc), undefined, commandLabel(cmd)), error: null };
}

const fillet = { id: "fillet_9", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 1, 0], pick: "all" }, radius: 1 };

describe("a feature session's transaction", () => {
  const start = formatDocument(bracket);

  it("commits a new feature and its edits as one undo step named for it", () => {
    let h = createHistory(start);
    h = beginTransaction(h, "Add fillet_9", after(start, { type: "addFeature", feature: fillet }));
    expect(inTransaction(h)).toBe(true);
    h = dispatch(h, { type: "updateFeature", id: "fillet_9", patch: { radius: 2 } }).h;
    h = dispatch(h, { type: "updateFeature", id: "fillet_9", patch: { radius: 3 } }).h;
    h = commitTransaction(h);
    expect(inTransaction(h)).toBe(false);
    expect(h.past).toEqual([start]);
    expect(undoLabel(h)).toBe("Add fillet_9");
    expect(JSON.parse(h.present).features.at(-1)).toMatchObject({ id: "fillet_9", radius: 3 });
    // One undo takes the whole fillet away; redo brings it back with its last radius.
    h = undo(h);
    expect(h.present).toBe(start);
    expect(redoLabel(h)).toBe("Add fillet_9");
    h = redo(h);
    expect(JSON.parse(h.present).features.at(-1).radius).toBe(3);
  });

  it("rolls a new feature back to exactly the document it began on, with no undo step", () => {
    let h = createHistory(start);
    h = record(h, after(start, { type: "updateFeature", id: "ext_1", patch: { distance: 7 } }), undefined, "Edit ext_1");
    const was = h;
    h = beginTransaction(h, "Add fillet_9", after(h.present, { type: "addFeature", feature: fillet }));
    h = dispatch(h, { type: "updateFeature", id: "fillet_9", patch: { radius: 2 } }).h;
    h = rollbackTransaction(h);
    expect(h.present).toBe(was.present);
    expect(h.past).toEqual(was.past);
    expect(h.future).toEqual(was.future);
    expect(undoLabel(h)).toBe("Edit ext_1");
    expect(inTransaction(h)).toBe(false);
  });

  it("keeps redo when cancelled, and clears it when committed", () => {
    let h = record(createHistory("a"), "b");
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    const cancelled = rollbackTransaction(record(beginTransaction(h, "Edit x"), "c"));
    expect(cancelled.present).toBe("a");
    expect(redo(cancelled).present).toBe("b");
    const kept = commitTransaction(record(beginTransaction(h, "Edit x"), "c"));
    expect(kept.future).toEqual([]);
    expect(kept.past).toEqual(["a"]);
  });

  it("an edit session that changes nothing leaves no undo step, whatever it went through", () => {
    let h = createHistory("a");
    h = beginTransaction(h, "Edit x");
    h = record(h, "b");
    h = record(h, "a"); // back where it began
    expect(transactionChanged(h)).toBe(false);
    h = commitTransaction(h);
    expect(h.past).toEqual([]);
    expect(h.present).toBe("a");
  });

  it("undo and redo step through the changes inside it, never below where it opened", () => {
    let h = createHistory("a");
    h = beginTransaction(h, "Add f", "a+f");
    h = record(h, "a+f2");
    h = record(h, "a+f3");
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe("a+f2");
    h = undo(h);
    expect(h.present).toBe("a+f");
    // At its floor: the add itself is not undone inside the session.
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present).toBe("a+f2");
    // A new change inside it drops the redo inside it.
    h = record(h, "a+f4");
    expect(canRedo(h)).toBe(false);
    // The outer history is untouched until it closes.
    expect(h.past).toEqual([]);
  });

  it("undo past its start closes it undone whole: the document is back, and redo brings the session's result", () => {
    let h = record(createHistory("a"), "b", undefined, "Edit y");
    h = beginTransaction(h, "Add f", "b+f");
    h = record(h, "b+f2");
    h = undoOutOf(h);
    expect(inTransaction(h)).toBe(false);
    expect(h.present).toBe("b");
    expect(redo(h).present).toBe("b+f2");
    expect(undoLabel(h)).toBe("Edit y");
    // A session that changed nothing just closes, history untouched.
    const quiet = undoOutOf(beginTransaction(record(createHistory("a"), "b"), "Edit z"));
    expect(quiet.present).toBe("b");
    expect(quiet.past).toEqual(["a"]);
    expect(quiet.future).toEqual([]);
  });

  it("refuses a second transaction while one is open (nested sessions)", () => {
    const h = beginTransaction(createHistory("a"), "Add f", "a+f");
    expect(() => beginTransaction(h, "Add g")).toThrow(/"Add f" is still open/);
  });

  it("nested commands inside it (a rename, a body rename, a batch) are changes within it, all undone by Cancel", () => {
    let h = createHistory(start);
    h = beginTransaction(h, "Edit ext_1");
    // Renaming the feature it edits: the rename is a change like any other.
    const renamed = dispatch(h, { type: "updateFeature", id: "hole_1", patch: { id: "bore" } });
    expect(renamed.error).toBeNull();
    h = relabelTransaction(renamed.h, "Edit bore");
    h = dispatch(h, { type: "updateFeature", id: "bore", patch: { diameter: 8 } }).h;
    expect(JSON.parse(h.present).features.some((f: { id: string }) => f.id === "bore")).toBe(true);
    // A refused command inside it changes nothing and records nothing.
    const refused = dispatch(h, { type: "updateFeature", id: "bore", patch: { diameter: -1 } });
    expect(refused.error).not.toBeNull();
    expect(refused.h).toBe(h);
    expect(h.tx!.label).toBe("Edit bore");
    // Cancel after the rename: the document is exactly as it was, under its old name.
    h = rollbackTransaction(h);
    expect(h.present).toBe(start);
    expect(JSON.parse(h.present).features.some((f: { id: string }) => f.id === "hole_1")).toBe(true);
  });

  it("typing in the JSON editor during a session is part of it: Cancel takes the typing back too, OK keeps it in the one step", () => {
    let h = createHistory(start);
    h = beginTransaction(h, "Edit ext_1");
    h = dispatch(h, { type: "updateFeature", id: "ext_1", patch: { distance: 9 } }).h;
    // A pause in the typing records the text, as useDocument's commitTyping does: inside the session.
    const typed = start.replace('"name": "bracket"', '"name": "bracket-b"');
    h = record(h, typed, undefined, "Edit the JSON");
    expect(h.tx!.steps.length).toBe(2);
    expect(rollbackTransaction(h).present).toBe(start);
    const kept = commitTransaction(h);
    expect(kept.present).toBe(typed);
    expect(kept.past).toEqual([start]);
    expect(undoLabel(kept)).toBe("Edit ext_1");
  });

  it("names ordinary undo steps after their commands", () => {
    expect(commandLabel({ type: "addFeature", feature: { id: "hole_2" } })).toBe("Add hole_2");
    expect(commandLabel({ type: "deleteFeature", id: "hole_2" })).toBe("Delete hole_2");
    expect(commandLabel({ type: "updateFeature", id: "ext_1", patch: {} })).toBe("Edit ext_1");
    expect(commandLabel({ type: "setParameter", name: "t", value: 2 })).toBe("Set parameter");
    let h = createHistory(start);
    h = dispatch(h, { type: "updateFeature", id: "ext_1", patch: { distance: 9 } }).h;
    expect(undoLabel(h)).toBe("Edit ext_1");
    expect(redoLabel(undo(h))).toBe("Edit ext_1");
  });

  it("keeps labels in step with the snapshots when old ones are dropped for the budget", () => {
    let h = createHistory("x".repeat(10));
    for (let i = 0; i < 6; i++) h = record(h, `${i}`.repeat(10), 30, `step ${i}`);
    expect(h.past.length).toBe(3);
    expect(h.past).toEqual(["2".repeat(10), "3".repeat(10), "4".repeat(10)]);
    expect(h.pastLabels).toEqual(["step 3", "step 4", "step 5"]);
    expect(undoLabel(h)).toBe("step 5");
  });
});

describe("a session whose feature goes in later (command-first: picks first)", () => {
  it("settles its floor where the feature went in: undo inside stops there, Cancel still goes back to before", () => {
    let h = beginTransaction(createHistory("a"), "Add f");
    h = record(h, "a+f"); // the first pick made it complete: it went in
    h = settleTransaction(h);
    h = record(h, "a+f2");
    h = undo(h);
    expect(h.present).toBe("a+f");
    expect(canUndo(h)).toBe(false);
    expect(rollbackTransaction(h).present).toBe("a");
    expect(commitTransaction(h).past).toEqual(["a"]);
  });
});
