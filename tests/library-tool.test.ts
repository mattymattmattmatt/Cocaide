// addLibraryProfile: the AI brings a catalogue section into the part, and a
// size the catalogue doesn't list is refused with the nearest sizes (so the AI
// asks the user) unless it is added explicitly as a non-catalogue size.

import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { toolCommand } from "../src/ask/tools/batch";
import { libraryProfileCommand, LIBRARY_SIZE_RULE } from "../src/weldment/libraryTool";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
}, 120_000);

const empty = (): RawDocument => ({ version: 1, units: "mm", name: "bench", features: [] }) as unknown as RawDocument;

describe("addLibraryProfile", () => {
  it("copies a catalogue family in, only the sizes asked for", () => {
    const cmd = libraryProfileCommand({ query: "SHS", sizes: ["25x25x2.5", "40 x 40 x 3.0"] });
    expect(typeof cmd).toBe("object");
    if (typeof cmd === "string") return;
    expect(cmd.type).toBe("setProfile");
    const profile = (cmd as { profile: { name: string; sizes: { designation: string }[]; library?: { id: string } } }).profile;
    expect(profile.name).toBe("SHS (AS/NZS 1163)");
    expect(profile.sizes.map((s) => s.designation)).toEqual(["25x25x2.5 SHS", "40x40x3.0 SHS"]);
    expect(profile.library?.id).toBe("std:shs");
  });

  it("refuses a size the catalogue doesn't list, naming the nearest ones, so the AI asks", () => {
    const r = libraryProfileCommand({ query: "SHS", sizes: ["20x20x2.5"] });
    expect(typeof r).toBe("string");
    expect(r).toContain('no catalogue size "20x20x2.5"');
    expect(r).toContain("20x20x1.6 SHS");
    expect(r).toContain("20x20x2.0 SHS");
    expect(r).toContain("extraSizes");
    // A 2 mm wall is not mistaken for the 2.5 one, and the other way round.
    const two = libraryProfileCommand({ query: "SHS", sizes: ["20x20x2"] });
    expect(typeof two === "object" && (two as { profile: { sizes: { designation: string }[] } }).profile.sizes[0].designation).toBe("20x20x2.0 SHS");
    expect(LIBRARY_SIZE_RULE).toMatch(/ask the user/);
  });

  it("adds an exact non-catalogue size when asked, marked as such, and a member made from it rebuilds", () => {
    const cmd = toolCommand("addLibraryProfile", { query: "SHS", sizes: ["20x20x2"], extraSizes: [{ designation: "20x20x2.5 SHS", values: { b: 20, t: 2.5 } }] });
    expect(typeof cmd).toBe("object");
    if (typeof cmd === "string") return;
    const doc = empty();
    const r1 = apply(doc, cmd);
    expect(r1.ok).toBe(true);
    const withProfile = r1.ok ? r1.doc : doc;
    const sizes = (withProfile.profiles as Record<string, { sizes: { designation: string; values: Record<string, number> }[] }>)["SHS (AS/NZS 1163)"].sizes;
    const extra = sizes.find((s) => s.designation === "20x20x2.5 SHS (non-catalogue)")!;
    // The corner radius follows the catalogue's rule (2t for t <= 3).
    expect(extra.values).toEqual({ b: 20, t: 2.5, r: 5 });

    const part: RawDocument = {
      ...withProfile,
      nodes: { A: [0, 0, 0], B: [1000, 0, 0] },
      features: [{ id: "rail", op: "member", profile: "SHS (AS/NZS 1163)", size: "20x20x2.5 SHS (non-catalogue)", from: "A", to: "B" }],
    } as RawDocument;
    const built = rebuild(part, oc);
    try {
      expect(built.errors).toEqual([]);
      const m = built.measurements!.members!.find((x) => x.id === "rail")!;
      expect(m.length).toBeCloseTo(1000, 3);
      expect(m.designation).toBe("20x20x2.5 SHS (non-catalogue)");
    } finally {
      built.dispose();
    }
  });

  it("says what families there are when nothing matches", () => {
    const r = libraryProfileCommand({ query: "zzz" });
    expect(r).toMatch(/nothing in the section library matches "zzz"\. Families: .*SHS/);
  });
});
