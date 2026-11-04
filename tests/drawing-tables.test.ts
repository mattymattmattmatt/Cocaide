// Phase Q wave 1B: the table engine — rows from the part, sorting and
// grouping, column widths fitted to the text, blocks split at maxRows,
// placement at an anchor, the primitives drawn, validation; the hole table's
// tags and coordinates; the stock (cutting plan) table.

import { describe, expect, it } from "vitest";
import type { Vec3, Weld } from "../src/doc/types";
import type { Prim } from "../src/drafting/sheet";
import {
  checkDrawingTable,
  checkDrawingTables,
  holeSize,
  holesInView,
  holeTable,
  holeTagPrims,
  layoutTable,
  outlineOrigin,
  placeTable,
  renderSheetTables,
  renderTable,
  setTableIn,
  tableData,
  tagLetters,
  type DrawingTable,
  type SheetFrame,
} from "../src/drafting/tables";
import { textWidth } from "../src/drafting/text";
import { viewFrame } from "../src/drafting/views";
import type { HoleMeasurement } from "../src/kernel/measure";
import type { HoleRecord } from "../src/kernel/rebuild";
import { cutListItems } from "../src/weldment/items";
import type { MemberMeasurement } from "../src/kernel/measure";
import { nest } from "../src/weldment/nesting";

const SHEET: SheetFrame = { frame: { min: [20, 10], max: [410, 287] }, titleBlock: { min: [230, 10], max: [410, 49] } };

function member(id: string, length: number, angle = 0): MemberMeasurement {
  const c = Math.cos((angle * Math.PI) / 180);
  const s = Math.sin((angle * Math.PI) / 180);
  return {
    id,
    body: id,
    profile: "SHS",
    designation: "SHS 40x40x3",
    length,
    angles: [angle, angle],
    perimeters: [160, 160],
    ends: [
      [0, 0, 0],
      [length, 0, 0],
    ],
    massKg: (444 * length * 7850) / 1e9,
    normals: [
      [-c, s, 0],
      [c, s, 0],
    ],
    axes: { x: [0, 1, 0], y: [0, 0, 1] },
    symmetry: { mirrorX: true, mirrorY: true, quarter: true, round: false },
    area: 160 * length,
  };
}
const list = cutListItems({
  measurements: { members: [member("r1", 1200, 45), member("r2", 1200, 45), member("l1", 860), member("l2", 860), member("l3", 860), member("l4", 860), member("b1", 600, 45)], bodies: [] },
  profiles: {},
  settings: { members: { l1: { group: "Legs" }, l2: { group: "Legs" }, l3: { group: "Legs" }, l4: { group: "Legs" } } },
});
const texts = (prims: Prim[]) => prims.flatMap((p) => (p.k === "text" ? [p.text] : []));

