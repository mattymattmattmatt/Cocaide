// Phase Q wave 1B: the cut list v2 — end cuts with their orientation,
// grouping, item numbers kept, plates, masses and areas, the document's
// cut list settings and their command, nesting worked by hand, and the
// XLSX workbook's structure.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { checkCutList, mergeCutList } from "../src/doc/cutListSettings";
import { scopeProblem } from "../src/doc/scope";
import { allErrors, validateDocument } from "../src/doc/validate";
import type { Vec3 } from "../src/doc/types";
import { unzipStored } from "../src/io/zip";
import { loadOC, rebuild, type OC } from "../src/kernel";
import type { BodyMeasurement, MemberMeasurement, SectionSymmetry } from "../src/kernel/measure";
import { DEFAULT_CUT_COLUMNS } from "../src/weldment/columns";
import { memberCuts, motionsOf, sameCuts, sectionSymmetry, cutsText } from "../src/weldment/endCuts";
import { cutListCsvV2, cutListXlsx, cuttingPlanHtml } from "../src/weldment/exports";
import { cutListItems, cutListOf, itemNumberFor, itemTextPatch, keptNumbering, renumberPatch, splitGrade, splitStandard } from "../src/weldment/items";
import { barOf, fits, nest, nestCutList, nestOptions } from "../src/weldment/nesting";
import { columnName, writeXlsx } from "../src/weldment/xlsx";

const SQUARE: SectionSymmetry = { mirrorX: true, mirrorY: true, quarter: true, round: false };
const ANGLE: SectionSymmetry = { mirrorX: false, mirrorY: false, quarter: false, round: false };
const s2 = Math.SQRT1_2;

/** A member along +x, profile x across (+y world), y up (+z world), cut at each end with these outward normals. */
function member(id: string, length: number, normals: [Vec3, Vec3], angles: [number, number], extra: Partial<MemberMeasurement> = {}): MemberMeasurement {
  return {
    id,
    body: id,
    profile: "SHS",
    designation: "SHS 40x40x3",
    length,
    angles,
    perimeters: [160, 160],
    ends: [
      [0, 0, 0],
      [length, 0, 0],
    ],
    massKg: (444 * length * 7850) / 1e9,
    normals,
    axes: { x: [0, 1, 0], y: [0, 0, 1] },
    symmetry: SQUARE,
    endFaces: [1, 1],
    copes: [false, false],
    area: 160 * length,
    ...extra,
  };
}
const square = (id: string, length: number, extra: Partial<MemberMeasurement> = {}) =>
  member(
    id,
    length,
    [
      [-1, 0, 0],
      [1, 0, 0],
    ],
    [0, 0],
    extra,
  );
/** Both ends mitred 45°, leaning across the profile's x (world y): a picture frame's piece. */
const trapezoid = (id: string, length: number, extra: Partial<MemberMeasurement> = {}) =>
  member(
    id,
    length,
    [
      [-s2, s2, 0],
      [s2, s2, 0],
    ],
    [45, 45],
    extra,
  );
const body = (name: string, extra: Partial<BodyMeasurement> = {}): BodyMeasurement => ({ name, volume: 1000, massKg: 0.00785, material: "steel", boundingBox: { min: [0, 0, 0], max: [10, 10, 10], size: [10, 10, 10] }, holeCount: 0, solids: 1, area: 600, ...extra });

