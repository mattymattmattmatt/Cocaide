import { beforeAll, describe, expect, it } from "vitest";
import { critique } from "../src/intent/critic";
import { planPart, type Plan } from "../src/intent/plan";
import { answerIntent, numbersIn, reviewIntent } from "../src/intent/review";
import { blank, emptyHoleGroup, emptyIntent, stated, type HoleGroup, type Intent, type NumberField } from "../src/intent/schema";
import { loadOC, rebuild, type OC } from "../src/kernel";

const inferred = (value: number, confidence = 0.9): NumberField => ({ value, evidence: "", source: "inferred", confidence });

function plate(w: NumberField, h: NumberField, t: NumberField, holes: Partial<HoleGroup>[] = []): Intent {
  return { ...emptyIntent(), name: "plate", width: w, height: h, thickness: t, holes: holes.map((g) => ({ ...emptyHoleGroup(), ...g })) };
}

const BRACKET_TEXT = "80 x 40 x 6 plate, four 6.6 holes 8 mm from corners";
const bracketIntent = () =>
  plate(stated(80, "80"), stated(40, "40"), stated(6, "6"), [
    { diameter: stated(6.6, "6.6 holes"), count: stated(4, "four"), placement: "corners", inset: stated(8, "8 mm from corners") },
  ]);

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function build(plan: Plan) {
  if (!plan.ok) throw new Error(plan.error);
  const r = rebuild(plan.doc, oc);
  const c = critique(plan.expect, r.measurements, r.errors);
  const m = r.measurements;
  r.dispose();
  return { c, m, doc: plan.doc };
}

