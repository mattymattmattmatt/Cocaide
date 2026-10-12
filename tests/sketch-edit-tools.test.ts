// The sketch edit tool registry (src/ui/sketcher/edit), driven as the
// sketcher drives it: clicks with what is under the pointer, picks, options,
// Apply. Exact results; the geometry itself is tested in sketch-trim,
// sketch-fillet-offset and sketch-mirror-pattern.

import { describe, expect, it } from "vitest";
import type { Constraint, SketchEntity, Vec2 } from "../src/doc/types";
import { COMMANDS } from "../src/ui/input";
import { ICON_NAMES } from "../src/ui/icons";
import { EDIT_TOOLS, editByName } from "../src/ui/sketcher/edit";
import { offsetOptions } from "../src/ui/sketcher/edit/offset";
import { NO_PICKS, type EditInput, type EditPicks, type EditStep } from "../src/ui/sketcher/edit/types";
import type { SketchItem } from "../src/ui/sketcher/draft";
import { optionValues, toolbarEntries } from "../src/ui/sketcher/tools/run";
import type { Edit, SketchState } from "../src/geom/sketchEdit/relations";

const tool = (name: string) => editByName(name)!;
const options = (name: string, over: Record<string, number | string> = {}) => ({ ...optionValues(tool(name)), ...over });
const at = (p: Vec2, item: SketchItem | null = null, extra: Partial<EditInput> = {}): EditInput => ({ p, item, ref: null, tol: 0.5, ...extra });
const entity = (id: string): SketchItem => ({ kind: "entity", id });
const point = (ref: string): SketchItem => ({ kind: "point", ref });
const picks = (s: EditStep): EditPicks => {
  if (!("picks" in s)) throw new Error(JSON.stringify(s));
  return s.picks;
};
const edit = (s: EditStep | Edit | string | null | undefined): Edit => {
  const r = s && typeof s === "object" && "edit" in s ? s.edit : s;
  if (!r || typeof r === "string" || "message" in r || "picks" in r) throw new Error(JSON.stringify(r));
  return r as Edit;
};
const line = (id: string, start: Vec2, end: Vec2, extra: Partial<SketchEntity> = {}): SketchEntity => ({ id, type: "line", start, end, ...extra }) as SketchEntity;

/** A 40 × 30 rectangle of four joined lines. */
function rectangle(): SketchState {
  const p: Vec2[] = [[0, 0], [40, 0], [40, 30], [0, 30]];
  return {
    entities: p.map((a, i) => line(`l${i + 1}`, a, p[(i + 1) % 4])),
    constraints: p.map((_, i): Constraint => ({ type: "coincident", points: [`l${i + 1}.end`, `l${((i + 1) % 4) + 1}.start`] })),
  };
}

describe("the edit tool registry", () => {
  it("each tool is a live Sketch command with an icon and a unique name; the flyouts group them", () => {
    const names = new Set<string>();
    for (const t of EDIT_TOOLS) {
      const cmd = COMMANDS.find((c) => c.id === t.id);
      expect(cmd, t.id).toBeDefined();
      expect(cmd!.planned, t.id).toBeUndefined();
      expect(cmd!.group).toBe("Sketch");
      expect(ICON_NAMES).toContain(t.icon);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      if (t.kind === "collect") expect(t.apply, t.name).toBeDefined();
    }
    const entries = toolbarEntries(EDIT_TOOLS).map((e) => (e.kind === "flyout" ? `${e.flyout.label} ▾ ${e.tools.map((t) => t.label).join("/")}` : e.tool.label));
    expect(entries).toEqual(["Trim ▾ Trim/Extend/Split", "Fillet ▾ Fillet/Chamfer", "Offset", "Mirror", "Pattern ▾ Linear pattern/Circular pattern", "Move ▾ Move/Copy/Rotate/Scale"]);
    expect(COMMANDS.find((c) => c.id === "sketch.trim")!.key).toBe("T");
    for (const id of ["sketch.explode", "sketch.check"]) expect(COMMANDS.find((c) => c.id === id)).toBeDefined();
  });
});

