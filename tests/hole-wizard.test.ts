// Wave 5: the Hole Wizard. ISO metric sizes from src/features/hole/standards.ts
// (clearance fits, tap drills, counterbores and countersinks for socket
// head screws), several holes in one feature (centres, or every point of a
// sketch), blind / through all / up to next, tapped holes with a thread
// record, and the drawing callouts that read them.

import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, references, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { composeSheet, holeText } from "../src/drafting/compose";
import { sheetPDF } from "../src/drafting/pdf";
import { sheetSVG } from "../src/drafting/svg";
import {
  defaultThreadDepth,
  HOLE_SIZES,
  holeSpec,
  holeVolume,
  ISO_METRIC,
  screwSize,
  threadCallout,
  type HoleSpec,
} from "../src/features/hole/standards";
import { getOC, loadOC, rebuild, type OC } from "../src/kernel";

let oc: OC;
let kernel: LocalKernel;
beforeAll(async () => {
  oc = await loadOC();
  kernel = new LocalKernel(getOC);
});

const W = 80;
const D = 40;
const T = 10;
const PLATE = W * D * T;
const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };

/** An 80 x 40 plate, 10 thick (z 0 to 10), and features after it. */
function plate(...more: Record<string, unknown>[]): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "plate",
    features: [
      { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: W, h: D }] },
      { id: "e1", op: "extrude", sketch: "s1", distance: T },
      ...more,
    ],
  };
}

const hole = (f: Record<string, unknown>) => ({ id: "h", op: "hole", face: TOP, center: [0, 0], depth: "through", ...f });
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const spec = (h: Parameters<typeof holeSpec>[0]): HoleSpec => {
  const s = holeSpec(h);
  if (typeof s === "string") throw new Error(s);
  return s;
};

function built(doc: RawDocument) {
  const r = rebuild(doc, oc);
  try {
    return { errors: r.errors, volume: r.measurements?.volume ?? 0, holes: r.holes, measured: r.measurements?.holes ?? [] };
  } finally {
    r.dispose();
  }
}

const cyl = (d: number, h: number) => Math.PI * (d / 2) ** 2 * h;

