// The AI assembling, through the agent session's tools (what the bridge
// serves): the bracket and a pin (a part file, then the same pin as a STEP
// file), the pin's shaft found to fit the bracket's hole (suggestMates), mated
// concentric and seated on the plate, checked (the pin can still turn about
// its axis, nothing overlaps), a bad mate refused, and the assembly's STEP.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { getOC, loadOC, rebuild } from "../src/kernel";
import { exportSTEP } from "../src/kernel/step";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8"));
// A pin: a Ø6.6 shaft 20 long under a Ø10 × 3 head, its axis Z, the head's underside at z = 0.
const pin = {
  version: 1,
  units: "mm",
  name: "pin",
  features: [
    { id: "sk_shaft", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, -20] }, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 3.3 }] },
    { id: "shaft", op: "extrude", sketch: "sk_shaft", distance: 20 },
    { id: "sk_head", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 5 }] },
    { id: "head", op: "extrude", sketch: "sk_head", distance: 3 },
  ],
};

let dir: string;
beforeAll(async () => {
  await loadOC();
  dir = mkdtempSync(join(tmpdir(), "cocaide-asm-ai-"));
  writeFileSync(join(dir, "pin.cocaide.json"), JSON.stringify(pin));
  const r = rebuild(pin, getOC());
  try {
    writeFileSync(join(dir, "pin.step"), exportSTEP(getOC(), r.solid!, "pin"));
  } finally {
    r.dispose();
  }
}, 120_000);

type R = Record<string, unknown> & { ok: boolean; error?: string };
async function open() {
  const s = await AgentSession.open({ doc: bracket, docPath: join(dir, "bracket.cocaide.json"), outDir: dir });
  const call = async (tool: string, a: Record<string, unknown> = {}) => (await s.call(tool, a)).result as R;
  return { s, call };
}