describe("end cuts", () => {
  it("a picture frame's rail is cut in one plane, the cuts leaning the same way: a trapezoid", () => {
    const c = memberCuts(trapezoid("a", 1200));
    expect(c.relation).toBe("samePlane");
    expect(c.shape).toBe("trapezoid");
    expect(c.ends.map((e) => e.toward)).toEqual(["x", "x"]);
    expect(cutsText(c)).toBe("45° / 45°, same plane (trapezoid)");
  });

  it("cuts leaning opposite ways are a parallelogram; across the other face, twisted 90°", () => {
    const para = member(
      "p",
      1000,
      [
        [-s2, s2, 0],
        [s2, -s2, 0],
      ],
      [45, 45],
    );
    expect(memberCuts(para).shape).toBe("parallelogram");
    // The second cut leans up the section (world z): the cut planes are a quarter turn apart.
    const twisted = member(
      "t",
      1000,
      [
        [-s2, s2, 0],
        [s2, 0, s2],
      ],
      [45, 45],
    );
    const t = memberCuts(twisted);
    expect(t.relation).toBe("twisted");
    expect(t.twist).toBe(90);
    expect(t.ends[1].toward).toBe("y");
    expect(cutsText(t)).toBe("45° / 45°, twisted 90°");
    expect(sameCuts(memberCuts(trapezoid("a", 1000)), t, SQUARE)).toBe(false);
  });

  it("a square tube turned end for end or a quarter turn is the same piece; an angle's left and right hands are not", () => {
    // The same trapezoid built the other way round (from its other end): leans as seen from each end swap places.
    const a = memberCuts(trapezoid("a", 1000));
    const turned = memberCuts(
      member(
        "b",
        1000,
        [
          [-s2, -s2, 0],
          [s2, -s2, 0],
        ],
        [45, 45],
      ),
    );
    expect(sameCuts(a, turned, SQUARE)).toBe(true);
    expect(sameCuts(a, turned, ANGLE)).toBe(false);
    // A quarter turn about the line: the lean moves from the x faces to the y faces.
    const quarter = memberCuts(
      member(
        "q",
        1000,
        [
          [-s2, 0, s2],
          [s2, 0, s2],
        ],
        [45, 45],
      ),
    );
    expect(sameCuts(a, quarter, SQUARE)).toBe(true);
    expect(sameCuts(a, quarter, { ...SQUARE, quarter: false })).toBe(false);
    expect(motionsOf(SQUARE)).toHaveLength(8); // the square's symmetries: 4 turns, each with or without turning end for end
    expect(motionsOf(ANGLE)).toHaveLength(1);
  });

  it("tells a section's symmetry from its outline", () => {
    expect(sectionSymmetry([[-20, -20], [20, -20], [20, 20], [-20, 20]])).toEqual({ mirrorX: true, mirrorY: true, quarter: true, round: false });
    expect(sectionSymmetry([[-50, -25], [50, -25], [50, 25], [-50, 25]])).toEqual({ mirrorX: true, mirrorY: true, quarter: false, round: false });
    expect(sectionSymmetry([[0, 0], [40, 0], [40, 3], [3, 3], [3, 40], [0, 40]])).toEqual({ mirrorX: false, mirrorY: false, quarter: false, round: false });
    const circle = Array.from({ length: 720 }, (_, i) => [10 * Math.cos((i * Math.PI) / 360), 10 * Math.sin((i * Math.PI) / 360)] as [number, number]);
    expect(sectionSymmetry(circle).round).toBe(true);
  });

  it("flags copes and notches, and keeps them apart from plain cuts", () => {
    const coped = memberCuts(square("c", 800, { copes: [true, false] }));
    const notched = memberCuts(square("n", 800, { endFaces: [2, 1] }));
    expect([coped.cope, notched.notch]).toEqual([true, true]);
    expect(sameCuts(coped, memberCuts(square("s", 800)), SQUARE)).toBe(false);
    expect(cutsText(coped)).toBe("square, coped");
  });
});