describe("the ISO metric table", () => {
  it("has M3 to M24, smallest first, with coarse pitches", () => {
    expect(HOLE_SIZES).toEqual(["M3", "M4", "M5", "M6", "M8", "M10", "M12", "M14", "M16", "M20", "M24"]);
    expect(ISO_METRIC.map((r) => [r.size, r.pitch])).toEqual([
      ["M3", 0.5],
      ["M4", 0.7],
      ["M5", 0.8],
      ["M6", 1],
      ["M8", 1.25],
      ["M10", 1.5],
      ["M12", 1.75],
      ["M14", 2],
      ["M16", 2],
      ["M20", 2.5],
      ["M24", 3],
    ]);
  });

  it("gives clearance diameters by fit (ISO 273): close < normal < loose", () => {
    expect(screwSize("M6")!.clearance).toEqual({ close: 6.4, normal: 6.6, loose: 7 });
    expect(screwSize("M8")!.clearance).toEqual({ close: 8.4, normal: 9, loose: 10 });
    expect(screwSize("M12")!.clearance).toEqual({ close: 13, normal: 13.5, loose: 14.5 });
    for (const r of ISO_METRIC) {
      expect(r.clearance.close).toBeGreaterThan(r.d);
      expect(r.clearance.normal).toBeGreaterThan(r.clearance.close);
      expect(r.clearance.loose).toBeGreaterThan(r.clearance.normal);
    }
  });

  it("taps with the nominal diameter less one pitch, to the nearest standard drill", () => {
    for (const r of ISO_METRIC) expect(Math.abs(r.tapDrill - (r.d - r.pitch))).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(ISO_METRIC.map((r) => r.tapDrill)).toEqual([2.5, 3.3, 4.2, 5, 6.8, 8.5, 10.2, 12, 14, 17.5, 21]);
    expect(spec({ size: "M8", kind: "tapped" }).diameter).toBe(6.8);
  });

  it("counterbores clear an ISO 4762 head (dk = 1.5 d + ..., k = d) and countersinks an ISO 10642 head at 90°", () => {
    const head: Record<string, number> = { M3: 5.5, M4: 7, M5: 8.5, M6: 10, M8: 13, M10: 16, M12: 18, M14: 21, M16: 24, M20: 30, M24: 36 };
    for (const r of ISO_METRIC) {
      expect(r.counterbore.diameter).toBeGreaterThan(head[r.size]);
      expect(r.counterbore.depth).toBeGreaterThan(r.d);
    }
    expect(spec({ size: "M6", kind: "counterbore" })).toEqual({ kind: "counterbore", diameter: 6.6, counterbore: { diameter: 11, depth: 6.5 } });
    expect(spec({ size: "M6", kind: "countersink" })).toEqual({ kind: "countersink", diameter: 6.6, countersink: { diameter: 13.7, angle: 90 } });
    expect(holeSpec({ size: "M24", kind: "countersink" })).toBe("ISO 10642 has no countersunk screw of size M24: give the countersink's diameter");
  });

  it("lets every number the hole gives win over the table", () => {
    expect(spec({ size: "M6", kind: "counterbore", fit: "close", counterbore: { depth: 7 } })).toEqual({ kind: "counterbore", diameter: 6.4, counterbore: { diameter: 11, depth: 7 } });
    expect(spec({ size: "M6", diameter: 6.5 }).diameter).toBe(6.5);
    expect(spec({ size: "M8", kind: "tapped", thread: { pitch: 1, depth: 10 }, depth: 15 }).thread).toEqual({ designation: "M8×1", major: 8, pitch: 1, class: "6H", depth: 10 });
    // No size: the hole gives its numbers itself, as before sizes existed.
    expect(spec({ diameter: 5, counterbore: { diameter: 9, depth: 3 } })).toEqual({ kind: "counterbore", diameter: 5, counterbore: { diameter: 9, depth: 3 } });
    expect(holeSpec({})).toBe('needs a diameter, or a size ("M6") to take it from the table');
    expect(holeSpec({ kind: "tapped", diameter: 5 })).toBe('a tapped hole needs a size ("M6")');
  });

  it("threads a blind tapped hole three pitches short of the drill, a through one all the way", () => {
    expect(defaultThreadDepth(15, 1)).toBe(12);
    expect(defaultThreadDepth(2, 1)).toBe(1);
    expect(defaultThreadDepth("through", 1)).toBe("through");
    expect(threadCallout(spec({ size: "M6", kind: "tapped", depth: 15 }).thread!)).toBe("M6×1 - 6H ⌴12");
    expect(threadCallout(spec({ size: "M8", kind: "tapped", depth: "through" }).thread!)).toBe("M8×1.25 - 6H THRU");
  });

  it("works out a hole's volume: bore, plus the counterbore's ring, plus the countersink's cone less the bore inside it", () => {
    expect(holeVolume({ diameter: 6.6 }, 10)).toBeCloseTo(cyl(6.6, 10), 9);
    expect(holeVolume({ diameter: 6.6, counterbore: { diameter: 11, depth: 6.5 } }, 10)).toBeCloseTo(cyl(6.6, 10) + cyl(11, 6.5) - cyl(6.6, 6.5), 9);
    // 90°: the countersink is as deep as it is wider than the bore, (13.7 - 6.6) / 2.
    const h = (13.7 - 6.6) / 2;
    const frustum = (Math.PI * h * (6.85 ** 2 + 6.85 * 3.3 + 3.3 ** 2)) / 3;
    expect(holeVolume({ diameter: 6.6, countersink: { diameter: 13.7, angle: 90 } }, 10)).toBeCloseTo(cyl(6.6, 10) + frustum - cyl(6.6, h), 9);
  });
});

