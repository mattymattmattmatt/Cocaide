// Mesh parts (a .glb model carried in an assembly): reading the .glb, turning it into a part's view (Z up, mm, its
// underside's middle on the origin, textured), checking the document, the joined scene, VR's items and an accepted
// VR move.
import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, isGlb, parseGlb } from "../src/mesh/glb";
import { meshPartView, meshSpecProblems, scaleForSize, MESH_BODY } from "../src/mesh/meshPart";
import { meshKey } from "../src/mesh/loadMesh";
import { validateDocument } from "../src/doc/validate";
import { composeScene } from "../src/assembly/scene";
import { placementOf } from "../src/assembly/transform";
import { itemsOf } from "../src/ui/vr/items";
import { acceptMove } from "../src/doc/vr";
import type { RebuildView } from "../src/worker/protocol";
import { boxGlb, PNG_2X2 } from "./glb-fixture";

describe("parseGlb", () => {
  it("reads a box: its triangles, normals, texture coordinates, material and texture, the node's move applied", () => {
    const g = parseGlb(boxGlb(2, 0.5, 1, [10, 0, 0]));
    expect(g.positions.length / 3).toBe(24);
    expect(g.indices.length).toBe(36);
    expect(g.normals?.length).toBe(72);
    expect(g.uvs?.length).toBe(48);
    expect(g.primitives).toEqual([{ start: 0, count: 36, material: 0 }]);
    expect(g.materials).toEqual([{ color: [1, 1, 1, 1], image: 0, doubleSided: true }]);
    expect(g.images[0].mime).toBe("image/png");
    expect([...g.images[0].bytes]).toEqual([...PNG_2X2]);
    // Moved 10 along X by its parent node.
    let minX = Infinity;
    for (let i = 0; i < g.positions.length; i += 3) minX = Math.min(minX, g.positions[i]);
    expect(minX).toBeCloseTo(9);
  });
  it("refuses what isn't a .glb, and a compressed one", () => {
    expect(isGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBe(false);
    expect(() => parseGlb(new TextEncoder().encode("not a glb at all"))).toThrow(/not a \.glb/);
    const b = boxGlb();
    // Mark it as needing Draco: rewrite its JSON chunk with extensionsRequired.
    const dv = new DataView(b.buffer);
    const jl = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jl)));
    json.extensionsRequired = ["KHR_draco_mesh_compression"];
    let j = new TextEncoder().encode(JSON.stringify(json));
    j = Uint8Array.from([...j, ...new Array((4 - (j.length % 4)) % 4).fill(0x20)]);
    const rest = b.subarray(20 + jl);
    const out = new Uint8Array(20 + j.length + rest.length);
    out.set(b.subarray(0, 20));
    new DataView(out.buffer).setUint32(12, j.length, true);
    out.set(j, 20);
    out.set(rest, 20 + j.length);
    expect(() => parseGlb(out)).toThrow(/compressed/);
  });
  it("carries a .glb as base64 and back unchanged", () => {
    const b = boxGlb();
    expect([...base64ToBytes(bytesToBase64(b))]).toEqual([...b]);
  });
});

describe("meshPartView", () => {
  it("turns it Z up in mm, its underside's middle on the origin, one textured face", () => {
    // 2 m wide (X), 0.5 m tall (glTF Y), 1 m deep (glTF Z), moved off centre: drawn 2000 × 1000 × 500, standing on the origin.
    const v = meshPartView(parseGlb(boxGlb(2, 0.5, 1, [3, 7, -2])), "Sofa", 1, "sofa");
    expect(v.meshSize?.map(Math.round)).toEqual([2000, 1000, 500]);
    const p = v.mesh!.positions;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], p[i + c]);
      hi[c] = Math.max(hi[c], p[i + c]);
    }
    expect(lo.map(Math.round)).toEqual([-1000, -500, 0]);
    expect(hi.map(Math.round)).toEqual([1000, 500, 500]);
    expect(v.faces).toHaveLength(1);
    expect(v.faces[0]).toMatchObject({ body: MESH_BODY, mesh: { color: "#ffffff", texture: "sofa#0", doubleSided: true } });
    expect(v.faces[0].area).toBeCloseTo(2 * (2000 * 1000 + 2000 * 500 + 1000 * 500), -2);
    expect(Object.keys(v.textures ?? {})).toEqual(["sofa#0"]);
    expect(v.mesh!.uvs?.length).toBe(48);
    // glTF's top (+Y) is now up (+Z).
    const n = v.mesh!.normals;
    const ups = [];
    for (let i = 0; i < n.length; i += 3) if (n[i + 2] > 0.99) ups.push(i);
    expect(ups.length).toBe(4);
  });
  it("scales, and works out the scale for a real size", () => {
    const g = parseGlb(boxGlb(2, 0.5, 1));
    expect(meshPartView(g, "x", 1.5).meshSize?.map(Math.round)).toEqual([3000, 1500, 750]);
    expect(scaleForSize([2000, 1000, 500], 1, 0, 3380)).toBeCloseTo(1.69);
    expect(scaleForSize([3000, 1500, 750], 1.5, 2, 880)).toBeCloseTo(1.76);
  });
  it("a material's colour without a texture, in sRGB", () => {
    const v = meshPartView(parseGlb(boxGlb(1, 1, 1, [0, 0, 0], { texture: false, color: [0.5, 0.2, 0.1, 1] })), "x");
    expect(v.faces[0].mesh).toEqual({ color: "#bc7c59", doubleSided: true });
    expect(v.textures).toBeUndefined();
  });
});

