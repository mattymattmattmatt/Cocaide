// Phase P wave 3A, the UI rules (pure): the tree's rows, filter, tooltip
// values and drop places; What's wrong's list and fixes; the parameters
// manager's usage table; parents and children through picked faces; a broken
// pick replaced by the next one; and the rebuild's record of whose faces each
// feature picked.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { loadOC, rebuild, type OC } from "../src/kernel";
import type { FeatureStatus, HealNote } from "../src/kernel/rebuild";
import type { EdgeInfo, FaceInfo } from "../src/kernel/topology";
import { brokenSelector, diagnose, lastSeen, problemCounts } from "../src/ui/diagnose/diagnose";
import { childrenOf, parentsOf } from "../src/ui/evaluate/relations";
import { isUsed, parameterRows, sortRows, suggestName } from "../src/ui/params/usage";
import { toggleEdges, toggleFace } from "../src/ui/props/picking";
import { dropIndex, featureState, keyValues, matchesFilter, treeRows } from "../src/ui/treeModel";
import type { RebuildView } from "../src/worker/protocol";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const topFace = { type: "planar", normal: [0, 0, 1], pick: "largest" };

function doc(): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "t",
    parameters: { t: 6, spare: 2, angle_a: 30 },
    features: [
      { id: "sketch_1", op: "sketch", plane: TOP, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 80, h: 40 }] },
      { id: "ext_1", op: "extrude", sketch: "sketch_1", distance: "=t", note: "the base plate" },
      { id: "hole_1", op: "hole", face: topFace, center: [30, 0], diameter: 6.6, depth: "through" },
      { id: "fillet_1", op: "fillet", edges: { type: "edge", kind: "circle", radius: 3.3, onFace: topFace, pick: "all", createdBy: "hole_1", hint: { centroid: [30, 0, 6] } }, radius: 1 },
      { id: "draft_1", op: "draft", faces: [{ type: "planar", normal: [1, 0, 0], offset: 40, pick: "largest" }], neutral: { datum: "Top" }, angle: "=angle_a / 10" },
    ],
    folders: [{ id: "folder_1", name: "Holes", features: ["hole_1", "fillet_1"] }],
  };
}

const view = (features: FeatureStatus[], errors: string[] = []): RebuildView => ({ ok: true, name: "t", errors, features, sketches: [], measurements: null, mesh: null, faces: [], edges: [], bodies: [], datums: {} });

describe("the tree's rows and filter", () => {
  const d = doc();
  it("a folder's head above its first feature; collapsed, its features hidden; filtered, only matches", () => {
    const folders = d.folders as never;
    const rows = treeRows(d.features, folders, new Set());
    expect(rows.map((r) => (r.kind === "folder" ? `[${r.folder.name}]` : String(d.features[r.index].id)))).toEqual(["sketch_1", "ext_1", "[Holes]", "hole_1", "fillet_1", "draft_1"]);
    expect(treeRows(d.features, folders, new Set(["folder_1"])).map((r) => (r.kind === "folder" ? `[${r.folder.name}]` : String(d.features[r.index].id)))).toEqual(["sketch_1", "ext_1", "[Holes]", "draft_1"]);
    const only = treeRows(d.features, folders, new Set(["folder_1"]), (i) => d.features[i].id === "fillet_1");
    expect(only.map((r) => (r.kind === "folder" ? `[${r.folder.name}]` : String(d.features[r.index].id)))).toEqual(["[Holes]", "fillet_1"]);
  });

  it("the filter: a name, a type, a state, a note", () => {
    const f = d.features[1];
    expect(matchesFilter(f, "Extrude", "ok", "ext")).toBe(true);
    expect(matchesFilter(f, "Extrude", "ok", "type:extrude")).toBe(true);
    expect(matchesFilter(f, "Extrude", "ok", "type:hole")).toBe(false);
    expect(matchesFilter(f, "Extrude", "ok", "error")).toBe(false);
    expect(matchesFilter(f, "Extrude", "error", "error")).toBe(true);
    expect(matchesFilter(f, "Extrude", "ok", "plate")).toBe(true);
  });

  it("a feature's state; its key values for the tooltip", () => {
    expect(featureState({ id: "a" }, { id: "a", op: "x", ok: true, warnings: ["a: w"] }, false)).toBe("warning");
    expect(featureState({ id: "a", suppressed: true }, undefined, false)).toBe("suppressed");
    expect(featureState({ id: "a" }, { id: "a", op: "x", ok: false }, true)).toBe("rolled");
    expect(keyValues(d.features[1], { distance: 6 })).toEqual(["Depth =t (6 mm)", "Sketch sketch_1"]);
    expect(keyValues(d.features[2])).toEqual(["Diameter 6.6 mm", "Depth through"]);
  });

  it("where a drop lands: above or below the row, counting the dragged one out", () => {
    expect(dropIndex(4, 1, false)).toBe(1);
    expect(dropIndex(4, 1, true)).toBe(2);
    expect(dropIndex(0, 3, false)).toBe(2);
    expect(dropIndex(0, 3, true)).toBe(3);
  });
});

