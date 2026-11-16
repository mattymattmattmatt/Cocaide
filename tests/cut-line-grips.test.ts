// The section's cutting line and the detail's circle, edited by their grips
// on the sheet (src/ui/drawing/cutLine.ts): where the grips sit, and the new
// line or circle in the parent's view mm after a drag.

import { describe, expect, it } from "vitest";
import type { Vec2 } from "../src/doc/types";
import { cutLineAfter, cutLineGrips, detailRingAfter, detailRingGrips } from "../src/ui/drawing/cutLine";

// A parent view at 2:1, its origin drawn at (100, 100) on the sheet.
const parent = { centre: [100, 100] as Vec2, origin: [0, 0] as Vec2, scale: 2, breaks: [] };
const toSheet = (p: Vec2): Vec2 => [100 + p[0] * 2, 100 + p[1] * 2];

describe("a section's cutting line", () => {
  // Stored from x -30 to 30 at y 5; drawn run out past the dimensions to x -50 .. 50.
  const stored: Vec2[] = [[-30, 5], [30, 5]];
  const section = { cutLine: [toSheet([-50, 5]), toSheet([50, 5])] };

  it("has a grip at each end, along the line, and one in the middle, square to it", () => {
    const g = cutLineGrips(section);
    expect(g.map((x) => x.id)).toEqual(["cut:0", "cut:1", "cut:move"]);
    expect(g[0].at).toEqual(section.cutLine[0]);
    expect(g[0].along).toEqual([-1, 0]);
    expect(g[1].along).toEqual([1, 0]);
    expect(g[2].at).toEqual([100, 110]);
    expect(Math.abs(g[2].along![0])).toBe(0);
    expect(Math.abs(g[2].along![1])).toBe(1);
  });

  it("an end dragged in is the line shorter, from where it is drawn", () => {
    // 60 sheet mm in is 30 view mm in from the drawn end at -50.
    const line = cutLineAfter(section, stored, parent, "cut:0", [60, 0])!;
    expect(line).toEqual([[-20, 5], [30, 5]]);
  });

  it("the middle dragged moves every point by the drag", () => {
    expect(cutLineAfter(section, stored, parent, "cut:move", [0, 8])).toEqual([[-30, 9], [30, 9]]);
  });

  it("an offset line's corner goes where it is dropped", () => {
    const st: Vec2[] = [[-30, 5], [0, 5], [0, -5], [30, -5]];
    const s = { cutLine: st.map(toSheet) };
    expect(cutLineGrips(s).map((x) => x.id)).toEqual(["cut:0", "cut:1", "cut:2", "cut:3", "cut:move"]);
    expect(cutLineGrips(s)[1].along).toBeUndefined();
    expect(cutLineAfter(s, st, parent, "cut:1", [4, 2])).toEqual([[-30, 5], [2, 6], [0, -5], [30, -5]]);
  });

  it("nothing for a grip that is not the line's, or a view without one", () => {
    expect(cutLineAfter(section, stored, parent, "ring:centre", [1, 1])).toBeNull();
    expect(cutLineAfter(section, stored, parent, "cut:7", [1, 1])).toBeNull();
    expect(cutLineGrips({})).toEqual([]);
  });
});

describe("a detail's circle", () => {
  const detail = { detailRing: { c: toSheet([10, 10]), r: 16 } };

  it("has a grip at its centre and one on its rim", () => {
    expect(detailRingGrips(detail)).toEqual([
      expect.objectContaining({ id: "ring:centre", at: [120, 120] }),
      expect.objectContaining({ id: "ring:rim", at: [136, 120] }),
    ]);
    expect(detailRingGrips({})).toEqual([]);
  });

  it("the centre dragged moves the circle, the same size", () => {
    expect(detailRingAfter(detail, parent, "ring:centre", [10, -4])).toEqual({ at: [15, 8], r: 8 });
  });

  it("the rim dragged out makes it bigger, in it smaller, never nothing", () => {
    expect(detailRingAfter(detail, parent, "ring:rim", [8, 0])).toEqual({ at: [10, 10], r: 12 });
    expect(detailRingAfter(detail, parent, "ring:rim", [-8, 0])).toEqual({ at: [10, 10], r: 4 });
    expect(detailRingAfter(detail, parent, "ring:rim", [-16, 0])!.r).toBe(1);
  });
});