describe("validating a Hole Wizard hole", () => {
  it("takes a size, a kind and a fit, and keeps old holes valid", () => {
    expect(errorsOf(plate(hole({ size: "M6" })))).toEqual([]);
    expect(errorsOf(plate(hole({ size: "M6", kind: "counterbore", fit: "loose" })))).toEqual([]);
    expect(errorsOf(plate(hole({ diameter: 6.6 })))).toEqual([]);
    expect(errorsOf(plate(hole({ diameter: 5, counterbore: { diameter: 9, depth: 3 } })))).toEqual([]);
    const v = validateDocument(plate(hole({ size: "M8", kind: "tapped", depth: 15 })));
    expect(v.features[2].feature).toEqual({
      id: "h",
      op: "hole",
      face: TOP,
      center: [0, 0],
      size: "M8",
      kind: "tapped",
      diameter: 6.8,
      depth: 15,
      thread: { designation: "M8×1.25", major: 8, pitch: 1.25, class: "6H", depth: 11.25 },
    });
  });

  it("says what is wrong, field by field", () => {
    const bad = (f: Record<string, unknown>) => errorsOf(plate(hole(f)));
    expect(bad({ size: "M7" })).toEqual(['h: size: must be an ISO metric size: "M3", "M4", "M5", "M6", "M8", "M10", "M12", "M14", "M16", "M20", "M24" (got "M7")']);
    expect(bad({ size: "M6", kind: "pilot" })).toEqual(['h: kind: must be "simple", "counterbore", "countersink" or "tapped" (got "pilot")']);
    expect(bad({ size: "M6", fit: "snug" })).toEqual(['h: fit: must be "close", "normal" or "loose" (got "snug")']);
    expect(bad({ size: "M6", kind: "tapped", fit: "close" })).toEqual(["h: fit: is the clearance of a hole a screw passes through; a tapped hole's drill comes from its thread"]);
    expect(bad({ size: "M6", kind: "simple", counterbore: { depth: 3 } })).toEqual(['h: counterbore: goes with kind "counterbore" (the hole is "simple")']);
    expect(bad({ size: "M6", kind: "counterbore", counterbore: { depth: -3 } })).toEqual(["h: counterbore.depth: must be greater than 0 (got -3)"]);
    expect(bad({ size: "M6", kind: "tapped", depth: 10, thread: { depth: 12 } })).toEqual(["h: thread.depth: must be at most the drill depth 10 (got 12)"]);
    expect(bad({ size: "M6", kind: "tapped", diameter: 6.5 })).toEqual(["h: diameter: a tapped hole's drill must be smaller than its thread (M6×1: 6) (got 6.5)"]);
    expect(bad({ kind: "tapped" })).toEqual(['h: a tapped hole needs a size ("M6")']);
    expect(bad({ size: "M6", kind: "counterbore", depth: 5 })).toEqual(["h: counterbore.depth: must be less than the hole depth 5 (got 6.5)"]);
    expect(bad({ size: "M6", depth: "deep" })).toEqual(['h: depth: must be a positive number (blind), "through" or "upToNext" (got "deep")']);
  });

  it("takes one centre, several, or a sketch's points, and only one of them", () => {
    const bad = (f: Record<string, unknown>) => errorsOf(plate(hole({ size: "M6", ...f })));
    expect(bad({ center: undefined, centers: [[0, 0], [10, 0]] })).toEqual([]);
    expect(bad({ centers: [[0, 0]] })).toEqual(["h: give one of center and centers, not both"]);
    expect(bad({ center: undefined })).toEqual(['h: needs where it goes: "center": [x, y], "centers": [[x, y], ...] or "points": "<sketch id>"']);
    expect(bad({ center: undefined, centers: [] })).toEqual(["h: centers: must be a list of [x, y] centres, at least one (got [])"]);
    expect(bad({ center: undefined, centers: [[0, 0], [10, 0], [0, 0]] })).toEqual(["h: centers[2]: is the same point as centers[0]"]);
    expect(bad({ center: undefined, centers: [[0, 0], [10]] })).toEqual(["h: centers[1]: must be an array of 2 numbers (got [10])"]);
    expect(bad({ center: undefined, points: "e1" })).toEqual(['h: points: "e1" is an extrude, not a sketch']);
    expect(bad({ center: undefined, points: "s9" })).toEqual(['h: points: "s9" is not a feature before this one']);
    // The plate's sketch has a rectangle and no points.
    expect(bad({ center: undefined, points: "s1" })).toEqual(['h: points: sketch "s1" has no points: put a point (the Point tool) where each hole goes']);
    // Without points, a face is needed.
    expect(bad({ face: undefined })).toEqual(["h: face: must be a face selector object (got nothing)"]);
  });

  it("counts the sketch of its points as a reference: it can't be deleted from under the hole", () => {
    const doc = plate(points(), { id: "h", op: "hole", points: "pts", size: "M6", depth: "through" });
    expect(references(doc.features[3])).toEqual(["pts"]);
    expect(apply(doc, { type: "deleteFeature", id: "pts" })).toEqual({ ok: false, error: "deleteFeature: pts is used by h; delete or change it first" });
  });
});