describe("trim, extend, split", () => {
  const crossed = (): SketchState => ({ entities: [line("l1", [0, 0], [30, 0]), line("l2", [10, -5], [10, 5]), line("l3", [20, -5], [20, 5])], constraints: [] });

  it("trims the piece under the pointer, shows it first, and says when nothing is there", () => {
    const t = tool("trim");
    expect(t.preview!(crossed(), NO_PICKS, {}, at([15, 0.2])).remove).toEqual([{ id: "trim-preview", type: "line", start: [10, 0], end: [20, 0] }]);
    const r = edit(t.click(crossed(), NO_PICKS, at([15, 0.2]), {}));
    expect(r.entities.filter((e) => e.type === "line")).toHaveLength(4);
    expect(t.click(crossed(), NO_PICKS, at([15, 3]), {})).toEqual({ message: expect.stringContaining("click on a line") });
  });

  it("power trims along a drag, and gives nothing for a drag across nothing", () => {
    const t = tool("trim");
    const r = edit(t.drag!(crossed(), [[5, 2], [25, 2]], {}));
    // The stroke crossed l2 and l3 above l1: their upper pieces went.
    expect(r.entities.find((e) => e.id === "l2")).toMatchObject({ start: [10, -5], end: [10, 0] });
    expect(r.entities.find((e) => e.id === "l3")).toMatchObject({ start: [20, -5], end: [20, 0] });
    expect(t.drag!(crossed(), [[0, 10], [30, 10]], {})).toBeNull();
  });

  it("extends to the next entity and splits exactly on the curve", () => {
    const s: SketchState = { entities: [line("l1", [0, 0], [5, 0]), line("l2", [10, -5], [10, 5])], constraints: [] };
    expect(tool("extend").preview!(s, NO_PICKS, {}, at([4.8, 0.1])).add).toEqual([{ id: "extend-preview", type: "line", start: [0, 0], end: [10, 0] }]);
    expect(edit(tool("extend").click(s, NO_PICKS, at([4.8, 0.1]), {})).entities[0]).toMatchObject({ end: [10, 0] });
    const split = edit(tool("split").click(s, NO_PICKS, at([2, 0.3]), {}));
    expect(split.entities.filter((e) => e.type === "line").map((e) => (e as { start: Vec2; end: Vec2 }).end)).toEqual([[2, 0], [5, 0], [10, 5]]);
  });
});

describe("fillet and chamfer", () => {
  it("collects corners by their points (a corner picked twice counts once), and applies one radius", () => {
    const t = tool("fillet");
    let p = picks(t.click(rectangle(), NO_PICKS, at([40, 0], point("l1.end")), options("fillet")));
    p = picks(t.click(rectangle(), p, at([40, 0], point("l2.start")), options("fillet")));
    expect(t.prompt(p, options("fillet"))).toContain("2 picks");
    const r = edit(t.apply!(rectangle(), p, options("fillet", { radius: 4 })));
    expect(r.made).toEqual(["a1"]);
    expect(r.constraints).toContainEqual({ type: "radius", entity: "a1", value: 4 });
    expect(t.preview!(rectangle(), p, options("fillet", { radius: 4 }), null).add!.map((e) => e.id).sort()).toEqual(["a1", "l1", "l2"]);
  });

  it("starts from a selected rectangle's sides (all its corners), and refuses a circle", () => {
    const t = tool("fillet");
    const p = t.start!(["l1", "l2", "l3", "l4"].map(entity), rectangle());
    expect(edit(t.apply!(rectangle(), p, options("fillet"))).made).toEqual(["a1", "a2", "a3", "a4"]);
    const withCircle = { ...rectangle(), entities: [...rectangle().entities, { id: "c1", type: "circle", center: [5, 5], radius: 1 } as SketchEntity] };
    expect(t.click(withCircle, NO_PICKS, at([6, 5], entity("c1")), options("fillet"))).toEqual({ message: expect.stringContaining("c1 is a circle") });
    expect(t.apply!(rectangle(), NO_PICKS, options("fillet"))).toBeNull();
  });

  it("chamfers equal distances, or by an angle", () => {
    const t = tool("chamfer");
    const p = { ...NO_PICKS, points: ["l1.end"] };
    const r = edit(t.apply!(rectangle(), p, options("chamfer", { distance: 3 })));
    expect(r.entities.find((e) => e.id === "l5")).toEqual({ id: "l5", type: "line", start: [37, 0], end: [40, 3] });
    const a = edit(t.apply!(rectangle(), p, options("chamfer", { mode: "angle", distance: 3, angle: 30 })));
    const l5 = a.entities.find((e) => e.id === "l5") as Extract<SketchEntity, { type: "line" }>;
    expect(l5.end[1]).toBeCloseTo(3 * Math.tan(Math.PI / 6), 9);
  });
});

