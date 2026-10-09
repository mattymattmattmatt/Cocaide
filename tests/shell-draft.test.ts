// shell and draft (Phase O wave 2, DESIGN §2.6): a body hollowed to a wall
// thickness (faces removed, or closed), inward or outward; faces tapered about
// a neutral plane. Expected volumes are boxes and frustums worked out by hand.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { wallsMessage } from "../src/features/shell/kernel";
import { loadOC, rebuild, type OC } from "../src/kernel";

type Raw = Record<string, unknown>;
const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const stand = example("stand"); // base 120 x 80 x 8 (two 10 mm holes); upright 120 x 8 x 60, a body of its own
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));

/** A 20 x 20 box on Top, centred on the origin, `h` tall (z = 0..h), then the features. */
const box = (h: number, ...features: Raw[]): RawDocument => ({
  version: 1,
  units: "mm",
  name: "box",
  features: [
    { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 20, h: 20 }], constraints: [] },
    { id: "ext_1", op: "extrude", sketch: "s1", distance: h },
    ...features,
  ],
});
const face = (normal: number[], pick = "largest") => ({ type: "planar", normal, pick });
const TOP = face([0, 0, 1]);
const SIDES = [face([1, 0, 0]), face([-1, 0, 0]), face([0, 1, 0]), face([0, -1, 0])];

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    const m = r.measurements;
    return {
      errors: r.errors,
      volume: m?.volume ?? 0,
      faces: m?.faces ?? 0,
      box: m?.boundingBox ? { min: m.boundingBox.min.map(r6), max: m.boundingBox.max.map(r6) } : null,
      bodies: Object.fromEntries((m?.bodies ?? []).map((b) => [b.name, b.volume])),
    };
  } finally {
    r.dispose();
  }
}

describe("shell: validation", () => {
  const bad = (f: Raw) => errorsOf(box(20, { id: "sh", op: "shell", ...f }));
  it("needs a wall thickness over 0; faces may be empty or left out; nothing it does not know", () => {
    expect(bad({ thickness: 2, faces: [TOP] })).toEqual([]);
    expect(bad({ thickness: 2, faces: [] })).toEqual([]);
    expect(bad({ thickness: 2 })).toEqual([]);
    expect(bad({ faces: [TOP] })).toEqual(["sh: thickness: must be a number (got nothing)"]);
    expect(bad({ thickness: -1 })).toEqual(["sh: thickness: must be greater than 0 (got -1)"]);
    expect(bad({ thickness: 2, wall: 3 })).toEqual(['sh: unknown field "wall" (allowed: id, op, faces, thickness, outward, body)']);
    expect(bad({ thickness: 2, body: "nope" })).toEqual(['sh: body: no body "nope" before this feature (bodies so far: main)']);
  });
  it("apply refuses it and says why", () => {
    expect(apply(box(20), { type: "addFeature", feature: { id: "sh", op: "shell", thickness: 0 } })).toEqual({
      ok: false,
      error: "addFeature rejected: sh: thickness: must be greater than 0 (got 0)",
    });
  });
});