describe("grouping and numbering", () => {
  const settings = {};
  const input = (members: MemberMeasurement[], bodies: BodyMeasurement[] = [], s = settings) => cutListItems({ measurements: { members, bodies: [...members.map((m) => body(m.body, { material: "steel AS/NZS 1163-C350L0", area: m.area })), ...bodies] }, profiles: {}, settings: s, finish: "Hot-dip galvanised" });

  it("groups alike members: same size, length within 0.5 mm and the same end cuts", () => {
    const list = input([trapezoid("r1", 1200), trapezoid("r2", 1200.3), trapezoid("r3", 1201), square("l1", 860), square("l2", 860)]);
    expect(list.items.map((i) => [i.item, i.quantity, i.length, i.members])).toEqual([
      [1, 1, 1201, ["r3"]],
      [2, 2, 1200.2, ["r1", "r2"]], // the mean of 1200 and 1200.3, to 0.1
      [3, 2, 860, ["l1", "l2"]],
    ]);
    expect(list.items[0]).toMatchObject({ material: "steel AS/NZS 1163", grade: "C350L0", finish: "Hot-dip galvanised" });
  });

  it("weighs and measures: kg each and total, paint area, length per profile", () => {
    const list = input([square("a", 1000), square("b", 1000)]);
    const i = list.items[0];
    // 444 mm² × 1000 mm × 7850 kg/m³ = 3.4854 kg each; 160 mm round × 1000 mm = 0.16 m² each.
    expect(i.massEach).toBeCloseTo(3.4854, 6);
    expect(i.massTotal).toBeCloseTo(6.9708, 6);
    expect(i.areaTotal).toBe(320000);
    expect(list.totals.paintArea).toBeCloseTo(0.32, 9);
    expect(list.totals.byProfile).toEqual([{ designation: "SHS 40x40x3", pieces: 2, length: 2000, massKg: 6.9708 }]);
  });

  it("plates and other bodies are items of their own: thickness × width × length, plan area", () => {
    const plate = body("cap_1", { plate: { thickness: 6, size: [40, 50], area: 2000, holes: 0, cutLength: 180 }, massKg: 0.0942, area: 4000 + 6 * 180 });
    const list = cutListItems({ measurements: { members: [square("a", 500)], bodies: [body("a"), plate, { ...plate, name: "cap_2" }, body("odd", { boundingBox: { min: [0, 0, 0], max: [30, 20, 10], size: [30, 20, 10] } })] }, profiles: {}, settings: {}, sources: { cap_1: "endCap", cap_2: "endCap" } });
    expect(list.items.map((i) => [i.item, i.kind, i.quantity, i.description])).toEqual([
      [1, "member", 1, "SHS 40x40x3"],
      [2, "plate", 2, "End cap PL 6 × 40 × 50"],
      [3, "body", 1, "odd"],
    ]);
    expect(list.items[1]).toMatchObject({ thickness: 6, width: 40, length: 50, plateArea: 2000 });
    expect(list.items[2].designation).toBe("30 × 20 × 10");
    expect(list.totals.plates).toEqual([{ thickness: 6, material: "steel", pieces: 2, area: 4000, massKg: 0.1884 }]);
    expect(itemNumberFor(list, "cap_2")).toBe(2);
    expect(itemNumberFor(list, "a")).toBe(1);
    expect(itemNumberFor(list, "nothing")).toBeNull();
  });

  it("keeps item numbers across rebuilds: a kept item keeps its number, a new one comes after", () => {
    const first = input([trapezoid("r1", 1200), trapezoid("r2", 1200), square("l1", 860)]);
    const kept = { items: keptNumbering(first) };
    expect(kept.items).toEqual([
      { item: 1, members: ["r1", "r2"] },
      { item: 2, members: ["l1"] },
    ]);
    // The rails get shorter than the legs and a 2000 brace comes in: without kept numbers the order would change.
    const after = input([trapezoid("r1", 700), trapezoid("r2", 700), square("l1", 860), square("brace", 2000)], [], kept);
    expect(after.items.map((i) => [i.item, i.members])).toEqual([
      [1, ["r1", "r2"]],
      [2, ["l1"]],
      [3, ["brace"]],
    ]);
    // Renumbering puts them in the default order again: longest first.
    const renumbered = input([trapezoid("r1", 700), trapezoid("r2", 700), square("l1", 860), square("brace", 2000)], [], renumberPatch(after));
    expect(renumbered.items.map((i) => [i.item, i.members[0]])).toEqual([
      [1, "brace"],
      [2, "l1"],
      [3, "r1"],
    ]);
  });

  it("typed text goes with its item; members with text of their own are an item of their own", () => {
    const first = input([trapezoid("r1", 1200), trapezoid("r2", 1200)]);
    const patch = itemTextPatch(first, 1, { description: "Top rail", properties: { Supplier: "Steel & Co" } })!;
    const typed = input([trapezoid("r1", 1200), trapezoid("r2", 1200)], [], patch);
    expect(typed.items[0]).toMatchObject({ description: "Top rail", autoDescription: "SHS 40x40x3", properties: { Supplier: "Steel & Co" } });
    expect(typed.propertyNames).toEqual(["Supplier"]);
    const split = input([trapezoid("r1", 1200), trapezoid("r2", 1200)], [], { ...patch, members: { r2: { properties: { "Heat no.": "H2231" } } } });
    expect(split.items.map((i) => [i.item, i.members, i.properties])).toEqual([
      [1, ["r1"], { Supplier: "Steel & Co" }],
      [2, ["r2"], { "Heat no.": "H2231" }],
    ]);
    expect(itemTextPatch(first, 9, {})).toBeNull();
  });

  it("reads the standard and the grade from the names", () => {
    expect(splitStandard("SHS (AS/NZS 1163)")).toEqual({ family: "SHS", standard: "AS/NZS 1163" });
    expect(splitStandard("SHS")).toEqual({ family: "SHS", standard: "" });
    expect(splitGrade("steel AS/NZS 3679.1-300")).toEqual({ material: "steel AS/NZS 3679.1", grade: "300" });
    expect(splitGrade("steel G450 Z350")).toEqual({ material: "steel G450 Z350", grade: "" });
  });
});

