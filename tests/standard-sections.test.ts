// The standard section library: catalogue families every user has, their
// dimensions and areas against the published tables, members of any size,
// timber mass, search, and the agent finding sizes by code.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { kgPerMetre, sectionAt } from "../src/geom/section";
import { matchSection, sectionCode } from "../src/intent/review";
import { sectionOptions } from "../src/ask/part";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { addLibraryMember, exportLibrary, matchingSizes, partCopy, searchLibrary, withStandard, type LibraryEntry } from "../src/weldment/library";
import { cornerRadius, standardLibrary, STANDARD_GROUPS } from "../src/weldment/standard";

const lib = standardLibrary();
const family = (id: string) => lib.find((e) => e.id === `std:${id}`)!;
const area = (id: string, designation: string) => {
  const m = sectionAt(family(id), designation);
  if (!m.ok) throw new Error(m.error);
  return m.props;
};
const empty = (): RawDocument => ({ version: 1, units: "mm", name: "t", features: [] }) as RawDocument;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

describe("the standard library", () => {
  it("has every family in a standard group, and every size measures", () => {
    expect(lib.length).toBeGreaterThanOrEqual(18);
    const sizes = lib.reduce((n, e) => n + e.sizes.length, 0);
    expect(sizes).toBeGreaterThan(350);
    for (const e of lib) {
      expect(STANDARD_GROUPS).toContain(e.group);
      expect(e.builtin).toBe(true);
      expect(e.density).toBeGreaterThan(0);
      for (const s of e.sizes) expect(sectionAt(e, s.designation).ok, s.designation).toBe(true);
    }
  });

  it("each part copy is a valid profile", () => {
    for (const e of lib) {
      const v = validateDocument({ version: 1, units: "mm", name: "c", profiles: { [e.name]: partCopy(e) }, features: [] });
      expect(v.headerErrors, e.name).toEqual([]);
    }
  });

  it("matches the AS/NZS 3679.1 catalogue gross areas (within 1%)", () => {
    const cases: [string, string, number][] = [
      ["ub", "150UB14.0", 1780],
      ["ub", "200UB25.4", 3230],
      ["ub", "310UB40.4", 5210],
      ["ub", "610UB125", 16000],
      ["uc", "100UC14.8", 1890],
      ["uc", "310UC158", 20100],
      ["pfc", "200PFC", 2920],
      ["pfc", "380PFC", 7030],
      ["ea", "100x100x10 EA", 1810],
    ];
    for (const [id, d, a] of cases) expect(Math.abs(area(id, d).area - a) / a, d).toBeLessThan(0.01);
  });

  it("has the catalogue's dimensions", () => {
    expect(family("ub").sizes.find((s) => s.designation === "200UB25.4")!.values).toEqual({ d: 203, b: 133, tf: 7.8, tw: 5.8, r1: 8.9 });
    expect(area("ub", "200UB25.4").envelope).toEqual([133, 203]);
    expect(area("uc", "310UC158").envelope).toEqual([310, 327]);
    expect(area("ea", "100x100x10 EA").envelope).toEqual([100, 100]);
    expect(family("ub").sizes[0].designation).toBe("610UB125");
    expect(family("ub").sizes.at(-1)!.designation).toBe("150UB14.0");
    expect(family("uc").sizes.at(-1)!.designation).toBe("100UC14.8");
  });

  it("matches the AS/NZS 1163 hollow section tables, corners and all", () => {
    expect(cornerRadius(3)).toBe(6);
    expect(cornerRadius(4)).toBe(10);
    // 50x50x3.0 SHS: 4.25 kg/m; 100x100x4.0 SHS: 11.6 kg/m; 48.3x3.2 CHS: 3.56 kg/m.
    expect(kgPerMetre(area("shs", "50x50x3.0 SHS").area)).toBeCloseTo(4.25, 1);
    expect(kgPerMetre(area("shs", "100x100x4.0 SHS").area)).toBeCloseTo(11.6, 1);
    expect(kgPerMetre(area("chs", "48.3x3.2 CHS").area)).toBeCloseTo(3.56, 1);
    expect(area("rhs", "100x50x3.0 RHS").envelope).toEqual([50, 100]);
    expect(area("shs", "50x50x3.0 SHS").hollow).toBe(true);
  });

  it("has purlins by code and timber at its actual sizes", () => {
    const c = family("c-purlin").sizes.map((s) => s.designation);
    expect(c[0]).toBe("C10010");
    expect(c.at(-1)).toBe("C30030");
    expect(family("z-purlin").sizes.map((s) => s.designation)).toContain("Z20015");
    expect(family("c-purlin").sizes.find((s) => s.designation === "C20015")!.values).toEqual({ d: 203, b: 76, L: 15.5, t: 1.5 });
    expect(area("mgp10", "90x45 MGP10").area).toBe(4050);
    expect(area("mgp10", "290x45 MGP10").envelope).toEqual([45, 290]);
    expect(area("f-hardwood", "100x50 F8 HW").area).toBe(5000);
    expect(family("mgp10").density).toBe(550);
    expect(family("post").sizes.map((s) => s.designation)).toEqual(["90x90 H4 post", "100x100 H4 post", "125x125 H4 post", "150x150 H4 post"]);
  });
});

