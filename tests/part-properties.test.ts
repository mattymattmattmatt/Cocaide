// Part properties and the files around them (Phase P, DESIGN §2.9): the
// document's "properties" (strict validation, setProperties with undo and
// write scopes), who reads them (the drawing's title block, the cut list CSV
// header, STEP export, export file names), what a file opened or dropped
// becomes (src/ui/files/plan.ts), and the MCP tools: setProperties,
// importStep, exportDxf.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { toolCommand } from "../src/ask/tools/batch";
import { apply, type RawDocument } from "../src/doc/commands";
import { csvHeaderRows, exportBase, partProperties, stepProduct } from "../src/doc/properties";
import { allErrors, validateDocument } from "../src/doc/validate";
import { composeSheet } from "../src/drafting/compose";
import { readDxf } from "../src/io/dxf";
import { unzipStored } from "../src/io/zip";
import { exportSTEP, loadOC, rebuild, type OC } from "../src/kernel";
import { exportPartSTEP } from "../src/kernel/stepPart";
import { baseName, bodyNameFor, dxfPart, fileKind, importFeature, readDxfFile, stepPart, stepSizeProblem } from "../src/ui/files/plan";
import { cutListCSV } from "../src/weldment/cutlist";
import { createHistory, record } from "../src/doc/history";

