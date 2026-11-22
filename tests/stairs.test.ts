// The stair tool: straight, L and U stairs by the rise and going rules, built
// through the real kernel (stringers cut level and plumb, treads housed), and
// the report's rule checks and headroom.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { planStair, stairNumbers, type StairSpec } from "../src/weldment/stairs";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});
const empty = (): RawDocument => ({ version: 1, units: "mm", name: "stairs", features: [] }) as unknown as RawDocument;
const base: StairSpec = { type: "straight", origin: [0, 0, 0], direction: 0, rise: 3079, width: 1000, going: 260 };

function build(spec: StairSpec) {
  const r = planStair(empty(), spec);
  if (!r.ok) throw new Error(r.error);
  const b = rebuild(r.doc, oc);
  try {
    return { r, errors: b.errors, box: b.measurements!.boundingBox, members: b.measurements!.members, bodies: b.bodies.length };
  } finally {
    b.dispose();
  }
}

describe("the stair's numbers", () => {
  it("takes the fewest risers under 190, and checks 2R + G, the going and the flight", () => {
    const n = stairNumbers(base);
    expect(n.risers).toBe(17);
    expect(n.riser).toBeCloseTo(181.12, 2);
    expect(n.stride).toBeCloseTo(622.2, 1);
    expect(n.warnings).toEqual([]);
    expect(stairNumbers({ ...base, going: 200 }).warnings).toEqual(["a going of 200 is under 240"]);
    expect(stairNumbers({ ...base, rise: 4000 }).warnings.join(" ")).toMatch(/flight 1 has 22 risers: at most 18/);
    expect(stairNumbers({ ...base, rise: 4000, type: "L" }).warnings).toEqual([]);
  });
});

describe("a straight stair", () => {
  it("builds: two stringers cut level on the floor and plumb at the top, 16 housed treads", () => {
    const b = build(base);
    expect(b.errors).toEqual([]);
    expect(b.members.map((m: { id: string }) => m.id).sort()).toEqual(["stair_stringer_left", "stair_stringer_right"]);
    // The feet on the floor, the heads on the plane at the top riser (16 goings on).
    expect(b.box!.min[2]).toBeCloseTo(0, 3);
    expect(b.box!.max[0]).toBeCloseTo(16 * 260, 3);
    expect(b.r.features.filter((id) => /_tread_\d+$/.test(id))).toHaveLength(16);
    // The top tread's top 16 risers up.
    expect(b.box!.max[2]).toBeGreaterThan(16 * (3079 / 17) - 1);
  });

  it("reports headroom under the floor above, and warns when the opening is short", () => {
    const ok = planStair(empty(), { ...base, above: { depth: 380, opening: 3800 } });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.report.headroom).toBeGreaterThan(2000);
    const short = planStair(empty(), { ...base, above: { depth: 380, opening: 1500 } });
    if (!short.ok) throw new Error(short.error);
    expect(short.report.headroom).toBeLessThan(2000);
    expect(short.report.warnings.join(" ")).toMatch(/headroom is \d+ over a nosing/);
  });
});

describe("turned stairs", () => {
  it("an L turning left: a landing W x W, the second flight going +Y", () => {
    const b = build({ ...base, type: "L", turn: "left", direction: 0 });
    expect(b.errors).toEqual([]);
    expect(b.r.features).toContain("stair_landing");
    expect(b.box!.max[1]).toBeGreaterThan(1000);
  });
  it("a U turning right: the second flight comes back beside the first", () => {
    const b = build({ ...base, type: "U", turn: "right", risers: true });
    expect(b.errors).toEqual([]);
    expect(b.box!.min[1]).toBeLessThan(-1500);
    expect(b.r.features.some((id) => /_riser_\d+$/.test(id))).toBe(true);
  });
});

describe("the agent's stair tool", () => {
  it("adds the stair as one undo step and returns its numbers", async () => {
    const { AgentSession } = await import("../src/agent/session");
    const s = await AgentSession.open({ doc: empty() });
    const r = (await s.call("stair", { type: "straight", origin: [0, 0, 0], direction: 90, rise: 2800, width: 900, going: 250 })) as { result: { ok: boolean; report: { risers: number; warnings: string[] } } };
    expect(r.result.ok).toBe(true);
    expect(r.result.report.risers).toBe(15);
    expect(r.result.report.warnings).toEqual([]);
    expect(((s as unknown as { doc: RawDocument }).doc.features as { id: string }[]).some((f) => f.id === "stair_stringer_left")).toBe(true);
    await s.call("undo", {});
    expect((s as unknown as { doc: RawDocument }).doc.features).toEqual([]);
  });
});
