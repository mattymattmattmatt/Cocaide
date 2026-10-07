// Phase I: weldment profiles drawn as sketches, their sections measured, the
// section library, and straight members that sweep a part's copy of a profile.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import type { ProfileDef, SketchEntity } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { kgPerMetre, sectionAt, sectionOf, sizedEntities, suggestTags } from "../src/geom/section";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { measurementSummary } from "../src/kernel/inspect";
import { cutList } from "../src/weldment/cutlist";
import {
  addLibraryMember,
  designationFor,
  exportLibrary,
  mergeLibrary,
  nameTaken,
  partCopy,
  profileFromSketch,
  searchLibrary,
  sketchParameters,
  toEntry,
  updatePartCopy,
  type LibraryEntry,
} from "../src/weldment/library";

const frame: RawDocument = JSON.parse(readFileSync(new URL("../examples/frame-members.cocaide.json", import.meta.url), "utf8"));
const SHS = (frame.profiles as Record<string, ProfileDef>).SHS;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function must(r: ReturnType<typeof apply>): RawDocument {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

function built(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    const m = r.measurements;
    return {
      errors: r.errors,
      bodies: m ? m.bodies.map((b) => ({ name: b.name, volume: r6(b.volume), min: b.boundingBox!.min.map(r6), max: b.boundingBox!.max.map(r6) })) : [],
      members: m?.members ?? [],
      interference: m?.interference ?? [],
      summary: m ? measurementSummary(m) : null,
    };
  } finally {
    r.dispose();
  }
}

/** The part the acceptance draws: SHS b × b × t, its dimensions written as expressions. */
const drawn: RawDocument = {
  version: 1,
  units: "mm",
  name: "shs",
  parameters: { b: 40, t: 3, unrelated: 7 },
  features: [
    {
      id: "sketch_1",
      op: "sketch",
      plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
      entities: [
        { id: "r1", type: "rect", center: [0, 0], w: 40, h: 40 },
        { id: "r2", type: "rect", center: [0, 0], w: 34, h: 34 },
      ],
      constraints: [
        { type: "coincident", points: ["r1.center", "origin"] },
        { type: "distanceX", entity: "r1", value: "=b" },
        { type: "distanceY", entity: "r1", value: "=b" },
        { type: "coincident", points: ["r2.center", "origin"] },
        { type: "distanceX", entity: "r2", value: "=b - 2 * t" },
        { type: "distanceY", entity: "r2", value: "=b - 2 * t" },
      ],
    },
  ],
};

const rect = (id: string, w: number, h: number, center: [number, number] = [0, 0]): SketchEntity => ({ id, type: "rect", center, w, h });

