// Phase F: reading a drawing. The fixtures are a real dimensioned drawing of
// the spec bracket (scripts/make-drawings.ts): a vector PDF, a clean scan
// and a blurry scan. The model is scripted; legibility, the review rules,
// the card and the build run for real.

import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { ScriptedModel } from "../src/ask/model";
import { continuePartAsk, runPartAsk } from "../src/ask/part";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { legibility } from "../src/drawing/legibility";
import type { DrawingReading } from "../src/intent/drawing";
import { emptyHoleGroup, emptyIntent, type NumberField } from "../src/intent/schema";
import { getOC, loadOC, rebuild } from "../src/kernel";
import { decodePNG } from "../src/render/pngDecode";
import { drawingOf, fixture, SHEET } from "./drawings";

const EMPTY: RawDocument = { version: 1, units: "mm", name: "part", features: [] };
const printed = (value: number, evidence = String(value), confidence = 0.97): NumberField => ({ value, evidence, source: "stated", confidence });
const sheetText = (value: string, evidence: string, confidence = 0.95) => ({ value, evidence, source: "stated" as const, confidence });

/** What a good reading of the bracket drawing looks like. */
function bracketReading(): DrawingReading {
  return {
    partsShown: 1,
    views: [
      { kind: "top", label: "TOP VIEW", evidence: "TOP VIEW", confidence: 0.95 },
      { kind: "front", label: "FRONT VIEW", evidence: "FRONT VIEW", confidence: 0.95 },
    ],
    projection: sheetText("third-angle", "THIRD ANGLE PROJECTION"),
    units: sheetText("mm", "UNITS: mm"),
    title: sheetText("BRACKET", "BRACKET"),
    drawingNumber: sheetText("CD-0001", "CD-0001"),
    material: sheetText("S275 STEEL", "MATERIAL: S275 STEEL"),
    notes: [],
    part: {
      ...emptyIntent(),
      name: "bracket",
      width: printed(80),
      height: printed(40),
      thickness: printed(6, "6"),
      holes: [
        {
          ...emptyHoleGroup(),
          diameter: printed(6.6, "Ø6.6 THRU"),
          count: printed(1, "Ø6.6 THRU", 0.9),
          placement: "points",
          points: { value: [{ x: 70, y: 20 }], evidence: "70, 20", source: "stated", confidence: 0.95 },
        },
      ],
    },
  };
}

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

describe("legibility", () => {
  it("the clean scan reads as clear and the blurry one does not", async () => {
    const scan = await decodePNG(fixture("bracket-scan.png"));
    const blurry = await decodePNG(fixture("bracket-blurry.png"));
    expect(scan.width).toBe(2340); // A4 landscape at 200 dpi
    expect(legibility(scan.data, scan.width, scan.height)).toMatchObject({ blurry: false });
    expect(legibility(blurry.data, blurry.width, blurry.height)).toMatchObject({ blurry: true });
  });

  it("falls as the blur grows: soft but readable passes, unreadable fails", async () => {
    const scan = await decodePNG(fixture("bracket-scan.png"));
    const score = (r: number) => {
      const d = r ? boxBlur(scan.data, scan.width, scan.height, r) : scan.data;
      return legibility(d, scan.width, scan.height).score;
    };
    const s = [0, 2, 3, 6, 12].map(score);
    expect(s[0]).toBe(1);
    expect(s[1]).toBeGreaterThan(0.5); // r=2: a little soft
    expect(s[2]).toBeGreaterThan(0.5); // r=3: soft, the 3.5 mm text still reads
    expect(s[3]).toBeLessThan(0.5); // r=6: the dimensions are smudges
    expect(s[4]).toBeLessThan(s[3] + 1e-9);
  });
});

