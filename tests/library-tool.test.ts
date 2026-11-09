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

describe("a bench as a weldment, through the AI's own tools", () => {
  it("SHS 25x25x2.5 frame 1500 x 900 x 900: members, mitred top corners, gussets", async () => {
    const { AgentSession } = await import("../src/agent/session");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cocaide-bench-"));
    const s = await AgentSession.open({ doc: { version: 1, units: "mm", name: "bench", features: [] }, docPath: join(dir, "bench.cocaide.json"), logPath: join(dir, "log.jsonl") });
    const ok = async (tool: string, args: Record<string, unknown>) => {
      const { result } = await s.call(tool, args);
      expect(result, `${tool} ${JSON.stringify(args)}`).toMatchObject({ ok: true });
      return result;
    };
    try {
      await ok("addLibraryProfile", { query: "SHS", sizes: ["25x25x2.5"] });
      const W = 1500, D = 900, H = 900, h = H - 12.5; // the top rails' centre line sits half a tube below 900
      const at: Record<string, number[]> = { A: [0, 0, h], B: [W, 0, h], C: [W, D, h], E: [0, D, h], A0: [0, 0, 0], B0: [W, 0, 0], C0: [W, D, 0], E0: [0, D, 0] };
      for (const [name, p] of Object.entries(at)) await ok("setNode", { name, at: p });
      const size = "25x25x2.5 SHS";
      const profile = "SHS (AS/NZS 1163)";
      const members = [
        ["front", "A", "B"], ["right", "B", "C"], ["back", "C", "E"], ["left", "E", "A"],
        ["leg_a", "A0", "A"], ["leg_b", "B0", "B"], ["leg_c", "C0", "C"], ["leg_e", "E0", "E"],
      ];
      for (const [id, from, to] of members) await ok("addFeature", { feature: { id, op: "member", profile, size, from, to } });
      for (const [node, a, b] of [["A", "left", "front"], ["B", "front", "right"], ["C", "right", "back"], ["E", "back", "left"]]) {
        await ok("addFeature", { feature: { id: `mitre_${node}`, op: "joint", node, type: "mitre", members: [a, b] } });
        await ok("addFeature", { feature: { id: `gusset_${node}`, op: "gusset", node, members: [a, b], size: 100, thickness: 5 } });
      }
      const m = (await s.call("measure")).result as unknown as { solids: number; boundingBox: { size: number[] }; bodies: { name: string; size: number[] }[] };
      // 8 members and 4 gussets, each its own body; the frame stands 900 tall on a 1500 x 900 footprint (plus half a tube each side).
      expect(m.solids).toBe(12);
      expect(m.boundingBox.size.map((v) => Math.round(v))).toEqual([W + 25, D + 25, H]);
      // Mitred top rails are long point to long point: the outside size.
      const front = m.bodies.find((b) => b.name === "front")!;
      expect(Math.round(Math.max(...front.size))).toBe(W + 25);
      const cut = (await s.call("cutList")).result as { items?: unknown[] };
      expect(cut.items?.length).toBeGreaterThanOrEqual(3);
    } finally {
      s.close();
    }
  }, 240_000);
});
