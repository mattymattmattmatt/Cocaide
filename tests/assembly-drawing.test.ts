// An assembly drawn: a base plate, a pillow block on its tapped holes and two
// bolts in the block's counterbores, exploded from the mates (the block up off
// the plate, the bolts up out of the block and further), then put on two
// sheets — the assembly's front, top and right, and its exploded iso with
// explode lines, the parts list and a balloon per item — and checked.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { heroCommands, planAssemblySheet, sheetCommands } from "../src/drafting/assemblyPlan";
import { viewSpecs } from "../src/drafting/specs";
import { detailState } from "../src/ask/detail/execute";
import { assemblyBom } from "../src/assembly/bom";
import { AgentSession } from "../src/agent/session";
import { loadOC } from "../src/kernel";

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
  dir = mkdtempSync(join(tmpdir(), "cocaide-asm-draw-"));
  for (const d of [plate, block, bolt]) writeFileSync(join(dir, `${d.name}.cocaide.json`), JSON.stringify(d));
}, 120_000);

type R = Record<string, any>;

describe("an assembly drawing", () => {
  it("explodes from the mates and draws the views, the parts list, balloons and explode lines", async () => {
    const s = await AgentSession.open({ doc: plate, docPath: join(dir, "baseplate.cocaide.json"), outDir: dir });
    const call = async (tool: string, a: Record<string, unknown> = {}) => (await s.call(tool, a)).result as R;
    const run = async (cmds: { type: string }[]) => {
      for (const c of cmds) {
        const { type, ...rest } = c as R;
        expect(await call(type, rest)).toMatchObject({ ok: true });
      }
    };
    await call("insertComponent", { part: "self" });
    await call("insertComponent", { part: { file: "pillow-block.cocaide.json" }, at: [100, 100, 100] });
    await call("insertComponent", { part: { file: "bolt-m8.cocaide.json" }, at: [100, -100, 200] });
    await call("insertComponent", { part: "bolt-m8", at: [300, -100, 200] });
    for (const [a, b] of [["baseplate-1", "pillow-block-1"], ["pillow-block-1", "bolt-m8-1"], ["pillow-block-1", "bolt-m8-2"]]) {
      const sg = await call("suggestMates", { a, b });
      for (const m of sg.suggestions[0].mates) expect(await call("addMate", m)).toMatchObject({ ok: true });
    }
    // Exploded from the mates: the block straight up off the plate, each bolt up out of its counterbore, further.
    const ex = await call("explodeAssembly");
    const move = (id: string) => (ex.explode as { components: string[]; move: number[] }[]).find((x) => x.components.includes(id))!.move;
    expect(move("pillow-block-1")[2]).toBeGreaterThan(50);
    expect(move("bolt-m8-1")[2]).toBeGreaterThan(move("pillow-block-1")[2] + 30);
    expect(move("bolt-m8-1").slice(0, 2).map((x) => Math.abs(x))).toEqual([0, 0]);

    await call("newDrawing");
    const doc = (s as unknown as { doc: R }).doc;
    const first = doc.drawing.sheets[0];
    const plan = planAssemblySheet(doc.drawing, first.format, first.projection, assemblyBom(doc), true, "pillow block assembly");
    for (const sh of plan.sheets) await run(sheetCommands(sh));
    await run([{ type: "fitViews", sheet: plan.sheets[0].id } as { type: string }]);
    const inspector = (s as unknown as { inspector: Parameters<typeof detailState>[1] }).inspector;
    const g = await inspector.project((s as unknown as { doc: R }).doc as never, viewSpecs((s as unknown as { doc: R }).doc.drawing));
    await run(heroCommands(plan.sheets[1], g!.views.find((x) => x.id === plan.iso), 3));

    // The exploded view: every part drawn, its explode lines (block, two bolts).
    const st = await detailState((s as unknown as { doc: R }).doc as never, inspector, { sheet: plan.sheets[1].id });
    const pv = st.geometry!.views.find((x) => x.id === plan.iso)!;
    expect(new Set(pv.edges.map((e) => e.body))).toEqual(new Set(["baseplate-1", "pillow-block-1", "bolt-m8-1", "bolt-m8-2"]));
    expect(pv.trails).toHaveLength(3);
    // The parts list: one row per part, the bolts two; the balloons read 1, 2, 3; the title block weighs it all.
    const texts = st.sheet!.prims.filter((p) => p.k === "text").map((p) => (p as { text: string }).text);
    for (const t of ["PARTS LIST", "baseplate", "pillow-block", "bolt-m8", "EXPLODED VIEW", "see parts list"]) expect(texts).toContain(t);
    const balloons = st.sheet!.annotations.filter((a) => a.type === "balloon");
    expect(balloons.map((a) => a.item).sort()).toEqual([1, 2, 3]);
    expect(balloons.every((a) => !a.problem)).toBe(true);
    // The assembly's views sheet: front, top, right of the assembly, laid out without overlaps.
    const check = await call("checkDrawing");
    expect(check.findings.filter((f: string) => /overlap|runs off|shows nothing/.test(f))).toEqual([]);

    // Projected again with nothing changed: the assembly's views come from the cache, as they were, with the parts' info.
    const specs = () => viewSpecs((s as unknown as { doc: R }).doc.drawing);
    const now = () => (s as unknown as { doc: R }).doc as never;
    const g1 = (await inspector.project(now(), specs()))!;
    const g2 = (await inspector.project(now(), specs()))!;
    const iso = (g: typeof g1) => g.views.find((x) => x.id === plan.iso)!;
    expect(iso(g2).edges).toBe(iso(g1).edges);
    expect(g2.assemblyParts).toEqual(g1.assemblyParts);
    // A component hidden: the views are projected again without it.
    expect(await call("setComponent", { id: "bolt-m8-2", patch: { hidden: true } })).toMatchObject({ ok: true });
    const g3 = (await inspector.project(now(), specs()))!;
    expect(new Set(iso(g3).edges.map((e) => e.body)).has("bolt-m8-2")).toBe(false);
  }, 600_000);
});
