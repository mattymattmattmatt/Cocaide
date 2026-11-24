// A pin's note, wrapped to fit: between words, long words split, the writer's line breaks kept, capped with "…".
import { describe, expect, it } from "vitest";
import { noteWidth, wrapText } from "../src/ui/vr/wrap";

// One unit a character.
const m = (s: string) => s.length;

describe("wrapText", () => {
  it("keeps a short note on one line", () => {
    expect(wrapText("Lower this shelf", 20, m)).toEqual(["Lower this shelf"]);
  });
  it("breaks between words to fit the width", () => {
    expect(wrapText("the bench here is too tight to the fridge door", 16, m)).toEqual(["the bench here", "is too tight to", "the fridge door"]);
  });
  it("splits a word too long for a line", () => {
    expect(wrapText("aaaaaaaaaaaaaaaaaaaaaaaaa b", 10, m)).toEqual(["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa b"]);
  });
  it("keeps the writer's own line breaks and squeezes spaces", () => {
    expect(wrapText("One\n\nTwo   three", 20, m)).toEqual(["One", "", "Two three"]);
  });
  it("stops at the line limit with an ellipsis that fits", () => {
    const lines = wrapText("a b c d e f g h", 3, m, 3);
    expect(lines).toEqual(["a b", "c d", "e…"]);
  });
  it("ignores blank text", () => {
    expect(wrapText("   \n  ", 10, m)).toEqual([]);
  });
});

describe("noteWidth", () => {
  it("a short note is as wide as it is (but not narrower than the least)", () => {
    expect(noteWidth("Hi", m, 1, 40, 8)).toBe(8);
    expect(noteWidth("Move it left", m, 1, 40, 8)).toBe(12);
  });
  it("a long note wraps to a block, never wider than the most", () => {
    const w = noteWidth("x".repeat(400), m, 1, 40, 8);
    expect(w).toBeLessThanOrEqual(40);
    expect(w).toBeGreaterThan(20);
    expect(noteWidth("x".repeat(60), m, 1, 40, 8)).toBeLessThan(60);
  });
});
