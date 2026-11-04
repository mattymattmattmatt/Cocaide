// Phase Q wave Q2B: the sheet editor's pure parts — zoom and pan, view
// alignment while dragging, the tool registry, the property schemas and the
// panel drawn from them, snapping to view geometry (with the real kernel on
// the bracket), and the new view fields and ask scopes.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { scopeFor } from "../src/ask/packet";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { scopeProblem } from "../src/doc/scope";
import { allErrors, validateDocument } from "../src/doc/validate";
import type { DrawingView } from "../src/doc/types";
import { composeDrawing, viewToSheet, type ComposedSheet } from "../src/drafting/compose";
import { viewSpecs } from "../src/drafting/specs";
import { getOC, loadOC } from "../src/kernel";
import { across, alignmentOf, attachSide, constrain, followers, keepOff, pulledOff, snapToViews } from "../src/ui/drawing/align";
import { monoSheet } from "../src/ui/drawing/Dialogs";
import { nearestOnPolyline, snapAt, snapIndex, snapLabel, type SnapIndex } from "../src/ui/drawing/snap";
import "../src/ui/drawing/tools";
import { alignedCoordinate, extendThrough, sheetToView, squareTurn, squareUp } from "../src/ui/drawing/tools/geometry";
import { annotationKind, dimensionLine, offsetFor } from "../src/ui/drawing/tools/kinds";
import { drawingTool, registerDrawingTool, toolForKey, toolGroups, unregisterDrawingTool, TOOL_SLOTS } from "../src/ui/drawing/tools/registry";
import { SchemaForm } from "../src/ui/drawing/tools/SchemaForm";
import { applyPatch, getPath, readField, setPath, writeField, type PropField } from "../src/ui/drawing/tools/schema";
import { projectSide } from "../src/ui/drawing/tools/viewTools";
import { areaBox, fitBox, mmPerPixel, panBy, reshape, toHost, toUser, zoomAt, zoomPercent } from "../src/ui/drawing/zoom";

const close = (a: number[], b: number[], d = 9) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], d));

describe("zoom and pan", () => {
  it("fits an A3 sheet in a 1000 × 500 host: 420 × 1.08 = 453.6 wide, 297 × 1.08 = 320.76 high, widened to the host's 2:1", () => {
    const b = fitBox(420, 297, 1000, 500);
    // 320.76 × 2 = 641.52 across; centred: (420 − 641.52) / 2 = −110.76, (297 − 320.76) / 2 = −11.88.
    close(b, [-110.76, -11.88, 641.52, 320.76]);
    // A tall host keeps the width and grows the height: 453.6 / 0.5 = 907.2.
    close(fitBox(420, 297, 500, 1000), [-16.8, -305.1, 453.6, 907.2]);
  });

  it("zooms about the cursor: the point under it stays put, within the limits", () => {
    const b = zoomAt([0, 0, 400, 200], [100, 50], 2, 420);
    // Half as wide, and 100 is still a quarter of the way across: 50 + 200/4 = 100.
    close(b, [50, 25, 200, 100]);
    const host = 1000;
    const [px, py] = toHost([0, 0, 400, 200], host, 100, 50);
    close(toUser(b, host, px, py), [100, 50]);
    // At most 6 sheets wide, at least 4 mm.
    expect(zoomAt([0, 0, 400, 200], [0, 0], 0.01, 420)[2]).toBeCloseTo(2520, 9);
    expect(zoomAt([0, 0, 400, 200], [0, 0], 1000, 420)[2]).toBe(4);
  });

  it("pans with the pointer, reshapes about the middle, zooms to an area, and says the zoom", () => {
    // 100 px in a 1000 px host showing 400 mm: 40 mm.
    close(panBy([0, 0, 400, 200], 100, -50, 1000), [-40, 20, 400, 200]);
    close(reshape([0, 0, 400, 200], 1000, 1000), [0, -100, 400, 400]);
    close(areaBox([0, 0], [100, 50], 1000, 500)!, [0, 0, 100, 50]);
    // A tall area in a wide host: 50 high → 100 wide about x 25.
    close(areaBox([0, 0], [50, 50], 1000, 500)!, [-25, 0, 100, 50]);
    expect(areaBox([0, 0], [0.2, 0.2], 1000, 500)).toBeNull();
    expect(mmPerPixel([0, 0, 400, 200], 1000)).toBe(0.4);
    // 1000 px over 264.58 mm is the sheet at its size on a 96 dpi screen (3.7795 px/mm).
    expect(zoomPercent([0, 0, 264.583, 100], 1000)).toBe(100);
  });
});

