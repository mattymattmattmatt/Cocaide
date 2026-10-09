// The model tools as a registry (Phase O): every tool a ToolDef with its
// command, icon and test id; the CommandManager's tabs and groups laid out
// from it; the right-click menus' tools; and each tool doing what the
// toolbar did before it moved out of App, run against real rebuilds in node.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { loadOC, type OC } from "../src/kernel";
import { edgesSelectorFor } from "../src/kernel/synthesize";
import { ICON_NAMES } from "../src/ui/icons";
import { COMMANDS } from "../src/ui/input";
import { contextTools, MODEL_TOOLS, toolbarGroups, toolById, visibleTabs, type ToolbarEntry } from "../src/ui/model/registry";
import { TABS } from "../src/ui/model/tabs";
import type { Raw, ToolCtx, ToolDef } from "../src/ui/model/ToolContext";
import { deleteBody } from "../src/ui/model/tools/bodies";
import type { LibraryEntry } from "../src/weldment/library";
import { example, faceWhere, harness, unsigned, viewOf } from "./ui-fixtures";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const BLANK: RawDocument = { version: 1, units: "mm", name: "part", features: [] };
const run = (id: string, ctx: ToolCtx) => toolById(id)!.run(ctx);
const ids = (entries: ToolbarEntry[][]) => entries.map((g) => g.map((e) => (e.kind === "tool" ? e.tool.id : `${e.menu.id}: ${e.tools.map((t) => t.id).join(", ")}`)));

describe("the registry", () => {
  it("gives every tool a command in Settings, an icon, and its own id and test id", () => {
    for (const t of MODEL_TOOLS) {
      const cmd = COMMANDS.find((c) => c.id === t.id);
      expect(cmd, t.id).toMatchObject({ group: "Model tools" });
      expect(cmd!.planned, `${t.id} has landed: drop planned from its command`).toBeUndefined();
      expect(ICON_NAMES, t.id).toContain(t.icon);
      expect(t.testId).toMatch(/^tool-[a-z-]+$/);
      if (t.menu) expect(ICON_NAMES).toContain(t.menu.icon);
    }
    expect(new Set(MODEL_TOOLS.map((t) => t.id)).size).toBe(MODEL_TOOLS.length);
    expect(new Set(MODEL_TOOLS.map((t) => t.testId)).size).toBe(MODEL_TOOLS.length);
  });

  it("keeps the toolbar's test ids as they were", () => {
    expect(MODEL_TOOLS.map((t) => t.testId)).toEqual([
      "tool-sketch",
      "tool-extrude",
      "tool-cut",
      "tool-hole",
      "tool-fillet",
      "tool-chamfer",
      "tool-linear-pattern",
      "tool-circular-pattern",
      "tool-mirror",
      "tool-combine",
      "tool-split",
      "tool-move",
      "tool-delete-body",
      "tool-member",
      "tool-plane",
      "tool-axis",
      "tool-point",
    ]);
  });

  it("lays out the CommandManager: Sketch pinned, then each tab's groups in order, patterns in one menu", () => {
    expect(ids(toolbarGroups("pinned"))).toEqual([["tool.sketch"]]);
    expect(ids(toolbarGroups("features"))).toEqual([
      ["tool.extrude", "tool.cut"],
      ["tool.hole", "tool.fillet", "tool.chamfer"],
      ["pattern: tool.linearPattern, tool.circularPattern", "tool.mirror"],
    ]);
    expect(ids(toolbarGroups("bodies"))).toEqual([["tool.combine", "tool.split", "tool.move", "tool.deleteBody"]]);
    expect(ids(toolbarGroups("weldments"))).toEqual([["tool.member"]]);
    expect(ids(toolbarGroups("reference"))).toEqual([["tool.plane", "tool.axis", "tool.point"]]);
  });

  it("shows only the tabs that have tools, in SOLIDWORKS's order", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Features", "Reference", "Bodies", "Weldments", "Evaluate"]);
    expect(visibleTabs().map((t) => t.id)).toEqual(["features", "reference", "bodies", "weldments"]);
  });

  it("orders groups by the tab, puts unknown groups last, and gathers a menu's tools where the first of them is", () => {
    const tool = (id: string, group?: string, menu?: string): ToolDef => ({
      id: `tool.${id}`,
      label: id,
      icon: "extrude",
      tab: "features",
      group,
      title: id,
      testId: `tool-${id}`,
      run: () => undefined,
      ...(menu ? { menu: { id: menu, label: menu, icon: "pattern", title: menu, testId: `tool-${menu}` } } : {}),
    });
    const list = [tool("a", "extra"), tool("b", "pattern", "m"), tool("c", "shape"), tool("d", "pattern"), tool("e", "pattern", "m"), tool("f")];
    expect(ids(toolbarGroups("features", list))).toEqual([["tool.c"], ["m: tool.b, tool.e", "tool.d"], ["tool.a"], ["tool.f"]]);
  });

  it("offers Sketch and Hole on a face, Fillet and Chamfer on an edge", () => {
    expect(contextTools("face").map((t) => t.id)).toEqual(["tool.sketch", "tool.hole"]);
    expect(contextTools("edge").map((t) => t.id)).toEqual(["tool.fillet", "tool.chamfer"]);
    expect(contextTools("part")).toEqual([]);
  });

  it("reserves a command for each tool still to come, out of Settings until it lands", () => {
    const planned = COMMANDS.filter((c) => c.planned).map((c) => c.id);
    for (const id of ["tool.revolve", "tool.sweep", "tool.loft", "tool.shell", "tool.draft", "tool.rib", "tool.scale", "tool.measure", "tool.section", "tool.sketchPattern"]) {
      expect(planned).toContain(id);
    }
    const sketch = ["centerline", "point", "rectCenter", "rect3", "parallelogram", "polygon", "arc3", "tangentArc", "circle3", "slotCenter", "ellipse", "spline", "trim", "extend", "split", "fillet", "chamfer", "offset", "mirror", "linearPattern", "circularPattern", "move", "rotate", "scale", "copy", "convert", "fullyDefine"];
    expect(planned.filter((id) => id.startsWith("sketch.")).sort()).toEqual(sketch.map((s) => `sketch.${s}`).sort());
  });
});

