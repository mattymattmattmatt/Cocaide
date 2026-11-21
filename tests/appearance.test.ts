// Appearances: stored on the part, a body, a feature, a material or an
// assembly component; validated strictly; set and cleared by one command; and
// resolved per face, most particular first.
import { describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { faceAppearances, finishLight, inkOn, parseHex, PartAppearances, rgbToHex, hexToRgb, srgbToLinear, swatchName, SWATCH_GROUPS } from "../src/appearance";

const XY = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const plate = (): RawDocument => ({
  version: 1,
  units: "mm",
  name: "plate",
  features: [
    { id: "sk", op: "sketch", plane: XY, entities: [{ id: "r", type: "rect", center: [0, 0], w: 100, h: 60 }] },
    { id: "base", op: "extrude", sketch: "sk", distance: 10 },
    { id: "sk2", op: "sketch", plane: XY, entities: [{ id: "r", type: "rect", center: [80, 0], w: 30, h: 30 }] },
    { id: "lug", op: "extrude", sketch: "sk2", distance: 10, newBody: "lug" },
    { id: "bore", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [0, 0], diameter: 12, depth: "through" },
  ],
}) as unknown as RawDocument;
const must = (r: ReturnType<typeof apply>) => {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
};

describe("an appearance in the document", () => {
  it("is checked strictly and kept tidy (lower case, no default opacity or finish)", () => {
    const v = validateDocument({ ...plate(), appearance: { color: "#3A7BD5", opacity: 1, finish: "satin" } });
    expect(allErrors(v)).toEqual([]);
    expect(v.appearance).toEqual({ color: "#3a7bd5" });
    const bad = validateDocument({ ...plate(), appearance: { color: "blue", opacity: 2, finish: "shiny", glow: 1 } });
    expect(allErrors(bad)).toEqual([
      'document: appearance: unknown field "glow" (allowed: color, opacity, finish)',
      'document: appearance.color: must be a colour "#rrggbb", like "#3a7bd5" (got "blue")',
      "document: appearance.opacity: must be a number from 0.1 (nearly clear) to 1 (opaque) (got 2)",
      'document: appearance.finish: must be "matte", "satin", "gloss", "metallic" (got "shiny")',
    ]);
  });

  it("goes on bodies that exist, features that make faces, materials and components", () => {
    const doc = plate() as Record<string, unknown>;
    doc.bodyAppearances = { lug: { color: "#d64545" }, nothing: { color: "#000000" } };
    (doc.features as Record<string, unknown>[])[0].appearance = { color: "#ffffff" };
    (doc.features as Record<string, unknown>[])[4].appearance = { color: "#2f6fd6", finish: "gloss" };
    doc.material = { name: "steel", densityKgPerM3: 7850, appearance: { color: "#8c939b", finish: "metallic" } };
    const v = validateDocument(doc);
    expect(allErrors(v)).toEqual([
      'document: bodyAppearances.nothing: no body "nothing" (bodies: main, lug)',
      "sk: appearance: a sketch makes no faces to colour: give the feature that uses it the appearance",
    ]);
    expect(v.material?.appearance).toEqual({ color: "#8c939b", finish: "metallic" });
    expect(v.features[4].feature?.appearance).toEqual({ color: "#2f6fd6", finish: "gloss" });
    const asm = validateDocument({ ...plate(), assembly: { components: [{ id: "a", part: "self", appearance: { color: "#4f9d5d", opacity: 0.5 } }] } });
    expect(asm.assemblyErrors ?? []).toEqual([]);
    expect(asm.assembly?.components[0].appearance).toEqual({ color: "#4f9d5d", opacity: 0.5 });
  });
});

describe("setAppearance", () => {
  it("colours the part, a body, a feature or a component, and null takes it back", () => {
    let doc = must(apply(plate(), { type: "setAppearance", appearance: { color: "#c4cad3" } }));
    expect(doc.appearance).toEqual({ color: "#c4cad3" });
    doc = must(apply(doc, { type: "setAppearance", body: "lug", appearance: { color: "#d64545" } }));
    doc = must(apply(doc, { type: "setAppearance", feature: "bore", appearance: { color: "#2f6fd6" } }));
    expect(doc.bodyAppearances).toEqual({ lug: { color: "#d64545" } });
    expect((doc.features as Record<string, unknown>[]).find((f) => f.id === "bore")!.appearance).toEqual({ color: "#2f6fd6" });
    doc = must(apply(doc, { type: "setAppearance", body: "lug", appearance: null }));
    expect(doc.bodyAppearances).toBeUndefined();
    doc = must(apply(doc, { type: "setAppearance", appearance: null }));
    expect(doc.appearance).toBeUndefined();
  });

  it("says what is wrong", () => {
    const err = (cmd: Record<string, unknown>) => {
      const r = apply(plate(), { type: "setAppearance", ...cmd } as never);
      return r.ok ? null : r.error;
    };
    expect(err({ body: "ghost", appearance: { color: "#000000" } })).toBe('setAppearance: no body "ghost" (bodies: main, lug)');
    expect(err({ feature: "sk", appearance: { color: "#000000" } })).toBe("setAppearance: sk is a sketch, which makes no faces: colour the feature that uses it");
    expect(err({ body: "lug", feature: "bore", appearance: { color: "#000000" } })).toBe("setAppearance: give one of body, feature or component (or none, for the part), not body and feature");
    expect(err({ appearance: { color: "red" } })).toMatch(/^setAppearance rejected: document: appearance\.color: must be a colour/);
    expect(err({ component: "x", appearance: { color: "#000000" } })).toBe('setAppearance: no component "x" (components: none)');
  });

  it("follows a body that is renamed, and goes with a body that is deleted", () => {
    let doc = must(apply(plate(), { type: "setAppearance", body: "lug", appearance: { color: "#d64545" } }));
    doc = must(apply(doc, { type: "deleteFeature", id: "lug" } as never));
    expect(doc.bodyAppearances).toBeUndefined();
  });
});

describe("a face's appearance", () => {
  const doc = {
    ...plate(),
    material: { name: "steel", densityKgPerM3: 7850, appearance: { color: "#8c939b", finish: "metallic" } },
    bodyMaterials: { lug: { name: "pine", densityKgPerM3: 550, appearance: { color: "#e2c18f" } } },
  } as Record<string, unknown>;

  it("is the most particular said: feature, body, body material, part, part material", () => {
    const faces = [{ createdBy: "base", body: "main" }, { createdBy: "lug", body: "lug" }, { createdBy: "bore", body: "main" }];
    expect(faceAppearances(doc, faces)).toEqual([{ color: "#8c939b", finish: "metallic" }, { color: "#e2c18f" }, { color: "#8c939b", finish: "metallic" }]);
    const coloured = { ...doc, appearance: { color: "#ffffff" }, bodyAppearances: { lug: { color: "#d64545" } }, features: (doc.features as Record<string, unknown>[]).map((f) => (f.id === "bore" ? { ...f, appearance: { color: "#2f6fd6" } } : f)) };
    expect(faceAppearances(coloured, faces)).toEqual([{ color: "#ffffff" }, { color: "#d64545" }, { color: "#2f6fd6" }]);
    const p = new PartAppearances(coloured);
    expect(p.face(faces[2])).toEqual({ appearance: { color: "#2f6fd6" }, source: "feature", from: "bore" });
    expect(p.body("lug")).toEqual({ appearance: { color: "#d64545" }, source: "body", from: "lug" });
    expect(new PartAppearances(doc).body("lug")).toEqual({ appearance: { color: "#e2c18f" }, source: "bodyMaterial", from: "pine" });
  });

  it("is the default when nothing is said, and a member's colour stays on its own body", () => {
    expect(faceAppearances(plate(), [{ createdBy: "base", body: "main" }])).toEqual([null]);
    const frame = { features: [{ id: "post", op: "member", appearance: { color: "#d64545" } }] };
    // A joint cut on the rail by the post names the rail's end face after the post: it keeps the rail's colour.
    expect(faceAppearances(frame, [{ createdBy: "post", body: "post" }, { createdBy: "post", body: "rail" }])).toEqual([{ color: "#d64545" }, null]);
    // A suppressed feature colours nothing.
    expect(faceAppearances({ features: [{ id: "f", op: "fillet", suppressed: true, appearance: { color: "#000000" } }] }, [{ createdBy: "f" }])).toEqual([null]);
  });
});

describe("colours", () => {
  it("read and write hex, convert to linear light, and choose ink", () => {
    expect(parseHex("#ABC")).toBe("#aabbcc");
    expect(parseHex("3a7bd5")).toBe("#3a7bd5");
    expect(parseHex("blue")).toBeNull();
    expect(rgbToHex(hexToRgb("#3a7bd5"))).toBe("#3a7bd5");
    expect(srgbToLinear(1)).toBeCloseTo(1, 9);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214, 3);
    expect(inkOn("#f4f5f7")).toBe("#111827");
    expect(inkOn("#1d1f23")).toBe("#ffffff");
    expect(finishLight("metallic").metalness).toBeGreaterThan(finishLight(undefined).metalness);
  });

  it("names a swatch, and every swatch is a valid appearance", () => {
    expect(swatchName({ color: "#8c939b", finish: "metallic" })).toBe("Steel");
    expect(swatchName({ color: "#8c939b" })).toBeNull();
    for (const g of SWATCH_GROUPS) for (const s of g.swatches) expect(allErrors(validateDocument({ ...plate(), appearance: s.appearance }))).toEqual([]);
  });
});