describe("reading a drawing", () => {
  it("a clean PDF of the bracket lands in the card with the right numbers, and builds after confirm", async () => {
    const model = new ScriptedModel([], [bracketReading()]);
    const drawing = await drawingOf("bracket.pdf", "application/pdf", SHEET, 200);
    const card = await runPartAsk({ doc: EMPTY, text: "", drawing, model, kernel });

    // Always the card first, even with nothing blank: the user confirms against the drawing.
    expect(card.outcome).toBe("questions");
    expect(card.review!.blanks).toEqual([]);
    expect(card.review!.ready).toBe(true);
    const value = (path: string) => card.review!.rows.find((r) => r.path === path)!.value;
    expect([value("width"), value("height"), value("thickness"), value("holes[0].diameter")]).toEqual([80, 40, 6, 6.6]);
    expect(value("holes[0].points")).toEqual([{ x: 70, y: 20 }]);
    expect([value("drawing.units"), value("drawing.projection"), value("drawing.material")]).toEqual(["mm", "third-angle", "S275 STEEL"]);
    expect(card.views).toEqual(["top (TOP VIEW)", "front (FRONT VIEW)"]);
    expect(card.text).toBe("Read 11 values from bracket.pdf (views: top (TOP VIEW), front (FRONT VIEW)). Check every number against the drawing, then confirm.");

    // What went to the model: the 200 dpi page as an image, the text layer, the user's note last.
    const content = model.intentRequests[0].content;
    expect(model.intentRequests[0].schema).toBe("drawing");
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect((content[1] as Anthropic.TextBlockParam).text).toContain(`Its text layer, exactly as printed on the sheet:\n${SHEET}`);

    // Confirm: it builds, the critic checks it, and it is the spec's bracket.
    const built = await continuePartAsk({ doc: EMPTY, text: "", drawing, model, kernel }, card, {});
    expect(built.outcome, built.text).toBe("proposal");
    expect(built.proposal!.checks!.every((c) => c.ok)).toBe(true);
    const accepted = applyProposal(EMPTY, built.proposal!);
    if (!accepted.ok) throw new Error(accepted.error);
    const doc = accepted.doc;
    expect(allErrors(validateDocument(doc))).toEqual([]);
    expect(doc.name).toBe("BRACKET");
    expect(doc.source).toEqual({ drawing: "bracket.pdf", projection: "third-angle", material: "S275 STEEL", units: "mm", drawingNumber: "CD-0001" });
    expect(doc.material).toBeUndefined(); // the note is stored, not simulated
    const r = rebuild(doc, getOC());
    expect(r.measurements!.volume).toBeCloseTo(18994.728336, 6);
    expect(r.measurements!.holes[0].axisPoint.slice(0, 2).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([30, 0]);
    r.dispose();
  });

  it("a number the model reads that is not printed on the drawing is a blank", async () => {
    const reading = bracketReading();
    reading.part.thickness = printed(5, "5"); // misread
    reading.part.holes[0].diameter = printed(6.5, "Ø6.5 THRU");
    const drawing = await drawingOf("bracket.pdf", "application/pdf", SHEET, 200);
    const card = await runPartAsk({ doc: EMPTY, text: "", drawing, model: new ScriptedModel([], [reading]), kernel });
    expect(card.review!.blanks.map((b) => [b.path, b.note])).toEqual([
      ["thickness", "5 is not printed on the drawing"],
      ["holes[0].diameter", "6.5 is not printed on the drawing"],
    ]);
  });

  it("a blurry drawing leaves fields blank rather than inventing them", async () => {
    // The model claims a confident, complete reading of a scan nobody can read.
    const drawing = await drawingOf("bracket-blurry.png", "image/png", "", null);
    const model = new ScriptedModel([], [bracketReading()]);
    const card = await runPartAsk({ doc: EMPTY, text: "", drawing, model, kernel });
    expect(card.outcome).toBe("questions");
    expect(card.text.startsWith("The drawing is too blurry to read numbers from (legibility 2%), so nothing read from it is used.")).toBe(true);
    const blanks = new Map(card.review!.blanks.map((b) => [b.path, b.note]));
    for (const path of ["width", "height", "thickness", "holes[0].diameter", "holes[0].placement", "holes[0].count", "drawing.units", "drawing.projection"]) {
      expect(blanks.get(path), path).toBe("the drawing is too blurry to read this");
    }
    expect(card.review!.rows.filter((r) => r.path.startsWith("drawing.") || r.kind === "number").every((r) => r.value === null || r.source === "placement")).toBe(true);
    // The model was told the scan is blurry.
    expect((model.intentRequests[0].content[1] as Anthropic.TextBlockParam).text).toContain("The scan measures as blurry.");

    // Confirming without filling builds nothing; filling the blanks from the paper copy builds it.
    const still = await continuePartAsk({ doc: EMPTY, text: "", drawing, model, kernel }, card, {});
    expect(still.outcome).toBe("questions");
    // Where the holes go is asked first; the positions it needs come next, still not read from the scan.
    const where = await continuePartAsk({ doc: EMPTY, text: "", drawing, model, kernel }, card, {
      "drawing.units": "mm",
      "drawing.projection": "third-angle",
      width: 80,
      height: 40,
      thickness: 6,
      "holes[0].diameter": 6.6,
      "holes[0].placement": "points",
      "holes[0].count": 1,
    });
    expect(where.review!.blanks.map((b) => [b.path, b.note])).toEqual([["holes[0].points", "the drawing is too blurry to read this"]]);
    const built = await continuePartAsk({ doc: EMPTY, text: "", drawing, model, kernel }, where, { "holes[0].points": [{ x: 70, y: 20 }] });
    expect(built.outcome, built.text).toBe("proposal");
    expect(built.proposal!.volumeAfter).toBeCloseTo(18994.728336, 6);
  });

  it("a clean scan with no text layer is read at the model's confidence", async () => {
    const reading = bracketReading();
    reading.part.thickness = printed(6, "6", 0.6);
    const drawing = await drawingOf("bracket-scan.png", "image/png", "", null);
    const card = await runPartAsk({ doc: EMPTY, text: "", drawing, model: new ScriptedModel([], [reading]), kernel });
    expect(card.review!.blanks.map((b) => [b.path, b.note])).toEqual([["thickness", "read with low confidence (60%)"]]);
    expect(card.review!.rows.find((r) => r.path === "width")!.value).toBe(80);
  });

  it("v1 limits: one part per drawing, plates and discs only", async () => {
    const reading = bracketReading();
    reading.partsShown = 2;
    reading.part.kind = "other";
    const drawing = await drawingOf("bracket.pdf", "application/pdf", SHEET, 200);
    const card = await runPartAsk({ doc: EMPTY, text: "", drawing, model: new ScriptedModel([], [reading]), kernel });
    expect(card.review!.problems).toEqual([
      "This drawing shows 2 parts. v1 reads one part per drawing.",
      "From a drawing, v1 builds flat plates and discs: one outline with holes through it. Build this part by hand, or describe it.",
    ]);
    const built = await continuePartAsk({ doc: EMPTY, text: "", drawing, model: new ScriptedModel([], []), kernel }, card, {});
    expect(built.outcome).toBe("questions");
  });

  it("an inch drawing converts once and says so", async () => {
    const reading = bracketReading();
    reading.units = sheetText("in", "UNITS: in");
    reading.part.width = printed(3);
    reading.part.height = printed(1.5);
    reading.part.thickness = printed(0.25);
    reading.part.holes = [];
    const text = "3 1.5 0.25 PLATE UNITS: in THIRD ANGLE PROJECTION BRACKET DWG NO. CD-0001 MATERIAL: S275 STEEL";
    const drawing = await drawingOf("bracket.pdf", "application/pdf", text, 200);
    const model = new ScriptedModel([], [reading]);
    const card = await runPartAsk({ doc: EMPTY, text: "", drawing, model, kernel });
    expect(card.review!.blanks).toEqual([]);
    const built = await continuePartAsk({ doc: EMPTY, text: "", drawing, model, kernel }, card, {});
    expect(built.proposal!.doc.parameters).toEqual({ plate_w: 76.2, plate_h: 38.1, part_t: 6.35 });
    expect(built.proposal!.notes![0]).toMatch(/^Converted from inches once/);
  });
});

function boxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const tmp = new Float32Array(w * h);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[(y * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / (2 * r + 1);
        acc += src[(y * w + Math.min(w - 1, x + r + 1)) * 4 + c] - src[(y * w + Math.max(0, x - r)) * 4 + c];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + c] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}
