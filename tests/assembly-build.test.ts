// Parts of several kinds assembled through the AI's tools, as a user would:
// a welded frame (the table-frame example, smaller), a base plate with M8
// tapped and clearance holes, a pillow block (a boss and a web on a base, a
// bore, two counterbored bolt holes either side of the web) and an M8 bolt.
// What it checks is what went wrong before: the plate laid on the frame's
// side, holes matched one by one rather than as a pattern, tapped holes not
// taken for a bolt's, placed parts dragged when a new one is mated, a bolt's
// head on top of the block rather than in its counterbore, overlaps reported
// for touching faces and for bolts in their tapped holes.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { loadOC } from "../src/kernel";

const tf = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
const frame = { ...tf, name: "frame", parameters: { frame_w: 400, frame_d: 300, frame_h: 350 } };
const plate = { version: 1, units: "mm", name: "baseplate", features: [
  { id: "sk", op: "sketch", plane: { type: "datum", normal: [0,0,1], origin: [0,0,0] }, entities: [{ id: "r", type: "rect", center: [200,150], w: 400, h: 300 }] },
  { id: "ext", op: "extrude", sketch: "sk", distance: 10 },
  { id: "h_block", op: "hole", face: { type: "planar", normal: [0,0,1], pick: "largest" }, centers: [[150,150],[250,150]], size: "M8", kind: "tapped", depth: "through" },
  { id: "h_corner", op: "hole", face: { type: "planar", normal: [0,0,1], pick: "largest" }, centers: [[20,20],[380,20],[380,280],[20,280]], size: "M8", depth: "through" },
] };
const block = { version: 1, units: "mm", name: "pillow-block", features: [
  { id: "sk_base", op: "sketch", plane: { type: "datum", normal: [0,0,1], origin: [0,0,0] }, entities: [{ id: "r", type: "rect", center: [0,0], w: 140, h: 40 }] },
  { id: "base", op: "extrude", sketch: "sk_base", distance: 15 },
  { id: "sk_boss", op: "sketch", plane: { type: "datum", normal: [0,-1,0], origin: [0,20,0] }, entities: [{ id: "c", type: "circle", center: [0,50], radius: 30 }] },
  { id: "boss", op: "extrude", sketch: "sk_boss", distance: 40 },
  { id: "sk_web", op: "sketch", plane: { type: "datum", normal: [0,-1,0], origin: [0,20,0] }, entities: [{ id: "w", type: "rect", center: [0,32], w: 60, h: 36 }] },
  { id: "web", op: "extrude", sketch: "sk_web", distance: 40 },
  { id: "bore", op: "hole", face: { type: "planar", normal: [0,-1,0], pick: "largest" }, center: [0,50], diameter: 25, depth: "through" },
  { id: "bolts", op: "hole", face: { type: "planar", normal: [0,0,1], pick: "nearest", near: [50,0,15] }, centers: [[-50,0],[50,0]], size: "M8", kind: "counterbore", depth: "through" },
] };
const bolt = { version: 1, units: "mm", name: "bolt-m8", features: [
  { id: "sk1", op: "sketch", plane: { type: "datum", normal: [0,0,1], origin: [0,0,-30] }, entities: [{ id: "c", type: "circle", center: [0,0], radius: 4 }] },
  { id: "e1", op: "extrude", sketch: "sk1", distance: 30 },
  { id: "sk2", op: "sketch", plane: { type: "datum", normal: [0,0,1], origin: [0,0,0] }, entities: [{ id: "c", type: "circle", center: [0,0], radius: 6.5 }] },
  { id: "e2", op: "extrude", sketch: "sk2", distance: 8 },
] };

let dir: string;
beforeAll(async () => {
  await loadOC();
  dir = mkdtempSync(join(tmpdir(), "cocaide-asm-build-"));
  for (const d of [frame, plate, block, bolt]) writeFileSync(join(dir, `${d.name}.cocaide.json`), JSON.stringify(d));
}, 120_000);

type R = Record<string, any>;
type Mate = { type: string; a: unknown; b: unknown };