describe("nesting, worked by hand", () => {
  const o = { stock: [6000], kerf: 3, trim: 0, minOffcut: 300 };

  it("3 × 2500 and 2 × 1000 into 6 m bars at 3 mm kerf: two bars", () => {
    const r = nest("SHS", [1, 1, 1].map(() => ({ item: 1, length: 2500 })).concat([2, 2].map(() => ({ item: 2, length: 1000 }))), o);
    // Bar 1: 2500 + 3 + 2500 = 5003, 997 left, a kerf off: a 994 offcut (kept), 6 mm of kerf scrap.
    // Bar 2: 2500 + 3 + 1000 + 3 + 1000 = 4506, 1494 left: a 1491 offcut.
    expect(r.bars.map((b) => [b.pieces.map((p) => p.length), b.used, b.offcut, b.kept, b.scrap])).toEqual([
      [[2500, 2500], 5000, 994, true, 6],
      [[2500, 1000, 1000], 4500, 1491, true, 9],
    ]);
    expect(r.buy).toEqual([{ stock: 6000, count: 2 }]);
    expect(r.bought).toBe(12000);
    expect(r.wastePct).toBe(0.13); // 15 mm of kerf in 12 m
  });

  it("pieces that fill a bar exactly need no last cut; an offcut under the minimum is scrap", () => {
    expect(fits(6000, [2998.5, 2998.5], o)).toBe(true); // 2998.5 × 2 + 3 = 6000
    const b = barOf(6000, [{ item: 1, length: 2998.5 }, { item: 1, length: 2998.5 }], o);
    expect([b.offcut, b.cuts, b.scrap]).toEqual([0, 1, 3]);
    const short = barOf(6000, [{ item: 1, length: 5800 }], o);
    expect([short.offcut, short.kept, short.scrap, short.wastePct]).toEqual([197, false, 200, 3.33]);
  });

  it("end trim comes off both ends of a bar", () => {
    const t = { ...o, trim: 10 };
    expect(fits(6000, [2988.5, 2988.5], t)).toBe(true); // 5980 usable = 2988.5 × 2 + 3
    expect(fits(6000, [2988.6, 2988.5], t)).toBe(false);
  });

  it("picks among stock lengths: two 3020s go in one 6100 bar rather than two 6000s", () => {
    const r = nest("RHS", [{ item: 1, length: 3020 }, { item: 1, length: 3020 }], { ...o, stock: [6000, 6100] });
    expect(r.buy).toEqual([{ stock: 6100, count: 1 }]);
    // One piece alone is shrunk to the shortest bar that holds it.
    expect(nest("RHS", [{ item: 1, length: 3020 }], { ...o, stock: [6000, 6100] }).buy).toEqual([{ stock: 6000, count: 1 }]);
  });

  it("improves on first fit: empties a bar into the others", () => {
    // First fit decreasing on 10 m bars, kerf 0: [6, 4] [5, 5]? It packs 6+4 and 5+5 already; this case needs a move:
    // pieces 5, 4, 3, 3, 3, 2 in 10: FFD gives [5, 4] [3, 3, 3] [2]... then [2] empties into [3, 3, 3].
    const r = nest("x", [5, 4, 3, 3, 3, 2].map((length, i) => ({ item: i + 1, length })), { stock: [10], kerf: 0, trim: 0, minOffcut: 1 });
    expect(r.bars).toHaveLength(2);
    expect(r.bars.map((b) => b.used).sort()).toEqual([10, 10]);
  });

  it("lists a piece longer than every bar instead of nesting it", () => {
    const r = nest("x", [{ item: 4, length: 7000 }, { item: 1, length: 1000 }], o);
    expect(r.tooLong).toEqual([{ item: 4, length: 7000 }]);
    expect(r.bars).toHaveLength(1);
  });

  it("takes its options from the settings, a size's own first, and the part's stock_length", () => {
    const s = { stock: { lengths: [6000, 6100], kerf: 2, profiles: { "SHS 40x40x3": { lengths: [8000] } } } };
    expect(nestOptions(s, "SHS 40x40x3")).toEqual({ stock: [8000], kerf: 2, trim: 0, minOffcut: 300 });
    expect(nestOptions(s, "RHS")).toEqual({ stock: [6000, 6100], kerf: 2, trim: 0, minOffcut: 300 });
    expect(nestOptions({}, "RHS", 7500)).toEqual({ stock: [7500], kerf: 3, trim: 0, minOffcut: 300 });
  });
});