describe("table rows", () => {
  it("a cut list table: the standard columns, numbers as a drawing writes them, a totals row", () => {
    const d = tableData({ id: "t1", kind: "cutList" }, { cutList: list });
    expect(d.title).toBe("CUT LIST");
    expect(d.columns.map((c) => c.header)).toEqual(["ITEM", "QTY", "DESCRIPTION", "MATERIAL", "LENGTH", "ANGLE 1", "ANGLE 2", "KG"]);
    expect(d.rows.map((r) => r.cells)).toEqual([
      ["1", "2", "SHS 40x40x3", "", "1200", "45°", "45°", "8.36"],
      ["2", "4", "SHS 40x40x3", "", "860", "square", "square", "11.99"],
      ["3", "1", "SHS 40x40x3", "", "600", "45°", "45°", "2.09"],
    ]);
    // TOTAL under the description; 7 pieces, 444 mm² × (2 × 1200 + 4 × 860 + 600) mm × 7850 kg/m³ = 22.4459 kg.
    expect(d.totals).toEqual(["", "7", "TOTAL", "", "", "", "", "22.45"]);
    expect(d.rows.map((r) => r.ref)).toEqual([1, 2, 3]);
  });

  it("sorts and groups, by a column shown or not", () => {
    const sorted = tableData({ id: "t", kind: "cutList", sort: [{ column: "length" }] }, { cutList: list });
    expect(sorted.rows.map((r) => r.ref)).toEqual([3, 2, 1]);
    const grouped = tableData({ id: "t", kind: "cutList", group: "group", columns: ["item", "quantity", "description"] }, { cutList: list });
    expect(grouped.rows.map((r) => (r.kind === "group" ? `[${r.cells[0]}]` : r.cells[0]))).toEqual(["[(no group)]", "1", "3", "[Legs]", "2"]);
    const bad = tableData({ id: "t", kind: "cutList", sort: [{ column: "colour" }] }, { cutList: list });
    expect(bad.problems).toEqual(['t: sorts by "colour", which is not one of its columns']);
  });

  it("a weld table, a revision table, a general table", () => {
    const welds: Weld[] = [{ id: "w1", between: ["a", "b"], type: "fillet", size: 3, length: 160, process: "135 MAG", count: 4, side: "both" }, { id: "w2", between: ["a", "c"], type: "butt", size: 5, length: 120, allRound: true }];
    expect(tableData({ id: "w", kind: "welds", columns: ["id", "type", "size", "length", "count", "side", "process"] }, { welds }).rows.map((r) => r.cells)).toEqual([
      ["w1", "FILLET", "3", "160", "4", "BOTH", "135 MAG"],
      ["w2", "BUTT", "5", "ALL ROUND", "1", "", ""],
    ]);
    expect(tableData({ id: "r", kind: "revisions" }, { revisions: [{ rev: "A", description: "First issue", date: "2026-11-04", by: "JB" }] }).rows[0].cells).toEqual(["A", "First issue", "2026-11-04", "JB", ""]);
    const g = tableData({ id: "g", kind: "general", header: ["NOTE", "VALUE"], rows: [["Paint", "RAL 9005"], ["Weld", "AS/NZS 1554.1 SP"]] }, {});
    expect([g.title, g.columns.map((c) => c.header), g.rows[1].cells]).toEqual([null, ["NOTE", "VALUE"], ["Weld", "AS/NZS 1554.1 SP"]]);
  });

  it("a cutting plan table: alike bars on one row, the buy list in the totals", () => {
    // The bars worked by hand in tests/cutlist-v2.test.ts: [2500, 2500] and [2500, 1000, 1000]; four 2500s make two alike bars.
    const pieces = (n: number) => [...Array.from({ length: n }, () => ({ item: 1, length: 2500 })), { item: 2, length: 1000 }, { item: 2, length: 1000 }];
    const d = tableData({ id: "s", kind: "stock" }, { nesting: [nest("SHS 40x40x3", pieces(3), { stock: [6000], kerf: 3, trim: 0, minOffcut: 300 })] });
    expect(d.rows.map((x) => x.cells)).toEqual([
      ["SHS 40x40x3", "6000", "1", "2× #1 2500", "994 KEEP", "0.1"],
      ["SHS 40x40x3", "6000", "1", "#1 2500, 2× #2 1000", "1491 KEEP", "0.2"],
    ]);
    expect(d.totals).toEqual(["", "", "2", "BUY 2× SHS 40x40x3 6000", "", "0.1"]);
    const alike = tableData({ id: "s", kind: "stock", columns: ["bars", "cut"] }, { nesting: [nest("SHS 40x40x3", pieces(4).slice(0, 4), { stock: [6000], kerf: 3, trim: 0, minOffcut: 300 })] });
    expect(alike.rows.map((x) => x.cells)).toEqual([["2", "2× #1 2500"]]);
  });
});