describe("the AI assembling", () => {
  for (const file of ["pin.cocaide.json", "pin.step"]) {
    it(`puts ${file === "pin.step" ? "a STEP pin" : "a pin"} in the bracket's hole: found, mated, checked, exported`, async () => {
      const { s, call } = await open();
      expect(await call("insertComponent", { part: "self" })).toMatchObject({ ok: true, inserted: "bracket-1" });
      const ins = await call("insertComponent", { part: { file }, at: [100, 50, 40], rotation: [90, 0, 0] });
      expect(ins).toMatchObject({ ok: true });
      const pinId = ins.inserted as string;
      // What can be mated on the pin: its shaft and head are bosses.
      const feats = (await call("mateFeatures", { component: pinId, kind: "round" })) as R & { features: { kind: string; diameter: number }[] };
      expect(feats.features.map((f) => [f.kind, f.diameter])).toEqual(expect.arrayContaining([["boss", 6.6], ["boss", 10]]));
      // The shaft fits the bracket's Ø6.6 hole: the best suggestion.
      const sug = (await call("suggestMates", { a: "bracket-1", b: pinId })) as R & { suggestions: { what: string; mates: { type: string; a: unknown; b: unknown; aligned?: boolean }[] }[] };
      expect(sug.suggestions[0].what).toMatch(/Ø6\.6 boss into bracket-1's Ø6\.6 hole/);
      expect(sug.suggestions[0].mates.map((m) => m.type)).toEqual(["concentric", "coincident"]);
      for (const m of sug.suggestions[0].mates) expect(await call("addMate", m)).toMatchObject({ ok: true, solved: true });
      // Seated: the pin's axis is the hole's (x 30, y 0), its head's underside on the plate's top (z 6).
      const asm = (await call("assembly")) as R & { components: { id: string; roughly?: { min: number[]; max: number[] } }[]; solved: boolean };
      expect(asm.solved).toBe(true);
      const box = asm.components.find((k) => k.id === pinId)!.roughly!;
      expect((box.min[0] + box.max[0]) / 2).toBeCloseTo(30, 3);
      expect((box.min[1] + box.max[1]) / 2).toBeCloseTo(0, 3);
      // The check: every mate holds, the pin can still turn about its own axis (that's right), nothing overlaps.
      const check = (await call("checkAssembly")) as R & { issues: string[]; freedom: { id: string; free: number; canStill?: string[] }[] };
      expect(check.issues).toEqual([]);
      const free = check.freedom.find((f) => f.id === pinId)!;
      expect(free.free).toBe(1);
      expect(free.canStill![0]).toMatch(/^turn about an axis along \[0, 0, -?1\] through \[30, 0, /);
      // A mate that can't be (a flat face concentric with a hole) is refused, and nothing changes.
      const before = await call("assembly");
      const bad = await call("addMate", { type: "concentric", a: { component: "bracket-1", face: { type: "planar", normal: [0, 0, 1], pick: "largest" } }, b: (sug.suggestions[0].mates[0] as { b: unknown }).b });
      expect(bad).toMatchObject({ ok: false });
      expect(bad.error).toMatch(/concentric takes two axes/);
      expect(await call("assembly")).toEqual(before);
      // The assembly as STEP: both, named.
      const out = await call("exportAssemblySTEP");
      expect(out).toMatchObject({ ok: true, components: 2 });
      const step = readFileSync(out.file as string, "utf8");
      expect(step).toContain("'bracket-1'");
      expect(step).toContain(`'${pinId}'`);
      s.close();
    }, 240_000);
  }

  it("tells what is missing: a component held by nothing, two that overlap", async () => {
    const { s, call } = await open();
    await call("insertComponent", { part: "self" });
    await call("insertComponent", { part: "self", at: [10, 0, 0] });
    const check = (await call("checkAssembly")) as R & { issues: string[] };
    expect(check.issues).toEqual(expect.arrayContaining(["bracket-2 is held by nothing: mate it, or fix it", expect.stringMatching(/^bracket-1 and bracket-2 overlap by [\d.]+ mm³$/)]));
    s.close();
  }, 120_000);

  it("inserts an example part, and says what parts and examples there are", async () => {
    const { s, call } = await open();
    expect(await call("insertComponent", { part: { example: "flange" } })).toMatchObject({ ok: true, inserted: "flange-1", part: "flange" });
    expect(await call("insertComponent", { part: { example: "nope" } })).toMatchObject({ ok: false, error: expect.stringMatching(/no example "nope" \(examples: .*bracket.*flange/) });
    expect(await call("insertComponent", { part: "flange" })).toMatchObject({ ok: true, inserted: "flange-2" });
    const a = (await call("assembly")) as R & { parts: { key: string }[] };
    expect(a.parts.map((p) => p.key)).toEqual(["self", "flange"]);
    s.close();
  }, 120_000);
});

describe("the AI assembling several parts on the mounting plate", () => {
  it("two pins go into two holes (the nearest free one each), on top of the plate beside a countersink or in a counterbore; the flange sits on top; nothing overlaps", async () => {
    const pinFile = join(dir, "pin64.cocaide.json");
    writeFileSync(pinFile, JSON.stringify({ ...pin, name: "pin", features: pin.features.map((f) => (f.id === "sk_shaft" ? { ...f, plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, -12] }, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 3.2 }] } : f.id === "shaft" ? { ...f, distance: 12 } : f)) }));
    const s = await AgentSession.open({ doc: { version: 1, units: "mm", name: "fixture", features: [] }, docPath: join(dir, "fixture.cocaide.json"), outDir: dir });
    const call = async (tool: string, a: Record<string, unknown> = {}) => (await s.call(tool, a)).result as R;
    const insert = await call("insertComponent", { part: { example: "mounting-plate" } });
    // A document that is only an assembly: no "no solid" noise.
    expect(insert.errors).toBeUndefined();
    await call("insertComponent", { part: { example: "flange" }, at: [0, 0, 60] });
    await call("insertComponent", { part: { file: "pin64.cocaide.json" }, at: [-40, -20, 40] });
    await call("insertComponent", { part: "pin", at: [40, 20, 40] });
    const apply = async (a: string, b: string) => {
      const sg = (await call("suggestMates", { a, b })) as R & { suggestions: { mates: Record<string, unknown>[] }[] };
      for (const m of sg.suggestions[0].mates) expect(await call("addMate", m)).toMatchObject({ ok: true });
    };
    await apply("mounting-plate-1", "flange-1");
    await apply("mounting-plate-1", "pin-1");
    await apply("mounting-plate-1", "pin-2");
    const asm = (await call("assembly")) as R & { components: { id: string; roughly: { min: number[]; max: number[] } }[] };
    const box = (id: string) => asm.components.find((k) => k.id === id)!.roughly;
    const where = (id: string) => [Math.round((box(id).min[0] + box(id).max[0]) / 2), Math.round((box(id).min[1] + box(id).max[1]) / 2)];
    expect(where("pin-1")).not.toEqual(where("pin-2"));
    // Nothing went under the plate (its underside is z = 0): the flange and the pins' heads are above it.
    for (const id of ["flange-1", "pin-1", "pin-2"]) expect(box(id).max[2]).toBeGreaterThan(4);
    expect(box("flange-1").min[2]).toBeGreaterThanOrEqual(8 - 1e-6);
    const check = (await call("checkAssembly")) as R & { issues: string[] };
    expect(check.issues).toEqual([]);
    s.close();
  }, 240_000);
});
