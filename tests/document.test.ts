import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatDocument, parseDocumentText } from "../src/doc/format";
import { allErrors, toDocument, validateDocument } from "../src/doc/validate";

const bracketText = readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8");
const plateText = readFileSync(new URL("../examples/mounting-plate.cocaide.json", import.meta.url), "utf8");

describe("load and save", () => {
  it("parses the spec bracket into a typed document", () => {
    const parsed = parseDocumentText(bracketText);
    expect(parsed.ok).toBe(true);
    const v = validateDocument(parsed.ok && parsed.value);
    expect(allErrors(v)).toEqual([]);
    const doc = toDocument(v)!;
    expect(doc.name).toBe("bracket");
    expect(doc.features.map((f) => f.op)).toEqual(["sketch", "extrude", "hole"]);
  });

  it("saves byte-for-byte the way the spec writes it", () => {
    for (const text of [bracketText, plateText]) {
      const parsed = parseDocumentText(text);
      expect(formatDocument(parsed.ok && parsed.value)).toBe(text);
    }
  });

  it("round-trips through save and load unchanged", () => {
    const parsed = parseDocumentText(plateText);
    const doc = parsed.ok && parsed.value;
    const again = parseDocumentText(formatDocument(doc));
    expect(again.ok && again.value).toEqual(doc);
  });

  it("points at the line and column of a JSON syntax error", () => {
    const parsed = parseDocumentText('{\n  "version": 1,\n  "units": mm\n}');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/^invalid JSON at line 3, column 12/);
  });
});

describe("validation", () => {
  const base = () => JSON.parse(bracketText);

  it("rejects unknown fields instead of ignoring them", () => {
    const doc = base();
    doc.features[1].distnace = 6;
    expect(allErrors(validateDocument(doc))).toEqual([
      'ext_1: unknown field "distnace" (allowed: id, op, sketch, extent, distance, direction)',
    ]);
  });

  it("rejects ops it does not have", () => {
    const doc = base();
    doc.features.push({ id: "loft_1", op: "loft", sections: [] });
    expect(allErrors(validateDocument(doc))).toEqual([
      'loft_1: op: unknown op "loft" (supported: sketch, extrude, cut, hole, fillet, chamfer, linearPattern, circularPattern)',
    ]);
  });

  it("catches duplicate ids and forward references", () => {
    const doc = base();
    doc.features[1].sketch = "sketch_9";
    doc.features[2].id = "ext_1";
    expect(allErrors(validateDocument(doc))).toEqual([
      'ext_1: sketch: "sketch_9" is not a feature before this one',
      'ext_1: id: duplicate id "ext_1"',
    ]);
  });

  it("requires a sketch reference to be a sketch", () => {
    const doc = base();
    doc.features.push({ id: "e2", op: "cut", sketch: "ext_1", distance: 1 });
    expect(allErrors(validateDocument(doc))).toEqual(['e2: sketch: "ext_1" is a extrude, not a sketch']);
  });

  it("checks hole parameters against each other", () => {
    const doc = base();
    doc.features[2].depth = 5;
    doc.features[2].counterbore = { diameter: 5, depth: 6 };
    expect(allErrors(validateDocument(doc))).toEqual([
      "hole_1: counterbore.diameter: must be larger than the hole diameter 6.6 (got 5)",
      "hole_1: counterbore.depth: must be less than the hole depth 5 (got 6)",
    ]);
  });

  it("requires selectors to say which face to pick", () => {
    const doc = base();
    delete doc.features[2].face.pick;
    expect(allErrors(validateDocument(doc))).toEqual([
      'hole_1: face.pick: must be one of "largest", "smallest", "all" (got nothing)',
    ]);
  });

  it("validates constraint references", () => {
    const doc = base();
    doc.features[0].constraints.push({ type: "radius", entity: "r1", value: 3 });
    doc.features[0].constraints.push({ type: "coincident", points: ["r1.start", "r2.center"] });
    expect(allErrors(validateDocument(doc))).toEqual([
      'sketch_1: constraints[1] radius: entity "r1" is a rect; this constraint applies to circle or arc',
      'sketch_1: constraints[2] coincident: point ref "r1.start": a rect has points center',
      'sketch_1: constraints[2] coincident: point ref "r2.center" must be "origin" or "<entity>.<point>" for an entity in this sketch',
    ]);
  });

  it("rejects a zero direction and a missing distance", () => {
    const doc = base();
    doc.features[1].direction = [0, 0, 0];
    delete doc.features[1].distance;
    expect(allErrors(validateDocument(doc))).toEqual([
      "ext_1: distance: must be a number (got nothing)",
      "ext_1: direction: must not be the zero vector",
    ]);
  });

  it("keeps a valid feature usable when its neighbour is broken", () => {
    const doc = base();
    doc.features[2].diameter = -1;
    const v = validateDocument(doc);
    expect(v.features.map((f) => f.feature !== null)).toEqual([true, true, false]);
    expect(toDocument(v)).toBeNull();
  });
});