describe("offset", () => {
  it("goes outside a closed chain unless reversed; to the left of an open one", () => {
    const s = rectangle();
    expect(offsetOptions(s, { ...NO_PICKS, entities: ["l1"] }, options("offset")).side).toBe(-1);
    expect(offsetOptions(s, { ...NO_PICKS, entities: ["l1"] }, options("offset", { reverse: "on" })).side).toBe(1);
    const open: SketchState = { entities: [line("l1", [0, 0], [10, 0])], constraints: [] };
    expect(offsetOptions(open, { ...NO_PICKS, entities: ["l1"] }, options("offset")).side).toBe(1);
    const r = edit(tool("offset").apply!(s, { ...NO_PICKS, entities: ["l1"] }, options("offset", { distance: 2 })));
    expect(r.entities.find((e) => e.id === "l5")).toEqual({ id: "l5", type: "line", start: [-2, -2], end: [42, -2] });
    expect(tool("offset").preview!(s, { ...NO_PICKS, entities: ["l1"] }, options("offset", { distance: 2 }), null).add).toHaveLength(4);
  });
});

describe("mirror", () => {
  const s = (): SketchState => ({ entities: [line("l1", [5, 0], [10, 5]), line("l2", [0, -10], [0, 10], { construction: true }), line("l3", [5, 5], [5, 9])], constraints: [] });

  it("takes a centreline clicked after the entities as the mirror line; another line only after Mirror about", () => {
    const t = tool("mirror");
    let p = picks(t.click(s(), NO_PICKS, at([7, 2], entity("l1")), options("mirror")));
    p = picks(t.click(s(), p, at([5, 6], entity("l3")), options("mirror")));
    expect(p.entities).toEqual(["l1", "l3"]);
    expect(p.about).toBeUndefined();
    p = picks(t.click(s(), p, at([0, 3], entity("l2")), options("mirror")));
    expect(p.about).toBe("l2");
    const r = edit(t.apply!(s(), p, options("mirror")));
    expect(r.made).toEqual(["l4", "l5"]);
    // A plain line becomes the mirror line once Mirror about is pressed.
    const q = picks(t.click(s(), { ...NO_PICKS, entities: ["l1"], picking: false }, at([5, 6], entity("l3")), options("mirror")));
    expect(q.about).toBe("l3");
    // The X axis is a mirror line at once.
    expect(picks(t.click(s(), { ...NO_PICKS, entities: ["l1"] }, at([20, 0], entity("X")), options("mirror"))).about).toBe("X");
  });

  it("starts with a selected centreline as the mirror line", () => {
    expect(tool("mirror").start!([entity("l1"), entity("l2")], s())).toMatchObject({ entities: ["l1"], about: "l2" });
  });
});