const views: DrawingView[] = [
  { id: "front", look: "front" },
  { id: "top", kind: "projected", parent: "front", direction: "up" },
  { id: "right", kind: "projected", parent: "front", direction: "right" },
  { id: "iso", kind: "projected", parent: "front", direction: "upRight" },
  { id: "A", kind: "section", parent: "top", line: [[0, 10], [0, -10]] },
  { id: "B", kind: "detail", parent: "right", circle: { at: [0, 0], r: 3 } },
];

describe("dragging views: alignment", () => {
  it("knows the side each lined-up view sits on: a projected view's, a section square to the sheet's", () => {
    expect(attachSide(views[1], "third")).toEqual([0, 1]);
    expect(attachSide(views[2], "third")).toEqual([1, 0]);
    expect(attachSide(views[3], "third")).toBeNull(); // a corner: placed freely
    // Drawn downwards, the viewer is left of the line, at +x; first angle puts the section on the other side.
    expect(attachSide(views[4], "third")).toEqual([1, 0]);
    expect(attachSide(views[4], "first")).toEqual([-1, 0]);
    expect(attachSide({ ...views[2], free: true }, "third")).toBeNull();
    expect(attachSide(views[5], "third")).toBeNull();
  });

  it("keeps a drag to the view's line, says when it is pulled off, and names who follows", () => {
    const right = alignmentOf(views[2], views, "third");
    expect(right).toEqual({ axis: 0, parent: "front", side: [1, 0] });
    expect(constrain([12, 7], right)).toEqual([12, 0]);
    expect(across([12, 7], right)).toBe(7);
    expect(pulledOff([2, 30], right)).toBe(true);
    expect(pulledOff([30, 2], right)).toBe(false);
    expect(constrain([12, 7], alignmentOf(views[0], views, "third"))).toEqual([12, 7]);
    // The front takes the top and right with it, and the top its section; the iso (a corner) and the detail stay.
    expect(followers("front", views, "third")).toEqual(["top", "A", "right"]);
  });

  it("snaps a view's edge or centre to another's, and keeps it off the title block", () => {
    const box = { min: [0, 0] as [number, number], max: [10, 10] as [number, number] };
    // The other's bottom is 0.5 higher: the edges line up with a move of 0.5.
    const s = snapToViews(box, [0, 0], [{ id: "x", box: { min: [20, 0.5], max: [30, 10.5] } }], 1);
    expect(s.delta).toEqual([0, 0.5]);
    expect(s.guides).toEqual([{ axis: 1, at: 0.5, to: "x" }]);
    // Locked to x: no snap down.
    expect(snapToViews(box, [0, 0], [{ id: "x", box: { min: [20, 0.5], max: [30, 10.5] } }], 1, 0).delta).toEqual([0, 0]);
    const frame = { min: [0, 0] as [number, number], max: [100, 100] as [number, number] };
    const title = { min: [50, 0] as [number, number], max: [100, 20] as [number, number] };
    // Dropped on the title block (centre 75, 10): the nearest free place is just above it (20 + 2 gap).
    const d = keepOff(box, [70, 5], [title], frame, 2);
    expect(d).toEqual([70, 22]);
    // Off the paper's edge: pushed back inside.
    expect(keepOff(box, [-5, 40], [title], frame, 2)).toEqual([0, 40]);
  });

  it("finds where a lined-up view sits across: the parent's line, the same model point", () => {
    // Parent centred at (100, 50) drawing view point (2, 3) there at 1:2; the child's (2, 7): its y on the sheet is 50 + (7 − 3)/2 = 52.
    expect(alignedCoordinate({ origin: [2, 7], scale: 0.5 }, { centre: [100, 50], origin: [2, 3], scale: 0.5 }, [1, 0])).toEqual({ axis: 1, value: 52 });
    expect(alignedCoordinate({ origin: [2, 7], scale: 1 }, { centre: [100, 50], origin: [2, 3], scale: 0.5 }, [1, 0])).toBeNull();
  });
});

