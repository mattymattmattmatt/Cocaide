// Timber frames drawn as timber (screwed and nailed, a carpentry tolerance), and
// a long title that shrinks to fit the title block before it is cut short.
import { describe, expect, it } from "vitest";
import { isTimberFrame, TIMBER_TOLERANCE } from "../src/drafting/plan";
import { fit, fitSize } from "../src/drafting/formats";
import { parseGeneralTolerance } from "../src/drafting/tolerance";
import { textWidth } from "../src/drafting/text";

describe("a timber frame", () => {
  it("is known by its sections' tags or materials, else by the part's material", () => {
    const mgp = { tags: ["timber", "pine"], material: "MGP10 pine (seasoned)" };
    const shs = { tags: ["hollow", "square"], material: "steel AS/NZS 1163-C350L0" };
    expect(isTimberFrame({ profiles: { MGP10: mgp } }, [{ profile: "MGP10" }, { profile: "MGP10" }])).toBe(true);
    expect(isTimberFrame({ profiles: { MGP10: mgp, SHS: shs } }, [{ profile: "MGP10" }, { profile: "SHS" }])).toBe(false);
    expect(isTimberFrame({ profiles: { R: { tags: [] } }, material: { name: "Treated pine" } }, [{ profile: "R" }])).toBe(true);
    expect(isTimberFrame({ profiles: { SHS: shs }, material: { name: "S275 steel" } }, [{ profile: "SHS" }])).toBe(false);
  });

  it("gets a general tolerance the drawing checks can read", () => {
    expect(parseGeneralTolerance(TIMBER_TOLERANCE)).toMatchObject({ standard: "block", places: { 0: 2 }, angle: 1 });
  });
});

describe("a long title", () => {
  it("shrinks to fit before it is cut short", () => {
    const t = "TIMBER GARDEN SHED 5000 x 2000";
    const size = fitSize(t, 106, 7.6, 4.8, true);
    expect(size).toBeLessThan(7.6);
    expect(textWidth(t, size, true)).toBeLessThanOrEqual(106);
    expect(fit(t, 106, size, true)).toBe(t);
    // Too long even at the smallest size: cut short at that size.
    expect(fit("X".repeat(80), 106, fitSize("X".repeat(80), 106, 7.6, 4.8, true), true).endsWith("...")).toBe(true);
  });
});
