// Smart defaults (Phase P wave 2) on known parts, rebuilt and meshed in node
// as the worker does: the bracket (an 80 × 40 × 6 plate, a Ø6.6 hole at
// X 30), a 100 × 60 × 20 block, and a 40 × 20 × 10 box with rounded upright
// corners. A new feature's numbers come from the part (rounded to values a
// person would type), or from the last ones used when they still suit it.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { loadOC, rebuild, scoped, tessellate, type OC } from "../src/kernel";
import { describeEdges, describeFaces } from "../src/kernel/topology";
import { EMPTY_SELECTION } from "../src/ui/model/selection";
import {
  DRAFT_ANGLE,
  EXTRUDE_DRAFT_ANGLE,
  edgeLimit,
  faceWidth,
  filletRadiusFor,
  holeSizeFor,
  narrowestBeside,
  niceValue,
  patternSpacingFor,
  shellLimit,
  shellThicknessFor,
  suits,
  widthAcross,
  widthAlong,
} from "../src/ui/model/smartDefaults";
import { edgeDraft, edgeFeature } from "../src/ui/model/tools/edges";
import { shellFeature } from "../src/ui/model/tools/dress";
import { newHoleKind } from "../src/ui/model/tools/hole";
import { patternFeature } from "../src/ui/model/tools/pattern";
import { recalled, rememberFrom, REMEMBERED, type ToolMemory } from "../src/ui/model/toolMemory";
import type { RebuildView } from "../src/worker/protocol";
import { example, harness } from "./ui-fixtures";

type Raw = Record<string, unknown>;

let oc: OC;
let bracket: RebuildView;
let block: RebuildView;
let rounded: RebuildView;
const bracketDoc = () => example("bracket");

const boxDoc = (w: number, h: number, d: number, ...more: Raw[]): RawDocument => ({
  version: 1,
  units: "mm",
  name: "box",
  features: [
    { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w, h }], constraints: [] },
    { id: "ext_1", op: "extrude", sketch: "s1", distance: d },
    ...more,
  ],
});

/** The view the worker sends, with its mesh (the widths across faces are read from it). */
function fullView(doc: RawDocument): RebuildView {
  const r = rebuild(doc, oc);
  try {
    const topo = scoped((s) => {
      const f = describeFaces(oc, s, r.solid!);
      return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
    });
    return { ok: r.ok, name: r.name, errors: r.errors, features: r.features, sketches: r.sketches, measurements: r.measurements, mesh: tessellate(oc, r.solid!), faces: topo.faces, edges: topo.edges, bodies: r.bodies.map(({ name, faces, edges }) => ({ name, faces, edges })), datums: r.datums };
  } finally {
    r.dispose();
  }
}

/** The straight edge whose middle is at `at`. */
function edgeAt(view: RebuildView, at: [number, number, number]): number {
  const i = view.edges.findIndex((e) => Math.hypot(e.mid[0] - at[0], e.mid[1] - at[1], e.mid[2] - at[2]) < 1e-3);
  if (i < 0) throw new Error(`no edge at ${at}`);
  return i;
}
/** The flat face facing `n` (the largest, when several do). */
function faceFacing(view: RebuildView, n: [number, number, number]): number {
  let best = -1;
  view.faces.forEach((f, i) => {
    if (f.type === "plane" && f.normal && Math.hypot(f.normal[0] - n[0], f.normal[1] - n[1], f.normal[2] - n[2]) < 1e-6 && (best < 0 || f.area > view.faces[best].area)) best = i;
  });
  if (best < 0) throw new Error(`no face facing ${n}`);
  return best;
}

