// A single-cylinder engine with an intake manifold, as parts: what the engine test (assembly-engine.test.ts) and the
// "engine (assembly)" example are built from. Each part is drawn where it sits in the engine (X across, Y front to
// back, the front at −Y, Z up; mm), so the assembled engine puts every part back at its own origin, except the
// bolts, drawn at their own (their head's underside at Z 0). The crank is at top dead centre.

type F = Record<string, unknown>;
const r = (x: number) => Math.round(x * 1000) / 1000;
let n = 0;
const id = (p: string) => `${p}${++n}`;

/** A box from (x0, y0, z0) to (x1, y1, z1): added, or cut. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, cut = false): F[] {
  const s = id("sk");
  return [
    { id: s, op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, r(z0)] }, entities: [{ id: "r", type: "rect", center: [r((x0 + x1) / 2), r((y0 + y1) / 2)], w: r(x1 - x0), h: r(y1 - y0) }] },
    { id: id(cut ? "cut" : "ext"), op: cut ? "cut" : "extrude", sketch: s, distance: r(z1 - z0) },
  ];
}
/** A cylinder along Z: centre (x, y), radius, from z0 up to z1. */
function cylZ(x: number, y: number, rad: number, z0: number, z1: number, cut = false): F[] {
  const s = id("sk");
  return [
    { id: s, op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, r(z0)] }, entities: [{ id: "c", type: "circle", center: [r(x), r(y)], radius: rad }] },
    { id: id(cut ? "cut" : "ext"), op: cut ? "cut" : "extrude", sketch: s, distance: r(z1 - z0) },
  ];
}
/** A cylinder along Y: centre (x, z), radius, from y1 back to y0 (the sketch faces −Y at y1). */
function cylY(x: number, z: number, rad: number, y0: number, y1: number, cut = false): F[] {
  const s = id("sk");
  return [
    { id: s, op: "sketch", plane: { type: "datum", normal: [0, -1, 0], origin: [0, r(y1), 0] }, entities: [{ id: "c", type: "circle", center: [r(x), r(z)], radius: rad }] },
    { id: id(cut ? "cut" : "ext"), op: cut ? "cut" : "extrude", sketch: s, distance: r(y1 - y0) },
  ];
}
/** A rectangle in the XZ plane (centre (x, z), w across X, h up Z), from y1 back to y0. */
function slabY(x: number, z: number, w: number, h: number, y0: number, y1: number, cut = false): F[] {
  const s = id("sk");
  return [
    { id: s, op: "sketch", plane: { type: "datum", normal: [0, -1, 0], origin: [0, r(y1), 0] }, entities: [{ id: "r", type: "rect", center: [r(x), r(z)], w: r(w), h: r(h) }] },
    { id: id(cut ? "cut" : "ext"), op: cut ? "cut" : "extrude", sketch: s, distance: r(y1 - y0) },
  ];
}
/** A cylinder along X: centre (y, z), radius, from x0 to x1 (the sketch faces +X at x0). */
function cylX(y: number, z: number, rad: number, x0: number, x1: number, cut = false): F[] {
  const s = id("sk");
  return [
    { id: s, op: "sketch", plane: { type: "datum", normal: [1, 0, 0], origin: [r(x0), 0, 0], xDir: [0, 1, 0] }, entities: [{ id: "c", type: "circle", center: [r(y), r(z)], radius: rad }] },
    { id: id(cut ? "cut" : "ext"), op: cut ? "cut" : "extrude", sketch: s, distance: r(x1 - x0) },
  ];
}
const part = (name: string, description: string, color: string, finish: string, features: F[]) => ({ version: 1, units: "mm", name, properties: { description }, appearance: { color, finish }, features });

/** The crank's throw (mm), the con rod's centres, the crank's axis height. */
export const ENGINE = { throw: 25, rod: 110, crankZ: 40, pinZ: 175 };

