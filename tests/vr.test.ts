// The VR walkthrough: its start point in the document, and where the rig puts the model so you stand there.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { apply } from "../src/doc/commands";
import { vrProblems, vrStartOf } from "../src/doc/vr";
import { allErrors, validateDocument } from "../src/doc/validate";
import { defaultStart, rigFor, toXr } from "../src/ui/vr/xrWalk";

const base = { version: 1, units: "mm", name: "p", features: [] };

describe("the start point in the file", () => {
  it("is checked, set and cleared by setVr", () => {
    expect(vrProblems({ start: { at: [1, 2, 3], heading: 90 } })).toEqual([]);
    expect(vrProblems({ start: { at: [1, 2], heading: "north" }, extra: 1 }).map(([p]) => p)).toEqual(["vr", "vr.start.at", "vr.start.heading"]);
    expect(allErrors(validateDocument({ ...base, vr: { start: { at: [0, 0, 0], heading: 0 } } }))).toEqual([]);
    expect(allErrors(validateDocument({ ...base, vr: { start: { at: [0, 0] } } })).join("\n")).toMatch(/vr\.start\.at/);
    const set = apply(base as never, { type: "setVr", vr: { start: { at: [5000, 2000, 0], heading: 45 } } });
    expect(set.ok && vrStartOf(set.doc)).toEqual({ at: [5000, 2000, 0], heading: 45 });
    const cleared = set.ok ? apply(set.doc, { type: "setVr", vr: null }) : set;
    expect(cleared.ok && "vr" in cleared.doc).toBe(false);
    expect(apply(base as never, { type: "setVr", vr: { start: { at: [1], heading: 0 } } } as never).ok).toBe(false);
  });
});

describe("standing at the start", () => {
  /** A model point (mm, Z up) where the rig puts it in VR (m, Y up; you at the origin facing -Z). */
  const world = (start: { at: [number, number, number]; heading: number }, p: [number, number, number]) => {
    const { rotY, position } = rigFor(start);
    return toXr(p).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY).add(position);
  };
  const close = (v: THREE.Vector3, e: [number, number, number]) => v.toArray().forEach((x, i) => expect(x).toBeCloseTo(e[i], 9));
  it("the start under your feet, the heading straight ahead, up up", () => {
    const s = { at: [2000, 3000, 450] as [number, number, number], heading: 90 };
    close(world(s, s.at), [0, 0, 0]);
    close(world(s, [2000, 4000, 450]), [0, 0, -1]); // a metre north, facing north: a metre ahead
    close(world(s, [3000, 3000, 450]), [1, 0, 0]); // a metre east: on your right
    close(world(s, [2000, 3000, 2450]), [0, 2, 0]); // 2 m above the floor: 2 m up
    const e = { at: [0, 0, 0] as [number, number, number], heading: 0 };
    close(world(e, [1000, 0, 0]), [0, 0, -1]); // facing east
    close(world({ at: [0, 0, 0], heading: 225 }, [-1000, -1000, 0]), [0, 0, -Math.SQRT2]);
  });
  it("with no start: 3 m in front of the model, on its lowest level, facing it", () => {
    expect(defaultStart(new THREE.Box3(new THREE.Vector3(0, 0, -100), new THREE.Vector3(12000, 10000, 6000)))).toEqual({ at: [6000, -3000, -100], heading: 90 });
  });
});

import { acceptMove, vrNotesOf, withNotes } from "../src/doc/vr";
import { isFurniture, itemsOf, moved } from "../src/ui/vr/items";
import { composeScene } from "../src/assembly/scene";