beforeAll(async () => {
  oc = await loadOC();
  bracket = fullView(bracketDoc());
  block = fullView(boxDoc(100, 60, 20));
  rounded = fullView(boxDoc(40, 20, 10, { id: "f1", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" }, radius: 3 }));
}, 120_000);

describe("round values", () => {
  it("rounds down to 1, 2, 3 or 5 in each decade, never under 0.1", () => {
    expect([0.73, 0.6, 1, 1.9, 2.5, 4, 6, 10, 23, 47, 0.3].map(niceValue)).toEqual([0.5, 0.5, 1, 1, 2, 3, 5, 10, 20, 30, 0.3]);
    expect(niceValue(0.05)).toBe(0.1);
    expect(niceValue(0)).toBe(0.1);
    expect(niceValue(Number.NaN)).toBe(0.1);
  });
});

describe("fillet and chamfer: a tenth of the narrowest face beside the edges", () => {
  it("the bracket's long top edge: the 6 mm side is narrower than the 40 mm top, so 0.5", () => {
    const e = edgeAt(bracket, [0, -20, 6]);
    const top = faceFacing(bracket, [0, 0, 1]);
    const side = faceFacing(bracket, [0, -1, 0]);
    expect(widthAcross(bracket, top, e)).toBeCloseTo(40, 6);
    expect(widthAcross(bracket, side, e)).toBeCloseTo(6, 6);
    expect(narrowestBeside(bracket, [e])).toBeCloseTo(6, 6);
    expect(filletRadiusFor(bracket, [e])).toBe(0.5);
    // A remembered radius suits up to four tenths of that face.
    expect(edgeLimit(bracket, [e])).toBeCloseTo(2.4, 6);
  });

  it("the block's top edge (beside a 20 mm side): 2; an upright edge (60 and 100 mm faces): 5", () => {
    expect(filletRadiusFor(block, [edgeAt(block, [0, -30, 20])])).toBe(2);
    expect(filletRadiusFor(block, [edgeAt(block, [50, 30, 10])])).toBe(5);
    // Several edges: the narrowest face beside any of them.
    expect(filletRadiusFor(block, [edgeAt(block, [0, -30, 20]), edgeAt(block, [50, 30, 10])])).toBe(2);
  });

  it("the rounded box's top straight edge: its 10 mm side wins over the 20 mm top, so 1", () => {
    const e = rounded.edges.findIndex((x) => x.kind === "line" && Math.abs(x.mid[2] - 10) < 1e-6 && Math.abs(x.mid[1] + 10) < 1e-6);
    expect(e).toBeGreaterThanOrEqual(0);
    expect(filletRadiusFor(rounded, [e])).toBe(1);
  });

  it("the Fillet tool: the smart radius, or the last used while it suits the edges", () => {
    const e = edgeAt(bracket, [0, -20, 6]);
    const selection = { ...EMPTY_SELECTION, edges: [e] };
    const fresh = harness(bracketDoc(), bracket, { selection });
    expect(edgeFeature(fresh.ctx, "fillet")).toMatchObject({ op: "fillet", radius: 0.5 });
    expect(edgeFeature(fresh.ctx, "chamfer")).toMatchObject({ op: "chamfer", distance: 0.5 });
    const used = harness(bracketDoc(), bracket, { selection, memory: { fillet: { radius: 2 } } });
    expect(edgeFeature(used.ctx, "fillet")).toMatchObject({ radius: 2 });
    // 3 mm is more than a 6 mm face can take well (over 2.4): the part's own default instead.
    const big = harness(bracketDoc(), bracket, { selection, memory: { fillet: { radius: 3 } } });
    expect(edgeFeature(big.ctx, "fillet")).toMatchObject({ radius: 0.5 });
    // Nothing picked yet (command-first): the last radius, else 1.
    expect(edgeDraft(used.ctx, "fillet")).toMatchObject({ radius: 2 });
    expect(edgeDraft(fresh.ctx, "fillet")).toMatchObject({ radius: 1 });
  });
});

describe("shell: a tenth of the part's thinnest extent", () => {
  it("rounds the thinnest extent's tenth down", () => {
    expect(shellThicknessFor(bracket.measurements!.boundingBox)).toBe(0.5);
    expect(shellThicknessFor(block.measurements!.boundingBox)).toBe(2);
    expect(shellThicknessFor(null)).toBe(2);
    expect(shellLimit(block.measurements!.boundingBox)).toBeCloseTo(20 / 3, 6);
  });

  it("the Shell tool on the block's top face: 2 mm, or the last wall while it is under a third of the block's thinnest extent", () => {
    const selection = { ...EMPTY_SELECTION, faces: [faceFacing(block, [0, 0, 1])] };
    expect(shellFeature(harness(boxDoc(100, 60, 20), block, { selection }).ctx)).toMatchObject({ op: "shell", thickness: 2 });
    expect(shellFeature(harness(boxDoc(100, 60, 20), block, { selection, memory: { shell: { thickness: 4 } } }).ctx)).toMatchObject({ thickness: 4 });
    expect(shellFeature(harness(boxDoc(100, 60, 20), block, { selection, memory: { shell: { thickness: 8 } } }).ctx)).toMatchObject({ thickness: 2 });
  });
});

describe("hole: the largest M3–M12 whose counterbore sits on the face with a margin", () => {
  it("chooses by the face's narrowest width", () => {
    // Counterbores: M3 6.5, M4 8, M5 9.5, M6 11, M8 14, M10 17.5, M12 20 — each needs twice its diameter.
    expect([5, 13, 16, 19, 22, 28, 35, 40, 200].map(holeSizeFor)).toEqual(["M3", "M3", "M4", "M5", "M6", "M8", "M10", "M12", "M12"]);
  });

  it("the block's 100 × 60 top: 60 wide, so M12; its 60 × 20 end: M5; the bracket's own hole is copied", () => {
    expect(faceWidth(block, faceFacing(block, [0, 0, 1]))).toBeCloseTo(60, 6);
    expect(faceWidth(block, faceFacing(block, [1, 0, 0]))).toBeCloseTo(20, 6);
    expect(newHoleKind(harness(boxDoc(100, 60, 20), block).ctx, faceFacing(block, [0, 0, 1]))).toEqual({ depth: "through", size: "M12" });
    expect(newHoleKind(harness(boxDoc(100, 60, 20), block).ctx, faceFacing(block, [1, 0, 0]))).toEqual({ depth: "through", size: "M5" });
    // Used last in this browser: that size, type and fit.
    const memory: ToolMemory = { hole: { size: "M6", kind: "counterbore", fit: "close" } };
    expect(newHoleKind(harness(boxDoc(100, 60, 20), block, { memory }).ctx, faceFacing(block, [0, 0, 1]))).toEqual({ depth: "through", size: "M6", kind: "counterbore", fit: "close" });
  });
});

describe("pattern: spaced half as much again as the seed is wide", () => {
  it("rounds up to a whole millimetre", () => {
    expect(patternSpacingFor(6.6)).toBe(10);
    expect(patternSpacingFor(10)).toBe(15);
    expect(patternSpacingFor(0.4)).toBe(1);
    expect(patternSpacingFor(0)).toBe(10);
    expect(widthAlong([[0, 0, 0], [3, 4, 0], [-2, 1, 5]], [1, 0, 0])).toBe(5);
  });

  it("the bracket's Ø6.6 hole: 10 mm apart toward -X (the plate's room), three, or the count used last", () => {
    const doc = bracketDoc();
    const hole = (harness(doc, bracket).ctx.resolved as Raw[]).find((f) => f.id === "hole_1");
    expect(patternFeature(harness(doc, bracket, { selected: hole }).ctx, "linearPattern")).toMatchObject({ direction: [-1, 0, 0], spacing: 10, count: 3 });
    expect(patternFeature(harness(doc, bracket, { selected: hole, memory: { linearPattern: { count: 5 } } }).ctx, "linearPattern")).toMatchObject({ count: 5 });
    expect(patternFeature(harness(doc, bracket, { selected: hole, memory: { circularPattern: { count: 6 } } }).ctx, "circularPattern")).toMatchObject({ count: 6 });
  });
});

describe("drafts", () => {
  it("a draft feature starts at 1°, an extrude's draft at 2°", () => {
    expect(DRAFT_ANGLE).toBe(1);
    expect(EXTRUDE_DRAFT_ANGLE).toBe(2);
  });
});

describe("tool memory", () => {
  it("keeps each op's numbers and choices, never an expression; unchanged, the same object", () => {
    let m: ToolMemory = {};
    m = rememberFrom(m, { id: "fillet_1", op: "fillet", radius: 2, edges: { type: "edge" } });
    expect(m).toEqual({ fillet: { radius: 2 } });
    expect(rememberFrom(m, { op: "fillet", radius: 2 })).toBe(m);
    expect(rememberFrom(m, { op: "fillet", radius: "=r" })).toBe(m);
    m = rememberFrom(m, { op: "hole", size: "M8", kind: "counterbore", fit: "normal", diameter: 9 });
    expect(m.hole).toEqual({ size: "M8", kind: "counterbore", fit: "normal" });
    expect(rememberFrom(m, { op: "extrude", distance: 30 })).toBe(m);
    expect(recalled(m, "fillet", "radius")).toBe(2);
    expect(recalled(undefined, "fillet", "radius")).toBeUndefined();
    expect(Object.keys(REMEMBERED)).not.toContain("extrude");
  });

  it("a remembered value suits only while it is a positive number within the part's limit", () => {
    expect(suits(2, 2.4)).toBe(true);
    expect(suits(3, 2.4)).toBe(false);
    expect(suits(0)).toBe(false);
    expect(suits("2")).toBe(false);
    expect(suits(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