describe("in the library", () => {
  const mine: LibraryEntry = { ...family("fb"), id: "u1", name: "SHS", group: undefined, builtin: undefined, favourite: true, uses: 2 };

  it("sits beside the user's profiles, keeps a star, and isn't exported", () => {
    const starred = { ...family("ub"), favourite: true, uses: 3 };
    const all = withStandard([mine, starred]);
    expect(all.filter((e) => e.builtin)).toHaveLength(lib.length);
    expect(all.find((e) => e.id === "std:ub")).toMatchObject({ favourite: true, uses: 3 });
    expect(all.find((e) => e.id === "u1")).toBeDefined();
    expect(exportLibrary(all).profiles.map((e) => e.id)).toEqual(["u1"]);
  });

  it("searches by code, size and standard", () => {
    expect(searchLibrary(lib, "200UB25.4").map((e) => e.id)).toEqual(["std:ub"]);
    expect(matchingSizes(family("ub"), "200UB25.4").map((s) => s.designation)).toEqual(["200UB25.4"]);
    expect(searchLibrary(lib, "90x45 mgp10").map((e) => e.id)).toEqual(["std:mgp10"]);
    expect(searchLibrary(lib, "AS/NZS 1163").map((e) => e.id).sort()).toEqual(["std:chs", "std:rhs", "std:shs"]);
    expect(searchLibrary(lib, "timber").length).toBe(5);
  });

  it("makes a member of any size, which weighs its own density", () => {
    const one = addLibraryMember(empty(), family("mgp10"), "90x45 MGP10");
    if (!one.ok) throw new Error(one.error);
    const two = addLibraryMember(one.doc, family("ub"), "200UB25.4");
    if (!two.ok) throw new Error(two.error);
    expect(allErrors(validateDocument(two.doc))).toEqual([]);
    const r = rebuild(two.doc, oc);
    expect(r.errors).toEqual([]);
    const [timber, steel] = r.measurements!.members;
    expect(timber.designation).toBe("90x45 MGP10");
    expect(timber.massKg).toBeCloseTo(4050e-6 * 550, 2);
    expect(steel.massKg).toBeCloseTo(kgPerMetre(area("ub", "200UB25.4").area), 1);
    r.dispose();
  });
});

describe("the agent finds sizes by code", () => {
  const options = sectionOptions(empty(), lib);
  const one = (w: string) => matchSection(w, options).map((o) => o.designation);

  it("reads catalogue codes", () => {
    expect(sectionCode("200UB25.4")).toBe("ub");
    expect(sectionCode("50x50x3.0 SHS")).toBe("shs");
    expect(one("200UB25.4")).toEqual(["200UB25.4"]);
    expect(one("200 UB 25.4")).toEqual(["200UB25.4"]);
    expect(one("90x45 MGP10")).toEqual(["90x45 MGP10"]);
    expect(one("SHS 50x50x3")).toEqual(["50x50x3.0 SHS"]);
    expect(one("C20015")).toEqual(["C20015"]);
    expect(one("90 x 45 MGP12")).toEqual(["90x45 MGP12"]);
  });

  it("prefers the user's own profile over a standard one that reads the same", () => {
    const own = { value: "part|SHS|SHS 50x50x3", profile: "SHS", designation: "SHS 50x50x3", from: "part" as const };
    expect(matchSection("SHS 50x50x3", [...options, own])).toEqual([own]);
  });
});
