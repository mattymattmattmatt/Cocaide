// The wall frame tool: a wall's frame from its length, height and openings,
// built through the real kernel, along any direction; its numbers and its
// warnings; and the same change as commands (the agent's wallFrame).

import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { planWallFrame, wallNumbers, type WallFrameSpec } from "../src/weldment/wallFrame";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});
const empty = (): RawDocument => ({ version: 1, units: "mm", name: "walls", features: [] }) as unknown as RawDocument;
const wall: WallFrameSpec = {
  origin: [0, 0, 0], direction: 0, length: 6000, height: 2700,
  openings: [{ x0: 900, x1: 3300, sill: 900, head: 2370, name: "w1" }, { x0: 5000, x1: 5820, head: 2370, name: "d1" }],
};

function build(spec: WallFrameSpec) {
  const r = planWallFrame(empty(), spec);
  if (!r.ok) throw new Error(r.error);
  const b = rebuild(r.doc, oc);
  try {
    return { r, errors: b.errors, box: b.measurements!.boundingBox, members: b.measurements!.members };
  } finally {
    b.dispose();
  }
}

describe("a wall frame", () => {
  it("is set out as a framer would: plates broken at the door, kings and jacks, doubled lintels, sill, cripples, noggings", () => {
    const n = wallNumbers(wall);
    expect(n.warnings).toEqual([]);
    expect(n.lintels).toBe(4);
    const b = build(wall);
    expect(b.errors).toEqual([]);
    const ids = b.members.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["wall_bp0", "wall_bp1", "wall_tp_low", "wall_tp_high", "wall_king_w1_l", "wall_jack_d1_r", "wall_lintel_w1_a", "wall_lintel_w1_b", "wall_sill_w1"]));
    expect(ids.some((id: string) => id.startsWith("wall_cripple_w1_"))).toBe(true);
    expect(ids.some((id: string) => id.startsWith("wall_nog_"))).toBe(true);
    // 6000 long, 2700 high, the studs 90 deep across y with a 10 lining inside (+y).
    expect(b.box!.max[0]).toBeCloseTo(6000, 3);
    expect(b.box!.max[2]).toBeCloseTo(2700, 3);
    expect(b.box!.min[1]).toBeCloseTo(-45, 3);
    expect(b.box!.max[1]).toBeCloseTo(55, 3);
  });

  it("runs along any direction: turned 90°, along +Y, the lining on its inside (-X)", () => {
    const b = build({ ...wall, direction: 90, origin: [100, 200, 0], openings: [] });
    expect(b.errors).toEqual([]);
    expect(b.box!.min[1]).toBeCloseTo(200, 3);
    expect(b.box!.max[1]).toBeCloseTo(6200, 3);
    expect(b.box!.min[0]).toBeCloseTo(100 - 55, 3);
  });

  it("an internal wall: flat heads instead of lintels, lined both sides", () => {
    const b = build({ ...wall, loadBearing: false, openings: [{ x0: 1000, x1: 1820, head: 2100, name: "d" }] });
    expect(b.errors).toEqual([]);
    expect(b.members.some((m: { id: string }) => m.id === "wall_head_d")).toBe(true);
    expect(b.members.some((m: { id: string }) => m.id.startsWith("wall_lintel"))).toBe(false);
    expect(b.box!.min[1]).toBeCloseTo(-55, 3);
  });

  it("warns of openings that don't fit", () => {
    expect(wallNumbers({ ...wall, openings: [{ x0: 20, x1: 800, head: 2370 }] }).warnings.join(" ")).toMatch(/too near the end/);
    expect(wallNumbers({ ...wall, openings: [{ x0: 900, x1: 1800, head: 2500 }] }).warnings.join(" ")).toMatch(/above the lintel's underside/);
    expect(wallNumbers({ ...wall, openings: [{ x0: 900, x1: 1800, head: 2370 }, { x0: 1850, x1: 2500, head: 2370 }] }).warnings.join(" ")).toMatch(/too close/);
  });

  it("makes the same change as commands", () => {
    const r = planWallFrame(empty(), wall);
    if (!r.ok) throw new Error(r.error);
    let doc = empty();
    for (const c of r.commands) {
      const x = apply(doc, c);
      if (!x.ok) throw new Error(x.error);
      doc = x.doc;
    }
    expect(JSON.stringify(doc.features)).toBe(JSON.stringify(r.doc.features));
  });
});