describe("Sketch", () => {
  it("starts on the one flat face selected, by reference to it (so it follows the face); else on Top", () => {
    const doc = example("bracket");
    const view = viewOf(oc, doc);
    const top = faceWhere(view, (f) => f.type === "plane" && f.normal![2] > 0.99);
    const onFace = harness(doc, view, { selection: { faces: [top], edges: [], point: [0, 0, 6] } });
    run("tool.sketch", onFace.ctx);
    expect(onFace.out.sketches).toEqual([{ type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } }]);
    const none = harness(doc, view);
    run("tool.sketch", none.ctx);
    expect(none.out.sketches).toEqual([{ type: "ref", ref: { datum: "Top" } }]);
  });

  it("its menu offers the three planes and the selected face; greyed out on a round face", () => {
    const doc = example("bracket");
    const view = viewOf(oc, doc);
    const wall = faceWhere(view, (f) => f.type === "cylinder");
    const { ctx, out } = harness(doc, view, { selection: { faces: [wall], edges: [] } });
    const items = toolById("tool.sketch")!.items!(ctx);
    expect(items.map((i) => [i.label, i.testId, i.disabled ?? false])).toEqual([
      ["Top (XY)", "plane-top", false],
      ["Front (XZ)", "plane-front", false],
      ["Right (YZ)", "plane-right", false],
      ["On the selected face", "plane-selected-face", true],
    ]);
    items[1].run(ctx);
    expect(out.sketches).toEqual([{ type: "ref", ref: { datum: "Front" } }]);
    items[3].run(ctx);
    expect(out.notices).toEqual([["error", "Click a flat face first, then Sketch → On the selected face."]]);
    // With no face selected, "On selected face" is greyed out.
    expect(toolById("tool.sketch")!.items!(harness(doc, view).ctx)[3].disabled).toBe(true);
  });

  it("is offered on flat faces only, as Hole is", () => {
    const doc = example("bracket");
    const view = viewOf(oc, doc);
    const { ctx } = harness(doc, view);
    const top = faceWhere(view, (f) => f.type === "plane" && f.normal![2] > 0.99);
    const wall = faceWhere(view, (f) => f.type === "cylinder");
    for (const id of ["tool.sketch", "tool.hole"]) {
      const t = toolById(id)!;
      expect(t.contextWhen!(ctx, { kind: "face", index: top })).toBe(true);
      expect(t.contextWhen!(ctx, { kind: "face", index: wall })).toBe(false);
    }
  });
});

