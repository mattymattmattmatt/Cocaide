// Sub-assemblies: a document with an assembly of its own, put into another as one component (a shed into a house):
// found as such, its components counted, its view its components joined where it keeps them (so a face of it is
// named and mated like a part's), built again when one of its components moves, and in the kernel one compound
// (interference and STEP take it as one component).
import { beforeAll, describe, expect, it } from "vitest";
import { loadOC, type OC } from "../src/kernel";
import { scoped } from "../src/kernel/oc";
import { assemblyInterference, assemblySTEP } from "../src/kernel/assembly";
import { componentCount, isSubAssembly, subAssemblyKey, subAssemblyOf, subAssemblyView } from "../src/assembly/subassembly";
import { composeScene } from "../src/assembly/scene";
import { placementOf } from "../src/assembly/transform";
import { mateGeometry } from "../src/assembly/resolve";
import { faceSelectorFor } from "../src/kernel/synthesize";
import { validateDocument } from "../src/doc/validate";
import type { RebuildView } from "../src/worker/protocol";

/** A box part w × d × h from the origin. */
const block = (name: string, w: number, d: number, h: number) => ({
  version: 1, units: "mm", name,
  features: [
    { id: "s", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [
      { id: "a", type: "line", start: [0, 0], end: [w, 0] }, { id: "b", type: "line", start: [w, 0], end: [w, d] },
      { id: "c", type: "line", start: [w, d], end: [0, d] }, { id: "e", type: "line", start: [0, d], end: [0, 0] },
    ] },
    { id: "x", op: "extrude", sketch: "s", distance: h },
  ],
});
const empty = (name: string) => ({ version: 1, units: "mm", name, features: [] });
/** A small "shed": two 100 cube walls 300 apart (its own part has no features). */
const shed = () => ({
  ...empty("shed"),
  assembly: {
    parts: { wall: block("wall", 100, 100, 100) },
    components: [{ id: "wall-1", part: "wall", fixed: true }, { id: "wall-2", part: "wall", at: [300, 0, 0], fixed: true }],
  },
});

/** A view of one flat face per side of a w × d × h box, as the kernel would hand back (for the pure tests). */
function boxView(name: string, w: number, d: number, h: number): RebuildView {
  const f = (index: number, normal: [number, number, number], centroid: [number, number, number]) => ({ index, type: "plane" as const, area: 1, centroid, normal, point: centroid, body: name });
  return {
    ok: true, name, errors: [], features: [], sketches: [], measurements: null, datums: {}, edges: [],
    bodies: [{ name, faces: [0, 6], edges: [0, 0] }],
    faces: [f(0, [0, 0, -1], [w / 2, d / 2, 0]), f(1, [0, 0, 1], [w / 2, d / 2, h]), f(2, [-1, 0, 0], [0, d / 2, h / 2]), f(3, [1, 0, 0], [w, d / 2, h / 2]), f(4, [0, -1, 0], [w / 2, 0, h / 2]), f(5, [0, 1, 0], [w / 2, d, h / 2])],
    mesh: null,
  } as unknown as RebuildView;
}
const fakeBuild = async (d: Record<string, unknown>) => {
  const ext = (d.features as { op: string; distance?: number }[]).find((x) => x.op === "extrude");
  return ext ? boxView(String(d.name), 100, 100, ext.distance!) : boxView(String(d.name), 0, 0, 0);
};