describe("section properties", () => {
  it("measures SHS 40×40×3: 444 mm², 3.49 kg/m, Ix about its centroid, and suggests hollow and square", () => {
    const r = sectionAt(SHS, "SHS 40x40x3");
    if (!r.ok) throw new Error(r.error);
    expect(r.props.area).toBeCloseTo(444, 9);
    expect(r.props.centroid).toEqual([0, 0]);
    expect(r.props.envelope).toEqual([40, 40]);
    expect(r.props.ix).toBeCloseTo((40 ** 4 - 34 ** 4) / 12, 6);
    expect(r.props.iy).toBeCloseTo(r.props.ix, 6);
    expect(kgPerMetre(r.props.area)).toBeCloseTo(3.4854, 6);
    expect(suggestTags(r.props)).toEqual(["hollow", "square", "40x40"]);
  });

  it("re-solves drawn geometry at each size: dimensions written =b follow the size", () => {
    const at50 = sectionAt(SHS, "SHS 50x50x3");
    if (!at50.ok) throw new Error(at50.error);
    expect(at50.props.area).toBeCloseTo(564, 9);
    // The same profile drawn as numbers, driven only by its constraints: the solver moves the geometry.
    const numeric: ProfileDef = { ...SHS, entities: [rect("r1", 40, 40), rect("r2", 34, 34)] };
    const s = sizedEntities(numeric, { designation: "SHS 50x50x5", values: { b: 50, t: 5 } });
    if (!s.ok) throw new Error(s.error);
    expect(s.entities).toEqual([rect("r1", 50, 50), rect("r2", 40, 40)]);
    const r = sectionOf(s.entities);
    expect(r.ok && r.props.area).toBeCloseTo(900, 9);
  });

  it("finds an angle's centroid off the corner, and calls it open; a round tube is round", () => {
    const angle: SketchEntity[] = [
      { id: "a", type: "line", start: [0, 0], end: [50, 0] },
      { id: "b", type: "line", start: [50, 0], end: [50, 5] },
      { id: "c", type: "line", start: [50, 5], end: [5, 5] },
      { id: "d", type: "line", start: [5, 5], end: [5, 50] },
      { id: "e", type: "line", start: [5, 50], end: [0, 50] },
      { id: "f", type: "line", start: [0, 50], end: [0, 0] },
    ];
    const l = sectionOf(angle);
    if (!l.ok) throw new Error(l.error);
    expect(l.props.area).toBeCloseTo(475, 9);
    expect(l.props.centroid[0]).toBeCloseTo(14.342105, 5);
    expect(l.props.centroid[1]).toBeCloseTo(14.342105, 5);
    expect(suggestTags(l.props)).toEqual(["open", "50x50"]);

    const chs = sectionOf([
      { id: "o", type: "circle", center: [0, 0], radius: 24.15 },
      { id: "i", type: "circle", center: [0, 0], radius: 21.35 },
    ]);
    if (!chs.ok) throw new Error(chs.error);
    expect(chs.props.area).toBeCloseTo(Math.PI * (24.15 ** 2 - 21.35 ** 2), 9);
    expect(suggestTags(chs.props)).toEqual(["hollow", "round", "48.3x48.3"]);
    const bar = sectionOf([rect("r", 60, 20)]);
    expect(bar.ok && suggestTags(bar.props)).toEqual(["solid", "rectangular", "60x20"]);
  });

  it("says why an open sketch is not a section", () => {
    const r = sectionOf([{ id: "a", type: "line", start: [0, 0], end: [50, 0] }]);
    expect(r.ok).toBe(false);
  });
});