describe("the document's cut list settings", () => {
  const base: RawDocument = { version: 1, units: "mm", name: "p", features: [] };

  it("validates strictly, saying what each field must be", () => {
    expect(checkCutList({ stock: { kerf: 80 } }).errors).toEqual(["document: cutList.stock.kerf: must be a number from 0 to 50 mm (got 80)"]);
    expect(checkCutList({ items: [{ item: 1, members: ["a"] }, { item: 1, members: ["b"] }] }).errors[0]).toContain("item 1 is listed twice");
    expect(checkCutList({ items: [{ item: 1, members: ["a"] }, { item: 2, members: ["a"] }] }).errors[0]).toContain('"a" is on item 1 too');
    expect(checkCutList({ members: { a: { colour: "red" } } }).errors[0]).toContain('unknown field "colour"');
    expect(checkCutList({ members: { a: { notes: "" } } }).errors[0]).toContain("is empty; leave it out instead");
    expect(checkCutList({ stock: { lengths: [6000, 6100] }, tolerance: 1, members: { a: { properties: { Supplier: "X" } } } }).errors).toEqual([]);
    const v = validateDocument({ ...base, cutList: { stock: { lengths: [] } } });
    expect(allErrors(v)).toEqual(["document: cutList.stock.lengths: must be a list of 1 to 10 bar lengths in mm, like [6000, 6100] (got [])"]);
  });

  it("setCutList merges: stock one level, members by id, item text one item at a time; null removes", () => {
    let doc = base;
    const run = (patch: Record<string, unknown>) => {
      const r = apply(doc, { type: "setCutList", patch });
      if (!r.ok) throw new Error(r.error);
      doc = r.doc;
    };
    run({ stock: { lengths: [6000], kerf: 3 } });
    run({ stock: { kerf: 2 }, members: { a: { notes: "check fit" } } });
    expect(doc.cutList).toEqual({ stock: { lengths: [6000], kerf: 2 }, members: { a: { notes: "check fit" } } });
    run({ itemText: [{ item: 1, members: ["a", "b"], description: "Rail", properties: { Supplier: "X" } }] });
    run({ itemText: [{ item: 5, members: ["b"], properties: { Supplier: null, "Heat no.": "H1" } }] });
    expect((doc.cutList as { items: unknown }).items).toEqual([{ item: 1, members: ["a", "b"], description: "Rail", properties: { "Heat no.": "H1" } }]);
    const taken = apply(doc, { type: "setCutList", patch: { itemText: [{ item: 1, members: ["z"], notes: "x" }] } });
    expect(taken.ok || taken.error).toBe('setCutList: itemText: item 1 is kept for other members (a, b); give the members it is for');
    const bad = apply(doc, { type: "setCutList", patch: { stock: { trim: -1 } } });
    expect(bad.ok || bad.error).toBe("setCutList: cutList.stock.trim: must be a number from 0 to 1000 mm (got -1)");
    run({ stock: null, members: { a: null }, items: null });
    expect(doc.cutList).toBeUndefined();
    expect(mergeCutList({}, { members: { a: { notes: " " } } })).toEqual({});
  });

  it("is in the write scope as \"cutList\" (or the drawing's)", () => {
    expect(scopeProblem(base, { type: "setCutList", patch: {} }, ["cutList"])).toBeNull();
    expect(scopeProblem(base, { type: "setCutList", patch: {} }, ["drawing"])).toBeNull();
    expect(scopeProblem(base, { type: "setCutList", patch: {} }, ["+"])).toContain("setCutList");
  });

  it("takes weld process, side and count", () => {
    const v = validateDocument({ ...base, welds: [{ id: "w1", between: [], type: "fillet", size: 3, length: 100, process: "135 MAG", side: "both", count: 4 }] });
    expect(allErrors(v).filter((e) => !e.includes("between"))).toEqual([]);
    const bad = validateDocument({ ...base, welds: [{ id: "w1", between: [], type: "fillet", size: 3, length: 100, side: "left", count: 0 }] });
    expect(allErrors(bad).filter((e) => !e.includes("between"))).toEqual(['document: welds[0].side: must be "arrow", "other", "both" (got "left")', "document: welds[0].count: must be a whole number from 1 to 999 (got 0)"]);
  });
});