describe("patterns", () => {
  const s = (): SketchState => ({ entities: [{ id: "c1", type: "circle", center: [10, 0], radius: 1 }, { id: "p1", type: "point", at: [0, 10] }], constraints: [] });

  it("marks each place; a click on one skips it and back", () => {
    const t = tool("linear-pattern");
    const p0 = { ...NO_PICKS, entities: ["c1"] };
    const o = options("linear-pattern", { count: 3, spacing: 10, angle: 0 });
    expect(t.preview!(s(), p0, o, null).marks!.map((m) => m.at)).toEqual([[20, 0], [30, 0]]);
    const p1 = picks(t.click(s(), p0, at([30.2, 0]), o));
    expect(p1.skip).toEqual([3]);
    expect(edit(t.apply!(s(), p1, o)).entities.filter((e) => e.type === "circle")).toHaveLength(2);
    expect(picks(t.click(s(), p1, at([30, 0]), o)).skip).toEqual([]);
  });

  it("a circular pattern goes round a sketch point clicked as its centre", () => {
    const t = tool("circular-pattern");
    const p = picks(t.click(s(), { ...NO_PICKS, entities: ["c1"] }, at([0, 10], point("p1.at")), options("circular-pattern")));
    expect(p.points).toEqual(["p1.at"]);
    expect(t.prompt(p, options("circular-pattern"))).toContain("round p1.at");
    const r = edit(t.apply!(s(), p, options("circular-pattern", { count: 4, total: 360 })));
    const c = r.entities.filter((e): e is Extract<SketchEntity, { type: "circle" }> => e.type === "circle").map((x) => x.center.map((v) => Math.round(v * 1e9) / 1e9));
    expect(c).toEqual([[10, 0], [10, 20], [-10, 20], [-10, 0]]);
  });
});

describe("move, copy, rotate, scale", () => {
  const s = (): SketchState => ({ entities: [line("l1", [0, 0], [10, 0]), line("l2", [0, 5], [10, 5])], constraints: [{ type: "horizontal", entity: "l1" }] });

  it("picks the entities, goes on with a click in space, then moves by a base point and where it goes", () => {
    const t = tool("move");
    let p = t.start!([], s());
    expect(p.picking).toBe(true);
    p = picks(t.click(s(), p, at([5, 0], entity("l1")), options("move")));
    expect(t.places!(p, options("move"))).toBe(false);
    p = picks(t.click(s(), p, at([50, 50]), options("move")));
    expect(t.places!(p, options("move"))).toBe(true);
    p = picks(t.click(s(), p, at([0, 0], null, { ref: "l1.start" }), options("move")));
    const r = edit(t.click(s(), p, at([3, 4]), options("move")));
    expect(r.entities[0]).toEqual({ id: "l1", type: "line", start: [3, 4], end: [13, 4] });
    expect(r.constraints).toEqual([{ type: "horizontal", entity: "l1" }]);
  });

  it("applies typed values: a copy moved by ΔX, ΔY; a rotation about the origin; a scale", () => {
    const sel = [entity("l1")];
    const copy = edit(tool("copy").apply!(s(), tool("copy").start!(sel, s()), options("copy", { dx: 0, dy: 20 })));
    expect(copy.entities.find((e) => e.id === "l3")).toEqual({ id: "l3", type: "line", start: [0, 20], end: [10, 20] });
    const turned = edit(tool("rotate").apply!(s(), tool("rotate").start!(sel, s()), options("rotate", { angle: 90 })));
    const l1 = turned.entities[0] as Extract<SketchEntity, { type: "line" }>;
    expect(l1.end.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 10]);
    expect(turned.constraints).toEqual([]);
    const big = edit(tool("scale").apply!(s(), tool("scale").start!([entity("l1"), entity("l2")], s()), options("scale", { factor: 3 })));
    expect(big.entities[1]).toEqual({ id: "l2", type: "line", start: [0, 15], end: [30, 15] });
  });
});

describe("on the canvas", () => {
  it("draws an offset's one dimension across its first pair, and a symmetric pair's glyphs on both entities", async () => {
    const { dimensionShapes, relationGlyphs } = await import("../src/ui/sketcher/annotate");
    const r = edit(tool("offset").apply!(rectangle(), { ...NO_PICKS, entities: ["l1"] }, options("offset", { distance: 2 })));
    const dims = dimensionShapes(r.entities, r.constraints, 0.1);
    const k = r.constraints.findIndex((c) => c.type === "offset");
    expect(dims.find((d) => d.index === k)?.text).toBe("2");
    const m = edit(tool("mirror").apply!({ entities: [line("l1", [1, 0], [2, 3])], constraints: [] }, { ...NO_PICKS, entities: ["l1"], about: "Y" }, options("mirror")));
    expect(relationGlyphs(m.entities, m.constraints, 0.1).filter((g) => m.constraints[g.index].type === "symmetric")).toHaveLength(2);
  });
});