describe("tool geometry", () => {
  it("turns a sheet point into the view's millimetres and back, breaks and all", () => {
    const cv = { centre: [200, 150] as [number, number], origin: [10, 0] as [number, number], scale: 0.5, breaks: [] };
    close(sheetToView(cv, [210, 160]), [30, 20]);
    const broken = { ...cv, breaks: [{ axis: 0 as const, from: 100, to: 300, gap: 10, style: "zigzag" as const }] };
    for (const p of [[50, 5], [350, -4], [150, 2]] as [number, number][]) close(sheetToView(broken, viewToSheet(broken, p)), p, 6);
  });

  it("runs a cutting line past the part, squares a line up, turns an offset line square", () => {
    const outline = { min: [-40, -20] as [number, number], max: [40, 20] as [number, number] };
    // Vertical through x = 30, drawn from y 10 to −10: on to the outline's top and bottom, 3 past.
    expect(extendThrough([30, 10], [30, -10], outline, 3)).toEqual([[30, 23], [30, -23]]);
    expect(squareUp([0, 0], [10, 2])).toEqual([10, 0]);
    expect(squareUp([0, 0], [1, -9])).toEqual([0, -9]);
    expect(squareTurn([0, 0], [10, 0], [12, 7])).toEqual([10, 7]);
    expect(projectSide({ min: [0, 0], max: [10, 10] }, [20, 5])).toBe("right");
    expect(projectSide({ min: [0, 0], max: [10, 10] }, [5, -9])).toBe("down");
    expect(projectSide({ min: [0, 0], max: [10, 10] }, [20, 20])).toBe("upRight");
  });
});

describe("the tool registry", () => {
  it("shows every slot of a tab, the ones still to come among them", () => {
    const layout = toolGroups("layout").flat();
    expect(layout.map((e) => (e.kind === "tool" ? e.tool.id : e.slot.id))).toEqual(TOOL_SLOTS.filter((s) => s.tab === "layout").map((s) => s.id));
    expect(layout.find((e) => e.kind === "coming")).toMatchObject({ slot: { id: "view.alternate" } });
    const annotation = toolGroups("annotation").flat();
    expect(annotation.filter((e) => e.kind === "coming").map((e) => (e.kind === "coming" ? e.slot.id : ""))).toEqual(["annotation.modelItems", "annotation.surface", "annotation.gdt", "annotation.datum"]);
    expect(toolForKey("d")?.id).toBe("annotation.smartDimension");
  });

  it("lets a later wave fill a slot, or add a tool of its own to a group", () => {
    registerDrawingTool({ id: "annotation.gdt", tab: "annotation", group: "symbols", label: "GD&T", icon: "grid", title: "frames", run: () => undefined });
    registerDrawingTool({ id: "annotation.extra", tab: "annotation", group: "symbols", label: "Extra", icon: "grid", title: "more", key: "Q", run: () => undefined });
    const symbols = toolGroups("annotation").find((g) => g.some((e) => e.kind === "tool" && e.tool.id === "annotation.gdt"))!;
    expect(symbols.map((e) => (e.kind === "tool" ? `tool:${e.tool.id}` : `coming:${e.slot.id}`))).toEqual(["coming:annotation.surface", "tool:annotation.weld", "tool:annotation.gdt", "coming:annotation.datum", "tool:annotation.extra"]);
    expect(toolForKey("q")?.id).toBe("annotation.extra");
    unregisterDrawingTool("annotation.gdt");
    unregisterDrawingTool("annotation.extra");
    expect(drawingTool("annotation.gdt")).toBeUndefined();
  });
});