describe("the export files", () => {
  const list = cutListItems({ measurements: { members: [trapezoid("r1", 1200), trapezoid("r2", 1200), square("l1", 860)], bodies: [body("r1"), body("r2"), body("l1")] }, profiles: {}, settings: {} });

  it("CSV: the chosen columns, a totals row, quoted where it must be", () => {
    const csv = cutListCsvV2(list, ["item", "quantity", "description", "length", "orientation", "massTotal"], { header: [["Part", "frame"]] }).split("\r\n");
    expect(csv).toEqual(["Part,frame", "", "Item,Qty,Description,Length (mm),Orientation,kg total", '1,2,SHS 40x40x3,1200.0,"same plane, trapezoid",8.36', "2,1,SHS 40x40x3,860.0,square,3.00", "Total,3,,,,11.36", ""]);
  });

  it("XLSX: a ZIP of well-formed Office Open XML parts that a spreadsheet opens", () => {
    const bytes = cutListXlsx(list, nestCutList(list), [], DEFAULT_CUT_COLUMNS, { title: "frame cut list", date: new Date("2026-11-04T10:00:00Z") });
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
    const files = unzipStored(bytes);
    expect(files.map((f) => f.name)).toEqual(["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "docProps/app.xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]);
    const text = (n: string) => new TextDecoder().decode(files.find((f) => f.name === n)!.data);
    for (const f of files) expect(wellFormed(text(f.name)), f.name).toBe(true);
    expect(text("xl/workbook.xml")).toContain('<sheet name="Cut list" sheetId="1" r:id="rId1"/><sheet name="Stock" sheetId="2" r:id="rId2"/><sheet name="Cutting plan" sheetId="3" r:id="rId3"/>');
    expect(text("[Content_Types].xml")).toContain('PartName="/xl/worksheets/sheet3.xml"');
    const sheet = text("xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<c r="A1" s="2" t="inlineStr"><is><t xml:space="preserve">frame cut list</t></is></c>');
    expect(sheet).toContain('<pane ySplit="3"'); // the header row stays on screen
    expect(sheet).toMatch(/<c r="F4" s="5"><v>1200<\/v><\/c>/); // the first item's length, a number to 0.0
  });

  it("names columns past Z and keeps sheet names legal", () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    const files = unzipStored(writeXlsx([{ name: "a/b: [c]?", rows: [["x"]] }, { name: "a/b: [c]?", rows: [[1]] }]));
    expect(new TextDecoder().decode(files.find((f) => f.name === "xl/workbook.xml")!.data)).toContain('<sheet name="a b   c" sheetId="1" r:id="rId1"/><sheet name="a b   c 2" sheetId="2" r:id="rId2"/>');
  });

  it("the cutting plan page has the buy list and every bar to scale", () => {
    const html = cuttingPlanHtml(list, nestCutList(list), { title: "frame" });
    expect(html).toContain("<td>SHS 40x40x3</td><td class=\"num\">6000</td><td class=\"num\">1</td>");
    expect(html.match(/<div class="bar">/g)).toHaveLength(1);
  });
});