describe("Extrude and Cut", () => {
  it("extrude the selected (or latest) sketch 10 mm into the one body there is", () => {
    const doc = example("bracket");
    const { ctx, out } = harness(doc, viewOf(oc, doc));
    run("tool.extrude", ctx);
    expect(out.created).toEqual([{ id: "extrude_1", op: "extrude", sketch: "sketch_1", distance: 10 }]);
  });

  it("in a part of several bodies, extrude makes a new body", () => {
    const doc = example("stand");
    const { ctx, out } = harness(doc, viewOf(oc, doc));
    run("tool.extrude", ctx);
    expect(out.created).toEqual([{ id: "extrude_1", op: "extrude", sketch: "sketch_2", distance: 10, newBody: "body_1" }]);
  });

  it("cut 5 mm toward the material: on a sketch on the top face, downward", () => {
    const doc = example("bracket");
    const onTop = { ...doc, features: [...doc.features, { id: "sketch_2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 6] }, entities: [] }] };
    const { ctx, out } = harness(onTop, viewOf(oc, doc));
    run("tool.cut", ctx);
    const cut = out.created[0];
    // Nothing of the 0..6 mm plate lies above z = 6: the cut goes along -Z.
    expect({ ...cut, direction: unsigned(cut.direction as number[]) }).toEqual({ id: "cut_1", op: "cut", sketch: "sketch_2", distance: 5, direction: [0, 0, -1] });
    // On the plate's bottom sketch (z = 0, the plate above it), along the normal.
    const below = harness(doc, viewOf(oc, doc));
    run("tool.cut", below.ctx);
    expect(below.out.created).toEqual([{ id: "cut_1", op: "cut", sketch: "sketch_1", distance: 5 }]);
  });

  it("with no sketch, say to make one", () => {
    const { ctx, out } = harness(BLANK, null);
    run("tool.extrude", ctx);
    run("tool.cut", ctx);
    expect(out.notices).toEqual([
      ["error", "Make a sketch first, then Extrude."],
      ["error", "Make a sketch first, then Cut."],
    ]);
  });
});

describe("Hole, Fillet, Chamfer", () => {
  it("drills a 5 mm through hole where the flat face was clicked, centre in the face's frame", () => {
    const doc = example("bracket");
    const view = viewOf(oc, doc);
    const top = faceWhere(view, (f) => f.type === "plane" && f.normal![2] > 0.99);
    const { ctx, out } = harness(doc, view, { selection: { faces: [top], edges: [], point: [10, 5, 6] } });
    run("tool.hole", ctx);
    // The top face's frame: origin (0,0,6), x along +X, y along +Y, so (10, 5, 6) is [10, 5].
    expect(out.created).toEqual([{ id: "hole_2", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [10, 5], diameter: 5, depth: "through" }]);
  });

  it("refuses a round face, two faces, or none, saying what to click", () => {
    const doc = example("bracket");
    const view = viewOf(oc, doc);
    const wall = faceWhere(view, (f) => f.type === "cylinder");
    const top = faceWhere(view, (f) => f.type === "plane" && f.normal![2] > 0.99);
    const cases = [{ faces: [wall], edges: [], point: [33.3, 0, 3] }, { faces: [top, wall], edges: [], point: [0, 0, 6] }, { faces: [], edges: [] }];
    const notices = cases.map((selection) => {
      const { ctx, out } = harness(doc, view, { selection: selection as ToolCtx["selection"] });
      run("tool.hole", ctx);
      return out.notices[0]?.[1];
    });
    expect(notices).toEqual(["A hole needs a flat face.", "Click a flat face where the hole goes, then Hole.", "Click a flat face where the hole goes, then Hole."]);
  });

  it("fillets (R1) and chamfers (1 mm) the picked edges, as one selector", () => {
    const doc = example("bracket");
    const view = viewOf(oc, doc);
    const edges = view.edges.flatMap((e, i) => (e.kind === "line" && e.direction![2] !== 0 && Math.abs(e.direction![2]) > 0.99 ? [i] : [])).slice(0, 2);
    const s = edgesSelectorFor(view.edges, view.faces, edges);
    expect(s.ok).toBe(true);
    const { ctx, out } = harness(doc, view, { selection: { faces: [], edges } });
    run("tool.fillet", ctx);
    run("tool.chamfer", ctx);
    expect(out.created).toEqual([
      { id: "fillet_1", op: "fillet", edges: (s as { selector: unknown }).selector, radius: 1 },
      { id: "chamfer_1", op: "chamfer", edges: (s as { selector: unknown }).selector, distance: 1 },
    ]);
    const none = harness(doc, view);
    run("tool.fillet", none.ctx);
    expect(none.out.notices).toEqual([["error", "Click one or more edges (shift-click for more), then Fillet."]]);
  });
});

describe("Pattern and Mirror", () => {
  it("pattern the feature selected in the tree", () => {
    const doc = example("bracket");
    const view = viewOf(oc, doc);
    const hole = (harness(doc, view).ctx.resolved as Raw[]).find((f) => f.id === "hole_1");
    const { ctx, out } = harness(doc, view, { selected: hole });
    run("tool.linearPattern", ctx);
    run("tool.circularPattern", ctx);
    expect(out.created).toEqual([
      { id: "pattern_1", op: "linearPattern", feature: "hole_1", direction: [1, 0, 0], spacing: 10, count: 3 },
      { id: "circular_1", op: "circularPattern", feature: "hole_1", axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: 4 },
    ]);
    const none = harness(doc, view);
    run("tool.linearPattern", none.ctx);
    expect(none.out.notices).toEqual([["error", "Select an extrude, cut, hole or member in the feature tree, then Pattern."]]);
  });

  it("mirror the selected feature about the part's middle, or the clicked body beside itself", () => {
    const doc = example("stand");
    const view = viewOf(oc, doc);
    const hole = harness(doc, view).ctx.resolved.find((f) => f.id === "hole_1");
    const feature = harness(doc, view, { selected: hole });
    run("tool.mirror", feature.ctx);
    // The stand spans x -60..60: its middle is x = 0.
    expect(feature.out.created).toEqual([{ id: "mirror_1", op: "mirror", plane: { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] }, feature: "hole_1" }]);
    const base = faceWhere(view, (f) => f.body === "base");
    const body = harness(doc, view, { selection: { faces: [base], edges: [] } });
    run("tool.mirror", body.ctx);
    // The base's far side is x = 60.
    expect(body.out.created).toEqual([{ id: "mirror_1", op: "mirror", plane: { type: "datum", normal: [1, 0, 0], origin: [60, 0, 0] }, bodies: ["base"] }]);
  });
});

describe("the body tools", () => {
  it("combine the clicked body (else the second) into the other; greyed out with one body", () => {
    const stand = example("stand");
    const { ctx, out } = harness(stand, viewOf(oc, stand));
    run("tool.combine", ctx);
    expect(out.created).toEqual([{ id: "combine_1", op: "combine", operation: "add", target: "base", tools: ["upright"] }]);
    const bracket = example("bracket");
    expect(toolById("tool.combine")!.disabled!(harness(bracket, viewOf(oc, bracket)).ctx)).toBe("Combine needs two or more bodies");
    expect(toolById("tool.combine")!.disabled!(ctx)).toBeUndefined();
  });

  it("split the newest body at its middle, move a copy of it beside itself, delete it", () => {
    const stand = example("stand");
    const { ctx, out } = harness(stand, viewOf(oc, stand));
    run("tool.split", ctx);
    run("tool.move", ctx);
    run("tool.deleteBody", ctx);
    // The upright spans x -60..60 (120 wide): split at x = 0, the copy 120 + 20 mm along X.
    expect(out.created).toEqual([
      { id: "split_1", op: "split", body: "upright", plane: { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] } },
      { id: "move_1", op: "move", bodies: ["upright"], translate: [140, 0, 0], copy: true },
      { id: "delete_1", op: "deleteBody", bodies: ["upright"] },
    ]);
  });

  it("never delete a part's only body", () => {
    const bracket = example("bracket");
    const { ctx, out } = harness(bracket, viewOf(oc, bracket));
    expect(toolById("tool.deleteBody")!.disabled!(ctx)).toBe("A part needs at least one body");
    deleteBody(ctx, "main");
    expect(out.notices).toEqual([["error", "A part's only body can't be deleted."]]);
    expect(out.created).toEqual([]);
  });
});

describe("Member", () => {
  it("with nothing to copy, open Sections and say what to do", () => {
    const empty = harness(BLANK, null);
    run("tool.member", empty.ctx);
    expect(empty.out.tabs).toEqual(["sections"]);
    expect(empty.out.notices).toEqual([["info", "The section library is empty: draw a section as a sketch, tick Weldment profile and finish it."]]);
    const stocked = harness(BLANK, null, { library: [{ id: "x" } as LibraryEntry] });
    run("tool.member", stocked.ctx);
    expect(stocked.out.notices).toEqual([["info", "Pick a size in Sections, then + Member."]]);
  });

  it("adds another like the last member, as one undo step, and selects it", () => {
    const doc = example("frame-members");
    const { ctx, out } = harness(doc, null);
    run("tool.member", ctx);
    expect(out.replaced).toHaveLength(1);
    const [next, id] = out.replaced[0];
    expect(id).toBe("member_1");
    const last = doc.features.filter((f) => f.op === "member").at(-1)!;
    expect(next.features.at(-1)).toMatchObject({ id: "member_1", op: "member", profile: last.profile, size: last.size });
  });
});