describe("layout and placement", () => {
  it("fits each column to its widest text, within limits, or takes the width it is given", () => {
    const t: DrawingTable = { id: "t", kind: "cutList", columns: ["item", "description"], widths: { item: 12 } };
    const l = layoutTable(t, tableData(t, { cutList: list }));
    expect(l.widths[0]).toBe(12);
    // "SHS 40x40x3" at 3.5 mm, padded 1.5 each side, rounded up to the half millimetre.
    expect(l.widths[1]).toBe(Math.ceil((Math.max(textWidth("SHS 40x40x3", 3.5), textWidth("DESCRIPTION", 3.5, true)) + 3) * 2) / 2);
    expect(l.blocks).toHaveLength(1);
    // Title, header, three rows and the totals, 6 mm each (the title row 6.72 for its 4.2 mm text).
    expect(l.blocks[0].height).toBeCloseTo(6.72 + 5 * 6, 9);
  });

  it("splits at maxRows into blocks beside each other, the header in each; totals in the last", () => {
    const t: DrawingTable = { id: "t", kind: "cutList", maxRows: 2 };
    const r = renderTable(t, { cutList: list }, SHEET);
    expect(r.layout.blocks.map((b) => b.rows.map((x) => x.kind))).toEqual([
      ["title", "header", "data", "data"],
      ["header", "data", "totals"],
    ]);
    // Above the title block, on its right edge; the second block to the left of the first, both on the title block.
    const [a, b] = r.boxes;
    expect(a.max[0]).toBe(410);
    expect(a.min[1]).toBe(49);
    expect(b.max[0]).toBeCloseTo(a.min[0], 9);
    expect(b.min[1]).toBe(49);
    expect(texts(r.prims).filter((x) => x === "ITEM")).toHaveLength(2);
  });

  it("puts the header at the bottom with rows reading upward from it (a parts list on a title block)", () => {
    const t: DrawingTable = { id: "t", kind: "bom", headerAt: "bottom", title: null };
    const l = layoutTable(t, tableData(t, { cutList: list }));
    expect(l.blocks[0].rows.map((x) => (x.kind === "data" ? x.cells[0] : x.kind))).toEqual(["totals", "3", "2", "1", "header"]);
  });

  it("anchors to each corner of the frame, or a free point", () => {
    const t = (anchor: DrawingTable["anchor"]): DrawingTable => ({ id: "t", kind: "revisions", anchor });
    const box = (a: DrawingTable["anchor"]) => {
      const tt = t(a);
      return placeTable(tt, layoutTable(tt, tableData(tt, { revisions: [] })), SHEET)[0];
    };
    const tr = box({ corner: "topRight" });
    expect([tr.max[0], tr.max[1]]).toEqual([410, 287]);
    const tl = box({ corner: "topLeft", offset: [5, -5] });
    expect([tl.min[0], tl.max[1]]).toEqual([25, 282]);
    const bl = box({ corner: "bottomLeft" });
    expect(bl.min[0]).toBe(20);
    expect(bl.min[1]).toBeCloseTo(10, 9);
    const lt = box({ corner: "leftOfTitleBlock" });
    expect(lt.max[0]).toBe(230);
    expect(lt.min[1]).toBeCloseTo(10, 9);
    const free = box({ at: [100, 200] });
    expect([free.min[0], free.max[1]]).toEqual([100, 200]);
  });

  it("stacks tables that share an anchor so they never overlap", () => {
    const out = renderSheetTables([{ id: "a", kind: "cutList" }, { id: "b", kind: "bom" }], { cutList: list }, SHEET);
    expect(out[1].box!.min[1]).toBeCloseTo(out[0].box!.max[1], 9);
  });

  it("draws the frame and the header rule heavy, the rest light; everything owned by the table", () => {
    const r = renderTable({ id: "cut", kind: "cutList" }, { cutList: list }, SHEET);
    expect(r.prims.every((p) => p.owner === "cut")).toBe(true);
    const lines = r.prims.filter((p): p is Extract<Prim, { k: "line" }> => p.k === "line");
    expect(new Set(lines.map((l) => l.w))).toEqual(new Set([0.5, 0.25]));
    const frame = lines[lines.length - 1];
    expect(frame.pts).toHaveLength(5);
    expect(frame.w).toBe(0.5);
    // Numbers right-aligned, the item number and angles centred, text left.
    const cell = (text: string) => r.prims.find((p) => p.k === "text" && p.text === text) as Extract<Prim, { k: "text" }>;
    expect([cell("1200").anchor, cell("45°").anchor, cell("SHS 40x40x3").anchor, cell("CUT LIST").anchor]).toEqual(["end", "middle", "start", "middle"]);
    expect(cell("ITEM").bold).toBe(true);
  });
});

