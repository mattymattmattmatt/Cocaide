// Flat faces and plates out to DXF (Phase P, DESIGN §2.9): a planar face's
// outline in its own plane (exact lines, arcs and circles), the bodies that
// are flat plates laid flat for cutting (alike plates counted, bars and
// members left out with the reason), and the files a plates export makes
// (one DXF per plate, an overview, a cutting list) in a ZIP.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import type { RawDocument } from "../src/doc/commands";
import { buildProfile } from "../src/geom/profile";
import { readDxf, writeDxf, type DxfEntity } from "../src/io/dxf";
import { dxfToSketch } from "../src/io/dxfSketch";
import { plateFileName, plateFiles, platesCsv, platesOverview, platesSummary } from "../src/io/plates";
import { crc32, unzipStored, zipFiles } from "../src/io/zip";
import { loadOC, type OC } from "../src/kernel";
import type { FlatPlate, FlatResult } from "../src/kernel/flat";

const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket"); // 80 x 40 x 6 plate on z = 0, centred; a 6.6 hole through at [30, 0]
const stand = example("stand"); // base 120 x 80 x 8 with two 10 mm holes; upright 120 x 8 x 60 standing on it
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const round = (v: unknown): unknown => (typeof v === "number" ? r6(v) : Array.isArray(v) ? v.map(round) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v);
const of = <T extends DxfEntity["type"]>(es: DxfEntity[], type: T) => es.filter((e): e is Extract<DxfEntity, { type: T }> => e.type === type);

let oc: OC;
let kernel: LocalKernel;
beforeAll(async () => {
  oc = await loadOC();
  kernel = new LocalKernel(() => oc);
});

async function faceIndex(doc: RawDocument, normal: number[], pick: "largest" | "smallest" = "largest"): Promise<number> {
  const r = await kernel.select(doc, { type: "planar", normal, pick });
  if (!r.ok || r.kind !== "faces") throw new Error(r.ok ? "not faces" : r.error);
  return r.indices[0];
}

function plates(r: FlatResult) {
  if (r.kind !== "plates") throw new Error(r.kind === "error" ? r.error : "not plates");
  return r;
}