describe("property schemas", () => {
  const num: PropField = { key: "offset", label: "Offset", kind: "number", optional: true };
  it("reads and writes paths, numbers, choices and points", () => {
    const a = { id: "c1", type: "centerline", view: "top", between: ["top:ea", "top:eb"] };
    expect(getPath(a, "between.1")).toBe("top:eb");
    expect(setPath(a, "between.1", "top:cx")).toEqual({ between: ["top:ea", "top:cx"] });
    expect(setPath({ style: { textSize: 3 } }, "style.textSize", undefined)).toEqual({ style: null });
    expect(writeField({}, num, "12,5")).toEqual({ patch: { offset: 12.5 } });
    expect(writeField({ offset: 3 }, num, "")).toEqual({ patch: { offset: null } });
    expect(writeField({}, { ...num, optional: false }, "")).toEqual({ error: "Offset can't be empty" });
    expect(writeField({}, { ...num, positive: true }, "-2")).toEqual({ error: "Offset must be more than 0 (got -2)" });
    expect(writeField({}, num, "ten")).toEqual({ error: 'Offset must be a number (got "ten")' });
    const at: PropField = { key: "at", label: "At", kind: "vec2" };
    expect(writeField({}, at, "12, -4")).toEqual({ patch: { at: [12, -4] } });
    expect(readField({ at: [12, -4] }, at)).toBe("12, -4");
    const dir: PropField = { key: "direction", label: "Direction", kind: "select", options: ["horizontal", "vertical"] };
    expect(writeField({}, dir, "sideways", [{ value: "horizontal", label: "" }])).toEqual({ error: 'Direction must be one of horizontal (got "sideways")' });
    expect(applyPatch({ id: "d1", offset: 3, at: [1, 2] }, { offset: null, at: [3, 4] })).toEqual({ id: "d1", at: [3, 4] });
  });

  it("draws the dimension's panel from its schema: its fields, its choices, a pick button for its points", () => {
    const doc = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
    const k = annotationKind("dimension")!;
    const a = { id: "d1", type: "dimension", view: "top", from: "@left", to: "top:chole_1/c1", offset: 12 };
    const sheetDoc = { id: "s1", format: { size: "A3" as const }, projection: "third" as const, views: [{ id: "top", look: "top" as const }], annotations: [] };
    const html = renderToStaticMarkup(createElement(SchemaForm, { schema: k.schema, value: a, env: { doc, drawing: { sheets: [sheetDoc] }, sheetDoc, sheet: null, measurements: null }, prefix: "prop-dimension", onPatch: () => null, onArm: () => undefined }));
    for (const id of ["prop-dimension-view", "prop-dimension-from", "prop-dimension-to", "prop-dimension-direction", "prop-dimension-offset", "prop-dimension-from-pick"]) expect(html).toContain(`data-testid="${id}"`);
    // No member: the member row is not shown. The hole and the view's sides are offered.
    expect(html).not.toContain("prop-dimension-member");
    expect(html).toContain('value="hole_1"');
    expect(html).toContain('value="@left"');
    expect(html).toContain('value="top:chole_1/c1"');
  });
});