describe("What's wrong", () => {
  it("errors name the reference they are about and where it was; warnings offer Accept; fragile ones Make robust", () => {
    const d = doc();
    const heal: HealNote = { kind: "edge", selector: d.features[3].edges as never, healed: { type: "edge", pick: "all" }, was: [30, 0, 6], now: [20, 0, 6], matched: 0, message: "fillet_1: an edge moved — re-found it (check)" };
    const list = diagnose(
      d,
      view([
        { id: "sketch_1", op: "sketch", ok: true },
        { id: "ext_1", op: "extrude", ok: true },
        { id: "hole_1", op: "hole", ok: false, error: "hole_1: face: selector matched 0 faces (wanted 1 planar face normal +Z)" },
        { id: "fillet_1", op: "fillet", ok: true, warnings: [heal.message], heals: [heal] },
        { id: "draft_1", op: "draft", ok: true },
      ]),
    );
    expect(list.map((p) => [p.severity, p.feature, p.ref?.path ?? null, p.fixes])).toEqual([
      ["error", "hole_1", "face", ["repick", "edit", "suppress", "rollback", "delete"]],
      ["warning", "fillet_1", "edges", ["accept", "repick", "edit"]],
      ["fragile", "draft_1", "faces[0]", ["robust", "edit"]],
    ]);
    expect(list[1].ghost).toEqual([30, 0, 6]);
    expect(list[0].message).toBe("face: selector matched 0 faces (wanted 1 planar face normal +Z)");
    expect(problemCounts(list)).toEqual({ errors: 1, warnings: 1, fragile: 1 });
  });

  it("a suppressed feature has nothing wrong; a document error stands alone", () => {
    const list = diagnose(doc(), view([{ id: "hole_1", op: "hole", ok: true, suppressed: true }], ["document: parameters.x: bad"]));
    expect(list.map((p) => [p.severity, p.message])).toEqual([["error", "parameters.x: bad"]]);
  });

  it("which selector an error is about; where a selector was last seen", () => {
    const f = { id: "x", op: "extrude", upTo: { face: { type: "planar", normal: [0, 0, 1], pick: "all", near: [1, 2, 3] } }, faces: [{ type: "planar", normal: [1, 0, 0], pick: "all" }] };
    expect(brokenSelector(f, "upTo.face: selector matched 0 faces")?.path).toBe("upTo.face");
    expect(brokenSelector(f, "faces[0]: selector matched 2 faces")?.path).toBe("faces[0]");
    expect(lastSeen({ type: "edge", onFace: { near: [4, 5, 6] } })).toEqual([4, 5, 6]);
  });
});

