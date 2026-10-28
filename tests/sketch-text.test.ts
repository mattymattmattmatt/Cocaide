// Phase P wave 3B: sketch text. The TrueType reader against the bundled font,
// the layout (height = capital height, alignment, angle, lines), the letters
// as profile loops with their holes, validation, the solver's height
// dimension, and text embossed and engraved (volume = letter area × depth).

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { SketchEntity } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { buildProfile, segArea } from "../src/geom/profile";
import { solveSketch } from "../src/geom/solver";
import { FONT_DATA } from "../src/geom/text/fontData";
import { layoutText, missingGlyphs, textCorners } from "../src/geom/text/text";
import { readTtf } from "../src/geom/text/ttf";
import { loadOC, rebuild, type OC } from "../src/kernel";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const text = (t: string, more: Partial<Extract<SketchEntity, { type: "text" }>> = {}): Extract<SketchEntity, { type: "text" }> => ({ id: "t1", type: "text", at: [0, 0], text: t, height: 10, ...more });

describe("the font", () => {
  it("reads the bundled TrueType font, as the data was written", () => {
    const font = readTtf(new Uint8Array(readFileSync("assets/fonts/LiberationSans-Regular.ttf")));
    expect(font.unitsPerEm).toBe(2048);
    const o = font.glyph(font.glyphIndex("O".charCodeAt(0)));
    expect(o.contours.length).toBe(2);
    expect(FONT_DATA.sans.glyphs.O[0]).toBe(o.advance);
    expect(FONT_DATA.sans.glyphs.O[1].length).toBe(2);
    // An accented letter is a composite: the e and its accent.
    const e = font.glyph(font.glyphIndex("é".charCodeAt(0)));
    expect(e.contours.length).toBe(3);
    expect(missingGlyphs("Hello ✓")).toEqual(["✓"]);
  });
});

describe("text layout", () => {
  it("makes the capital height the text's height", () => {
    const c = textCorners(text("H"));
    expect(c[0][1]).toBeCloseTo(0, 9);
    expect(c[3][1]).toBeCloseTo(10, 9);
  });

  it("aligns about its anchor and turns about it", () => {
    const left = textCorners(text("AB"));
    const centre = textCorners(text("AB", { align: "center" }));
    const w = left[1][0] - left[0][0];
    expect(centre[0][0]).toBeCloseTo(left[0][0] - w / 2, 6);
    const up = textCorners(text("AB", { angle: 90 }));
    expect(up[1][0]).toBeCloseTo(-left[0][1], 6);
    expect(up[1][1]).toBeCloseTo(left[1][0], 6);
  });

  it("puts a letter's holes in it: O is a ring, B has two holes", () => {
    const o = buildProfile([text("O")]);
    expect(o.ok && o.regions.length).toBe(1);
    expect(o.ok && o.regions[0].holes.length).toBe(1);
    const b = buildProfile([text("B")]);
    expect(b.ok && b.regions[0].holes.length).toBe(2);
    // Area: the loops' exact areas (outer less holes).
    const loops = layoutText(text("O")).loops.map((l) => Math.abs(l.reduce((t, s) => t + segArea(s), 0)));
    expect(o.ok && o.area).toBeCloseTo(Math.max(...loops) - Math.min(...loops), 9);
  });

  it("scales the area with the square of the height", () => {
    const a = buildProfile([text("Cocaide")]);
    const b = buildProfile([text("Cocaide", { height: 20 })]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.area / a.area).toBeCloseTo(4, 9);
  });
});

describe("text in the document", () => {
  const sketch = (entity: unknown, constraints: unknown[] = []): RawDocument => ({
    version: 1,
    units: "mm",
    name: "t",
    features: [{ id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [entity], constraints }],
  });

  it("validates strictly", () => {
    expect(allErrors(validateDocument(sketch(text("ok"))))).toEqual([]);
    const errs = allErrors(validateDocument(sketch({ id: "t1", type: "text", at: [0, 0], text: "", height: 0, align: "middle", size: 3 })));
    expect(errs.some((e) => e.includes("unknown field \"size\""))).toBe(true);
    expect(errs.some((e) => e.includes("text: must be the text to write"))).toBe(true);
    expect(errs.some((e) => e.includes('align: must be "left", "center" or "right"'))).toBe(true);
  });

  it("dimensions its height, and the solver holds it", () => {
    const r = solveSketch([text("Hi")], [{ type: "distance", entity: "t1", value: 7 }, { type: "coincident", points: ["t1.at", "origin"] }]);
    expect(r.ok).toBe(true);
    const t = r.ok ? (r.entities[0] as Extract<SketchEntity, { type: "text" }>) : null;
    expect(t?.height).toBeCloseTo(7, 9);
  });

  it("engraves a plate: volume less letter area × depth; and embosses", () => {
    const plate = (op: "cut" | "extrude"): RawDocument => ({
      version: 1,
      units: "mm",
      name: "plate",
      features: [
        { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: 120, h: 40 }] },
        { id: "e1", op: "extrude", sketch: "s1", distance: 5 },
        { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 5] }, entities: [{ ...text("COCAIDE 2026", { align: "center", at: [0, -5] }) }] },
        op === "cut" ? { id: "c1", op: "cut", sketch: "s2", distance: 1 } : { id: "e2", op: "extrude", sketch: "s2", distance: 1.5 },
      ],
    });
    const area = (() => {
      const p = buildProfile([text("COCAIDE 2026", { align: "center", at: [0, -5] })]);
      return p.ok ? p.area : NaN;
    })();
    for (const op of ["cut", "extrude"] as const) {
      const r = rebuild(plate(op), oc);
      try {
        expect(r.errors).toEqual([]);
        const v = r.measurements!.volume;
        const expected = op === "cut" ? 120 * 40 * 5 - area * 1 : 120 * 40 * 5 + area * 1.5;
        expect(Math.abs(v - expected) / (area * (op === "cut" ? 1 : 1.5))).toBeLessThan(0.01);
      } finally {
        r.dispose();
      }
    }
  });
});