const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket");
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const PROPS = { partNumber: "BR-1001", description: "Base bracket, 6 mm plate", revision: "B", author: "J. Smith", finish: "Hot-dip galvanised", custom: { Customer: "Acme Pty Ltd" } };

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function must(r: ReturnType<typeof apply>): RawDocument {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

describe("the document's properties", () => {
  it("validates them strictly: text only, known keys, no empty values", () => {
    expect(errorsOf({ ...bracket, properties: PROPS })).toEqual([]);
    expect(validateDocument({ ...bracket, properties: PROPS }).properties).toEqual(PROPS);
    expect(errorsOf({ ...bracket, properties: { partNumber: 1001, colour: "red", revision: " ", custom: { "": "x", Job: 7 } } })).toEqual([
      'document: properties: unknown field "colour" (allowed: partNumber, description, revision, author, finish, custom)',
      "document: properties.partNumber: must be text (got 1001)",
      "document: properties.revision: is empty; leave it out instead",
      'document: properties.custom: a property name must be 1 to 60 characters (got "")',
      "document: properties.custom.Job: must be text (got 7)",
    ]);
    expect(errorsOf({ ...bracket, properties: "BR-1001" })).toEqual(['document: properties: must be an object of part properties: partNumber, description, revision, author, finish, custom (got "BR-1001")']);
  });

  it("setProperties merges, removes with null or blank, replaces custom whole, and drops the key when nothing is left", () => {
    let doc = must(apply(bracket, { type: "setProperties", patch: { partNumber: "BR-1001", revision: "A" } }));
    expect(doc.properties).toEqual({ partNumber: "BR-1001", revision: "A" });
    doc = must(apply(doc, { type: "setProperties", patch: { revision: "B", custom: { Customer: "Acme", Job: "" } } }));
    expect(doc.properties).toEqual({ partNumber: "BR-1001", revision: "B", custom: { Customer: "Acme" } });
    doc = must(apply(doc, { type: "setProperties", patch: { custom: null, revision: "  " } }));
    expect(doc.properties).toEqual({ partNumber: "BR-1001" });
    doc = must(apply(doc, { type: "setProperties", patch: { partNumber: null } }));
    expect(doc.properties).toBeUndefined();
    expect(apply(bracket, { type: "setProperties", patch: { partNumber: 5 } })).toEqual({ ok: false, error: "setProperties rejected: document: properties.partNumber: must be text (got 5)" });
  });

  it("agents set them in scope: 'properties', 'drawing' or '*', not '+' or a feature", () => {
    const cmd = toolCommand("setProperties", { patch: { partNumber: "X-1" } });
    expect(cmd).toEqual({ type: "setProperties", patch: { partNumber: "X-1" } });
    if (typeof cmd === "string") return;
    for (const scope of [["properties"], ["drawing"], ["*"]]) expect(apply(bracket, cmd, { writeScope: scope }).ok).toBe(true);
    expect(apply(bracket, cmd, { writeScope: ["+", "hole_1"] })).toEqual({ ok: false, error: "writeScope: setProperties is outside the scope [+, hole_1]" });
  });

  it("names exports by part number and revision, else the part's name", () => {
    expect(exportBase(bracket)).toBe("bracket");
    expect(exportBase({ ...bracket, properties: { partNumber: "BR 1001/2" } })).toBe("BR_1001_2");
    expect(exportBase({ ...bracket, properties: { partNumber: "BR-1001", revision: "B" } })).toBe("BR-1001-revB");
    expect(stepProduct({ ...bracket, properties: PROPS }, "bracket")).toEqual({ name: "BR-1001", description: "Base bracket, 6 mm plate" });
    expect(stepProduct(bracket, "bracket")).toEqual({ name: "bracket", description: null });
    expect(partProperties({ properties: { partNumber: "", finish: "Paint", custom: { a: 1, b: "x" } } })).toEqual({ finish: "Paint", custom: { b: "x" } });
  });

  it("starts the cut list CSV with the part number and description (and leaves it as it was without them)", () => {
    expect(csvHeaderRows(bracket, "bracket")).toEqual([]);
    const rows = csvHeaderRows({ ...bracket, properties: PROPS }, "bracket");
    expect(rows).toEqual([
      ["Part", "bracket"],
      ["Part number", "BR-1001"],
      ["Description", "Base bracket, 6 mm plate"],
      ["Revision", "B"],
    ]);
    expect(cutListCSV([], rows).split("\r\n")).toEqual([
      "Part,bracket",
      "Part number,BR-1001",
      'Description,"Base bracket, 6 mm plate"',
      "Revision,B",
      "",
      "Item,Profile,Size,Length (mm),End 1 (deg),End 2 (deg),Qty,kg each,kg total,Members",
      "",
    ]);
  });
});

describe("undo with a big import in the part", () => {
  it("keeps the undo states within a size budget (the newest, and at least ten)", () => {
    const state = (i: number) => String(i).padStart(2, "0").repeat(500);
    let h = createHistory(state(0));
    for (let i = 1; i <= 30; i++) h = record(h, state(i), 15_000);
    // 15 000 characters hold 15 states of 1000; at least 10 stay whatever the budget.
    expect(h.past).toHaveLength(15);
    expect(h.past[0].startsWith("15")).toBe(true);
    for (let i = 31; i <= 40; i++) h = record(h, state(i), 100);
    expect(h.past).toHaveLength(10);
  });
});

describe("the drawing's title block reads them", () => {
  it("shows part number, description, revision, author and finish; the sheet's own fields win", () => {
    const doc = must(apply({ ...bracket, properties: PROPS }, { type: "setDrawing", drawing: { sheet: { size: "A3", projection: "third" }, views: [], annotations: [] } }));
    const texts = (d: RawDocument) =>
      composeSheet(d, { measurements: null, geometry: null })!
        .prims.filter((p) => p.k === "text" && p.owner === "titleBlock")
        .map((p) => (p as { text: string }).text);
    const words = texts(doc);
    for (const w of ["PART NO.", "BR-1001", "DESCRIPTION", "Base bracket, 6 mm plate", "DRAWING NO.", "REV", "B", "DRAWN", "J. Smith", "FINISH", "Hot-dip galvanised", "bracket"]) expect(words).toContain(w);
    // The drawing's own number and revision win over the part's.
    const own = must(apply(doc, { type: "setSheet", patch: { number: "DWG-7", revision: "C", drawnBy: "K. Lee" } }));
    const ownWords = texts(own);
    expect(ownWords).toEqual(expect.arrayContaining(["DWG-7", "C", "K. Lee", "BR-1001"]));
    expect(ownWords).not.toContain("J. Smith");
  });
});

describe("what a file opened or dropped becomes", () => {
  it("tells files apart by name, then by their first bytes", () => {
    expect([fileKind("a.step"), fileKind("B.STP"), fileKind("c.dxf"), fileKind("d.cocaide.json"), fileKind("e.pdf"), fileKind("f.txt")]).toEqual(["step", "step", "dxf", "part", "drawing", "other"]);
    expect(fileKind("noext", "ISO-10303-21;\nHEADER;")).toBe("step");
    expect(fileKind("noext", "  0\nSECTION\n")).toBe("dxf");
    expect([baseName("C:\\parts\\Bracket v2.step"), bodyNameFor("Bracket v2.step"), bodyNameFor("2-lug.stp"), bodyNameFor("___.step")]).toEqual(["Bracket v2", "Bracket_v2", "_2-lug", "imported"]);
  });

  it("a STEP file: a new part holding it, or an import in this part named after the file (a second one numbered)", () => {
    const r = rebuild(bracket, oc);
    const step = exportSTEP(oc, r.solid!, r.name);
    r.dispose();
    const part = stepPart("lug plate.step", step);
    if (typeof part === "string") throw new Error(part);
    expect(part.doc).toMatchObject({ name: "lug plate", features: [{ id: "import_1", op: "import", format: "step", fileName: "lug plate.step", newBody: "lug_plate" }] });
    expect(errorsOf(part.doc)).toEqual([]);
    const once = importFeature(part.doc, "lug plate.step", step);
    if (typeof once === "string") throw new Error(once);
    expect(once.feature).toMatchObject({ id: "import_2", newBody: "lug_plate2" });
    expect(importFeature(bracket, "notes.step", "hello")).toBe('notes.step does not start with "ISO-10303-21;": it is not a STEP file (save it from the program it came from as STEP AP203, AP214 or AP242).');
    expect(stepSizeProblem(11 * 1024 * 1024).warn).toMatch(/^The STEP file is 11\.0 MB: the part holds the whole file/);
    expect(stepSizeProblem(51 * 1024 * 1024).refuse).toMatch(/^The STEP file is 51\.0 MB: a part holds at most 50\.0 MB/);
  });

  it("a DXF file: a new part with a sketch on Top holding it", () => {
    const read = readDxfFile("slot.dxf", readFileSync(new URL("./fixtures/dxf/slot-plate-r12.dxf", import.meta.url), "utf8"));
    if (typeof read === "string") throw new Error(read);
    const made = dxfPart("slot.dxf", read, { layers: ["OUTLINE"] });
    expect(made.doc).toMatchObject({ name: "slot", features: [{ id: "sketch_1", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } } }] });
    expect(errorsOf(made.doc)).toEqual([]);
    expect(made.report).toBe("Inserted 5 entities (1 text skipped; units not given: read as mm)");
    expect(readDxfFile("x.dxf", "  0\nSECTION\n  2\nENTITIES\n  0\nTEXT\n  1\nhi\n  0\nENDSEC\n  0\nEOF\n")).toBe("x.dxf has no lines, arcs or curves to insert (only 1 text).");
    expect(readDxfFile("y.dxf", "hello")).toBe("y.dxf: not a DXF file: it has no SECTION.");
  });
});

