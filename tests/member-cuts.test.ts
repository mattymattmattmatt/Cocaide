// A member end cut on a plane or a flat face (cutStart / cutEnd): a stringer's
// foot level on the floor and its head plumb against a trimmer, built through
// the real kernel; validated, refused where the plane runs along the member.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, type OC } from "../src/kernel";

const table = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

/** A 40x40 member rising 700 over 1000, its ends cut as given; a plane at x = 1000 to cut on. */
function stringer(cuts: Record<string, unknown>) {
  return {
    version: 1,
    units: "mm",
    name: "stringer",
    profiles: structuredClone(table.profiles),
    features: [
      { id: "head", op: "plane", mode: "parallelThroughPoint", refs: [{ datum: "Right" }, { point: [1000, 0, 0] }] },
      { id: "s1", op: "member", profile: "SHS", size: "SHS 40x40x3", from: [0, 0, 0], to: [1000, 0, 700], ...cuts },
    ],
  };
}

function built(doc: unknown) {
  const b = rebuild(doc, oc);
  try {
    return { errors: b.errors, box: b.measurements?.boundingBox, member: b.measurements?.members?.[0] };
  } finally {
    b.dispose();
  }
}

describe("a member end cut on a plane", () => {
  it("as drawn, its square ends stick out past the floor and the head plane", () => {
    const r = built(stringer({}));
    expect(r.errors).toEqual([]);
    expect(r.box!.min[2]).toBeLessThan(-10);
    expect(r.box!.max[0]).toBeGreaterThan(1010);
  });

  it("foot level on the floor (Top) and head plumb on a plane feature: flat on both, the angles in the cut list", () => {
    const r = built(stringer({ cutStart: { to: { datum: "Top" } }, cutEnd: { to: { datum: "head" } } }));
    expect(r.errors).toEqual([]);
    expect(r.box!.min[2]).toBeCloseTo(0, 6);
    expect(r.box!.max[0]).toBeCloseTo(1000, 6);
    // 35° from square at each end: atan(700 / 1000) at the foot, its complement measured the same way at the head.
    const slope = (Math.atan2(700, 1000) * 180) / Math.PI;
    expect(r.member!.angles.map((a: number) => Math.round(a * 10) / 10).sort()).toEqual([Math.round((90 - slope) * 10) / 10, Math.round(slope * 10) / 10].sort());
  });

  it("an offset leaves a gap: the foot 10 above the floor", () => {
    const r = built(stringer({ cutStart: { to: { datum: "Top" }, offset: 10 } }));
    expect(r.errors).toEqual([]);
    expect(r.box!.min[2]).toBeCloseTo(10, 6);
  });

  it("cuts on a flat face of a body made before it", () => {
    const doc = stringer({ cutStart: { to: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } } });
    doc.features.unshift(
      { id: "floor_sk", op: "sketch", plane: { type: "ref", ref: { datum: "Top" }, offset: -100 }, entities: [{ id: "r", type: "rect", center: [500, 0], w: 1600, h: 400 }] } as never,
      { id: "floor", op: "extrude", sketch: "floor_sk", distance: 150, newBody: "floor" } as never,
    );
    const r = built(doc);
    expect(r.errors).toEqual([]);
    expect(r.member!.length).toBeGreaterThan(0);
    expect(r.box!.min[2]).toBeCloseTo(-100, 6); // the floor's own underside; the member stands on its top at 50
  });

  it("is refused, saying why, on a plane along the member, and validated", () => {
    expect(built(stringer({ cutStart: { to: { datum: "Front" } } })).errors.join(" ")).toMatch(/cutStart: .*runs along the member/);
    const bad = validateDocument(stringer({ cutEnd: { offset: 3 } }));
    expect(allErrors(bad).join(" ")).toMatch(/cutEnd\.to: needed/);
    const typo = validateDocument(stringer({ cutEnd: { to: { datum: "Top" }, gap: 3 } }));
    expect(allErrors(typo).join(" ")).toMatch(/gap/);
  });
});