export function engineParts() {
  n = 0;
  return {
    // The crankcase: fixed; the crank runs in its Ø20 bearing along Y.
    block: part("crankcase", "Crankcase: the fixed base; a Ø20 main bearing along Y", "#8d9095", "matte", [...box(-60, -40, 0, 60, 40, 80), ...cylY(0, ENGINE.crankZ, 10, -40, 40, true)]),
    // The cylinder: on the crankcase's top, forward of it; a Ø52 bore, two Ø8 bolt holes for the head.
    cylinder: part("cylinder", "Cylinder: Ø52 bore, two Ø8 head-bolt holes", "#c9ccd1", "satin", [
      ...box(-35, -97, 80, 35, -27, 200),
      ...cylZ(0, -62, 26, 80, 200, true),
      ...cylZ(27, -89, 4, 80, 200, true),
      ...cylZ(-27, -35, 4, 80, 200, true),
    ]),
    // The crank: its Ø20 main journal in the bearing, a web, a Ø20 crankpin 25 above the axis (top dead centre).
    crank: part("crankshaft", "Crankshaft: Ø20 journal, web, Ø20 crankpin on a 25 throw", "#4b4f56", "metallic", [
      ...cylY(0, ENGINE.crankZ, 10, -50, 45),
      ...box(-15, -55, 25, 15, -45, 75),
      ...cylY(0, ENGINE.crankZ + ENGINE.throw, 10, -72, -55),
    ]),
    // The con rod: 110 between its Ø20 big end and Ø12 small end, 8 thick.
    rod: part("con rod", "Connecting rod: 110 centres, Ø20 big end, Ø12 small end, 8 thick", "#9aa3ad", "metallic", [
      ...slabY(0, (ENGINE.crankZ + ENGINE.throw + ENGINE.pinZ) / 2, 16, ENGINE.rod, -66, -58),
      ...cylY(0, ENGINE.crankZ + ENGINE.throw, 16, -66, -58),
      ...cylY(0, ENGINE.pinZ, 12, -66, -58),
      ...cylY(0, ENGINE.crankZ + ENGINE.throw, 10, -66, -58, true),
      ...cylY(0, ENGINE.pinZ, 6, -66, -58, true),
    ]),
    // The piston: Ø50, slotted from below for the rod, a Ø12 wrist-pin hole across.
    piston: part("piston", "Piston: Ø50 × 40, slotted for the rod, Ø12 wrist-pin hole", "#dfe2e6", "metallic", [
      ...cylZ(0, -62, 25, 155, 195),
      ...box(-26, -67, 155, 26, -57, 188, true),
      ...cylY(0, ENGINE.pinZ, 6, -87, -37, true),
    ]),
    // The wrist pin, drawn from its front end back (its axis runs +Y; the rod's eye runs −Y): a concentric the other way round.
    wristPin: part("wrist pin", "Wrist pin: Ø12 × 46", "#b7bcc2", "metallic", [
      // (Facing +Y with X across, the sketch's own up is −Z.)
      { id: "skp", op: "sketch", plane: { type: "datum", normal: [0, 1, 0], origin: [0, -85, 0], xDir: [1, 0, 0] }, entities: [{ id: "c", type: "circle", center: [0, -ENGINE.pinZ], radius: 6 }] },
      { id: "pin", op: "extrude", sketch: "skp", distance: 46 },
    ]),
    // The head: a plate on the cylinder, its two bolt holes over the cylinder's.
    head: part("cylinder head", "Cylinder head: 15 plate, two Ø8 bolt holes", "#2f3237", "satin", [
      ...box(-35, -97, 200, 35, -27, 215),
      ...cylZ(27, -89, 4, 200, 215, true),
      ...cylZ(-27, -35, 4, 200, 215, true),
    ]),
    // A head bolt, drawn at its own origin: a Ø8 × 30 shank under a Ø14 × 6 head.
    bolt: part("head bolt", "Head bolt: Ø8 × 30 shank, Ø14 × 6 head", "#c0a062", "metallic", [...cylZ(0, 0, 4, -30, 0), ...cylZ(0, 0, 7, 0, 6)]),
    // The intake manifold: a flange on the cylinder's side and a Ø30 pipe out along X, bored Ø22.
    manifold: part("intake manifold", "Intake manifold: flange, Ø30 pipe bored Ø22", "#d58a3a", "satin", [
      ...box(35, -87, 120, 45, -37, 170),
      ...cylX(-62, 145, 15, 45, 105),
      ...cylX(-62, 145, 11, 35, 105, true),
    ]),
    // A stand under the pipe's end: the pipe rests on it.
    stand: part("pipe stand", "Pipe stand: the manifold's pipe rests on it", "#3f6fb5", "satin", [...box(80, -80, 0, 100, -44, 130)]),
  };
}

/** A flat face of a part by its outward normal, nearest a point on it (in the part's own frame). */
export const flat = (normal: number[], near: number[]) => ({ type: "planar", normal, pick: "nearest", near });
/** A round face of a part by its radius, nearest a point on its axis. */
export const round = (radius: number, near: number[]) => ({ type: "cylindrical", radius, pick: "nearest", near });