/** Every tag closed in order (enough to show the XML parses). */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  const body = xml.replace(/<\?xml[^>]*\?>/, "");
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0 && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(body);
}

describe("on the rebuilt table frame", () => {
  let oc: OC;
  beforeAll(async () => {
    oc = await loadOC();
  });
  const table = (): RawDocument => JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));

  it("measures the cuts' orientation, the caps as plates, masses and areas", () => {
    const doc = table();
    doc.features.push({ id: "cap_a", op: "endCap", member: "leg_a", end: "start", thickness: 6 }, { id: "cap_b", op: "endCap", member: "leg_b", end: "start", thickness: 6 });
    const r = rebuild(doc, oc);
    try {
      expect(r.errors).toEqual([]);
      const m = r.measurements!;
      const rail = m.members.find((x) => x.id === "rail_front")!;
      expect(rail.symmetry).toEqual(SQUARE);
      expect(rail.normals![0].map((x) => Math.round(x * 1e4) / 1e4)).toEqual([-0.7071, 0.7071, 0]);
      const list = cutListOf(doc, m);
      expect(list.items.map((i) => [i.item, i.quantity, i.description, i.length, i.endsText, i.faces[0]])).toEqual([
        [1, 2, "SHS 40x40x3", 1200, "45° / 45°, same plane (trapezoid)", "on 40 face"],
        [2, 4, "SHS 40x40x3", 860, "square", ""],
        [3, 2, "SHS 40x40x3", 600, "45° / 45°, same plane (trapezoid)", "on 40 face"],
        [4, 2, "End cap PL 6 × 40 × 40", 40, "", ""],
      ]);
      // A mitred rail is the section times its length at the centroid: 444 × (1200 − 40) = 515 040 mm³, 4.0431 kg in steel.
      expect(list.items[0].massEach).toBeCloseTo((515040 * 7850) / 1e9, 6);
      // The cap: 40 × 40 × 6 = 9600 mm³, 0.07536 kg; plan area 1600 mm²; surface 2 × 1600 + 4 × 40 × 6 = 4160 mm².
      expect(list.items[3]).toMatchObject({ kind: "plate", thickness: 6, plateArea: 1600 });
      expect(list.items[3].massEach).toBeCloseTo(0.07536, 9);
      expect(list.items[3].areaEach).toBeCloseTo(4160, 6);
      // A leg: SHS 40×40×3, 860 long, square: outside 4 × 40 − corner rounding, inside, both ends: what the faces add up to.
      const leg = m.bodies.find((b) => b.name === "leg_c")!;
      expect(list.items[1].areaEach).toBeCloseTo(leg.area!, 6);
    } finally {
      r.dispose();
    }
  });

  it("tells a twisted member from one cut in a single plane", () => {
    const doc = table();
    // A beam from A to B with a mitre to a rail along y at A and to a post up at B: its cuts are a quarter turn apart.
    const twisted: RawDocument = {
      ...doc,
      nodes: { A: [0, 0, 0], B: [1000, 0, 0], C: [0, 600, 0], D: [1000, 0, 600], E: [1000, 600, 0] },
      parameters: {},
      features: [
        { id: "beam", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "A", to: "B" },
        { id: "side", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "A", to: "C" },
        { id: "post", op: "member", profile: "SHS", size: "SHS 40x40x3", from: "B", to: "D" },
        { id: "j1", op: "joint", node: "A", type: "mitre", members: ["beam", "side"] },
        { id: "j2", op: "joint", node: "B", type: "mitre", members: ["beam", "post"] },
      ],
    };
    const r = rebuild(twisted, oc);
    try {
      expect(r.errors).toEqual([]);
      const beam = cutListOf(twisted, r.measurements!).items.find((i) => i.members.includes("beam"))!;
      expect(beam.cuts!.relation).toBe("twisted");
      expect(beam.cuts!.twist).toBe(90);
      expect(beam.endsText).toBe("45° / 45°, twisted 90°");
    } finally {
      r.dispose();
    }
    // The same beam with the second mitre to a rail along y as well: one plane.
    const flat = { ...twisted, features: twisted.features.map((f) => (f.id === "post" ? { ...f, to: "E" } : f)) };
    const r2 = rebuild(flat, oc);
    try {
      const beam = cutListOf(flat, r2.measurements!).items.find((i) => i.members.includes("beam"))!;
      expect(beam.cuts!.relation).toBe("samePlane");
      expect(beam.cuts!.shape).toBe("trapezoid");
    } finally {
      r2.dispose();
    }
  });

  it("keeps the numbers through a rename of a body", () => {
    let doc = table();
    const r = rebuild(doc, oc);
    const list = cutListOf(doc, r.measurements!);
    r.dispose();
    const k = apply(doc, { type: "setCutList", patch: { items: keptNumbering(list) } });
    if (!k.ok) throw new Error(k.error);
    doc = k.doc;
    const renamed = apply(doc, { type: "renameBody", from: "leg_a", to: "front_leg" });
    if (!renamed.ok) throw new Error(renamed.error);
    const items = (renamed.doc.cutList as { items: { members: string[] }[] }).items;
    // leg_a's member keeps its id (its body is named apart from it); the body name is what follows.
    expect(items[1].members).toContain("leg_a");
  });
});

