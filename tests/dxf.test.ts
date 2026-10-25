// DXF in and out (Phase P, DESIGN §2.9: src/io/dxf.ts): the writer (R2000
// and R12), the reader on files written here and by another program (blocks,
// bulges, inches, ellipses, splines, text and dimensions skipped), the
// geometry helpers, and sketches out to DXF and DXF into sketches: a closed
// outline read from a DXF becomes a profile that extrudes to the right volume.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { SketchEntity } from "../src/doc/types";
import { buildProfile } from "../src/geom/profile";
import { splineOf } from "../src/geom/curves";
import { closestOnSpline, splinePoint } from "../src/geom/spline";
import { DxfError, dxfNumber, readDxf, skippedText, writeDxf, type DxfEntity } from "../src/io/dxf";
import { bulgeArc, joinContours, nurbsPoint, sampleSpline, transformEntity } from "../src/io/dxfGeom";
import { dxfToSketch, sketchToDxf } from "../src/io/dxfSketch";
import { solveSketch } from "../src/geom/solver";
import { sketchHealth } from "../src/ui/sketcher/status";
import { loadOC, rebuild, type OC } from "../src/kernel";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/dxf/${name}`, import.meta.url), "utf8");
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const round = (v: unknown): unknown => (typeof v === "number" ? r6(v) : Array.isArray(v) ? v.map(round) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v);
const of = <T extends DxfEntity["type"]>(es: DxfEntity[], type: T) => es.filter((e): e is Extract<DxfEntity, { type: T }> => e.type === type);

describe("dxf numbers and geometry", () => {
  it("writes plain decimals: no exponent, no -0, always a point", () => {
    expect([dxfNumber(10), dxfNumber(-0), dxfNumber(1e-12), dxfNumber(0.1 + 0.2), dxfNumber(-2.5), dxfNumber(123456789.123), dxfNumber(1e-7)]).toEqual([
      "10.0",
      "0.0",
      "0.0",
      "0.3",
      "-2.5",
      "123456789.123",
      "0.0000001",
    ]);
  });

  it("turns a bulge into its arc: bulge 1 is a half turn, counter-clockwise", () => {
    // From (80, 0) to (80, 40) with bulge 1: the right half of a circle about (80, 20), radius 20, from 270° to 90°.
    expect(round(bulgeArc([80, 0], [80, 40], 1))).toEqual({ c: [80, 20], r: 20, start: 270, end: 90 });
    // tan(90° / 4) is a quarter turn: from (90, 0) to (100, 10) about (90, 10).
    expect(round(bulgeArc([90, 0], [100, 10], Math.tan(Math.PI / 8)))).toEqual({ c: [90, 10], r: 10, start: 270, end: 0 });
    // A negative bulge runs clockwise: the same arc, its ends swapped for DXF's counter-clockwise.
    expect(round(bulgeArc([100, 10], [90, 0], -Math.tan(Math.PI / 8)))).toEqual({ c: [90, 10], r: 10, start: 270, end: 0 });
  });

  it("stretches a circle into an ellipse, and mirrors an arc the right way round", () => {
    // x doubled: a circle of radius 5 becomes an ellipse 10 by 5.
    const [e] = transformEntity({ type: "circle", c: [1, 1], r: 5 }, { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(e.type).toBe("ellipse");
    const el = e as Extract<DxfEntity, { type: "ellipse" }>;
    expect(round(el.c)).toEqual([2, 1]);
    expect(r6(Math.hypot(...el.major))).toBe(10);
    expect(r6(el.ratio)).toBe(0.5);
    // Mirrored in x, the arc from 0° to 90° about the origin is the arc from 90° to 180°.
    const [m] = transformEntity({ type: "arc", c: [0, 0], r: 3, start: 0, end: 90 }, { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(round(m)).toEqual({ type: "arc", c: [0, 0], r: 3, start: 90, end: 180 });
  });

  it("joins lines and arcs that meet end to end into one closed polyline, whichever way each runs", () => {
    const pieces: DxfEntity[] = [
      { type: "line", a: [0, 0], b: [80, 0] },
      { type: "arc", c: [80, 20], r: 20, start: 270, end: 90 }, // (80, 0) round to (80, 40)
      { type: "line", a: [0, 40], b: [80, 40] }, // drawn backwards
      { type: "arc", c: [0, 20], r: 20, start: 90, end: 270 }, // (0, 40) round to (0, 0)
      { type: "circle", c: [40, 20], r: 5 },
    ];
    const joined = joinContours(pieces);
    expect(joined.map((e) => e.type).sort()).toEqual(["circle", "polyline"]);
    const p = of(joined, "polyline")[0];
    expect(p.closed).toBe(true);
    expect(round(p.points)).toEqual([[0, 0], [80, 0], [80, 40], [0, 40]]);
    expect(round(p.bulges)).toEqual([0, 1, 0, 1]);
  });
});

describe("reading DXF", () => {
  it("reads a hand-written R12 file: a POLYLINE with bulges, layers, a text skipped, units not given", () => {
    const r = readDxf(fixture("slot-plate-r12.dxf"));
    expect(r.version).toBe("AC1009");
    expect(r.units).toEqual({ code: null, name: "millimetres", scale: 1, assumed: true });
    expect(r.layers).toEqual([
      { name: "OUTLINE", count: 2 },
      { name: "CENTRE", count: 1, off: true },
    ]);
    expect(r.skipped).toEqual({ text: 1 });
    expect(round(r.entities)).toEqual([
      { type: "polyline", points: [[0, 0], [80, 0], [80, 40], [0, 40]], bulges: [0, 1, 0, 1], closed: true, layer: "OUTLINE" },
      { type: "circle", c: [40, 20], r: 5, layer: "OUTLINE" },
      { type: "line", a: [-30, 20], b: [110, 20], layer: "CENTRE" },
    ]);
  });

  it("reads a file another program wrote in inches: blocks exploded (rotated, scaled, mirrored, arrayed), ellipse, splines, a mirrored arc", () => {
    const r = readDxf(fixture("inch-blocks.dxf"));
    const IN = 25.4;
    expect(r.units).toEqual({ code: 1, name: "inches", scale: IN, assumed: false });
    expect(r.skipped).toEqual({ text: 2, dimension: 1, hatch: 1 });
    expect(r.warnings).toEqual([]);
    // Block LUG (base point (1, 0)): a line (1,0)-(3,0) on layer 0, a hole r 0.25 at (2, 1) on HOLES, an arc r 1 about (2, 0), 0°-180°.
    // Inserted plain at (10, 0), rotated 90° and scaled 2 at (20, 0), mirrored at (30, 0), and as 2 rows x 3 columns at (0, 10): 9 copies.
    expect(of(r.entities, "circle")).toHaveLength(9);
    expect(r.layers).toEqual([
      { name: "HOLES", count: 9 },
      { name: "PARTS", count: 23 },
    ]);
    const lines = of(r.entities, "line").map((l) => round([l.a, l.b]));
    expect(lines.slice(0, 3)).toEqual(
      round([
        [[10 * IN, 0], [12 * IN, 0]], // plain: the block's layer-0 line takes the insert's layer
        [[20 * IN, 0], [20 * IN, 4 * IN]], // (0,0)-(2,0) scaled 2, turned 90°
        [[30 * IN, 0], [28 * IN, 0]], // mirrored
      ]),
    );
    expect(of(r.entities, "line")[0].layer).toBe("PARTS");
    const arcs = of(r.entities, "arc").map((a) => round({ c: a.c, r: a.r, start: a.start, end: a.end }));
    expect(arcs[1]).toEqual({ c: [20 * IN, 2 * IN], r: 2 * IN, start: 90, end: 270 });
    // Columns 4 in apart, rows 5 in apart, from (0, 10).
    expect(of(r.entities, "circle").slice(3).map((c) => round(c.c))).toEqual([
      [1 * IN, 11 * IN],
      [5 * IN, 11 * IN],
      [9 * IN, 11 * IN],
      [1 * IN, 16 * IN],
      [5 * IN, 16 * IN],
      [9 * IN, 16 * IN],
    ]);
    // An arc about (5, 5) drawn from below (extrusion 0, 0, -1): about (-5, 5) in the world, from 90° to 180°.
    expect(arcs.at(-1)).toEqual({ c: [-5 * IN, 5 * IN], r: IN, start: 90, end: 180 });
    const [el] = of(r.entities, "ellipse");
    expect(round({ c: el.c, major: el.major, ratio: el.ratio, start: el.start, end: el.end })).toEqual({ c: [0, -10 * IN], major: [4 * IN, 0], ratio: 0.5, start: 0, end: r6(Math.PI) });
    const [fit, ctrl] = of(r.entities, "spline");
    expect(round(fit.fit)).toEqual(round([[0, -20 * IN], [2 * IN, -18 * IN], [4 * IN, -20 * IN], [6 * IN, -18 * IN]]));
    expect(ctrl.degree).toBe(3);
    expect(ctrl.knots).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    // A cubic Bezier's middle: (P0 + 3 P1 + 3 P2 + P3) / 8.
    expect(round(nurbsPoint(3, ctrl.knots, ctrl.control, undefined, 0.5))).toEqual(round([12 * IN, ((-20 + 3 * -17 + 3 * -17 - 20) / 8) * IN]));
    expect(round(of(r.entities, "point")[0].at)).toEqual(round([7 * IN, 7 * IN]));
  });

  it("refuses what is not ASCII DXF, saying what to do", () => {
    expect(() => readDxf("AutoCAD Binary DXF\r\n\u001a\u0000...")).toThrow(new DxfError("this is a binary DXF; save it as ASCII DXF (any version) and try again"));
    expect(() => readDxf("hello\nworld\n")).toThrow(DxfError);
    expect(() => readDxf("0\nEOF\n")).toThrow(new DxfError("not a DXF file: it has no SECTION"));
  });

  it("words what it skipped", () => {
    expect(skippedText({ text: 3, dimension: 1, hatch: 2 })).toBe("3 texts, 1 dimension, 2 hatches");
  });
});

describe("writing DXF", () => {
  const sketch: SketchEntity[] = [
    { id: "l1", type: "line", start: [0, 0], end: [100, 0] },
    { id: "a1", type: "arc", center: [100, 20], start: [100, 0], end: [100, 40] },
    { id: "l2", type: "line", start: [100, 40], end: [0, 40] },
    { id: "l3", type: "line", start: [0, 40], end: [0, 0] },
    { id: "c1", type: "circle", center: [30, 20], radius: 8 },
    { id: "el1", type: "ellipse", center: [70, 20], major: [70, 25], minor: 8, startAngle: 30, endAngle: 200 },
    { id: "sp1", type: "spline", points: [[0, 60], [20, 70], [40, 60], [60, 75]] },
    { id: "p1", type: "point", at: [50, 50] },
    { id: "l4", type: "line", start: [-10, 20], end: [130, 20], construction: true },
  ];

  it("writes a sketch as R2000 that reads back the same: profile, construction and points on their layers, mm", () => {
    const text = writeDxf(sketchToDxf(sketch));
    expect(text).toContain("AC1015");
    expect(text).toMatch(/\$INSUNITS\r\n 70\r\n4\r\n/);
    const r = readDxf(text);
    expect(r.units.scale).toBe(1);
    expect(r.units.assumed).toBe(false);
    expect(r.layers.map((l) => l.name).sort()).toEqual(["CONSTRUCTION", "POINTS", "PROFILE"]);
    // The outline's three lines and arc are one closed polyline.
    const [outline] = of(r.entities, "polyline");
    expect(outline.closed).toBe(true);
    expect(round(outline.points)).toEqual([[0, 0], [100, 0], [100, 40], [0, 40]]);
    expect(round(outline.bulges)).toEqual([0, 1, 0, 0]);
    expect(round(of(r.entities, "circle"))).toEqual([{ type: "circle", c: [30, 20], r: 8, layer: "PROFILE" }]);
    expect(of(r.entities, "line")).toEqual([{ type: "line", a: [-10, 20], b: [130, 20], layer: "CONSTRUCTION" }]);
    expect(of(r.entities, "point")).toEqual([{ type: "point", at: [50, 50], layer: "POINTS" }]);
    // The ellipse was drawn with its "major" end the shorter radius (5 < 8): DXF's major axis is the 8, a quarter turn on.
    const [el] = of(r.entities, "ellipse");
    expect(round({ major: el.major, ratio: el.ratio, start: el.start, end: el.end })).toEqual({ major: [-8, 0], ratio: r6(5 / 8), start: r6(((30 - 90) * Math.PI) / 180 + 2 * Math.PI), end: r6(((200 - 90) * Math.PI) / 180) });
  });

  it("a sketch exported and inserted again keeps its construction as construction: the profile is the same", () => {
    const outline = sketch.filter((e) => ["l1", "a1", "l2", "l3", "c1", "l4"].includes(e.id));
    const back = dxfToSketch(readDxf(writeDxf(sketchToDxf(outline))), []);
    // The centre line crosses the outline: as profile geometry it would cut it in two.
    expect(back.entities.filter((e) => e.construction).map((e) => [e.type, (e as { start?: number[] }).start])).toEqual([["line", [-10, 20]]]);
    const before = buildProfile(outline);
    const after = buildProfile(back.entities);
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) expect(after.area).toBeCloseTo(before.area, 6);
  });

  it("writes a spline exactly: the B-spline passes through every sketch point at its knots", () => {
    const r = readDxf(writeDxf(sketchToDxf(sketch)));
    const [s] = of(r.entities, "spline");
    const curve = splineOf(sketch[6] as Extract<SketchEntity, { type: "spline" }>);
    for (let i = 0; i < curve.points.length; i++) expect(round(nurbsPoint(3, s.knots, s.control, undefined, curve.knots[i]))).toEqual(round(curve.points[i]));
    // And between them it is the sketch's own curve.
    for (const t of [3.3, 17.1, 41.9]) expect(round(nurbsPoint(3, s.knots, s.control, undefined, t))).toEqual(round(splinePoint(curve, t)));
  });

  it("writes R12 for old controllers: POLYLINE with bulges, ellipses and splines as polylines within 0.01 mm", () => {
    const text = writeDxf(sketchToDxf(sketch), { version: "R12" });
    expect(text).toContain("AC1009");
    expect(text).not.toContain("LWPOLYLINE");
    expect(text).not.toContain("ELLIPSE");
    expect(text).not.toContain("SPLINE");
    const r = readDxf(text);
    const polylines = of(r.entities, "polyline");
    expect(polylines).toHaveLength(3); // the outline, the ellipse arc, the spline
    expect(round(polylines.find((p) => p.closed)!.bulges)).toEqual([0, 1, 0, 0]);
    // Every point of the spline's polyline is on the sketch spline, and no chord strays more than 0.01 mm from it.
    const curve = splineOf(sketch[6] as Extract<SketchEntity, { type: "spline" }>);
    const spl = polylines.find((p) => Math.abs(p.points[0][1] - 60) < 1e-9)!;
    expect(spl.points[0]).toEqual([0, 60]);
    expect(round(spl.points.at(-1))).toEqual([60, 75]);
    for (const p of spl.points) expect(closestOnSpline(curve, p).distance).toBeLessThan(1e-6);
    for (let i = 1; i < spl.points.length; i++) {
      const m: [number, number] = [(spl.points[i - 1][0] + spl.points[i][0]) / 2, (spl.points[i - 1][1] + spl.points[i][1]) / 2];
      expect(closestOnSpline(curve, m).distance).toBeLessThan(0.0101);
    }
  });

  it("names layers DXF can hold and escapes text that is not ASCII", () => {
    const text = writeDxf({ entities: [{ type: "text", at: [0, 0], height: 5, text: "plate · 10 mm", layer: "a/b" }] });
    expect(text).toContain("plate \\U+00B7 10 mm");
    expect(readDxf(text).layers).toEqual([]);
    expect(text).toContain("\r\n  8\r\na_b\r\n");
  });
});

describe("DXF into a sketch", () => {
  it("makes lines and arcs of a polyline, joins its ends with coincident relations, and says what it skipped", () => {
    const r = readDxf(fixture("slot-plate-r12.dxf"));
    const ins = dxfToSketch(r, [{ id: "l1", type: "line", start: [0, 0], end: [1, 1] }], { layers: ["OUTLINE"] });
    expect(ins.entities.map((e) => e.id)).toEqual(["l2", "a1", "l3", "a2", "c1"]);
    expect(ins.joined).toBe(4);
    expect(ins.constraints.filter((k) => k.type === "coincident")).toHaveLength(4);
    expect(ins.constraints.filter((k) => k.type === "horizontal")).toEqual([
      { type: "horizontal", entity: "l2" },
      { type: "horizontal", entity: "l3" },
    ]);
    expect(ins.report).toBe("Inserted 5 entities (1 text skipped; units not given: read as mm)");
    // The outline less the hole: 80 x 40 + π 20² − π 5².
    const p = buildProfile(ins.entities);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.area).toBeCloseTo(80 * 40 + Math.PI * 400 - Math.PI * 25, 6);
  });

  it("centres the drawing on the sketch origin, and scales it when asked", () => {
    const r = readDxf(fixture("slot-plate-r12.dxf"));
    const ins = dxfToSketch(r, [], { layers: ["OUTLINE"], centre: true });
    // The box runs −20..100 by 0..40: its middle (40, 20) goes to the origin, so the hole is there.
    expect(ins.entities.find((e) => e.type === "circle")).toMatchObject({ center: [0, 0], radius: 5 });
    const big = dxfToSketch(r, [], { layers: ["OUTLINE"], scale: 2 });
    expect(big.entities.find((e) => e.type === "circle")).toMatchObject({ center: [80, 40], radius: 10 });
  });

  it("snaps ends that nearly meet and keeps an arc an arc", () => {
    const read = { entities: [
      { type: "line", a: [0, 0], b: [10, 0.004], layer: "0" },
      { type: "arc", c: [10, 5], r: 5, start: 270, end: 90, layer: "0" },
      { type: "line", a: [10.003, 10], b: [0, 10], layer: "0" },
      { type: "line", a: [0, 10], b: [0, 0], layer: "0" },
    ] as DxfEntity[], layers: [], units: { code: 4, name: "millimetres", scale: 1, assumed: false }, skipped: {}, warnings: [] };
    const ins = dxfToSketch(read, []);
    expect(ins.joined).toBe(4);
    const arc = ins.entities.find((e) => e.type === "arc") as Extract<SketchEntity, { type: "arc" }>;
    const lines = ins.entities.filter((e) => e.type === "line") as Extract<SketchEntity, { type: "line" }>[];
    // The lines moved onto the arc's ends, which stay on one circle.
    expect(lines[0].end).toEqual(arc.start);
    expect(lines[1].start).toEqual(arc.end);
    expect(Math.hypot(arc.start[0] - arc.center[0], arc.start[1] - arc.center[1])).toBeCloseTo(Math.hypot(arc.end[0] - arc.center[0], arc.end[1] - arc.center[1]), 12);
    expect(buildProfile(ins.entities).ok).toBe(true);
  });

  it("turns ellipses and splines into sketch curves within a hundredth of a millimetre", () => {
    const r = readDxf(fixture("inch-blocks.dxf"));
    const ins = dxfToSketch(r, [], { layers: ["PARTS"] });
    const el = ins.entities.find((e) => e.type === "ellipse")!;
    expect(round(el)).toMatchObject({ center: [0, -254], major: [101.6, -254], minor: 50.8, startAngle: 0, endAngle: 180 });
    const splines = ins.entities.filter((e) => e.type === "spline") as Extract<SketchEntity, { type: "spline" }>[];
    expect(splines).toHaveLength(2);
    // Through the fit points as given.
    expect(round(splines[0].points)).toEqual([[0, -508], [50.8, -457.2], [101.6, -508], [152.4, -457.2]]);
    // The control-point spline: every point of the file's curve is within 0.01 mm of the sketch spline.
    const ctrl = of(r.entities, "spline")[1];
    const curve = splineOf(splines[1]);
    let worst = 0;
    for (const p of sampleSpline(ctrl, 0.001)) worst = Math.max(worst, closestOnSpline(curve, p).distance);
    expect(worst).toBeLessThan(0.01);
    expect(ins.report).toContain("inches converted to mm");
    expect(ins.report).toContain("2 texts, 1 dimension, 1 hatch skipped");
  });
});

describe("DXF into a sketch: tangent where it runs on smoothly", () => {
  const plain = (entities: DxfEntity[]) => ({ entities, layers: [], units: { code: 4, name: "millimetres", scale: 1, assumed: false }, skipped: {}, warnings: [] });

  it("ties a slot's sides to its ends: the outline keeps its shape, nothing is over-defined", () => {
    const ins = dxfToSketch(readDxf(fixture("slot-plate-r12.dxf")), [], { layers: ["OUTLINE"] });
    const tangents = ins.constraints.filter((k) => k.type === "tangent").map((k) => [...(k as { entities: string[] }).entities].sort().join(" "));
    expect(tangents.sort()).toEqual(["a1 l1", "a1 l2", "a2 l1", "a2 l2"]);
    // Two lines (8) and two arcs (10) less 4 joints (8), 2 horizontals and 4 tangents: 4 left (where, how long, how wide); the hole 3 more.
    const h = sketchHealth(ins.entities, ins.constraints);
    expect([h.state, h.dof, h.conflicting]).toEqual(["under", 7, []]);
    expect(solveSketch(ins.entities, ins.constraints).ok).toBe(true);
  });

  it("ties a rounded plate's corners: 8 tangents, 8 freedoms left for the outline (where, size, four radii)", () => {
    const ins = dxfToSketch(readDxf(fixture("rounded-plate-r2010.dxf")), []);
    expect(ins.constraints.filter((k) => k.type === "tangent")).toHaveLength(8);
    const h = sketchHealth(ins.entities, ins.constraints);
    // The outline's 8, and the two holes' 3 each.
    expect([h.state, h.dof, h.conflicting]).toEqual(["under", 14, []]);
  });

  it("adds none at a sharp corner, nor between two arcs of one circle", () => {
    const corner = dxfToSketch(
      plain([
        // A square corner of two lines, then an arc that ends on the second line's end with its radius along the line.
        { type: "line", a: [0, 0], b: [10, 0] },
        { type: "line", a: [10, 0], b: [10, 10] },
        { type: "arc", c: [10, 5], r: 5, start: 0, end: 90 },
      ]),
      [],
    );
    expect(corner.constraints.filter((k) => k.type === "tangent")).toEqual([]);
    const circle = dxfToSketch(plain([{ type: "arc", c: [0, 0], r: 5, start: 0, end: 180 }, { type: "arc", c: [0, 0], r: 5, start: 180, end: 360 }]), []);
    expect(circle.joined).toBe(2);
    expect(circle.constraints.filter((k) => k.type === "tangent")).toEqual([]);
    expect(sketchHealth(circle.entities, circle.constraints).conflicting).toEqual([]);
  });

  it("ties two arcs that run on into each other (an S bend), not two that meet at an angle", () => {
    const s = dxfToSketch(plain([{ type: "arc", c: [0, 0], r: 10, start: 180, end: 360 }, { type: "arc", c: [20, 0], r: 10, start: 0, end: 180 }, { type: "arc", c: [40, 0], r: 10, start: 180, end: 270 }]), []);
    // The first two meet at (10, 0) with their radii in line; the second and third meet at (30, 0), also in line.
    expect(s.constraints.filter((k) => k.type === "tangent").map((k) => (k as { entities: string[] }).entities)).toEqual([
      ["a1", "a2"],
      ["a2", "a3"],
    ]);
    const v = dxfToSketch(plain([{ type: "arc", c: [0, 0], r: 10, start: 0, end: 90 }, { type: "arc", c: [10, 10], r: 10, start: 180, end: 270 }]), []);
    // Meeting at (10, 0) and (0, 10)? No: the ends are (10, 0)/(0, 10) and (0, 10)/(10, 0): a lens, its tips sharp.
    expect(v.joined).toBe(2);
    expect(v.constraints.filter((k) => k.type === "tangent")).toEqual([]);
  });
});

describe("a DXF outline extrudes", () => {
  let oc: OC;
  beforeAll(async () => {
    oc = await loadOC();
  });

  it("reads a rounded plate with two holes, sketches it on Top and extrudes it 10 mm", () => {
    const ins = dxfToSketch(readDxf(fixture("rounded-plate-r2010.dxf")), []);
    const doc = {
      version: 1,
      units: "mm",
      name: "dxf-plate",
      features: [
        { id: "sketch_1", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: ins.entities, constraints: ins.constraints },
        { id: "extrude_1", op: "extrude", sketch: "sketch_1", distance: 10 },
      ],
    };
    const r = rebuild(doc, oc);
    try {
      expect(r.errors).toEqual([]);
      // 100 x 60 with R10 corners (each takes off 10² − π 10² / 4) and two Ø12 holes, 10 thick.
      const area = 100 * 60 - 4 * (100 - (Math.PI * 100) / 4) - 2 * Math.PI * 36;
      expect(r.measurements!.volume).toBeCloseTo(area * 10, 4);
    } finally {
      r.dispose();
    }
  });
});