describe("the document", () => {
  const part = (mesh: unknown) => ({ version: 1, units: "mm", name: "sofa", features: [], mesh });
  it("takes a mesh with the .glb or an address, and a scale", () => {
    expect(meshSpecProblems({ glb: "AAAA" })).toEqual([]);
    expect(meshSpecProblems({ url: "https://example.com/sofa.glb", scale: 1.6 })).toEqual([]);
    expect(validateDocument(part({ glb: "AAAA", scale: 2 })).headerErrors).toEqual([]);
  });
  it("says what is wrong with one", () => {
    expect(meshSpecProblems({})).toEqual(['needs one of "glb" (the file, base64) or "url" (where to fetch it)']);
    expect(meshSpecProblems({ glb: "AAAA", url: "https://x/y.glb" })[0]).toMatch(/one of/);
    expect(meshSpecProblems({ glb: "AAAA", scale: 0 })).toEqual(["scale: must be a number above 0"]);
    expect(meshSpecProblems({ glb: "AAAA", size: 3 })).toEqual(["size: not a mesh field (glb, url, scale)"]);
    expect(validateDocument(part({ url: "ftp://x" })).headerErrors.join(" ")).toMatch(/url: must be a web address/);
  });
  it("a mesh part's key changes with its scale and name, not by hashing the whole file", () => {
    const a = part({ glb: "A".repeat(1000), scale: 1 });
    expect(meshKey(a)).not.toBe(meshKey(part({ glb: "A".repeat(1000), scale: 2 })));
    expect(meshKey(a).length).toBeLessThan(300);
  });
});

describe("in an assembly", () => {
  const meshView = meshPartView(parseGlb(boxGlb(2, 0.5, 1)), "Sofa", 1, "sofa");
  const plain: RebuildView = {
    ok: true, name: "block", errors: [], features: [], sketches: [], measurements: null, datums: {}, edges: [], bodies: [{ name: "block", faces: [0, 1], edges: [0, 0] }],
    faces: [{ index: 0, type: "plane", area: 1, centroid: [0, 0, 0], body: "block" }],
    mesh: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]), faceRanges: [{ start: 0, count: 3 }], edges: new Float32Array(), edgeRanges: [] },
  };
  it("the joined scene carries texture coordinates (zeros for parts without) and textures, the face's look kept", () => {
    const s = composeScene([
      { id: "block-1", placement: placementOf({}), view: plain },
      { id: "sofa-1", placement: placementOf({ at: [5000, 0, 0] }), view: meshView },
    ]);
    expect(s.view.mesh!.uvs?.length).toBe((3 + 24) * 2);
    expect([...s.view.mesh!.uvs!.slice(0, 6)]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Object.keys(s.view.textures ?? {})).toEqual(["sofa#0"]);
    expect(s.view.faces[1]).toMatchObject({ body: "sofa-1", partBody: MESH_BODY, mesh: { texture: "sofa#0" } });
    // Without a mesh part: no texture coordinates at all.
    expect(composeScene([{ id: "block-1", placement: placementOf({}), view: plain }]).view.mesh!.uvs).toBeUndefined();
  });
  it("in VR a mesh part's component is furniture (it moves), whatever it is called", () => {
    const s = composeScene([
      { id: "block-1", placement: placementOf({}), view: plain },
      { id: "thing-1", placement: placementOf({}), view: meshView },
    ]);
    const items = itemsOf(s.view);
    expect(items.find((i) => i.body === "thing-1")?.movable).toBe(true);
    expect(items.find((i) => i.body === "block-1")?.movable).toBe(false);
  });
  it("a VR move of a mesh part's component, accepted, moves the component (it has no features to move)", () => {
    const doc = {
      version: 1, units: "mm", name: "house", features: [],
      assembly: { parts: { sofa: { version: 1, units: "mm", name: "Sofa", features: [], mesh: { glb: "AAAA" } } }, components: [{ id: "sofa-1", part: "sofa", at: [1000, 2000, 0] }] },
      vr: { moves: [{ id: "m1", component: "sofa-1", body: MESH_BODY, move: [500, 0, 0], turn: 90, centre: [1000, 2000, 250] }] },
    };
    const r = acceptMove(doc as never, "m1");
    expect("doc" in r).toBe(true);
    const out = (r as { doc: { assembly: { components: { at: number[]; rotation: number[] }[]; parts: { sofa: { features: unknown[] } } }; vr?: unknown } }).doc;
    expect(out.assembly.components[0].at).toEqual([1500, 2000, 0]);
    expect(out.assembly.components[0].rotation.map((v) => Math.round(v))).toEqual([0, 0, 90]);
    expect(out.assembly.parts.sofa.features).toEqual([]);
    expect(out.vr).toBeUndefined();
  });
});