describe("dragging annotations", () => {
  it("turns a dimension line's place into its offset: above or right is +, below or left −, at least 4 off the view", () => {
    const view = { min: [0, 50] as [number, number], max: [100, 100] as [number, number] };
    expect(offsetFor("h", 120, view)).toBe(20);
    expect(offsetFor("h", 40, view)).toBe(-10);
    expect(offsetFor("h", 101, view)).toBe(4);
    expect(offsetFor("h", 60, view)).toBe(-4);
    expect(offsetFor("v", 130, view)).toBe(30);
  });

  it("finds a dimension's line among its own: the one across the two extension lines", () => {
    const sheet = {
      prims: [
        { k: "line", pts: [[10, 51.5], [10, 72]], w: 0.18, owner: "d1" },
        { k: "line", pts: [[90, 51.5], [90, 72]], w: 0.18, owner: "d1" },
        { k: "line", pts: [[10, 70], [90, 70]], w: 0.18, owner: "d1" },
        { k: "line", pts: [[10, 70], [13, 70.6], [13, 69.4]], w: 0.18, fill: true, owner: "d1" },
        { k: "line", pts: [[0, 0], [5, 0]], w: 0.5, owner: "d2" },
      ],
    } as unknown as ComposedSheet;
    expect(dimensionLine(sheet, "d1")).toEqual({ dir: "h", level: 70, a: [10, 70], b: [90, 70] });
  });
});

describe("snapping", () => {
  it("names what it finds", () => {
    expect(snapLabel("circle", "hole_1", { radius: 3.3 })).toBe("Edge of hole_1 (circle Ø6.6)");
    expect(snapLabel("edge", "ext_1", { length: 80 })).toBe("Edge of ext_1 (line 80)");
    expect(snapLabel("arc", "fillet_1", { radius: 5, visible: false })).toBe("Edge of fillet_1 (arc R5), hidden");
    expect(snapLabel("quadrant", "hole_1", { radius: 3.3 })).toBe("Quadrant of hole_1 (Ø6.6)");
    expect(nearestOnPolyline([[0, 0], [10, 0], [10, 10]], [12, 4])).toEqual({ at: [10, 4], d: 2 });
  });

  it("prefers a point to the edge it is on, a visible one to a hidden one, and leaves hidden edges out", () => {
    const index: SnapIndex = {
      sheet: "s",
      targets: [
        { ref: "v:ea", view: "v", kind: "edge", at: [5, 0], pts: [[[0, 0], [10, 0]]], visible: true, label: "edge a" },
        { ref: "v:va.1", view: "v", kind: "vertex", at: [10, 0], visible: true, label: "vertex" },
        { ref: "v:eh", view: "v", kind: "edge", at: [5, 3], pts: [[[0, 3], [10, 3]]], visible: false, label: "hidden" },
        { ref: "v:ec", view: "v", kind: "circle", at: [30, 0], circle: { c: [30, 0], r: 5 }, visible: true, label: "circle" },
      ],
    };
    expect(snapAt(index, [9.2, 0.3], 1)?.ref).toBe("v:va.1");
    const e = snapAt(index, [4, 0.6], 1)!;
    expect([e.ref, e.at]).toEqual(["v:ea", [4, 0]]);
    expect(snapAt(index, [4, 2.8], 0.5)).toBeNull();
    expect(snapAt(index, [4, 2.8], 0.5, { hidden: true })?.ref).toBe("v:eh");
    const c = snapAt(index, [30, 5.4], 1)!;
    expect([c.ref, c.at]).toEqual(["v:ec", [30, 5]]);
    expect(snapAt(index, [9.2, 0.3], 1, { kinds: ["edge"] })?.ref).toBe("v:ea");
  });

  let kernel: LocalKernel;
  beforeAll(async () => {
    await loadOC();
    kernel = new LocalKernel(getOC);
  });

  it("finds the bracket's hole in the top view at 2:1: its centre, its circle, its quadrants, by name", async () => {
    const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
    const r = apply(bracket, { type: "setDrawing", drawing: { sheets: [{ id: "s1", format: { size: "A3" }, scale: "2:1", projection: "third", views: [{ id: "top", look: "top" }], annotations: [] }] } } as Command);
    if (!r.ok) throw new Error(r.error);
    const v = validateDocument(r.doc);
    const geometry = await kernel.project(r.doc, viewSpecs(v.drawing!));
    const sheet = composeDrawing(r.doc, { measurements: (await kernel.check(r.doc)).measurements, geometry })!.sheets[0];
    const index = snapIndex(sheet);
    const cv = sheet.views[0];
    // The hole at (30, 0) in the view is at centre + (30 − origin) × 2 on the sheet.
    const hole = viewToSheet(cv, [30, 0]);
    const c = snapAt(index, [hole[0] + 0.5, hole[1] - 0.5], 2)!;
    expect(c.label).toBe("Centre of hole_1 (Ø6.6)");
    expect(c.ref).toMatch(/^top:chole_1\/c\d$/);
    close(c.at, hole, 6);
    // On its circle, 6.6 across at 2:1 (radius 6.6 on the sheet), between quadrants: the circle.
    const q = 6.6 / Math.SQRT2;
    const e = snapAt(index, [hole[0] + q, hole[1] + q], 1)!;
    expect(e.label).toBe("Edge of hole_1 (circle Ø6.6)");
    const top = snapAt(index, [hole[0], hole[1] + 6.6], 1)!;
    expect([top.kind, top.label]).toEqual(["quadrant", "Quadrant of hole_1 (Ø6.6)"]);
    // A corner of the plate: a vertex of ext_1 (the plate is 80 long: x from −40 at 2:1).
    const corner = viewToSheet(cv, [-40, 20]);
    expect(snapAt(index, corner, 1)?.label).toMatch(/^Vertex of /);
  });
});