describe("a flat face as DXF", () => {
  it("writes the bracket's top face in its own plane: one closed outline and the hole, exact", async () => {
    const r = await kernel.flat(bracket, { kind: "face", face: await faceIndex(bracket, [0, 0, 1]) });
    if (r.kind !== "face") throw new Error(r.kind);
    // The frame a sketch on that face has: the origin dropped onto z = 6, x along X.
    expect(round(r.frame)).toEqual({ origin: [0, 0, 6], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
    expect(r.area).toBeCloseTo(80 * 40 - Math.PI * 3.3 ** 2, 6);
    const [outline] = of(r.entities, "polyline");
    expect(outline.closed).toBe(true);
    expect(outline.bulges).toBeUndefined();
    expect(new Set(outline.points.map((p) => JSON.stringify(round(p))))).toEqual(new Set(["[-40,-20]", "[40,-20]", "[40,20]", "[-40,20]"].map((s) => s)));
    expect(round(of(r.entities, "circle"))).toEqual([{ type: "circle", c: [30, 0], r: 3.3, layer: "CUT" }]);
  });

  it("keeps arcs as arcs: a rounded outline becomes one polyline with bulges", async () => {
    // A 60 x 40 plate with R8 corners: lines and quarter arcs, extruded 5.
    const doc = {
      version: 1,
      units: "mm",
      name: "rounded",
      features: [
        { id: "s", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: [{ id: "sl", type: "slot", center1: [-20, 0], center2: [20, 0], width: 30 }] },
        { id: "e", op: "extrude", sketch: "s", distance: 5 },
      ],
    };
    const r = await kernel.flat(doc, { kind: "face", face: await faceIndex(doc as RawDocument, [0, 0, -1]) });
    if (r.kind !== "face") throw new Error(r.kind);
    const [outline] = of(r.entities, "polyline");
    expect(outline.closed).toBe(true);
    // Two straight sides and two half turns (bulge ±1: seen from below, the turns run the other way).
    expect(outline.bulges!.map((b) => Math.abs(r6(b))).sort()).toEqual([0, 0, 1, 1]);
    // Written out, read back and sketched, it is the same shape: 40 x 30 and two R15 ends.
    const back = readDxf(writeDxf({ entities: r.entities }));
    const sketch = dxfToSketch(back, []);
    const p = buildProfile(sketch.entities);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.area).toBeCloseTo(40 * 30 + Math.PI * 15 ** 2, 6);
  });

  it("refuses a face that is not flat", async () => {
    const doc = { ...bracket };
    const cyl = await kernel.select(doc, { type: "cylindrical", pick: "largest" });
    if (!cyl.ok) throw new Error(cyl.error);
    expect(await kernel.flat(doc, { kind: "face", face: cyl.indices[0] })).toEqual({ kind: "error", error: "that face is not flat: pick a flat face to export it as DXF" });
  });
});

describe("plates for cutting", () => {
  it("finds both plates of the stand and lays each flat: the base with its holes, the upright on its side", async () => {
    const r = plates(await kernel.flat(stand, { kind: "plates" }));
    expect(r.others).toEqual([]);
    expect(r.plates.map((p) => ({ bodies: p.bodies, thickness: p.thickness, size: p.size, holes: p.holes }))).toEqual([
      { bodies: ["base"], thickness: 8, size: [120, 80], holes: 2 },
      { bodies: ["upright"], thickness: 8, size: [120, 60], holes: 0 },
    ]);
    const base = r.plates[0];
    expect(base.area).toBeCloseTo(120 * 80 - 2 * Math.PI * 25, 3);
    // Cut length: the outline and two Ø10 holes.
    expect(base.cutLength).toBeCloseTo(2 * (120 + 80) + 2 * Math.PI * 10, 1);
    // Laid flat at the origin.
    const box = base.entities.flatMap((e) => (e.type === "polyline" ? e.points : []));
    expect(Math.min(...box.map((p) => p[0]))).toBeCloseTo(0, 9);
    expect(Math.min(...box.map((p) => p[1]))).toBeCloseTo(0, 9);
  });

  it("counts alike plates once, with every body that is one", async () => {
    const doc = { ...stand, features: [...stand.features, { id: "copy", op: "move", bodies: ["base"], translate: [0, 0, -100], rotate: { axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, angle: 30 }, copy: true }] };
    const r = plates(await kernel.flat(doc, { kind: "plates" }));
    expect(r.plates.map((p) => p.bodies)).toEqual([["base", "base_copy"], ["upright"]]);
    expect(platesSummary(r.plates)).toBe("3 plates (3 of 8 mm)");
  });

  it("keeps plates apart that only share area and cut length: a 100 x 50 and a notched 90 x 60 are two parts", async () => {
    // Both 5000 mm² with a 300 mm cut, no holes, 6 thick: only their size tells them apart.
    const line = (id: string, start: number[], end: number[]) => ({ id, type: "line", start, end });
    const doc = {
      version: 1,
      units: "mm",
      name: "pair",
      features: [
        { id: "s1", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 100, h: 50 }] },
        { id: "e1", op: "extrude", sketch: "s1", distance: 6 },
        {
          id: "s2",
          op: "sketch",
          plane: { type: "ref", ref: { datum: "Top" } },
          entities: [line("l1", [200, 0], [290, 0]), line("l2", [290, 0], [290, 40]), line("l3", [290, 40], [270, 40]), line("l4", [270, 40], [270, 60]), line("l5", [270, 60], [200, 60]), line("l6", [200, 60], [200, 0])],
        },
        { id: "e2", op: "extrude", sketch: "s2", distance: 6, newBody: "notched" },
      ],
    };
    const r = plates(await kernel.flat(doc as RawDocument, { kind: "plates" }));
    expect(r.plates.map((p) => [p.bodies, r6(p.area), Math.round(p.cutLength)])).toEqual([
      [["main"], 5000, 300],
      [["notched"], 5000, 300],
    ]);
  });

  it("leaves out members and says why", async () => {
    const r = plates(await kernel.flat(example("frame-members"), { kind: "plates" }));
    expect(r.plates).toEqual([]);
    expect(r.others.map((o) => o.body)).toEqual(["leg", "rail"]);
    for (const o of r.others) expect(o.why).toMatch(/^not a flat plate: /);
  });

  it("finds a plate that is turned in space (an imported or moved plate)", async () => {
    const doc = { ...bracket, features: [...bracket.features, { id: "turn", op: "move", bodies: ["main"], rotate: { axis: { origin: [0, 0, 0], direction: [1, 1, 0] }, angle: 37 } }] };
    const r = plates(await kernel.flat(doc, { kind: "plates" }));
    expect(r.plates.map((p) => ({ t: p.thickness, size: p.size, holes: p.holes }))).toEqual([{ t: 6, size: [80, 40], holes: 1 }]);
  });
});