describe("shell", () => {
  it("removes the top of a 20 mm box, 2 mm walls inside: 20³ - 16 x 16 x 18", () => {
    const b = built(box(20, { id: "sh", op: "shell", faces: [TOP], thickness: 2 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(20 ** 3 - 16 * 16 * 18, 6);
    expect(b.box).toEqual({ min: [-10, -10, 0], max: [10, 10, 20] });
  });

  it("removes two faces at once (each selector may pick several)", () => {
    const b = built(box(20, { id: "sh", op: "shell", faces: [TOP, face([1, 0, 0])], thickness: 2 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(20 ** 3 - 18 * 16 * 18, 6);
  });

  it("with no faces removed, a closed hollow: 20³ - 16³ inward, 24³ - 20³ outward", () => {
    const inward = built(box(20, { id: "sh", op: "shell", faces: [], thickness: 2 }));
    expect(inward.errors).toEqual([]);
    expect(inward.volume).toBeCloseTo(20 ** 3 - 16 ** 3, 6);
    expect(inward.box).toEqual({ min: [-10, -10, 0], max: [10, 10, 20] });
    const outward = built(box(20, { id: "sh", op: "shell", thickness: 2, outward: true }));
    expect(outward.errors).toEqual([]);
    expect(outward.volume).toBeCloseTo(24 ** 3 - 20 ** 3, 6);
    expect(outward.box).toEqual({ min: [-12, -12, -2], max: [12, 12, 22] });
  });

  it("outward with the top removed: the box becomes the cavity of a 24 x 24 x 22 tray", () => {
    const b = built(box(20, { id: "sh", op: "shell", faces: [TOP], thickness: 2, outward: true }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(24 * 24 * 22 - 20 ** 3, 6);
  });

  it("says how thin the walls must be when they do not fit", () => {
    expect(built(box(20, { id: "sh", op: "shell", faces: [TOP], thickness: 10 })).errors).toEqual([
      "sh: 10 mm walls do not fit: the thinnest part is 20 mm across, so the walls must be thinner than 10 mm",
    ]);
    expect(built(box(4, { id: "sh", op: "shell", faces: [], thickness: 3 })).errors).toEqual([
      "sh: 3 mm walls do not fit: the thinnest part is 4 mm across, so the walls must be thinner than 2 mm",
    ]);
  });

  it("works out the limit from opposite flat faces: half the gap where both keep a wall, all of it where one is open", () => {
    const f = (index: number, normal: number[], offset: number) => ({ index, type: "plane" as const, area: 1, centroid: [0, 0, 0] as [number, number, number], normal: normal as [number, number, number], offset });
    const faces = [f(0, [0, 0, 1], 6), f(1, [0, 0, -1], 0), f(2, [1, 0, 0], 40), f(3, [-1, 0, 0], 40)];
    expect(wallsMessage({ thickness: 3 }, faces, new Set())).toBe("3 mm walls do not fit: the thinnest part is 6 mm across, so the walls must be thinner than 3 mm");
    expect(wallsMessage({ thickness: 3 }, faces, new Set([0]))).toBe("shell failed: try a thinner wall or fewer faces");
    expect(wallsMessage({ thickness: 7 }, faces, new Set([0]))).toBe("7 mm walls do not fit: the thinnest part is 6 mm across, so the walls must be thinner than 6 mm");
    expect(wallsMessage({ thickness: 50, outward: true }, faces, new Set())).toBe("shell failed: try a thinner wall or fewer faces");
  });

  it("names a selector that picks nothing", () => {
    expect(built(box(20, { id: "sh", op: "shell", faces: [face([1, 1, 0])], thickness: 2 })).errors[0]).toMatch(/^sh: faces\[0\]: selector matched no face/);
  });

  it("in a part of several bodies: the body named, or the one its faces are on; with neither, asks which", () => {
    // The upright, 120 x 8 x 60, hollowed with 1 mm walls all round: less 118 x 6 x 58.
    const named = built({ ...stand, features: [...stand.features, { id: "sh", op: "shell", body: "upright", thickness: 1 }] });
    expect(named.errors).toEqual([]);
    expect(named.bodies.upright).toBeCloseTo(120 * 8 * 60 - 118 * 6 * 58, 6);
    const unnamed = built({ ...stand, features: [...stand.features, { id: "sh", op: "shell", thickness: 1 }] });
    expect(unnamed.errors).toEqual(['sh: the part has 2 bodies (base, upright); name the one to shell with "body"']);
    // The upright's top face (z = 68) removed: it is on the upright, so that is the body.
    const byFace = built({ ...stand, features: [...stand.features, { id: "sh", op: "shell", faces: [{ type: "planar", normal: [0, 0, 1], pick: "largest", body: "upright" }], thickness: 1 }] });
    expect(byFace.errors).toEqual([]);
    expect(byFace.bodies.upright).toBeCloseTo(120 * 8 * 60 - 118 * 6 * 59, 6);
    const wrong = built({ ...stand, features: [...stand.features, { id: "sh", op: "shell", body: "base", faces: [{ type: "planar", normal: [0, 0, 1], pick: "largest", body: "upright" }], thickness: 1 }] });
    expect(wrong.errors).toEqual(['sh: faces: the faces are on body "upright", not on "base" (the body this feature names)']);
  });
});

describe("draft: validation", () => {
  const bad = (f: Raw) => errorsOf(box(10, { id: "d", op: "draft", ...f }));
  it("needs faces, a neutral plane and an angle between 0° and 90°", () => {
    expect(bad({ faces: SIDES, neutral: { datum: "Top" }, angle: 5 })).toEqual([]);
    expect(bad({ faces: SIDES, angle: 5 })).toEqual(['d: neutral: needed: the plane the faces keep their size on, { "datum": "Top" }, a plane feature, or { "face": <flat face selector> } (the bottom face, say)']);
    expect(bad({ faces: SIDES, neutral: { datum: "Top" }, angle: 0 })).toEqual(['d: angle: must be over 0° and under 90° (got 0); to lean the faces the other way, use "flip"']);
    expect(bad({ faces: SIDES, neutral: { datum: "Top" }, angle: 90 })).toEqual(['d: angle: must be over 0° and under 90° (got 90); to lean the faces the other way, use "flip"']);
    expect(bad({ faces: SIDES, neutral: { datum: "Top" } })).toEqual(["d: angle: must be a number of degrees (got nothing)"]);
    expect(bad({ faces: SIDES, neutral: { datum: "Z" }, angle: 5 })[0]).toMatch(/^d: neutral: .*Z/);
    expect(bad({ faces: SIDES, neutral: { datum: "Top" }, angle: 5, pull: [0, 0, 1] })).toEqual(['d: unknown field "pull" (allowed: id, op, faces, neutral, angle, flip)']);
    expect(bad({ faces: [], neutral: { datum: "Top" }, angle: 5 })[0]).toMatch(/^d: faces: /);
  });
});

describe("draft", () => {
  // A 20 x 20 x 10 box, its four sides drafted 5° about z = 0: a frustum, 20 square at the bottom, 20 - 2 x 10 tan 5° at the top.
  const frustum = (bottom: number, top: number, h: number) => (h / 3) * (bottom ** 2 + top ** 2 + bottom * top);
  const narrow = 20 - 2 * 10 * Math.tan((5 * Math.PI) / 180);
  const wide = 20 + 2 * 10 * Math.tan((5 * Math.PI) / 180);

  it("tapers a box's four sides 5° about Top: the box narrows upward", () => {
    const b = built(box(10, { id: "d", op: "draft", faces: SIDES, neutral: { datum: "Top" }, angle: 5 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(frustum(20, narrow, 10), 6);
    expect(b.box).toEqual({ min: [-10, -10, 0], max: [10, 10, 10] });
  });

  it("about the bottom face (pull into the part from it), the same; flip leans the sides out", () => {
    const bottom = { face: face([0, 0, -1]) };
    expect(built(box(10, { id: "d", op: "draft", faces: SIDES, neutral: bottom, angle: 5 })).volume).toBeCloseTo(frustum(20, narrow, 10), 6);
    const out = built(box(10, { id: "d", op: "draft", faces: SIDES, neutral: { datum: "Top" }, angle: 5, flip: true }));
    expect(out.errors).toEqual([]);
    expect(out.volume).toBeCloseTo(frustum(20, wide, 10), 6);
    expect(out.box!.max[0]).toBeCloseTo(wide / 2, 6);
  });

  it("about the top face: the top keeps its size and the box narrows downward", () => {
    const b = built(box(10, { id: "d", op: "draft", faces: SIDES, neutral: { face: TOP }, angle: 5 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(frustum(20, narrow, 10), 6);
  });

  it("drafts one face: a wedge-shaped strip less, 10 x 10 tan 5° / 2 x 20", () => {
    const b = built(box(10, { id: "d", op: "draft", faces: [face([1, 0, 0])], neutral: { datum: "Top" }, angle: 5 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(4000 - ((10 * 10 * Math.tan((5 * Math.PI) / 180)) / 2) * 20, 6);
  });

  it("drafts two adjacent outer sides of a shelled box about its bottom: the cross-section is (20 - z tan 3°)²", () => {
    const t = Math.tan((3 * Math.PI) / 180);
    const doc = box(20, { id: "sh", op: "shell", faces: [TOP], thickness: 2 }, { id: "d", op: "draft", faces: [face([1, 0, 0]), face([0, -1, 0])], neutral: { face: face([0, 0, -1]) }, angle: 3 });
    const b = built(doc);
    expect(b.errors).toEqual([]);
    // ∫0^20 (20 - z t)² dz = 8000 - 8000 t + 8000 t² / 3, less the 16 x 16 x 18 cavity.
    expect(b.volume).toBeCloseTo(8000 - 8000 * t + (8000 * t * t) / 3 - 16 * 16 * 18, 6);
  });

  it("refuses a face parallel to the neutral plane: there is nothing to taper", () => {
    expect(built(box(10, { id: "d", op: "draft", faces: [TOP], neutral: { datum: "Top" }, angle: 5 })).errors).toEqual([
      "d: faces[0]: the flat face with normal +Z at [0, 0, 10] is parallel to the neutral plane: there is nothing to taper (draft the faces that run along the pull direction)",
    ]);
  });

  it("drafts faces on two bodies in each body", () => {
    // The stand's base sides along X (y = ±40) and the upright's (y = ±4), 2° about Top.
    const sides = [
      { type: "planar", normal: [0, 1, 0], pick: "all" },
      { type: "planar", normal: [0, -1, 0], pick: "all" },
    ];
    const b = built({ ...stand, features: [...stand.features, { id: "d", op: "draft", faces: sides, neutral: { datum: "Top" }, angle: 2 }] });
    expect(b.errors).toEqual([]);
    const t = Math.tan((2 * Math.PI) / 180);
    // A prism of length L whose two side faces lean in t per mm of height, from z = 0: the cross-section loses 2 x (z t) at height z.
    const lean = (L: number, z0: number, z1: number) => L * t * (z1 ** 2 - z0 ** 2);
    expect(b.bodies.base).toBeCloseTo(120 * 80 * 8 - 2 * Math.PI * 25 * 8 - lean(120, 0, 8), 4);
    expect(b.bodies.upright).toBeCloseTo(120 * 8 * 60 - lean(120, 8, 68), 6);
  });
});