describe("profiles in a part, and members", () => {
  it("validates profiles: sizes need every parameter, unique designations and positive values", () => {
    expect(allErrors(validateDocument(frame))).toEqual([]);
    const bad = structuredClone(frame);
    const p = (bad.profiles as Record<string, Record<string, unknown>>).SHS;
    p.sizes = [
      { designation: "A", values: { b: 40 } },
      { designation: "A", values: { b: 40, t: 0 } },
      { designation: "B", values: { b: 40, t: 3, w: 1 } },
    ];
    p.anchor = "corner";
    const errors = allErrors(validateDocument(bad));
    expect(errors).toContain("document: profiles.SHS.sizes[0].values: needs a value for t");
    expect(errors).toContain('document: profiles.SHS.sizes[1].designation: "A" is listed twice');
    expect(errors).toContain("document: profiles.SHS.sizes[1].values.t: must be a number greater than 0 (got 0)");
    expect(errors).toContain("document: profiles.SHS.sizes[2].values.w: is not one of the profile's parameters (b, t)");
    expect(errors).toContain('document: profiles.SHS.anchor: must be "centroid" or "origin" (got "corner")');
    // Its members point at the profile's errors, not at a missing profile.
    expect(errors).toContain('leg: profile: the part\'s profile "SHS" has errors (see profiles.SHS)');
  });

  it("validates members: the profile and size must be the part's, and the line must have length", () => {
    const bad = structuredClone(frame);
    bad.features = [
      { id: "m1", op: "member", profile: "RHS", size: "x", from: [0, 0, 0], to: [1, 0, 0] },
      { id: "m2", op: "member", profile: "SHS", size: "SHS 60x60x4", from: [0, 0, 0], to: [1, 0, 0] },
      { id: "m3", op: "member", profile: "SHS", size: "SHS 40x40x3", from: [5, 5, 5], to: [5, 5, 5] },
    ];
    const errors = allErrors(validateDocument(bad));
    expect(errors).toContain('m1: profile: no profile "RHS" in the part (profiles: SHS)');
    expect(errors).toContain('m2: size: "SHS 60x60x4" is not a size of SHS (sizes: SHS 40x40x3, SHS 50x50x3)');
    expect(errors).toContain("m3: to: must not be the same point as from");
  });

  it("builds each member as its own body, upright and centred on its line, measured with its length and mass", () => {
    const b = built(frame);
    expect(b.errors).toEqual([]);
    expect(b.bodies).toEqual([
      { name: "leg", volume: 444 * 900, min: [-20, -20, 0], max: [20, 20, 900] },
      { name: "rail", volume: 564 * 600, min: [100, -25, -25], max: [700, 25, 25] },
    ]);
    expect(b.interference).toEqual([]);
    expect(b.members.map((m) => ({ ...m, massKg: Math.round(m.massKg * 1e4) / 1e4 }))).toEqual([
      { id: "leg", body: "leg", profile: "SHS", designation: "SHS 40x40x3", length: 900, angles: [0, 0], perimeters: [160, 160], massKg: 3.1369 },
      { id: "rail", body: "rail", profile: "SHS", designation: "SHS 50x50x3", length: 600, angles: [0, 0], perimeters: [200, 200], massKg: 2.6564 },
    ]);
  });

  it("rotates a member about its line, and anchors on the sketch origin when asked", () => {
    const rhs = structuredClone(frame);
    const p = (rhs.profiles as Record<string, ProfileDef>).SHS;
    p.entities = [rect("r1", 60, 20, [30, 10])];
    p.constraints = [];
    p.parameters = {};
    p.sizes = [{ designation: "flat 60x20", values: {} }];
    rhs.features = [{ id: "bar", op: "member", profile: "SHS", size: "flat 60x20", from: [0, 0, 0], to: [100, 0, 0], rotation: 90 }];
    // Along +X the frame is right-handed with +Z up: the profile's x runs along +Y and its y up +Z, so it reads as
    // drawn from the "to" end. Turned 90° about the line, its 60 mm width stands up.
    expect(built(rhs).bodies[0]).toMatchObject({ min: [0, -10, -30], max: [100, 10, 30] });
    p.anchor = "origin";
    rhs.features = [{ id: "bar", op: "member", profile: "SHS", size: "flat 60x20", from: [0, 0, 0], to: [100, 0, 0] }];
    expect(built(rhs).bodies[0]).toMatchObject({ min: [0, 0, 0], max: [100, 60, 20] });
  });

  it("patterns a member into new bodies, renames a member's body, and will not drop a profile a member uses", () => {
    let doc = must(apply(frame, { type: "addFeature", feature: { id: "legs", op: "linearPattern", feature: "leg", direction: [1, 0, 0], spacing: 800, count: 2 } }));
    expect(built(doc).bodies.map((b) => b.name)).toEqual(["leg", "rail", "leg_2"]);
    doc = must(apply(doc, { type: "renameBody", from: "leg", to: "post" }));
    expect(doc.features[0]).toMatchObject({ id: "leg", newBody: "post" });
    expect(built(doc).bodies.map((b) => b.name)).toEqual(["post", "rail", "post_2"]);
    const r = apply(doc, { type: "setProfile", name: "SHS", profile: null });
    expect(r.ok || r.error).toBe("setProfile: SHS is used by leg, rail");
  });

  it("lists alike members together, as a cut list counts them", () => {
    const doc = must(apply(frame, { type: "addFeature", feature: { id: "leg2", op: "member", profile: "SHS", size: "SHS 40x40x3", from: [800, 0, 0], to: [800, 0, 900] } }));
    const groups = cutList(built(doc).members);
    expect(groups.map((g) => [g.designation, g.length, g.members])).toEqual([
      ["SHS 40x40x3", 900, ["leg", "leg2"]],
      ["SHS 50x50x3", 600, ["rail"]],
    ]);
  });
});

