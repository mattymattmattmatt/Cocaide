// sketchProfile (a fully defined sketch from a compact description) and the
// fullyDefine and holes helpers. Pure where they can be; holes reads the face
// from the kernel.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { fullyDefineCommand, holesCommands } from "../src/ask/tools/helpers";
import { sketchProfile, type ProfileMade } from "../src/ask/tools/sketchProfile";
import { apply, type RawDocument } from "../src/doc/commands";
import type { Constraint, SketchEntity } from "../src/doc/types";
import { checkConstraints } from "../src/geom/constraints";
import { sketchStatus } from "../src/geom/solver";
import { getOC, loadOC } from "../src/kernel";

const empty = (parameters: Record<string, unknown> = {}): RawDocument => ({ version: 1, units: "mm", name: "t", parameters, features: [] });
const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;

function made(doc: RawDocument, input: unknown): ProfileMade {
  const r = sketchProfile(doc, input);
  if (typeof r === "string") throw new Error(r);
  return r;
}

/** The sketch the command writes, after apply (validated, constraints checked on the stored geometry). */
function written(doc: RawDocument, m: ProfileMade): { entities: SketchEntity[]; constraints: Constraint[] } {
  const r = apply(doc, m.command);
  if (!r.ok) throw new Error(r.error);
  return r.doc.features.find((f) => f.id === m.sketch) as unknown as { entities: SketchEntity[]; constraints: Constraint[] };
}

describe("sketchProfile", () => {
  it("a centred rectangle with rounded corners: fully defined, sizes kept as expressions and named", () => {
    const doc = empty({ w: 80 });
    const m = made(doc, { sketch: "sk", shapes: [{ rect: { center: [0, 0], width: "=w", height: 40, fillet: 5 }, name: "plate" }] });
    expect(m).toMatchObject({ created: true, dof: 0, profile: { closed: true, regions: 1 } });
    expect((m.profile as { area: number }).area).toBeCloseTo(80 * 40 - (4 - Math.PI) * 25, 6);
    const s = written(doc, m);
    // 4 lines, 4 fillet arcs, a construction diagonal and the centre point.
    expect(s.entities.map((e) => e.type).sort()).toEqual(["arc", "arc", "arc", "arc", "line", "line", "line", "line", "line", "point"]);
    expect(s.constraints).toContainEqual(expect.objectContaining({ type: "distance", value: "=w", name: "plate_w" }));
    expect(s.constraints).toContainEqual(expect.objectContaining({ type: "distance", value: 40, name: "plate_h" }));
    // One radius dimension; the other three fillets are equal to it.
    expect(s.constraints.filter((k) => k.type === "radius")).toHaveLength(1);
    expect(s.constraints.filter((k) => k.type === "equal")).toHaveLength(3);
    // The centre is on the origin.
    expect(s.constraints).toContainEqual({ type: "coincident", points: ["origin", "p1.at"] });
  });

  it("an outline of lines and arcs with a rounded corner: tangent where it should be, closed, fully defined", () => {
    const doc = empty();
    const m = made(doc, { sketch: "sk", shapes: [{ polyline: [[0, 0], [40, 0], { at: [40, 10], fillet: 3 }, [10, 10], { arcTo: [0, 20], center: [0, 10] }] }] });
    expect(m.dof).toBe(0);
    const s = written(doc, m);
    expect(s.constraints.filter((k) => k.type === "tangent")).toHaveLength(2); // the fillet, both sides
    expect(s.constraints.filter((k) => k.type === "coincident" && !(k as { points: string[] }).points.includes("origin")).length).toBe(6);
    expect(checkConstraints(s.entities, s.constraints)).toEqual([]);
    // Area: the L-ish outline less the fillet's corner piece, plus the quarter disc the arc closes in.
    const corner = 9 - (Math.PI * 9) / 4;
    expect((m.profile as { area: number }).area).toBeCloseTo(40 * 10 - corner + (Math.PI * 100) / 4, 6);
  });

  it("tangent arcs and three-point arcs", () => {
    const doc = empty();
    // A stadium: two lines and two arcs that run on tangent.
    const m = made(doc, { sketch: "sk", shapes: [{ polyline: [[0, 0], [40, 0], { arcTo: [40, 20], tangent: true }, [0, 20], { arcTo: [0, 0], tangent: true }] }] });
    expect(m.dof).toBe(0);
    expect((m.profile as { area: number }).area).toBeCloseTo(40 * 20 + Math.PI * 100, 6);
    const n = made(doc, { sketch: "sk", shapes: [{ polyline: [[0, 0], [20, 0], { arcTo: [0, 0], through: [10, 10] }] }] });
    expect((n.profile as { area: number }).area).toBeCloseTo((Math.PI * 100) / 2, 6);
  });

  it("circles, slots, polygons, centrelines and points, all fully defined", () => {
    const doc = empty();
    const m = made(doc, {
      sketch: "sk",
      shapes: [
        { circle: { center: [30, 10], diameter: 8 }, name: "bore" },
        { slot: { from: [-20, 0], to: [0, 10], width: 6 } },
        { polygon: { center: [0, 40], sides: 6, acrossFlats: 10 } },
        { line: { from: [0, -50], to: [0, 60] }, id: "axis", construction: true },
        { point: [5, 5] },
      ],
    });
    expect(m.dof).toBe(0);
    const len = Math.hypot(20, 10);
    const hexArea = 2 * Math.sqrt(3) * 5 ** 2;
    expect((m.profile as { area: number }).area).toBeCloseTo(Math.PI * 16 + 6 * len + Math.PI * 9 + hexArea, 5);
    expect(m.shapes.map((s) => s.shape)).toEqual(["circle", "slot", "polygon", "line", "point"]);
    expect(m.shapes[3].entities).toEqual(["axis"]);
    const s = written(doc, m);
    expect(s.constraints).toContainEqual(expect.objectContaining({ type: "diameter", value: 8, name: "bore" }));
    expect(s.constraints).toContainEqual({ type: "vertical", entity: "axis" });
  });

  it("adds to an existing sketch, keeping what it had", () => {
    const m = made(bracket, { sketch: "sketch_1", shapes: [{ circle: { center: [-30, 0], diameter: 5 } }] });
    expect(m.created).toBe(false);
    expect(m.command.type).toBe("updateFeature");
    const s = written(bracket, m);
    expect(s.entities.map((e) => e.id)).toEqual(["r1", "c1"]);
    expect(s.constraints[0]).toEqual({ type: "distanceX", entity: "r1", value: 80 });
    // Fully Define finishes the old rectangle too.
    expect(sketchStatus(s.entities, s.constraints).dof).toBe(0);
    expect(m.added[0].index).toBe(1);
  });

  it('"dimensions": "none" leaves the sizes to you', () => {
    const m = made(empty(), { sketch: "sk", dimensions: "none", shapes: [{ polyline: [[0, 0], [10, 0], [10, 5]] }] });
    expect(m.dof).toBeGreaterThan(0);
    expect(m.profile.closed).toBe(true);
  });

  it("says what to fix", () => {
    const err = (input: unknown, doc = empty()) => sketchProfile(doc, input) as string;
    expect(err({ sketch: "sk", shapes: [] })).toMatch(/at least one shape/);
    expect(err({ sketch: "sk", shapes: [{ rect: { center: [0, 0], width: 10, height: 10, fillet: 6 } }] })).toMatch(/fillet of 6 .* more than the sides have; use a smaller radius/);
    expect(err({ sketch: "sk", shapes: [{ polyline: [[0, 0], [10, 0], { arcTo: [20, 0], tangent: true }] }] })).toMatch(/that is a line/);
    expect(err({ sketch: "sk", shapes: [{ circle: { center: [0, 0], diameter: "=nope" } }] })).toMatch(/nope/);
    expect(err({ sketch: "sk", shapes: [{ blob: {} }] })).toMatch(/one of polyline, rect, circle/);
    expect(err({ sketch: "ext_1", shapes: [{ point: [0, 0] }] }, bracket)).toMatch(/is a extrude, not a sketch/);
    expect(err({ sketch: "sketch_1", plane: { type: "ref", ref: { datum: "Top" } }, shapes: [{ point: [0, 0] }] }, bracket)).toMatch(/leave out "plane"/);
  });
});