/** A sketch on the plate's top face with points at three places. */
function points(at: [number, number][] = [[-25, 0], [0, 10], [25, 0]], plane: unknown = { type: "ref", ref: { face: TOP } }): Record<string, unknown> {
  return { id: "pts", op: "sketch", plane, entities: at.map((p, i) => ({ id: `p${i + 1}`, type: "point", at: p })) };
}

describe("drilling Hole Wizard holes", () => {
  it("drills an M6 clearance hole through, normal fit: Ø6.6", () => {
    const b = built(plate(hole({ size: "M6" })));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - cyl(6.6, T), 6);
    expect(b.measured.map((m) => m.diameter)).toEqual([6.6]);
  });

  it("drills three M6 counterbored holes at the centres given, each by the formula", () => {
    const one = holeVolume(spec({ size: "M6", kind: "counterbore" }), T);
    const b = built(plate(hole({ size: "M6", kind: "counterbore", center: undefined, centers: [[-25, 0], [0, 10], [25, 0]] })));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 3 * one, 6);
    // One record per hole, each where it was drilled.
    expect(b.holes.map((h) => [h.entry, h.diameter, h.counterbore])).toEqual([
      [[-25, 0, 10], 6.6, { diameter: 11, depth: 6.5 }],
      [[0, 10, 10], 6.6, { diameter: 11, depth: 6.5 }],
      [[25, 0, 10], 6.6, { diameter: 11, depth: 6.5 }],
    ]);
  });

  it("drills at every point of a sketch on the face, and follows the points when they move", () => {
    const one = holeVolume(spec({ size: "M6", kind: "counterbore" }), T);
    const b = built(plate(points(), { id: "h", op: "hole", points: "pts", size: "M6", kind: "counterbore", depth: "through" }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 3 * one, 6);
    expect(b.holes.map((h) => h.entry)).toEqual([
      [-25, 0, 10],
      [0, 10, 10],
      [25, 0, 10],
    ]);
    const four = built(plate(points([[-30, -10], [30, -10], [30, 10], [-30, 10]]), { id: "h", op: "hole", points: "pts", size: "M6", kind: "counterbore", depth: "through" }));
    expect(four.volume).toBeCloseTo(PLATE - 4 * one, 6);
  });

  it("drops a parallel sketch's points onto the face it names, and refuses one that is not parallel", () => {
    // Points sketched on the Top plane (z = 0), drilled from the top face (z = 10).
    const onTop = points([[-25, 0], [25, 0]], { type: "ref", ref: { datum: "Top" } });
    const b = built(plate(onTop, { id: "h", op: "hole", face: TOP, points: "pts", size: "M5", depth: 4 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 2 * cyl(5.5, 4), 6);
    expect(b.holes.map((h) => h.entry)).toEqual([
      [-25, 0, 10],
      [25, 0, 10],
    ]);
    const front = points([[0, 5]], { type: "ref", ref: { datum: "Front" } });
    expect(built(plate(front, { id: "h", op: "hole", face: TOP, points: "pts", size: "M5", depth: 4 })).errors).toEqual([
      'h: sketch "pts" is not parallel to the selected face: sketch the points on the face (or a plane parallel to it), or leave the face out to drill from the sketch\'s plane',
    ]);
  });

  it("without a face, drills from the sketch's plane against its normal, and says so when that misses the part", () => {
    // On the top face's plane, drilled down 4 mm.
    const above = points([[0, 0]], { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] });
    expect(built(plate(above, { id: "h", op: "hole", points: "pts", size: "M5", depth: 4 })).volume).toBeCloseTo(PLATE - cyl(5.5, 4), 6);
    // On the Top plane (z = 0), drilled down: away from the plate.
    const below = points([[0, 0]], { type: "ref", ref: { datum: "Top" } });
    expect(built(plate(below, { id: "h", op: "hole", points: "pts", size: "M5", depth: 4 })).errors).toEqual([
      'h: the hole at point "p1" [0, 0] meets no material within its depth 4: sketch its point over the part (drilled against the sketch\'s normal), or flip the sketch\'s plane',
    ]);
    // Flipped, it drills up into the plate.
    const flipped = points([[0, 0]], { type: "ref", ref: { datum: "Top" }, flip: true });
    expect(built(plate(flipped, { id: "h", op: "hole", points: "pts", size: "M5", depth: 4 })).volume).toBeCloseTo(PLATE - cyl(5.5, 4), 6);
  });

  it("says which centre is off the face", () => {
    expect(built(plate(hole({ size: "M6", center: undefined, centers: [[0, 0], [90, 0]] }))).errors).toEqual(["h: centers[1] [90, 0] is not on the selected face (it is 50 mm outside it)"]);
    expect(built(plate(hole({ size: "M6", center: [0, 50] }))).errors).toEqual(["h: center [0, 50] is not on the selected face (it is 30 mm outside it)"]);
  });

  it("countersinks by the formula", () => {
    const b = built(plate(hole({ size: "M6", kind: "countersink" })));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - holeVolume(spec({ size: "M6", kind: "countersink" }), T), 6);
  });

  it("taps an M8 blind hole: the tap drill bored 15 deep, the thread recorded for the drawing", () => {
    const b = built(thick(hole({ size: "M8", kind: "tapped", depth: 15, center: [10, 0] })));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(W * D * 20 - cyl(6.8, 15), 6);
    expect(b.holes).toEqual([
      {
        feature: "h",
        entry: [10, 0, 20],
        axis: [0, 0, -1],
        diameter: 6.8,
        depth: 15,
        through: false,
        size: "M8",
        thread: { designation: "M8×1.25", major: 8, pitch: 1.25, class: "6H", depth: 11.25 },
        copies: 0,
      },
    ]);
    expect(holeText(b.holes[0])).toEqual(["M8×1.25 - 6H ⌴11.25", "Ø6.8 ⌴15"]);
  });

  it("taps through: threaded all the way, one callout line", () => {
    const b = built(plate(hole({ size: "M6", kind: "tapped" })));
    expect(b.volume).toBeCloseTo(PLATE - cyl(5, T), 6);
    expect(holeText(b.holes[0])).toEqual(["M6×1 - 6H THRU"]);
  });

  it("goes up to next: through the first wall it meets, not the plate below the gap", () => {
    // A second plate 5 thick, 5 above the first (z 15 to 20), its own body.
    const upper = [
      { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 15] }, entities: [{ id: "r2", type: "rect", center: [0, 0], w: W, h: D }] },
      { id: "e2", op: "extrude", sketch: "s2", distance: 5, newBody: "lid" },
    ];
    const lidTop = { type: "planar", normal: [0, 0, 1], pick: "largest", body: "lid" };
    const next = built(plate(...upper, { id: "h", op: "hole", face: lidTop, center: [0, 0], size: "M6", depth: "upToNext" }));
    expect(next.errors).toEqual([]);
    expect(next.volume).toBeCloseTo(PLATE + W * D * 5 - cyl(6.6, 5), 6);
    expect(next.holes.map((h) => [h.depth, h.through])).toEqual([[5, true]]);
    const through = built(plate(...upper, { id: "h", op: "hole", face: lidTop, center: [0, 0], size: "M6", depth: "through" }));
    expect(through.volume).toBeCloseTo(PLATE + W * D * 5 - cyl(6.6, 5) - cyl(6.6, T), 6);
  });

  it("patterns every hole of the feature: the callout counts them all", async () => {
    const doc = plate(hole({ size: "M6", center: undefined, centers: [[-30, -10], [-30, 10]] }), { id: "lp", op: "linearPattern", feature: "h", direction: [1, 0, 0], spacing: 20, count: 4 });
    const b = built(doc);
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE - 8 * cyl(6.6, T), 6);
    expect(b.holes.map((h) => h.copies)).toEqual([3, 3]);
    // The drawing: one callout for the feature, "8× Ø6.6 THRU", pointing at its first hole.
    const c = await kernel.check(doc);
    const views = [{ id: "top", look: "top" as const }];
    const drawn = apply(doc, {
      type: "setDrawing",
      drawing: { sheet: { size: "A3", scale: "1:1", projection: "third" }, views: [{ id: "top", look: "top" }], annotations: [{ id: "h1", type: "hole", view: "top", hole: "h" }] },
    });
    if (!drawn.ok) throw new Error(drawn.error);
    const sheet = composeSheet(drawn.doc, { measurements: c.measurements, geometry: await kernel.project(drawn.doc, views) })!;
    expect(sheet.annotations.find((a) => a.id === "h1")!.text).toBe("8× Ø6.6 THRU");
  });
});

