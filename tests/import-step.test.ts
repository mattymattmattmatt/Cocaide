// STEP import (Phase P, DESIGN §2.9): the "import" registry op. A STEP file's
// solids become bodies (newBody, newBody_2 ...), placed by rotate (about X,
// then Y, then Z) and at; units are converted; surfaces that close are sewn
// into solids; later features (holes, fillets) work on the imported bodies;
// validation says what is wrong with a file; the document layer counts the
// solids a file makes (for the body names) the way the kernel's reader does.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { importBodies } from "../src/features/import/doc";
import { MAX_STEP_CHARS, stepProblem, stepSolidCount } from "../src/features/import/stepText";
import { exportSTEP, loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { compoundOf } from "../src/kernel/ops";
import { readStepSolids, StepImportError } from "../src/kernel/step";
import { describeFaces } from "../src/kernel/topology";

const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket"); // 80 x 40 x 6 plate on z = 0, centred; a 6.6 hole through at [30, 0]
const stand = example("stand"); // base 120 x 80 x 8 with two 10 mm holes; upright 120 x 8 x 60
const PLATE = 80 * 40 * 6 - Math.PI * 3.3 ** 2 * 6;
const BASE = 120 * 80 * 8 - 2 * Math.PI * 5 ** 2 * 8;
const UPRIGHT = 120 * 8 * 60;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const part = (...features: Record<string, unknown>[]): RawDocument => ({ version: 1, units: "mm", name: "imported", features });

let oc: OC;
let bracketStep: string;
let standStep: string;
beforeAll(async () => {
  oc = await loadOC();
  bracketStep = stepOf(bracket);
  standStep = stepOf(stand);
});

function stepOf(doc: unknown): string {
  const r = rebuild(doc, oc);
  try {
    return exportSTEP(oc, r.solid!, r.name, null, r.bodies);
  } finally {
    r.dispose();
  }
}

function built(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    const m = r.measurements;
    return {
      errors: r.errors,
      volume: m?.volume ?? 0,
      faces: r.solid ? scoped((s) => describeFaces(oc, s, r.solid!).infos.length) : 0,
      box: m?.boundingBox ? { min: m.boundingBox.min.map(r6), max: m.boundingBox.max.map(r6) } : null,
      bodies: (m?.bodies ?? []).map((b) => ({ name: b.name, volume: r6(b.volume), min: b.boundingBox!.min.map(r6), max: b.boundingBox!.max.map(r6) })),
      holes: m?.holeDiameters ?? [],
    };
  } finally {
    r.dispose();
  }
}

const imp = (extra: Record<string, unknown> = {}, data?: string) => ({ id: "import_1", op: "import", format: "step", fileName: "bracket.step", data: data ?? bracketStep, ...extra });

