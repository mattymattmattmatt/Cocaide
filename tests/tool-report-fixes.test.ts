// Fixes from a tool-issue report: what the in-app AI tripped over.
// - reference: the index's "extrude/cut" and an op documented inside another section ("joint") are found
// - a member size written another way ("SHS 25x25x2.5") is the catalogue's "25x25x2.5 SHS"
// - a weld note may leave its length out
// - a gusset can sit flush with the members' undersides (or tops), and be offset
// - a selector may say "pick": "nearest" with "near"
// - the subscription's usage warning is not a tool issue
// - a bare size ("100x100x5") is the catalogue's "100x100x5.0 SHS"; a size it lacks lists the nearest ones
// - a throughAllBoth cut from a plane with the whole part on one side of it cuts (it goes the way the part is)

import { beforeAll, describe, expect, it } from "vitest";
import { StreamReader } from "../src/bridge/claude";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { selectFaces } from "../src/kernel/selectors";
import { referenceSection } from "../src/mcp/sections";
import { issuesOf } from "../src/ui/ask/toolIssues";
import { libraryProfileCommand } from "../src/weldment/libraryTool";
import { apply } from "../src/doc/commands";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
}, 120_000);

/** Two SHS 25x25x2.5 members meeting at a flat corner (centre lines at z = 100), and what else is given. */
function corner(size: string, more: Record<string, unknown>[] = []): RawDocument {
  const cmd = libraryProfileCommand({ query: "SHS", sizes: ["25x25x2.5"] });
  if (typeof cmd === "string") throw new Error(cmd);
  const r = apply({ version: 1, units: "mm", name: "corner", features: [] } as unknown as RawDocument, cmd);
  if (!r.ok) throw new Error(r.error);
  return {
    ...r.doc,
    nodes: { A: [0, 0, 100], B: [500, 0, 100], C: [0, 400, 100] },
    features: [
      { id: "front", op: "member", profile: "SHS (AS/NZS 1163)", size, from: "A", to: "B" },
      { id: "left", op: "member", profile: "SHS (AS/NZS 1163)", size, from: "A", to: "C" },
      ...more,
    ],
  } as RawDocument;
}

describe("reference sections", () => {
  it("finds a section by the name the index lists it under, and an op documented inside another section", () => {
    expect(referenceSection("extrude/cut")).toMatch(/extrude/);
    expect(referenceSection("joint")).toMatch(/"op": "joint"/);
    expect(referenceSection("gusset")).toMatch(/"op": "gusset"/);
  });
});

describe("member sizes written another way", () => {
  it('"SHS 25x25x2.5" and "25 x 25 x 2.50 SHS" are the catalogue\'s 25x25x2.5 SHS; a size it has not stays an error', () => {
    for (const size of ["SHS 25x25x2.5", "25 x 25 x 2.50 SHS"]) {
      const b = rebuild(corner(size), oc);
      try {
        expect(b.errors).toEqual([]);
        expect(b.measurements!.members!.find((m) => m.id === "front")!.designation).toBe("25x25x2.5 SHS");
      } finally {
        b.dispose();
      }
    }
    expect(allErrors(validateDocument(corner("SHS 30x30x2.5"))).join(" ")).toMatch(/is not a size of SHS/);
  }, 120_000);
});

describe("bare sizes, nearest sizes", () => {
  it('"100x100x5" is "100x100x5.0 SHS"; a CHS size the catalogue lacks lists the ones nearest it', () => {
    const cmd = libraryProfileCommand({ query: "SHS", sizes: ["100x100x5"] });
    if (typeof cmd === "string") throw new Error(cmd);
    const r = apply({ version: 1, units: "mm", name: "s", features: [] } as unknown as RawDocument, cmd);
    if (!r.ok) throw new Error(r.error);
    const doc = { ...r.doc, features: [{ id: "m", op: "member", profile: "SHS (AS/NZS 1163)", size: "100x100x5", from: [0, 0, 0], to: [500, 0, 0] }] } as unknown as RawDocument;
    expect(allErrors(validateDocument(doc))).toEqual([]);
    const miss = libraryProfileCommand({ query: "CHS", sizes: ["168.3x7.1"] });
    expect(typeof miss).toBe("string");
    expect((miss as string).match(/near it: ([^.]+\.\d[^.]*?)[,.]/)?.[1]).toMatch(/^165\.1x/);
  });
});