describe("a welded frame, a plate, a pillow block and bolts, assembled by the AI's tools", () => {
  it("lays the plate on the frame's top, the block on its tapped holes as a pattern, a bolt in the counterbore, and copies a bolt to the corner holes", async () => {
    const s = await AgentSession.open({ doc: frame, docPath: join(dir, "frame.cocaide.json"), outDir: dir });
    const call = async (tool: string, a: Record<string, unknown> = {}) => (await s.call(tool, a)).result as R;
    const place = async (id: string) => ((await call("assembly")).components as R[]).find((k) => k.id === id)!;
    const apply = async (mates: Mate[]) => {
      for (const m of mates) expect(await call("addMate", m as R)).toMatchObject({ ok: true });
    };
    await call("insertComponent", { part: "self" });
    await call("insertComponent", { part: { file: "baseplate.cocaide.json" }, at: [0, 0, 500] });
    await call("insertComponent", { part: { file: "pillow-block.cocaide.json" }, at: [100, 100, 700] });
    await call("insertComponent", { part: { file: "bolt-m8.cocaide.json" }, at: [0, -200, 800] });

    // The plate is above the frame: the frame's top (a rail's top face, +Z) meets the plate's underside, not the biggest
    // face (a rail's side) — the plate lands flat on the frame.
    const s1 = await call("suggestMates", { a: "frame-1", b: "baseplate-1" });
    expect(s1.suggestions[0].mates[0].a.face.normal).toEqual([0, 0, 1]);
    await apply(s1.suggestions[0].mates);
    expect(await place("baseplate-1")).toMatchObject({ at: [0, 0, 350], rotation: [0, 0, 0] });

    // The block's two Ø9 holes match the plate's two M8 tapped holes, 100 apart: a pattern, held by two concentrics.
    const s2 = await call("suggestMates", { a: "baseplate-1", b: "pillow-block-1" });
    expect(s2.suggestions[0].what).toMatch(/2 M8 tapped and pillow-block-1's 2 Ø9 holes in line as a pattern/);
    expect(s2.suggestions[0].mates.map((m: Mate) => m.type)).toEqual(["concentric", "coincident", "concentric"]);
    await apply(s2.suggestions[0].mates);
    // The plate, placed already, stays put; the block comes to it.
    expect((await place("baseplate-1")).at).toEqual([0, 0, 350]);
    const pb = await place("pillow-block-1");
    expect(pb.at[2]).toBeCloseTo(360, 4);
    expect([150, 250].some((x) => Math.abs(pb.roughly.min[0] + 70 - x) < 1e-3 || Math.abs(pb.roughly.max[0] - 70 - x) < 1e-3) || Math.abs((pb.roughly.min[0] + pb.roughly.max[0]) / 2 - 200) < 1e-3).toBe(true);

    // A bolt in the block's counterbore: its head (no shoulder) sits on the counterbore's floor, 6.4 under the top.
    const s3 = await call("suggestMates", { a: "pillow-block-1", b: "bolt-m8-1" });
    await apply(s3.suggestions[0].mates);
    expect((await place("bolt-m8-1")).at[2]).toBeCloseTo(360 + 15 - 8.6, 3);

    // A bolt in one of the plate's corner holes, copied to the other three.
    await call("insertComponent", { part: "bolt-m8", at: [0, 0, 600] });
    const s4 = await call("suggestMates", { a: "baseplate-1", b: "bolt-m8-2" });
    expect(s4.suggestions[0].what).toMatch(/Ø8 boss into baseplate-1's Ø9 hole/);
    await apply(s4.suggestions[0].mates);
    const copied = await call("copyToHoles", { id: "bolt-m8-2" });
    expect(copied).toMatchObject({ ok: true, copies: ["bolt-m8-3", "bolt-m8-4", "bolt-m8-5"] });

    // The check: every mate holds; the bolts through the 10 mm plate run into the frame's rails (a real clash), and none
    // is reported for nothing.
    const check = await call("checkAssembly");
    expect(check.mates.every((m: R) => m.holds)).toBe(true);
    expect(check.issues.some((x: string) => /frame-1 and bolt-m8-\d overlap/.test(x))).toBe(true);
    expect(check.issues.every((x: string) => !/ 0 mm³/.test(x))).toBe(true);
  }, 600_000);

  it("calls a bolt in its tapped hole expected, not a clash", async () => {
    const s = await AgentSession.open({ doc: plate, docPath: join(dir, "baseplate.cocaide.json"), outDir: dir });
    const call = async (tool: string, a: Record<string, unknown> = {}) => (await s.call(tool, a)).result as R;
    await call("insertComponent", { part: "self" });
    await call("insertComponent", { part: { file: "bolt-m8.cocaide.json" }, at: [150, 150, 40] });
    const sug = await call("suggestMates", { a: "baseplate-1", b: "bolt-m8-1" });
    expect(sug.suggestions[0].what).toMatch(/into baseplate-1's M8 tapped hole/);
    for (const m of sug.suggestions[0].mates) expect(await call("addMate", m)).toMatchObject({ ok: true });
    const check = await call("checkAssembly");
    expect(check.issues).toEqual([]);
    expect(check.interference).toEqual([expect.objectContaining({ components: ["baseplate-1", "bolt-m8-1"], expected: expect.stringMatching(/tapped hole/) })]);
  }, 600_000);
});