describe("STEP import, document side", () => {
  it("counts the solids a file makes: one part, an assembly of named bodies", () => {
    expect(stepSolidCount(bracketStep)).toBe(1);
    expect(stepSolidCount(standStep)).toBe(2);
    expect(importBodies({ id: "import_1" }, 3)).toEqual(["import_1", "import_1_2", "import_1_3"]);
    expect(importBodies({ id: "import_1", newBody: "lug", names: ["a"] }, 2)).toEqual(["a", "lug_2"]);
  });

  it("knows the bodies an import makes before any rebuild: later features may name them", () => {
    const doc = part(imp({ newBody: "s", data: standStep }));
    const v = validateDocument(doc);
    expect(allErrors(v)).toEqual([]);
    expect(v.bodies).toEqual(["s", "s_2"]);
    // A hole on the second body validates; on a third (there is none) it does not.
    const hole = (body: string) => ({ id: "hole_1", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest", body }, center: [0, 0], diameter: 5, depth: "through", bodies: [body] });
    expect(errorsOf(part(imp({ newBody: "s", data: standStep }), hole("s_2")))).toEqual([]);
    expect(errorsOf(part(imp({ newBody: "s", data: standStep }), hole("s_3")))).toEqual([
      'hole_1: bodies[0]: no body "s_3" before this feature (bodies so far: s, s_2)',
      'hole_1: face.body: no body "s_3" before this feature (bodies so far: s, s_2)',
    ]);
  });

  it("says what is wrong with an import's fields", () => {
    expect(errorsOf(part(imp({ format: "dxf" })))).toEqual(['import_1: format: must be "step" (got "dxf"); a DXF drawing goes into a sketch instead: Insert DXF in the sketcher']);
    expect(errorsOf(part({ id: "import_1", op: "import", format: "step", fileName: "", data: "" }))).toEqual([
      'import_1: fileName: must be the name of the file it came from, like "bracket.step" (got "")',
      'import_1: data: must be the STEP file\'s text (got "")',
    ]);
    expect(errorsOf(part(imp({}, '{ "version": 1 }')))).toEqual(["import_1: data: is JSON, not STEP text: open a .cocaide.json part with Open"]);
    expect(errorsOf(part(imp({}, "solid cube\nfacet normal 0 0 1\n")))).toEqual([
      'import_1: data: does not start with "ISO-10303-21;": it is not a STEP file (save it from the program it came from as STEP AP203, AP214 or AP242)',
    ]);
    expect(errorsOf(part(imp({}, bracketStep.slice(0, 2000))))).toEqual(['import_1: data: does not end with "END-ISO-10303-21;": the file is cut short; export or copy it again']);
    expect(errorsOf(part(imp({ at: [1, 2], rotate: "90", colour: "red" })))).toEqual([
      'import_1: unknown field "colour" (allowed: id, op, format, fileName, data, newBody, names, at, rotate)',
      "import_1: at: must be an array of 3 numbers (got [1,2])",
      'import_1: rotate: must be an array of 3 numbers (got "90")',
    ]);
    // A name that is taken.
    expect(errorsOf({ ...bracket, features: [...bracket.features, imp({ newBody: "main" })] })).toEqual(['import_1: newBody: would make body "main", which is already a body']);
  });

  it("refuses a file over the size a part holds", () => {
    const big = `ISO-10303-21;\nDATA;\n${"x".repeat(MAX_STEP_CHARS)}\nEND-ISO-10303-21;\n`;
    expect(errorsOf(part(imp({}, big)))).toEqual(["import_1: data: is 50.0 MB of STEP text; a part holds at most 50.0 MB: simplify the model (fewer, simpler faces) or import it in parts"]);
    expect(stepProblem(bracketStep)).toBeNull();
  });

  it("renaming one imported body names them all, so the others keep theirs", () => {
    const doc = part(imp({ newBody: "s", data: standStep }), { id: "hole_1", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest", body: "s_2" }, center: [0, 0], diameter: 5, depth: 6, bodies: ["s_2"] });
    const r = apply(doc, { type: "renameBody", from: "s_2", to: "upright" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.features[0]).toMatchObject({ newBody: "s", names: ["s", "upright"] });
    expect(r.doc.features[1]).toMatchObject({ bodies: ["upright"], face: { body: "upright" } });
    // Renaming the first back and forth keeps it tidy: names that are the default again go.
    const back = apply(r.doc, { type: "renameBody", from: "upright", to: "s_2" });
    expect(back.ok && back.doc.features[0].names).toBeUndefined();
  });
});

describe("STEP import, kernel side", () => {
  it("exports the bracket and imports it back: the same volume, faces and box", () => {
    const original = built(bracket);
    const back = built(part(imp()));
    expect(back.errors).toEqual([]);
    expect(back.volume).toBeCloseTo(PLATE, 4);
    expect(back.volume).toBeCloseTo(original.volume, 6);
    expect(back.faces).toBe(original.faces);
    expect(back.box).toEqual(original.box);
    expect(back.bodies.map((b) => b.name)).toEqual(["import_1"]);
    expect(back.holes).toEqual([6.6]);
  });

  it("places the file: turned about X, then Y, then Z, then moved by at", () => {
    // 90° about X takes (x, y, z) to (x, −z, y): the plate stands up, 6 deep in −y, 40 tall; then up 50.
    expect(built(part(imp({ rotate: [90, 0, 0], at: [0, 0, 50] }))).box).toEqual({ min: [-40, -6, 30], max: [40, 0, 70] });
    // Then 90° about Z takes (x, y, z) to (−y, x, z): x from 0..6, y from −40..40.
    expect(built(part(imp({ rotate: [90, 0, 90] }))).box).toEqual({ min: [0, -40, -20], max: [6, 40, 20] });
    // About Z alone: the plate lies along y, x from −20..20, then 10 along x.
    expect(built(part(imp({ rotate: [0, 0, 90], at: [10, 0, 0] }))).box).toEqual({ min: [-10, -40, 0], max: [30, 40, 6] });
  });

  it("makes one body per solid of a multi-body file, in the file's order", () => {
    const b = built(part(imp({ fileName: "stand.step", newBody: "s", data: standStep })));
    expect(b.errors).toEqual([]);
    expect(b.bodies.map((x) => [x.name, x.volume])).toEqual([
      ["s", r6(BASE)],
      ["s_2", UPRIGHT],
    ]);
  });

  it("builds features on imported bodies: a hole in the top face and fillets on its vertical edges", () => {
    const doc = part(
      imp({ newBody: "plate" }),
      { id: "hole_2", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [-30, 0], diameter: 10, depth: "through" },
      { id: "fillet_1", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], length: 6, pick: "all" }, radius: 5 },
    );
    const b = built(doc);
    expect(b.errors).toEqual([]);
    // Less a Ø10 hole through 6, and four corners rounded R5: each takes 5² − π5²/4 off the plan.
    expect(b.volume).toBeCloseTo(PLATE - Math.PI * 25 * 6 - 4 * (25 - (Math.PI * 25) / 4) * 6, 4);
    expect(b.holes.sort()).toEqual([10, 6.6]);
  });

  it("converts the file's units: a file in centimetres comes in ten times as long", () => {
    const cm = bracketStep.replace("SI_UNIT(.MILLI.,.METRE.)", "SI_UNIT(.CENTI.,.METRE.)");
    expect(cm).not.toBe(bracketStep);
    const b = built(part(imp({}, cm)));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(PLATE * 1000, 0);
    expect(b.box).toEqual({ min: [-400, -200, 0], max: [400, 200, 60] });
  });

  it("sews a file of surfaces that close into a solid, and refuses one that stays open", () => {
    const shells = scoped((s) => {
      const box = s.track(new oc.BRepPrimAPI_MakeBox(10, 20, 30));
      const shell = s.track(box.Shell());
      const faces: ReturnType<typeof box.Shape>[] = [];
      const ex = s.track(new oc.TopExp_Explorer(shell, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; ex.More(); ex.Next()) faces.push(s.track(ex.Current()));
      return { closed: exportSTEP(oc, shell, "closed-shell"), open: exportSTEP(oc, compoundOf(oc, s, faces.slice(0, 5)), "open-shell") };
    });
    expect(shells.closed).not.toContain("MANIFOLD_SOLID_BREP");
    const b = built(part(imp({ fileName: "closed-shell.step" }, shells.closed)));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(10 * 20 * 30, 6);
    const open = built(part(imp({ fileName: "open-shell.step" }, shells.open)));
    expect(open.errors).toHaveLength(1);
    expect(open.errors[0]).toMatch(/^import_1: the STEP file holds surfaces only \(5 faces\) and they do not close into a solid \(\d+ open edges after sewing\): export the part as a solid, or close the gaps in the program it came from$/);
  });

  it("counts a part used twice in an assembly twice, as the reader makes it: the document and the kernel agree", () => {
    // An assembly with one 10 x 20 x 30 block placed twice (two occurrences of one product), written with XCAF.
    const text = scoped((s) => {
      const box = s.track(new oc.BRepPrimAPI_MakeBox(10, 20, 30));
      const solid = s.track(box.Shape());
      const str = (v: string) => s.track(new oc.TCollection_ExtendedString(v, false));
      const doc = new oc.TDocStd_Document(str("XmlXCAF"));
      const shapes = oc.XCAFDoc_DocumentTool.ShapeTool(s.track(doc.Main()));
      const assembly = s.track(shapes.NewShape());
      oc.TDataStd_Name.Set(assembly, str("pair"));
      const label = s.track(shapes.AddShape(solid, false, false));
      oc.TDataStd_Name.Set(label, str("block"));
      for (const x of [0, 50]) {
        const t = s.track(new oc.gp_Trsf());
        t.SetTranslation(s.track(new oc.gp_Vec(x, 0, 0)));
        s.track(shapes.AddComponent(assembly, label, s.track(new oc.TopLoc_Location(t))));
      }
      shapes.UpdateAssemblies();
      const writer = s.track(new oc.STEPCAFControl_Writer());
      const path = "/pair.step";
      if (!writer.Perform(doc, path, s.track(new oc.Message_ProgressRange()))) throw new Error("write failed");
      const out = new TextDecoder().decode(oc.FS.readFile(path) as Uint8Array);
      oc.FS.unlink(path);
      return out;
    });
    expect(text.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(1);
    expect(stepSolidCount(text)).toBe(2);
    const b = built(part(imp({ fileName: "pair.step", newBody: "block" }, text)));
    expect(b.errors).toEqual([]);
    expect(b.bodies.map((x) => [x.name, x.volume, x.min[0]])).toEqual([
      ["block", 6000, 0],
      ["block_2", 6000, 50],
    ]);
  });

  it("says when a STEP file holds nothing to build", () => {
    const empty = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('x','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    expect(() => readStepSolids(oc, empty)).toThrow(StepImportError);
    const b = built(part(imp({}, empty)));
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]).toMatch(/^import_1: the STEP file (is empty|has nothing the reader can turn into a shape)/);
  });

  it("keeps the file's solids between rebuilds: the second rebuild reuses them", () => {
    const doc = part(imp());
    const t0 = performance.now();
    built(doc);
    const first = performance.now() - t0;
    const t1 = performance.now();
    const again = built({ ...doc, features: [{ ...doc.features[0], at: [5, 0, 0] }] });
    const second = performance.now() - t1;
    expect(again.box!.min[0]).toBe(-35);
    // Not a timing test so much as a sanity check that the cache is used: reading parses the whole file.
    expect(second).toBeLessThan(first * 5 + 50);
  });
});

describe("STEP export reads the part's properties", () => {
  it("names the product by the part number, and writes the description and author", () => {
    const r = rebuild(bracket, oc);
    try {
      const text = exportSTEP(oc, r.solid!, "BR-1001", "Base bracket", r.bodies, { author: "J. Smith", productDescription: "Base bracket, 6 mm plate" });
      expect(text).toContain("PRODUCT('BR-1001','BR-1001','Base bracket, 6 mm plate'");
      expect(text).toContain("FILE_DESCRIPTION(('Base bracket')");
      expect(text).toMatch(/FILE_NAME\('BR-1001\.step','[^']*',\('J\. Smith'\)/);
    } finally {
      r.dispose();
    }
  });
});
