// rib (Phase O wave 4, DESIGN §2.6): an open sketch line thickened and
// filled out to the body's walls: in the sketch's plane (a gusset in an
// L-bracket's corner: triangle area x thickness) or straight out of it (a
// stiffener across a tray: its height x length x thickness). The end lines
// reach the walls even when drawn short of them; the side is found where the
// body closes the rib in; flip takes the other side.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { chainLeft, extendedChain, ribBand, sweptRegions } from "../src/features/rib/region";
import { regionsArea } from "../src/features/revolve/band";
import { sketchChain } from "../src/features/sweep/chain";
import { loadOC, rebuild, type OC } from "../src/kernel";

type Raw = Record<string, unknown>;
const sketch = (id: string, plane: unknown, entities: Raw[]): Raw => ({ id, op: "sketch", plane, entities, constraints: [] });
const doc = (...features: Raw[]): RawDocument => ({ version: 1, units: "mm", name: "rib test", features });
const errorsOf = (d: unknown) => allErrors(validateDocument(d));
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

/**
 * An L-bracket on Front (sketch x = X, sketch y = Z), 40 deep (Y = -40..0):
 * a leg 60 along X and 10 thick, a leg 60 up Z and 10 thick, meeting at the
 * corner [10, 10]. Volume (60·10 + 10·50) x 40.
 */
const L_SKETCH = sketch("l", { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] }, [
  { id: "a", type: "line", start: [0, 0], end: [60, 0] },
  { id: "b", type: "line", start: [60, 0], end: [60, 10] },
  { id: "c", type: "line", start: [60, 10], end: [10, 10] },
  { id: "d", type: "line", start: [10, 10], end: [10, 60] },
  { id: "e", type: "line", start: [10, 60], end: [0, 60] },
  { id: "f", type: "line", start: [0, 60], end: [0, 0] },
]);
const BRACKET = [L_SKETCH, { id: "ext", op: "extrude", sketch: "l", distance: 40 }];
const BRACKET_V = (60 * 10 + 10 * 50) * 40;
/** The bracket's middle plane (Y = -20), its sketch x = X and y = Z as on Front. */
const MID = { type: "datum", normal: [0, -1, 0], origin: [0, -20, 0] };
const gusset = (a: [number, number], b: [number, number]) => sketch("g", MID, [{ id: "g1", type: "line", start: a, end: b }]);

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(d: unknown) {
  const r = rebuild(d, oc);
  try {
    const m = r.measurements;
    return {
      errors: r.errors,
      volume: m?.volume ?? 0,
      box: m?.boundingBox ? { min: m.boundingBox.min.map(r6), max: m.boundingBox.max.map(r6) } : null,
      bodies: (m?.bodies ?? []).map((b) => b.name),
    };
  } finally {
    r.dispose();
  }
}

describe("rib: its 2D shapes (pure)", () => {
  const chain = sketchChain([{ id: "g", type: "line", start: [10, 50], end: [50, 10] }], "a rib", false);
  it("extends the end lines, and sweeps the chain across itself", () => {
    const long = extendedChain(chain, 10);
    const u = 10 / Math.SQRT2;
    expect(long.segs[0].a.map(r6)).toEqual([r6(10 - u), r6(50 + u)]);
    expect(long.segs[0].b.map(r6)).toEqual([r6(50 + u), r6(10 - u)]);
    expect(chainLeft(chain).map(r6)).toEqual([r6(Math.SQRT1_2), r6(Math.SQRT1_2)]);
    // The line (40√2 long) moved 5 across: a 40√2 x 5 rectangle.
    expect(regionsArea(sweptRegions(chain, [5 * Math.SQRT1_2, 5 * Math.SQRT1_2]))).toBeCloseTo(40 * Math.SQRT2 * 5, 9);
    expect(regionsArea([ribBand(chain, 4, "both")])).toBeCloseTo(40 * Math.SQRT2 * 4, 9);
    expect(regionsArea([ribBand(chain, 4, "left")])).toBeCloseTo(40 * Math.SQRT2 * 4, 9);
  });
});

describe("rib: validation", () => {
  const bad = (f: Raw) => errorsOf(doc(...BRACKET, gusset([10, 50], [50, 10]), { id: "rib", op: "rib", sketch: "g", ...f }));
  it("needs a sketch and a thickness; side is both, left or right", () => {
    expect(bad({ thickness: 4 })).toEqual([]);
    expect(bad({})).toEqual(["rib: thickness: must be a number (got nothing)"]);
    expect(bad({ thickness: 4, side: "middle" })[0]).toMatch(/^rib: side: /);
    expect(bad({ thickness: 4, height: 3 })).toEqual(['rib: unknown field "height" (allowed: id, op, sketch, thickness, side, normal, flip, body)']);
    expect(errorsOf(doc(gusset([10, 50], [50, 10]), { id: "rib", op: "rib", sketch: "g", thickness: 4 }))).toEqual([
      "rib: sketch: there is no body before the rib to stiffen: a rib reaches out to a body's walls",
    ]);
  });
});