describe("fullyDefine and holes helpers", () => {
  let kernel: LocalKernel;
  beforeAll(async () => {
    await loadOC();
    kernel = new LocalKernel(getOC);
  });

  it("fullyDefine adds what the sketch is missing, measured as it is", () => {
    const r = fullyDefineCommand(bracket, { sketch: "sketch_1" });
    if (typeof r === "string") throw new Error(r);
    expect(r.info.dof).toBe(0);
    const doc = apply(bracket, r.commands[0]);
    expect(doc.ok).toBe(true);
    const again = fullyDefineCommand(doc.ok ? doc.doc : bracket, { sketch: "sketch_1" });
    expect(typeof again !== "string" && again.commands).toEqual([]);
  });

  it("holes: a bolt circle is a hole and a circular pattern of it; corners and grids", async () => {
    const top = { type: "planar", normal: [0, 0, 1], pick: "largest" };
    const circle = await holesCommands(bracket, kernel, { face: top, size: "M4", at: { circle: { center: [-10, 0], diameter: 30, count: 4, startAngle: 45 } } });
    if (typeof circle === "string") throw new Error(circle);
    expect(circle.commands.map((c) => (c.type === "addFeature" ? c.feature.op : c.type))).toEqual(["hole", "circularPattern"]);
    const pattern = (circle.commands[1] as { feature: Record<string, unknown> }).feature;
    expect(pattern).toMatchObject({ feature: "hole_2", count: 4, axis: { origin: [-10, 0, 6], direction: [0, 0, 1] } });
    let doc = bracket;
    for (const c of circle.commands) {
      const r = apply(doc, c);
      if (!r.ok) throw new Error(r.error);
      doc = r.doc;
    }
    const check = await kernel.check(doc);
    expect(check.errors).toEqual([]);
    expect(check.measurements!.holeCount).toBe(5);

    const corners = await holesCommands(bracket, kernel, { face: top, diameter: 4, at: { corners: { inset: 6 } } });
    if (typeof corners === "string") throw new Error(corners);
    expect((corners.commands[0] as { feature: Record<string, unknown> }).feature.centers).toEqual([
      [-34, -14],
      [34, -14],
      [34, 14],
      [-34, 14],
    ]);
    const grid = await holesCommands(bracket, kernel, { face: top, diameter: 3, at: { grid: { center: [-15, 0], columns: 3, rows: 2, pitchX: 10, pitchY: 12 } } });
    if (typeof grid === "string") throw new Error(grid);
    expect((grid.commands[1] as { feature: Record<string, unknown> }).feature).toMatchObject({ op: "linearPattern", direction: [1, 0, 0], spacing: 10, count: 3, direction2: [0, 1, 0], spacing2: 12, count2: 2 });
    expect((grid.commands[0] as { feature: Record<string, unknown> }).feature.center).toEqual([-25, -6]);
    expect(await holesCommands(bracket, kernel, { face: top, diameter: 3, at: { corners: { inset: 30 } } })).toMatch(/leaves no room/);
    expect(await holesCommands(bracket, kernel, { face: top, colour: "red", at: { center: [0, 0] } })).toMatch(/unknown field colour/);
  });
});
