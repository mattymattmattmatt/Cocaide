// A written-out sketch plane's up: "yDir" sets it (x = yDir × normal); a plane whose own up points down warns.

import { beforeAll, describe, expect, it } from "vitest";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { planeFrame } from "../src/geom/frame";
import { validateDocument } from "../src/doc/validate";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const pin = (plane: Record<string, unknown>) => ({
  version: 1,
  units: "mm",
  name: "pin",
  features: [
    { id: "sk", op: "sketch", plane: { type: "datum", normal: [0, 1, 0], origin: [0, 0, 0], ...plane }, entities: [{ id: "c", type: "circle", center: [0, 50], radius: 5 }] },
    { id: "ext", op: "extrude", sketch: "sk", distance: 10 },
  ],
});

describe("a sketch plane's up", () => {
  it("yDir makes the sketch's +y that way, square to the normal", () => {
    const f = planeFrame([0, 1, 0], [0, 0, 0], undefined, [0, 0, 1]);
    expect(f.y.map((v) => v + 0)).toEqual([0, 0, 1]);
    expect(f.x.map((v) => v + 0)).toEqual([-1, 0, 0]);
    // Not quite square: the part of it square to the normal.
    expect(planeFrame([0, 0, 1], [0, 0, 0], undefined, [0, 1, 0.5]).y.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 1, 0]);
  });
  it("a plane facing +Y with no xDir or yDir warns that its up is down; with yDir it doesn't, and the circle is up", () => {
    const down = rebuild(pin({}), oc);
    const up = rebuild(pin({ yDir: [0, 0, 1] }), oc);
    try {
      expect(down.features[0].warnings?.join(" ")).toMatch(/points down.*"yDir": \[0, 0, 1\]/);
      expect(up.features[0].warnings).toBeUndefined();
      expect(up.features.every((f) => f.ok)).toBe(true);
    } finally {
      down.dispose();
      up.dispose();
    }
  });
  it("xDir and yDir together, or a yDir along the normal, are refused", () => {
    expect(JSON.stringify(validateDocument(pin({ xDir: [1, 0, 0], yDir: [0, 0, 1] })))).toMatch(/xDir or yDir, not both/);
    expect(JSON.stringify(validateDocument(pin({ yDir: [0, 1, 0] })))).toMatch(/yDir.*must not be parallel/);
  });
});