describe("rib: in the sketch's plane (a gusset)", () => {
  it("fills the bracket's inside corner: the 40 x 40 triangle (area 800) x 4 thick", () => {
    const b = built(doc(...BRACKET, gusset([10, 50], [50, 10]), { id: "rib", op: "rib", sketch: "g", thickness: 4 }));
    expect(b.errors).toEqual([]);
    expect(b.bodies).toEqual(["main"]);
    expect(b.volume).toBeCloseTo(BRACKET_V + 800 * 4, 6);
  });

  it("reaches the walls when the line stops short of them", () => {
    const b = built(doc(...BRACKET, gusset([20, 40], [40, 20]), { id: "rib", op: "rib", sketch: "g", thickness: 4 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(BRACKET_V + 800 * 4, 6);
  });

  it("puts the thickness on one side of the plane: left and right ribs side by side add twice", () => {
    for (const side of ["left", "right"]) {
      expect(built(doc(...BRACKET, gusset([10, 50], [50, 10]), { id: "rib", op: "rib", sketch: "g", thickness: 4, side })).volume).toBeCloseTo(BRACKET_V + 3200, 6);
    }
    const both = built(
      doc(...BRACKET, gusset([10, 50], [50, 10]), { id: "rib", op: "rib", sketch: "g", thickness: 4, side: "left" }, { id: "rib2", op: "rib", sketch: "g", thickness: 4, side: "right" }),
    );
    expect(both.errors).toEqual([]);
    expect(both.volume).toBeCloseTo(BRACKET_V + 6400, 6);
  });

  it("flip takes the other side, and says when nothing stops the rib there; a line out in the open is refused", () => {
    expect(built(doc(...BRACKET, gusset([10, 50], [50, 10]), { id: "rib", op: "rib", sketch: "g", thickness: 4, flip: true })).errors).toEqual([
      "rib: flip: left of the line the rib runs on past the body without meeting a wall; leave out flip to reach right of the line",
    ]);
    expect(built(doc(...BRACKET, gusset([70, 70], [90, 90]), { id: "rib", op: "rib", sketch: "g", thickness: 4 })).errors[0]).toMatch(/^rib: the rib meets nothing to stop at: /);
  });

  it("refuses a closed sketch", () => {
    const ring = sketch("g", MID, [{ id: "c", type: "circle", center: [30, 30], radius: 5 }]);
    expect(built(doc(...BRACKET, ring, { id: "rib", op: "rib", sketch: "g", thickness: 4 })).errors).toEqual(['rib: sketch "g": "c" is a closed shape: a rib needs an open chain of lines and arcs']);
  });
});

describe("rib: straight out of the sketch (a stiffener)", () => {
  // A tray: a 100 x 60 x 30 box shelled from its top, 5 mm walls and floor: the pocket is 90 x 50, 25 deep.
  const TRAY = [
    sketch("b", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, [{ id: "r", type: "rect", center: [0, 0], w: 100, h: 60 }]),
    { id: "box", op: "extrude", sketch: "b", distance: 30 },
    { id: "shell", op: "shell", faces: [{ type: "planar", normal: [0, 0, 1], pick: "largest" }], thickness: 5 },
  ];
  const TRAY_V = 100 * 60 * 30 - 90 * 50 * 25;
  const rim = (a: [number, number], b: [number, number]) => sketch("g", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 30] }, [{ id: "g1", type: "line", start: a, end: b }]);

  it("stands from the rim down to the floor, wall to wall: 25 x 50 x 4", () => {
    const b = built(doc(...TRAY, rim([0, -20], [0, 20]), { id: "rib", op: "rib", sketch: "g", thickness: 4, normal: true }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(TRAY_V + 25 * 50 * 4, 6);
    // On one side of the line (it runs up +Y: left is -X).
    const left = built(doc(...TRAY, rim([10, -20], [10, 20]), { id: "rib", op: "rib", sketch: "g", thickness: 4, normal: true, side: "left" }));
    expect(left.volume).toBeCloseTo(TRAY_V + 25 * 50 * 4, 6);
  });

  it("an L-shaped stiffener of two lines, wall to wall round a corner", () => {
    // From the -X wall along y = 0 to x = 20, then along x = 20 to the +Y wall: 65 + 25 long on the centre line, mitred.
    const b = built(
      doc(
        ...TRAY,
        sketch("g", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 30] }, [
          { id: "g1", type: "line", start: [-30, 0], end: [20, 0] },
          { id: "g2", type: "line", start: [20, 0], end: [20, 15] },
        ]),
        { id: "rib", op: "rib", sketch: "g", thickness: 2, normal: true },
      ),
    );
    expect(b.errors).toEqual([]);
    // The band: x from -45 to 20 along y = 0 (2 wide) and y from 0 to 25 along x = 20, mitred at the corner: (65 + 25) x 2, 25 deep.
    expect(b.volume).toBeCloseTo(TRAY_V + (65 + 25) * 2 * 25, 6);
  });
});