describe("the hole table", () => {
  const frame = viewFrame("top");
  const hole = (x: number, y: number, d: number, diameters = [d]): HoleMeasurement => ({ diameter: d, diameters, axisPoint: [x, y, 0], axis: [0, 0, -1], length: 8 });
  const record = (x: number, y: number, extra: Partial<HoleRecord> = {}): HoleRecord => ({ feature: "hole_1", entry: [x, y, 8] as Vec3, axis: [0, 0, -1], diameter: 6.6, depth: 8, through: true, copies: 3, ...extra });

  it("tags by size, smallest first, and numbers along X then Y; X and Y from the origin", () => {
    const holes = holesInView(
      [hole(40, 20, 6.6, [6.6, 11]), hole(-40, 20, 6.6, [6.6, 11]), hole(-40, -20, 6.6, [6.6, 11]), hole(40, -20, 6.6, [6.6, 11]), hole(0, 0, 20), hole(0, 0, 20.5) /* a coaxial wall: one hole */, { ...hole(0, 30, 4.2), axis: [1, 0, 0] } /* seen side-on */],
      [record(40, 20, { counterbore: { diameter: 11, depth: 4 } })],
      frame,
    );
    expect(holes).toHaveLength(5);
    const rows = holeTable(holes, [-50, -30]);
    expect(rows.map((r) => [r.tag, r.x, r.y, r.size])).toEqual([
      ["A1", 10, 10, "Ø6.6 THRU, CBORE Ø11 × 4"],
      ["A2", 10, 50, "Ø6.6 THRU, CBORE Ø11 × 4"],
      ["A3", 90, 10, "Ø6.6 THRU, CBORE Ø11 × 4"],
      ["A4", 90, 50, "Ø6.6 THRU, CBORE Ø11 × 4"],
      ["B1", 50, 30, "Ø20"],
    ]);
    expect(rows[0].outer).toBe(11);
    expect(tableData({ id: "h", kind: "holes", view: "top" }, { holes: rows }).rows[4].cells).toEqual(["B1", "50", "30", "Ø20"]);
  });

  it("calls out threads and blind holes in words", () => {
    expect(holeSize({ diameter: 5, depth: 15, through: false, thread: { designation: "M6×1", major: 6, pitch: 1, class: "6H", depth: 12 } })).toBe("M6×1 - 6H × 12 DEEP");
    expect(holeSize({ diameter: 8.5, depth: 20, through: true, countersink: { diameter: 16, angle: 90 } })).toBe("Ø8.5 THRU, CSK Ø16 × 90°");
    expect(holeSize({ diameter: 6, depth: 10, through: false })).toBe("Ø6 × 10 DEEP");
    expect([0, 1, 25, 26].map(tagLetters)).toEqual(["A", "B", "Z", "AA"]);
  });

  it("measures from a corner of the view's outline, and tags the holes on the view", () => {
    const outline = { min: [-50, -30] as [number, number], max: [50, 30] as [number, number] };
    expect(outlineOrigin("@upperRight", outline)).toEqual([50, 30]);
    expect(outlineOrigin(undefined, outline)).toEqual([-50, -30]);
    expect(outlineOrigin("top:v12", outline)).toBeNull();
    const rows = holeTable([{ center: [40, 20], diameter: 6.6, outer: 11, size: "Ø6.6" }], [-50, -30]);
    const prims = holeTagPrims(rows, { centre: [100, 100], origin: [0, 0], scale: 2 }, [-50, -30], "holes");
    // The tag up and right of the hole, clear of its 11 mm counterbore at 2:1: (100 + 80 + 11·0.707 + 1.2, 100 + 40 + ...).
    const tag = prims[0] as Extract<Prim, { k: "text" }>;
    expect(tag.text).toBe("A1");
    expect(tag.at[0]).toBeCloseTo(180 + 11 * Math.SQRT1_2 + 1.2, 9);
    expect(tag.at[1]).toBeCloseTo(140 + 11 * Math.SQRT1_2 + 1.2, 9);
  });
});

describe("validation", () => {
  it("checks every field and says what it must be", () => {
    expect(checkDrawingTable({ id: "t", kind: "cutList", columns: ["item", "colour"] }, "tables[0]").errors[0]).toMatch(/^tables\[0\]\.columns\[1\]: no column "colour" in a cutList table \(columns: item, quantity, /);
    expect(checkDrawingTable({ id: "t", kind: "holes" }, "t", { views: ["top"] }).errors).toEqual(["t.view: a hole table names the view whose holes it lists (got nothing)"]);
    expect(checkDrawingTable({ id: "t", kind: "holes", view: "side" }, "t", { views: ["top"] }).errors).toEqual(['t.view: no view "side" on the sheet (views: top)']);
    expect(checkDrawingTable({ id: "t", kind: "welds", anchor: { corner: "middle" } }, "t").errors[0]).toContain('t.anchor.corner: must be "topLeft", "topRight"');
    expect(checkDrawingTable({ id: "t", kind: "bom", rows: [["x"]] }, "t").errors).toEqual(["t.rows: only a general table has typed rows; the others' are read from the part"]);
    expect(checkDrawingTable({ id: "t", kind: "cutList", columns: ["item", "prop:Supplier"], sort: [{ column: "length", descending: true }], anchor: { at: [30, 280] }, style: { textSize: 2.5 } }, "t").errors).toEqual([]);
    expect(checkDrawingTables([{ id: "a", kind: "bom" }, { id: "a", kind: "welds" }], "tables").errors).toEqual(['tables[1].id: duplicate table id "a"']);
  });

  it("adds, replaces and removes a table by id", () => {
    const a = setTableIn([], "t1", { kind: "cutList" });
    expect(a.ok && a.tables).toEqual([{ id: "t1", kind: "cutList" }]);
    const b = setTableIn(a.ok ? a.tables : [], "t1", { kind: "cutList", maxRows: 10 });
    expect(b.ok && b.tables).toEqual([{ id: "t1", kind: "cutList", maxRows: 10 }]);
    expect(setTableIn([], "t9", null)).toEqual({ ok: false, error: "no table \"t9\" (tables: none)" });
    const bad = setTableIn([], "t1", { kind: "pie" });
    expect(bad.ok || bad.error).toContain('table "t1".kind: must be "cutList"');
  });
});