describe("the AI's cut list tools", () => {
  it("setCutList edits through the session; cutList reads the items and nesting; exportCutList writes the files", async () => {
    const { AgentSession } = await import("../src/agent/session");
    const { toolCommand } = await import("../src/ask/tools/batch");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    expect(toolCommand("setCutList", { patch: { stock: { kerf: 2 } } })).toEqual({ type: "setCutList", patch: { stock: { kerf: 2 } } });
    expect(toolCommand("setCutList", {})).toBe("setCutList: patch must be an object of cut list settings");
    const dir = mkdtempSync(join(tmpdir(), "cocaide-cut-"));
    const doc = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
    const s = await AgentSession.open({ doc, outDir: dir });
    const set = await s.call("setCutList", { patch: { itemText: [{ item: 1, members: ["rail_front", "rail_back"], description: "Top rail", properties: { Supplier: "Steel & Co" } }], stock: { lengths: [8000] } } });
    expect(set.result).toMatchObject({ ok: true, changed: true });
    const read = (await s.call("cutList", {})).result as unknown as { items: { item: number; description: string; properties?: Record<string, string>; ends?: string }[]; nesting: { buy: unknown }[] };
    expect(read.items[0]).toMatchObject({ item: 1, description: "Top rail", properties: { Supplier: "Steel & Co" }, ends: "45° / 45°, same plane (trapezoid)" });
    expect(read.nesting[0].buy).toEqual([{ stock: 8000, count: 1 }]);
    const csv = (await s.call("exportCutList", { format: "csv" })).result as unknown as { file: string };
    expect(readFileSync(csv.file, "utf8")).toContain("Top rail");
    const xlsx = (await s.call("exportCutList", { format: "xlsx", file: "frame" })).result as unknown as { file: string };
    expect(xlsx.file.endsWith("frame.xlsx")).toBe(true);
    expect(unzipStored(new Uint8Array(readFileSync(xlsx.file))).some((f) => f.name === "xl/worksheets/sheet1.xml")).toBe(true);
    s.close();
  }, 60_000);
});