/** The plate made 20 thick (for blind tapped holes), with a hole. */
function thick(h: Record<string, unknown>): RawDocument {
  const doc = plate(h);
  (doc.features[1] as Record<string, unknown>).distance = 20;
  return doc;
}

describe("a tapped hole on a drawing", () => {
  it("is called out M8×1.25 - 6H ⌴11.25, with the depth symbol drawn (the PDF's font has none)", async () => {
    const doc = thick(hole({ size: "M8", kind: "tapped", depth: 15, center: [10, 0] }));
    const drawn = apply(doc, {
      type: "setDrawing",
      drawing: { sheet: { size: "A3", scale: "1:1", projection: "third" }, views: [{ id: "top", look: "top" }], annotations: [{ id: "h1", type: "hole", view: "top", hole: "h" }] },
    });
    if (!drawn.ok) throw new Error(drawn.error);
    const c = await kernel.check(drawn.doc);
    const sheet = composeSheet(drawn.doc, { measurements: c.measurements, geometry: await kernel.project(drawn.doc, [{ id: "top", look: "top" }]) })!;
    const a = sheet.annotations.find((x) => x.id === "h1")!;
    expect([a.problem, a.text]).toEqual([undefined, "M8×1.25 - 6H ⌴11.25 Ø6.8 ⌴15"]);
    // The text is set without the symbol; each ⌴ is three strokes (a box open at the top).
    const texts = sheet.prims.flatMap((p) => (p.k === "text" ? [p.text] : []));
    expect(texts.some((t) => t.includes("⌴"))).toBe(false);
    expect(texts).toEqual(expect.arrayContaining(["M8×1.25 - 6H ", "11.25", "Ø6.8 ", "15"]));
    const svg = sheetSVG(sheet);
    expect(svg).not.toContain("⌴");
    // The PDF sets only what Helvetica has: no "?" stands in for a missing glyph.
    const pdf = new TextDecoder("latin1").decode(sheetPDF(sheet));
    expect(pdf).not.toMatch(/\(\?|\?\)/);
  });

  it("plans one callout per hole feature, however many holes it drilled", async () => {
    const doc = plate(hole({ size: "M6", center: undefined, centers: [[-25, 0], [25, 0]] }));
    const { planDrawing, DEFAULT_VIEWS } = await import("../src/drafting/plan");
    const c = await kernel.check(doc);
    const plan = planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS), { date: "2026-10-12" });
    expect(plan.annotations.filter((a) => a.type === "hole")).toHaveLength(1);
  });
});