describe("ask if missing", () => {
  it("reads every number in a request", () => {
    expect(numbersIn(BRACKET_TEXT)).toEqual([80, 40, 6, 6.6, 8]);
    expect(numbersIn("a 1/4 in plate", false)).toEqual([0.25, 1, 4]);
    expect(numbersIn("four holes", true)).toContain(4);
  });

  it("the bracket request is complete: nothing to ask", () => {
    const r = reviewIntent(bracketIntent(), { text: BRACKET_TEXT });
    expect(r.blanks).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('"a plate with some holes" asks for every number instead of guessing', () => {
    const intent = plate(blank(), blank(), blank(), [{ count: { value: null, evidence: "some holes", source: "missing", confidence: 0 } }]);
    const r = reviewIntent(intent, { text: "a plate with some holes" });
    expect(r.ready).toBe(false);
    expect(r.blanks.map((b) => b.path)).toEqual(["width", "height", "thickness", "holes[0].diameter", "holes[0].placement", "holes[0].count"]);
  });

  it("a number the model invented is a blank, whatever it claims", () => {
    // The model says "stated", but the request has no numbers at all.
    const intent = plate(stated(100, "plate"), stated(50, "plate"), stated(6, "plate"), [{ diameter: stated(6.6, "holes"), count: stated(4, "some"), placement: "corners", inset: stated(10, "") }]);
    const r = reviewIntent(intent, { text: "a plate with some holes" });
    expect(r.ready).toBe(false);
    const why = Object.fromEntries(r.blanks.map((b) => [b.path, b.note]));
    expect(why.width).toBe("100 is not in the request");
    expect(why.thickness).toBe("6 is not in the request");
    expect(why["holes[0].diameter"]).toBe("6.6 is not in the request");
    expect(r.intent.thickness.value).toBeNull();
  });

  it("thickness and hole diameter are ask-first: a confident guess is still a blank", () => {
    const r = reviewIntent(plate(stated(80, "80"), stated(40, "40"), inferred(6, 0.95)), { text: "an 80 by 40 plate" });
    expect(r.blanks.map((b) => [b.path, b.note])).toEqual([["thickness", "a guess: the request does not say"]]);
  });

  it("a named standard gives the number: M6 clearance is 6.6, M6 tapped is 5", () => {
    const m6 = (value: number) =>
      plate(stated(80, "80"), stated(40, "40"), stated(6, "6"), [
        { diameter: { value, evidence: "M6", source: "standard", confidence: 1 }, placement: "center", count: stated(1, "a") },
      ]);
    const text = "80x40x6 plate, an M6 hole in the middle";
    expect(reviewIntent(m6(6.6), { text }).ready).toBe(true);
    expect(reviewIntent(m6(5), { text }).ready).toBe(true);
    const wrong = reviewIntent(m6(7), { text });
    expect(wrong.blanks.map((b) => [b.path, b.note])).toEqual([["holes[0].diameter", '"M6" does not give 7']]);
  });

  it("answers from the card fill the blanks", () => {
    const first = reviewIntent(plate(blank(), blank(), blank(), [{}]), { text: "a plate with some holes" });
    const { intent, confirmed } = answerIntent(first.intent, {
      width: 80,
      height: 40,
      thickness: 6,
      "holes[0].diameter": 6.6,
      "holes[0].placement": "corners",
    });
    const second = reviewIntent(intent, { text: "a plate with some holes", confirmed });
    expect(second.blanks.map((b) => b.path)).toEqual(["holes[0].inset"]);
    const third = answerIntent(second.intent, { "holes[0].inset": 8 });
    const done = reviewIntent(third.intent, { text: "a plate with some holes", confirmed: new Set([...confirmed, ...third.confirmed]) });
    expect(done.ready).toBe(true);
    const { c } = build(planPart(done.intent));
    expect(c.ok).toBe(true);
  });

  it("a stated count that disagrees with the placement is a problem, not a guess", () => {
    const intent = bracketIntent();
    intent.holes[0].count = stated(3, "3");
    const r = reviewIntent(intent, { text: "80 x 40 x 6 plate, 3 holes 6.6 in the corners 8 from the edges" });
    expect(r.problems).toEqual(["Holes: count: the request says 3, but that placement makes 4."]);
    expect(r.ready).toBe(false);
  });
});

describe("planner and critic", () => {
  it("the bracket: 80 × 40 × 6 with four Ø6.6 holes 8 mm from the corners", () => {
    const r = reviewIntent(bracketIntent(), { text: BRACKET_TEXT });
    const { c, m, doc } = build(planPart(r.intent));
    expect(c.ok, c.findings.join("\n")).toBe(true);
    expect(m!.boundingBox!.size).toEqual([80, 40, 6]);
    expect(m!.holeCount).toBe(4);
    expect(m!.volume).toBeCloseTo(80 * 40 * 6 - 4 * Math.PI * 3.3 ** 2 * 6, 6);
    const centers = m!.holes.map((h) => [Math.round(h.axisPoint[0] * 1e6) / 1e6, Math.round(h.axisPoint[1] * 1e6) / 1e6]).sort();
    expect(centers).toEqual([
      [-32, -12],
      [-32, 12],
      [32, -12],
      [32, 12],
    ]);
    // Parametric: the user's numbers are parameters, used by the features.
    expect(doc.parameters).toEqual({ plate_w: 80, plate_h: 40, part_t: 6, hole_d: 6.6, hole_inset: 8 });
    expect(doc.features.map((f) => f.id)).toEqual(["sketch_1", "ext_1", "hole_1", "pattern_1"]);
  });

  it("the plan stays parametric: a wider plate keeps the holes 8 mm from its corners", () => {
    const plan = planPart(reviewIntent(bracketIntent(), { text: BRACKET_TEXT }).intent);
    if (!plan.ok) throw new Error(plan.error);
    plan.doc.parameters = { ...(plan.doc.parameters as object), plate_w: 100 };
    plan.expect.size = [100, 40, 6];
    plan.expect.holes = [
      [42, 12],
      [-42, 12],
      [42, -12],
      [-42, -12],
    ].map(([x, y]) => ({ diameter: 6.6, center: [x, y] as [number, number], depth: 6 }));
    // The rectangle's size, the hole positions and the pattern spacing are all expressions over the parameters.
    const { c } = build(plan);
    expect(c.ok, c.findings.join("\n")).toBe(true);
  });

  it("plans a grid, a circle on a disc, points from a corner, and a centre hole", () => {
    const grid = plate(stated(100, "100"), stated(60, "60"), stated(5, "5"), [
      { diameter: stated(4, "4"), placement: "grid", rows: stated(2, "2"), columns: stated(3, "3"), pitchX: stated(30, "30"), pitchY: stated(20, "20") },
    ]);
    expect(build(planPart(reviewIntent(grid, { text: "100 x 60 x 5, 2 rows of 3 holes, 4 dia, 30 by 20 pitch" }).intent)).c.ok).toBe(true);

    const disc: Intent = {
      ...emptyIntent(),
      kind: "disc",
      name: "flange",
      diameter: stated(120, "120"),
      thickness: stated(10, "10"),
      holes: [
        { ...emptyHoleGroup(), diameter: stated(20, "20"), placement: "center" },
        { ...emptyHoleGroup(), diameter: stated(9, "9"), count: stated(6, "6"), placement: "circle", circleDiameter: stated(90, "90") },
      ],
    };
    const d = build(planPart(reviewIntent(disc, { text: "disc 120 dia 10 thick, 20 bore, 6 holes 9 dia on a 90 circle" }).intent));
    expect(d.c.ok, d.c.findings.join("\n")).toBe(true);
    expect(d.m!.holeCount).toBe(7);

    const pts = plate(stated(50, "50"), stated(30, "30"), stated(4, "4"), [
      { diameter: stated(3, "3"), placement: "points", points: { value: [{ x: 10, y: 10 }, { x: 40, y: 20 }], evidence: "(10,10) and (40,20)", source: "stated", confidence: 1 } },
    ]);
    const p = build(planPart(reviewIntent(pts, { text: "50x30x4 plate, 3 mm holes at (10,10) and (40,20)" }).intent));
    expect(p.c.ok, p.c.findings.join("\n")).toBe(true);
  });

  it("inches are converted once, and the conversion is reported", () => {
    const intent = { ...plate(stated(3, "3"), stated(2, "2"), stated(0.25, "1/4")), units: "in" as const };
    const plan = planPart(reviewIntent(intent, { text: "a 3 x 2 in plate, 1/4 thick" }).intent);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.doc.parameters).toEqual({ plate_w: 76.2, plate_h: 50.8, part_t: 6.35 });
    expect(plan.notes[0]).toBe("Converted from inches once (× 25.4): thickness 0.25 in → 6.35 mm; width 3 in → 76.2 mm; height 2 in → 50.8 mm.");
    expect(build(plan).c.ok).toBe(true);
  });

  it("the critic catches a part that does not match the request", () => {
    const plan = planPart(reviewIntent(bracketIntent(), { text: BRACKET_TEXT }).intent);
    if (!plan.ok) throw new Error(plan.error);
    plan.doc.parameters = { ...(plan.doc.parameters as object), hole_d: 6, part_t: 5 };
    const { c } = build(plan);
    expect(c.ok).toBe(false);
    expect(c.findings).toEqual([
      "Size: expected 80 × 40 × 6, measured 80 × 40 × 5",
      "Hole diameters: expected 6.6, 6.6, 6.6, 6.6, measured 6, 6, 6, 6",
      "Hole positions: expected 4 at the asked centres, measured missing or wrong: Ø6.6 at [32, 12]; Ø6.6 at [-32, 12]; Ø6.6 at [32, -12]; Ø6.6 at [-32, -12]",
    ]);
  });
});