describe("the section library", () => {
  const sketch = drawn.features[0];

  it("makes a profile from a sketch: the parameters its dimensions use are its size parameters", () => {
    expect(sketchParameters(sketch, drawn)).toEqual({ b: 40, t: 3 });
    expect(designationFor("SHS", { b: 40, t: 3 })).toBe("SHS 40x3");
    const def = profileFromSketch(sketch, drawn, {
      name: " SHS ",
      sizes: [
        { designation: "SHS 40x40x3", values: { b: 40, t: 3 } },
        { designation: "SHS 50x50x3", values: { b: 50, t: 3 } },
      ],
      anchor: "centroid",
      tags: ["hollow", "square", " hollow ", ""],
      material: " S355 ",
    });
    expect(def).toMatchObject({ name: "SHS", parameters: { b: 40, t: 3 }, tags: ["hollow", "square"], material: "S355" });
    expect(def.constraints).toEqual(sketch.constraints);
    // It validates as a part's profile, and measures at both sizes.
    expect(allErrors(validateDocument({ ...drawn, profiles: { SHS: def } }))).toEqual([]);
    expect(def.sizes.map((s) => (sectionAt(def, s.designation) as { props: { area: number } }).props.area.toFixed(6))).toEqual(["444.000000", "564.000000"]);
  });

  const entry = (name: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
    ...toEntry({ ...SHS, name }, undefined, `id-${name}`, new Date("2026-10-01T00:00:00Z")),
    ...extra,
  });

  it("versions a profile saved again, keeping its id, star and uses", () => {
    const first = { ...entry("SHS"), favourite: true, uses: 4 };
    expect(first).toMatchObject({ id: "id-SHS", version: 1 });
    const second = toEntry({ ...SHS, tags: ["hollow"], library: { id: "ignored", version: 9 } }, first, "fresh", new Date("2026-10-02T00:00:00Z"));
    expect(second).toMatchObject({ id: "id-SHS", version: 2, favourite: true, uses: 4, tags: ["hollow"], updatedAt: "2026-10-02T00:00:00.000Z" });
    expect("library" in second).toBe(false);
    expect(partCopy(second)).toEqual({ ...SHS, tags: ["hollow"], library: { id: "id-SHS", version: 2 } });
  });

  it("searches every word in names, designations and tags: favourites first, then the most used", () => {
    const all = [
      entry("RHS", { tags: ["hollow", "rectangular"], uses: 9 }),
      entry("SHS", { uses: 1 }),
      entry("Angle", { tags: ["open"], sizes: [{ designation: "L 50x50x5", values: { b: 50, t: 3 } }], favourite: true }),
      entry("CHS", { tags: ["hollow", "round"], uses: 1 }),
    ];
    expect(searchLibrary(all, "").map((e) => e.name)).toEqual(["Angle", "RHS", "CHS", "SHS"]);
    expect(searchLibrary(all, "hollow").map((e) => e.name)).toEqual(["RHS", "CHS", "SHS"]);
    expect(searchLibrary(all, "SQUARE 50x50").map((e) => e.name)).toEqual(["SHS"]);
    expect(searchLibrary(all, "l 50x50x5").map((e) => e.name)).toEqual(["Angle"]);
    expect(nameTaken(all, " shs ")).toBe(true);
    expect(nameTaken(all, "SHS", "id-SHS")).toBe(false);
  });

  it("exports and merges: a profile already here is replaced only by a later version, keeping this browser's star", () => {
    const here = [entry("SHS", { favourite: true, uses: 3 }), entry("RHS")];
    const file = JSON.parse(JSON.stringify(exportLibrary([entry("SHS", { version: 2, tags: ["v2"] }), entry("RHS"), entry("CHS")])));
    // What a hand-edited file might hold: an entry with a size missing a value is skipped, and says why.
    file.profiles.push({ ...entry("Flat"), sizes: [{ designation: "F", values: { b: 40 } }] }, { name: "no id" });
    const merged = mergeLibrary(here, file);
    if ("error" in merged) throw new Error(merged.error);
    expect([merged.added, merged.updated]).toEqual([1, 1]);
    expect(merged.skipped).toEqual(["profiles.Flat.sizes[0].values: needs a value for t", "not a library entry"]);
    expect(merged.entries.find((e) => e.name === "SHS")).toMatchObject({ version: 2, tags: ["v2"], favourite: true, uses: 3 });
    expect(mergeLibrary(here, { profiles: [] })).toEqual({ error: "not a Cocaide section library file" });
  });

  it("adds a member of a library size with the part's copy, as one change; the part keeps its copy", () => {
    const lib = entry("SHS");
    const blank: RawDocument = { version: 1, units: "mm", name: "frame", features: [] };
    const one = addLibraryMember(blank, lib, "SHS 40x40x3");
    if (!one.ok) throw new Error(one.error);
    expect(one.id).toBe("member_1");
    expect(one.doc.profiles).toEqual({ SHS: partCopy(lib) });
    const two = addLibraryMember(one.doc, lib, "SHS 50x50x3");
    if (!two.ok) throw new Error(two.error);
    expect(two.doc.features).toEqual([
      { id: "member_1", op: "member", profile: "SHS", size: "SHS 40x40x3", from: [0, 0, 0], to: [1000, 0, 0] },
      { id: "member_2", op: "member", profile: "SHS", size: "SHS 50x50x3", from: [0, 100, 0], to: [1000, 100, 0] },
    ]);
    const b = built(two.doc);
    expect(b.bodies.map((x) => [x.name, x.volume])).toEqual([
      ["member_1", 444000],
      ["member_2", 564000],
    ]);
    expect(b.interference).toEqual([]);

    // A newer library version: the part keeps its copy while it has the size, and says so.
    const v2 = { ...lib, version: 2, sizes: [...lib.sizes, { designation: "SHS 50x50x5", values: { b: 50, t: 5 } }] };
    const kept = addLibraryMember(two.doc, v2, "SHS 40x40x3");
    expect(kept.ok && [kept.note, (kept.doc.profiles as Record<string, ProfileDef>).SHS.library]).toEqual([
      "This part keeps v1 of SHS: update its copy from Sections to use v2.",
      { id: "id-SHS", version: 1 },
    ]);
    // A size only the new version has brings the copy up to it.
    const bumped = addLibraryMember(two.doc, v2, "SHS 50x50x5");
    if (!bumped.ok) throw new Error(bumped.error);
    expect(bumped.note).toBe("This part's copy of SHS was v1; it is now v2, which has SHS 50x50x5.");
    expect((bumped.doc.profiles as Record<string, ProfileDef>).SHS.library).toEqual({ id: "id-SHS", version: 2 });

    // Another profile of the same name from elsewhere: the copy gets a name of its own.
    const other = addLibraryMember(two.doc, { ...lib, id: "elsewhere" }, "SHS 40x40x3");
    expect(other.ok && Object.keys(other.doc.profiles as object)).toEqual(["SHS", "SHS_2"]);
  });

  it("updates a part's copy from the library, unless a member uses a size the new version dropped", () => {
    const lib = entry("SHS");
    const added = addLibraryMember({ version: 1, units: "mm", name: "frame", features: [] }, lib, "SHS 50x50x3");
    if (!added.ok) throw new Error(added.error);
    const v2 = { ...lib, version: 2, tags: ["hollow", "square", "S355"] };
    const up = updatePartCopy(added.doc, v2);
    expect(up.ok && (up.doc.profiles as Record<string, ProfileDef>).SHS).toMatchObject({ tags: ["hollow", "square", "S355"], library: { version: 2 } });
    const dropped = updatePartCopy(added.doc, { ...v2, sizes: [lib.sizes[0]] });
    expect(dropped.ok || dropped.error).toBe('setProfile rejected: member_1: size: "SHS 50x50x3" is not a size of SHS (sizes: SHS 40x40x3)');
  });
});