describe("sub-assemblies", () => {
  it("a document with an assembly of components is one; a plain part, or an empty assembly, isn't", () => {
    expect(isSubAssembly(shed())).toBe(true);
    expect(isSubAssembly(block("b", 1, 1, 1))).toBe(false);
    expect(isSubAssembly({ ...empty("e"), assembly: { components: [] } })).toBe(false);
    expect(subAssemblyOf(shed())?.components).toHaveLength(2);
  });

  it("counts the components it holds, those of a sub-assembly in it too", () => {
    expect(componentCount(shed())).toBe(2);
    const yard = { ...empty("yard"), assembly: { parts: { shed: shed(), bin: block("bin", 50, 50, 80) }, components: [{ id: "shed-1", part: "shed", fixed: true }, { id: "bin-1", part: "bin", at: [0, 500, 0] }] } };
    expect(componentCount(yard)).toBe(3);
    // A house holding it is a valid document.
    expect(validateDocument({ ...block("house", 1000, 1000, 10), assembly: { parts: { yard }, components: [{ id: "self-1", part: "self", fixed: true }, { id: "yard-1", part: "yard", at: [0, 0, 10] }] } }).headerErrors).toEqual([]);
  });

  it("its view is its components joined where it keeps them, each a body named by its component", async () => {
    const v = await subAssemblyView(shed(), fakeBuild);
    expect(v.bodies.map((b) => b.name)).toEqual(["wall-1", "wall-2"]);
    const right = v.faces.filter((f) => f.normal?.[0] === 1).map((f) => f.centroid[0]).sort((a, b) => a - b);
    expect(right).toEqual([100, 400]);
  });

  it("in the house, a face of it is named on it and mated like a part's: found again, where it is", async () => {
    const v = await subAssemblyView(shed(), fakeBuild);
    const scene = composeScene([{ id: "shed-1", placement: placementOf({ at: [1000, 0, 0] }), view: v }]);
    // The far wall's right face: in the house at x 1400, on the shed's wall-2.
    const i = scene.view.faces.findIndex((f) => f.normal?.[0] === 1 && f.centroid[0] === 1400);
    expect(scene.view.faces[i]).toMatchObject({ body: "shed-1", partBody: "wall-2" });
    const local = scene.faceOwner[i].local;
    const syn = faceSelectorFor(v.faces, local);
    expect(syn.ok).toBe(true);
    const g = mateGeometry({ component: "shed-1", face: (syn as unknown as { selector: never }).selector }, v);
    expect(g).toMatchObject({ kind: "plane", n: [1, 0, 0] });
    expect((g as { p: number[] }).p[0]).toBe(400);
  });

  it("keeps its parts' colours (a component's own colour over its part's), so it looks the same wherever it is put", async () => {
    const d = shed();
    (d.assembly.parts.wall as Record<string, unknown>).appearance = { color: "#6b6c6c" };
    (d.assembly.components[1] as Record<string, unknown>).appearance = { color: "#ffffff" };
    const v = await subAssemblyView(d, fakeBuild);
    expect(new Set(v.faces.filter((f) => f.body === "wall-1").map((f) => f.look?.color))).toEqual(new Set(["#6b6c6c"]));
    expect(new Set(v.faces.filter((f) => f.body === "wall-2").map((f) => f.look?.color))).toEqual(new Set(["#ffffff"]));
  });

  it("is built again when one of its components moves, not when nothing changed", () => {
    const leaf = (d: Record<string, unknown>) => JSON.stringify(d.features);
    const a = shed();
    const b = shed();
    expect(subAssemblyKey(a, leaf)).toBe(subAssemblyKey(b, leaf));
    b.assembly.components[1].at = [350, 0, 0];
    expect(subAssemblyKey(a, leaf)).not.toBe(subAssemblyKey(b, leaf));
  });
});

describe("sub-assemblies in the kernel", () => {
  let oc: OC;
  beforeAll(async () => {
    oc = await loadOC();
  }, 120000);

  it("one compound: a block overlapping one of its walls clashes with it as one component", () => {
    const parts = { shed: shed(), block: block("block", 50, 50, 50) };
    const r = scoped((s) => assemblyInterference(oc, s, parts, [
      { id: "shed-1", part: "shed", R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] },
      { id: "block-1", part: "block", R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [375, 25, 25] },
    ]));
    expect(r).toHaveLength(1);
    expect(r[0].components.sort()).toEqual(["block-1", "shed-1"]);
    // 25 × 50 × 50 of the block is inside wall-2 (x 300 to 400).
    expect(r[0].volume).toBeCloseTo(25 * 50 * 50, 0);
  }, 120000);

  it("in a STEP file as one named solid (its walls in it)", () => {
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const text = scoped((s) => assemblySTEP(oc, s, "yard", { shed: shed(), bin: block("bin", 50, 50, 80) }, [{ id: "shed-1", part: "shed", R: I, t: [0, 0, 0] }, { id: "bin-1", part: "bin", R: I, t: [0, 500, 0] }]));
    expect(text).toContain("PRODUCT('shed-1'");
    expect(text).toContain("PRODUCT('bin-1'");
    // The shed's two walls and the bin.
    expect((text.match(/SOLID_BREP\(/g) ?? []).length).toBe(3);
  }, 120000);
});