describe("view fields, scopes and exports of wave Q2B", () => {
  const sheetOf = (views: unknown[]) => ({ sheets: [{ id: "s1", format: { size: "A3" }, projection: "third", views, annotations: [] }] });
  const bracket = () => JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
  it("checks free and locked: true or false, free only for views lined up with a parent", () => {
    const ok = validateDocument({ ...bracket(), drawing: sheetOf([{ id: "front", look: "front", locked: true }, { id: "top", kind: "projected", parent: "front", direction: "up", free: true }]) });
    expect(allErrors(ok)).toEqual([]);
    const bad = validateDocument({ ...bracket(), drawing: sheetOf([{ id: "front", look: "front", free: true, locked: "yes" }]) });
    expect(allErrors(bad).join("; ")).toMatch(/"free" is not for a model view/);
    expect(allErrors(bad).join("; ")).toMatch(/locked: must be true or false/);
  });

  it("scopes an ask from a table to that table, and from a sheet to the drawing", () => {
    const doc = { ...bracket(), drawing: { ...sheetOf([{ id: "top", look: "top" }]), sheets: [{ ...sheetOf([{ id: "top", look: "top" }]).sheets[0], tables: [{ id: "t1", kind: "general", header: ["A"], rows: [["x"]] }] }] } } as RawDocument;
    expect(scopeFor(doc, { kind: "table", id: "t1" })).toEqual(["table:t1"]);
    expect(scopeFor(doc, { kind: "sheet", id: "s1" })).toEqual(["drawing"]);
    expect(scopeProblem(doc, { type: "setTable", id: "t1", table: { kind: "general", header: ["B"], rows: [["y"]] } }, ["table:t1"])).toBeNull();
    expect(scopeProblem(doc, { type: "setView", id: "top", view: { look: "front" } }, ["table:t1"])).toMatch(/outside the scope/);
  });

  it("prints black and white: every colour dropped, shading kept", () => {
    const s = { prims: [{ k: "line", pts: [], w: 0.5, color: "#c0392b" }, { k: "text", at: [0, 0], text: "x", size: 3, anchor: "start", color: "#c0392b" }, { k: "area", loops: [], fill: "#ddd" }] } as unknown as ComposedSheet;
    const m = monoSheet(s).prims;
    expect(m.map((p) => ("color" in p ? p.color : p.k === "area" ? p.fill : undefined))).toEqual([undefined, undefined, "#ddd"]);
  });
});