describe("the parameters manager", () => {
  it("each parameter's users, unit and value; unused ones flagged; sorted and filtered", () => {
    const rows = parameterRows(doc());
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.t).toMatchObject({ kind: "parameter", expression: 6, value: 6, unit: "mm", features: [{ feature: "ext_1", fields: ["distance"] }] });
    expect(by.angle_a).toMatchObject({ unit: "°", features: [{ feature: "draft_1", fields: ["angle"] }] });
    expect(isUsed(by.spare)).toBe(false);
    expect(sortRows(rows, "name", "").map((r) => r.name)).toEqual(["angle_a", "spare", "t"]);
    expect(sortRows(rows, "value", "", true).map((r) => r.name)).toEqual(["angle_a", "t", "spare"]);
    expect(sortRows(rows, "name", "unused").map((r) => r.name)).toEqual(["spare"]);
    expect(sortRows(rows, "name", "draft").map((r) => r.name)).toEqual(["angle_a"]);
  });

  it("a named dimension is listed with its sketch; a name suggested from the field's label", () => {
    const d = doc();
    (d.features[0] as { constraints?: unknown[] }).constraints = [{ type: "distanceX", entity: "r1", value: 80, name: "width" }];
    d.features[2].center = ["=sketch_1.width / 2 - 10", 0];
    const row = parameterRows(d).find((r) => r.name === "sketch_1.width")!;
    expect(row).toMatchObject({ kind: "dimension", sketch: "sketch_1", value: 80, features: [{ feature: "hole_1", fields: ["center"] }] });
    expect(suggestName("Depth", ["depth"])).toBe("depth_2");
    expect(suggestName("Counterbore diameter", [])).toBe("counterbore_diameter");
  });
});

describe("parents and children through the faces a feature picks", () => {
  it("a selector's createdBy, and what the rebuild found its selectors matched, make parents", () => {
    const d = doc();
    expect(parentsOf(d.features, "fillet_1")).toEqual(["hole_1"]);
    const uses = new Map([["hole_1", ["ext_1"]]]);
    expect(parentsOf(d.features, "hole_1", uses)).toEqual(["ext_1"]);
    expect(childrenOf(d.features, "ext_1", uses)).toEqual(["hole_1"]);
  });

  it("the rebuild records whose faces and edges each feature's selectors matched", () => {
    const d = doc();
    d.features.pop();
    const r = rebuild(d, oc);
    try {
      expect(r.errors).toEqual([]);
      expect(r.uses.hole_1).toEqual(["ext_1"]);
      expect(r.uses.fillet_1).toEqual(["ext_1", "hole_1"]);
    } finally {
      r.dispose();
    }
  });
});

describe("Re-pick: a broken pick is replaced by the next one", () => {
  const face = (index: number, z: number, createdBy = "ext_1"): FaceInfo => ({ index, type: "plane", area: 100, centroid: [0, 0, z], normal: [0, 0, 1], point: [0, 0, z], offset: z, createdBy });
  it("a face selector with a hint that finds nothing goes when a face is picked", () => {
    const faces = [face(0, 6)];
    const broken = { type: "planar" as const, normal: [1, 0, 0] as [number, number, number], pick: "all" as const, hint: { centroid: [900, 900, 900] as [number, number, number] } };
    const plain = { type: "planar" as const, normal: [1, 0, 0] as [number, number, number], pick: "all" as const };
    const next = toggleFace([broken, plain], faces, 0);
    expect(Array.isArray(next) && next.length).toBe(2);
    expect(Array.isArray(next) && next[0]).toBe(plain);
  });

  it("an edge selector with a hint that finds nothing goes when an edge is picked", () => {
    const edge: EdgeInfo = { index: 0, kind: "line", length: 10, start: [0, 0, 0], end: [10, 0, 0], mid: [5, 0, 0], centroid: [5, 0, 0], direction: [1, 0, 0], faces: [], seam: false, createdBy: "ext_1" };
    const broken = { type: "edge" as const, kind: "circle" as const, radius: 3, pick: "all" as const, hint: { centroid: [9, 9, 9] as [number, number, number] } };
    const next = toggleEdges(broken, [edge], [], [0]);
    expect(next).toMatchObject({ type: "edge", createdBy: "ext_1" });
  });
});