describe("STEP export of a part with properties", () => {
  it("names the product by the part number and carries the description and author", () => {
    const doc = { ...bracket, properties: PROPS };
    const r = rebuild(doc, oc);
    try {
      const text = exportPartSTEP(oc, r, doc);
      expect(text).toContain("PRODUCT('BR-1001','BR-1001','Base bracket, 6 mm plate'");
      expect(text).toContain("FILE_DESCRIPTION(('Base bracket, 6 mm plate')");
      expect(text).toMatch(/FILE_NAME\('BR-1001\.step','[^']*',\('J\. Smith'\)/);
    } finally {
      r.dispose();
    }
  });
});

describe("the MCP tools", () => {
  it("setProperties, importStep from disk, and exportDxf of a sketch, a face and the plates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cocaide-files-"));
    const r = rebuild(bracket, oc);
    writeFileSync(join(dir, "bracket.step"), exportSTEP(oc, r.solid!, r.name));
    r.dispose();
    const s = await AgentSession.open({ doc: bracket, docPath: join(dir, "part.cocaide.json"), outDir: dir });
    try {
      expect((await s.call("setProperties", { patch: { partNumber: "BR-1001" } })).result).toMatchObject({ ok: true });
      expect(s.doc.properties).toEqual({ partNumber: "BR-1001" });
      const imported = (await s.call("importStep", { path: "bracket.step", newBody: "copy", at: [0, 0, 20] })).result;
      expect(imported).toMatchObject({ ok: true, id: "import_1", bodies: ["main", "copy"] });
      expect(imported.volume).toBeCloseTo(2 * 18994.728336, 3);
      expect((await s.call("importStep", { path: "nothing.step" })).result.error).toBe(`importStep: no file ${join(dir, "nothing.step")}`);
      // The agent reads the import without its megabytes of STEP text, and the part's properties with the features.
      const listed = (await s.call("listFeatures")).result;
      expect(listed.properties).toEqual({ partNumber: "BR-1001" });
      expect(JSON.stringify(listed)).not.toContain("ISO-10303-21");
      const got = (await s.call("getFeature", { id: "import_1" })).result as unknown as { feature: { data: string; newBody: string } };
      expect(got.feature.newBody).toBe("copy");
      expect(got.feature.data).toMatch(/^<the STEP file's text, \d+ kB, 1 solid: kept in the document/);

      const sketch = (await s.call("exportDxf", { what: "sketch", sketch: "sketch_1" })).result;
      expect(sketch).toMatchObject({ ok: true, file: join(dir, "BR-1001-sketch_1.dxf") });
      expect(readDxf(readFileSync(sketch.file as string, "utf8")).entities.map((e) => e.type)).toEqual(["polyline"]);
      const face = (await s.call("exportDxf", { what: "face", face: { type: "planar", normal: [0, 0, 1], pick: "largest", body: "main" } })).result;
      expect(face).toMatchObject({ ok: true, file: join(dir, "BR-1001-face.dxf"), entities: 2 });
      const plates = (await s.call("exportDxf", { what: "plates", version: "R12" })).result;
      expect(plates).toMatchObject({ ok: true, file: join(dir, "BR-1001-plates.zip"), plates: "2 plates (2 of 6 mm)" });
      const files = unzipStored(readFileSync(plates.file as string));
      expect(files.map((f) => f.name)).toEqual(["BR-1001-main-6mm-x2.dxf", "BR-1001-plates-overview.dxf", "BR-1001-plates.csv"]);
      expect(new TextDecoder().decode(files[0].data)).toContain("AC1009");
      expect((await s.call("exportDxf", { what: "nonsense" })).result.error).toBe('exportDxf: what must be "sketch" (with sketch), "face" (with a face selector) or "plates"');
    } finally {
      s.close();
    }
  });
});