describe("the files of a plates export", () => {
  const plate: FlatPlate = {
    bodies: ["gusset_1", "gusset_2"],
    thickness: 10,
    entities: [{ type: "polyline", points: [[0, 0], [100, 0], [0, 100]], closed: true, layer: "CUT" }, { type: "circle", c: [25, 25], r: 6, layer: "CUT" }],
    size: [100, 100],
    area: 5000 - Math.PI * 36,
    holes: 1,
    cutLength: 200 + 100 * Math.SQRT2 + 12 * Math.PI,
  };
  const end: FlatPlate = { ...plate, bodies: ["cap"], thickness: 6, entities: [{ type: "circle", c: [30, 30], r: 30, layer: "CUT" }], size: [60, 60], area: Math.PI * 900, holes: 0, cutLength: 60 * Math.PI };

  it("names each plate's file by part, body, thickness and quantity", () => {
    expect(plateFileName("BR-1001", plate)).toBe("BR-1001-gusset_1-10mm-x2.dxf");
    expect(plateFileName("frame", end)).toBe("frame-cap-6mm.dxf");
  });

  it("writes one clean DXF per plate (only the cut), an overview with labels, and a cutting list with mass", () => {
    const files = plateFiles([end, plate], "frame");
    expect(files.map((f) => f.name)).toEqual(["frame-cap-6mm.dxf", "frame-gusset_1-10mm-x2.dxf", "frame-plates-overview.dxf", "frame-plates.csv"]);
    const one = readDxf(String(files[1].data));
    expect(one.layers.map((l) => l.name)).toEqual(["CUT"]);
    expect(one.entities.map((e) => e.type)).toEqual(["polyline", "circle"]);
    const overview = readDxf(String(files[2].data));
    expect(overview.skipped).toEqual({ text: 2 });
    expect(overview.entities).toHaveLength(3);
    const csv = String(files[3].data).split("\r\n");
    expect(csv[0]).toBe("Plate,Bodies,Thickness (mm),Qty,Length (mm),Width (mm),Area each (m2),Cut length each (mm),Holes each,kg each,kg total");
    // The gusset: (5000 − 36π) mm² × 10 mm × 7850 kg/m³.
    const kg = (5000 - Math.PI * 36) * 10 * 1e-9 * 7850;
    expect(csv[2]).toBe(`gusset_1,gusset_1 gusset_2,10,2,100.0,100.0,0.0049,${(200 + 100 * Math.SQRT2 + 12 * Math.PI).toFixed(0)},1,${kg.toFixed(3)},${(kg * 2).toFixed(3)}`);
  });

  it("lists each plate's length as its longer side and its width as its shorter, however it lies", () => {
    const strip: FlatPlate = { ...end, bodies: ["strip"], entities: [{ type: "polyline", points: [[0, 0], [40, 0], [40, 250], [0, 250]], closed: true, layer: "CUT" }], size: [40, 250], area: 10000, holes: 0, cutLength: 580 };
    const row = platesCsv([strip]).split("\r\n")[1].split(",");
    expect(row.slice(4, 6)).toEqual(["250.0", "40.0"]);
  });

  it("lays the overview out side by side with a label under each", () => {
    const o = platesOverview([end, plate]);
    const texts = of(o, "text");
    expect(texts.map((t) => t.text)).toEqual(["cap, 6 mm", "gusset_1 x2, 10 mm"]);
    expect(texts.every((t) => t.layer === "LABELS")).toBe(true);
    // The gusset starts after the cap and the gap.
    const gusset = of(o, "polyline")[0];
    expect(gusset.points[0][0]).toBeCloseTo(60 + 25, 9);
  });

  it("zips files that read back byte for byte", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const zip = zipFiles([{ name: "a.dxf", data: "hello" }, { name: "b.csv", data: new Uint8Array([1, 2, 3]) }], new Date(2026, 9, 24, 12, 0, 0));
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const back = unzipStored(zip);
    expect(back.map((f) => f.name)).toEqual(["a.dxf", "b.csv"]);
    expect(new TextDecoder().decode(back[0].data)).toBe("hello");
    expect(Array.from(back[1].data)).toEqual([1, 2, 3]);
    expect(platesCsv([])).toBe("Plate,Bodies,Thickness (mm),Qty,Length (mm),Width (mm),Area each (m2),Cut length each (mm),Holes each,kg each,kg total\r\n");
  });
});