describe("notes from VR: pins and moved furniture", () => {
  it("are checked, added (a body moved twice sums its moves), and read back", () => {
    const pin = { id: "p1", at: [1000, 2000, 0] as [number, number, number], tag: "tight" as const, text: "door hits the robe" };
    const mv = { id: "m1", body: "sofa", move: [500, 0, 0] as [number, number, number], centre: [3000, 6000, 400] as [number, number, number] };
    const vr = withNotes(withNotes(undefined, [pin], [mv]), [], [{ ...mv, id: "m2", move: [0, 250, 0], turn: 90 }]);
    expect(vr.moves).toEqual([{ ...mv, move: [500, 250, 0], turn: 90 }]);
    expect(vrProblems(vr)).toEqual([]);
    expect(vrNotesOf({ ...base, vr }).pins).toEqual([pin]);
    expect(vrProblems({ pins: [{ id: "a", at: [0, 0, 0], tag: "nope" }, { id: "a", at: [0], tag: "note" }] }).map(([p]) => p)).toEqual(["vr.pins[0].tag", "vr.pins[1].id", "vr.pins[1].at"]);
  });

  it("an accepted move is a Move feature on the body (turned about its middle), the proposal gone", () => {
    const doc = { ...base, features: [{ id: "s", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [] }], vr: { start: { at: [0, 0, 0], heading: 0 }, moves: [{ id: "m1", body: "sofa", move: [500, 0, 0], turn: 90, centre: [3000, 6000, 400] }] } };
    const r = acceptMove(doc, "m1");
    if ("error" in r) throw new Error(r.error);
    expect((r.doc.features as unknown[]).at(-1)).toEqual({ id: "vr_move_1", op: "move", bodies: ["sofa"], translate: [500, 0, 0], rotate: { axis: { origin: [3000, 6000, 400], direction: [0, 0, 1] }, angle: 90 } });
    expect(r.doc.vr).toEqual({ start: { at: [0, 0, 0], heading: 0 } });
    expect(acceptMove(doc, "nope")).toEqual({ error: 'no VR move "nope"' });
  });

  it("in an assembly: on the component's part, in the part's own coordinates", () => {
    const furniture = { ...base, name: "furniture", features: [] };
    const doc = { ...base, assembly: { parts: { furniture }, components: [{ id: "slab", part: "self" }, { id: "furniture-1", part: "furniture", at: [10000, 0, 0], rotation: [0, 0, 90] }] }, vr: { moves: [{ id: "m1", body: "bed_king", component: "furniture-1", move: [0, 1000, 0], centre: [10000, 2000, 300] }] } };
    const r = acceptMove(doc, "m1");
    if ("error" in r) throw new Error(r.error);
    const f = ((r.doc.assembly as { parts: Record<string, { features: { translate: number[]; bodies: string[] }[] }> }).parts.furniture.features)[0];
    // The component is turned 90°: north in the house is the part's -X... its +X turned to +Y, so +Y in the house is +X in the part.
    expect(f.bodies).toEqual(["bed_king"]);
    expect(f.translate.map((v) => Math.round(v))).toEqual([1000, 0, 0]);
    expect("vr" in r.doc).toBe(false);
  });

  it("furniture moves; walls, benches and robes don't", () => {
    expect(isFurniture("furniture-1", "bed_king")).toBe(true);
    expect(isFurniture("sofa")).toBe(true);
    expect(isFurniture("chair_3")).toBe(true);
    expect(isFurniture("walls-1", "ext_12")).toBe(false);
    expect(isFurniture("joinery-1", "carcass_kit_bench")).toBe(false);
    expect(isFurniture("joinery-1", "robe_wir")).toBe(false);
    expect(moved([1, 0, 0], [0, 0, 0], 90, [10, 0, 0]).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([10, 1, 0]);
  });

  it("in an assembly's view each component body is its own item, with its own name", () => {
    const part = (body: string, x: number) => ({ ok: true, name: body, errors: [], features: [], sketches: [], measurements: null, datums: {}, bodies: [{ name: body, faces: [0, 1], edges: [0, 0] }], faces: [{ index: 0, type: "plane", area: 1, centroid: [x, 0, 0], body }], edges: [], mesh: { positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), faceRanges: [{ start: 0, count: 3 }], edges: new Float32Array(0), edgeRanges: [] } });
    const scene = composeScene([{ id: "furniture-1", placement: { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] }, view: part("sofa", 0) as never }, { id: "walls-1", placement: { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] }, view: part("ext_1", 5) as never }], "house");
    const items = itemsOf(scene.view);
    expect(items.map((i) => [i.key, i.movable])).toEqual([["furniture-1/sofa", true], ["walls-1/ext_1", false]]);
  });
});

describe("what counts as furniture", () => {
  it("names that start with a piece of furniture, or a part named for it; not a door named after a bedroom", () => {
    expect(isFurniture("windows-doors-1", "jamb_bed2_door_209")).toBe(false);
    expect(isFurniture("windows-doors-1", "leaf_bed3_door_216")).toBe(false);
    expect(isFurniture("house", "bed_king_3")).toBe(true);
    expect(isFurniture("house", "bedside_l")).toBe(true);
    expect(isFurniture("house", "table_dining_57")).toBe(true);
    expect(isFurniture("furniture-1", "anything")).toBe(true);
  });
});