describe("through all both ways", () => {
  it("cuts from a plane with the whole part on one side, either side", () => {
    for (const z of [200, -50]) {
      const doc = { version: 1, units: "mm", name: "c", features: [
        { id: "s", op: "sketch", plane: "Top", entities: [{ id: "r", type: "rect", center: [0, 0], w: 100, h: 100 }] },
        { id: "box", op: "extrude", sketch: "s", distance: 100 },
        { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, z] }, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 20 }] },
        { id: "hole", op: "cut", sketch: "s2", extent: "throughAllBoth" },
      ] } as unknown as RawDocument;
      const b = rebuild(doc, oc);
      try {
        expect(b.errors).toEqual([]);
        expect(b.measurements!.volume).toBeCloseTo(100 * 100 * 100 - Math.PI * 400 * 100, -1);
      } finally {
        b.dispose();
      }
    }
  });
});

describe("welds and gussets", () => {
  it("a weld note without a length is fine (and one with a bad length is not)", () => {
    const ok = { ...corner("25x25x2.5 SHS"), welds: [{ id: "w1", between: ["front", "left"], type: "fillet", size: 3 }] };
    expect(allErrors(validateDocument(ok))).toEqual([]);
    const bad = { ...corner("25x25x2.5 SHS"), welds: [{ id: "w1", between: ["front", "left"], type: "fillet", size: 3, length: -2 }] };
    expect(allErrors(validateDocument(bad)).join(" ")).toMatch(/length/);
  });

  it("a gusset sits centred, flush with the members' undersides, flush with their tops, or offset", () => {
    const z = (more: Record<string, unknown>) => {
      const b = rebuild(corner("25x25x2.5 SHS", [{ id: "g", op: "gusset", node: "A", members: ["front", "left"], size: 100, thickness: 5, ...more }]), oc);
      try {
        expect(b.errors).toEqual([]);
        const box = b.measurements!.bodies.find((x) => x.name === "g")!.boundingBox!;
        return [box.min[2], box.max[2]].map((v) => Math.round(v * 1000) / 1000);
      } finally {
        b.dispose();
      }
    };
    // The tubes run from z = 87.5 to 112.5.
    expect(z({})).toEqual([97.5, 102.5]);
    expect(z({ align: "bottom" })).toEqual([87.5, 92.5]);
    expect(z({ align: "top" })).toEqual([107.5, 112.5]);
    expect(z({ align: "bottom", offset: 2 })).toEqual([89.5, 94.5]);
    expect(allErrors(validateDocument(corner("25x25x2.5 SHS", [{ id: "g", op: "gusset", node: "A", members: ["front", "left"], size: 100, thickness: 5, align: "under" }]))).join(" ")).toMatch(/align/);
  }, 120_000);
});

describe("pick nearest", () => {
  it('"nearest" with "near" picks the face nearest the point; without "near" it says what it needs', () => {
    const doc = (sel: Record<string, unknown>) => ({ version: 1, units: "mm", name: "p", features: [{ id: "s", op: "sketch", plane: { type: "ref", ref: { face: sel } }, entities: [] }] });
    expect(allErrors(validateDocument(doc({ type: "planar", normal: [0, 0, 1], near: [0, 0, 6], pick: "nearest" }))).join(" ")).not.toMatch(/pick/);
    expect(allErrors(validateDocument(doc({ type: "planar", normal: [0, 0, 1], pick: "nearest" }))).join(" ")).toMatch(/"nearest" needs "near"/);
    const faces = [
      { index: 0, type: "plane" as const, area: 10, centroid: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], point: [0, 0, 0] as [number, number, number], offset: 0 },
      { index: 1, type: "plane" as const, area: 20, centroid: [0, 0, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number], point: [0, 0, 10] as [number, number, number], offset: 10 },
    ];
    expect(selectFaces(faces, { type: "planar", normal: [0, 0, 1], near: [0, 0, 9], pick: "nearest" }).matches.map((f) => f.index)).toEqual([1]);
  });
});

describe("the usage warning", () => {
  it("reads plainly and is not logged as a tool issue", () => {
    const [e] = new StreamReader("Claude Code").line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1893456000 } }));
    expect(e).toMatchObject({ kind: "notice", text: expect.stringMatching(/^You're close to your Claude Code usage limit/) });
    const found = issuesOf({ askId: "a", at: "", model: "", prompt: "", target: "", part: "", calls: [], notices: [(e as { text: string }).text, "Claude Code rate limit: rejected"] });
    expect(found).toEqual([]);
  });
});
