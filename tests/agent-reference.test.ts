// The reference the agent reads: split into sections it fetches on demand,
// the right-click prompt carrying only the core, worked examples that really
// build (with the volumes their notes work out), and every Phase O op
// documented with an example and reachable through the agent's own tools.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { SYSTEM } from "../src/ask/prompt";
import type { RawDocument } from "../src/doc/commands";
import { FEATURE_OPS } from "../src/doc/types";
import { DOC_DEFS } from "../src/features/docIndex";
import { loadOC } from "../src/kernel";
import { WORKED_EXAMPLES } from "../src/mcp/examples";
import { REFERENCE } from "../src/mcp/reference";
import { coreReference, opSections, referenceSection, sectionIndex } from "../src/mcp/sections";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;

beforeAll(async () => {
  await loadOC();
});

describe("reference sections", () => {
  it("every op the document has is a section, found by its name or its partner's", () => {
    const keys = opSections().flatMap((s) => [s.key, ...s.aliases]);
    for (const d of DOC_DEFS) expect(keys).toContain(d.op);
    for (const op of ["sketch", "extrude", "cut", "hole", "fillet", "chamfer", "linearPattern", "circularPattern"]) expect(referenceSection(op)).toBeTruthy();
    expect(referenceSection("cut")).toMatch(/^## extrude \/ cut/);
    expect(referenceSection("mirror")).toMatch(/^## multibody tools/);
    expect(referenceSection("expressions")).toMatch(/^### Expressions\n"=<expression>"/);
    expect(referenceSection("selectors")).toContain("## Edge selectors");
    expect(referenceSection("examples")).toContain("A flanged pipe fitting");
    expect(referenceSection("ops")).toContain('## revolve\n{ "id": "revolve_1", "op": "revolve"');
    expect(referenceSection("nonsense")).toBeNull();
    expect(sectionIndex()).toMatch(/^Topics: document, /);
  });

  it("the right-click prompt carries the core, not the whole reference", () => {
    const core = coreReference();
    expect(SYSTEM).toContain(core);
    expect(SYSTEM).not.toContain(REFERENCE);
    expect(core.length).toBeLessThan(REFERENCE.length / 2);
    // What every ask needs is in it: sketches, references, selectors, the strategy, every op's first example.
    for (const s of ["## sketch", "## References", "## Face selectors", "## strategy", "## sweep", "## hole (the Hole Wizard)"]) expect(core).toContain(s);
    // The details are a reference call away.
    expect(core).not.toContain("### Sketch edits the app makes");
  });

  it("every feature op is documented with a JSON example", () => {
    const ops = new Set<string>([...FEATURE_OPS, ...DOC_DEFS.map((d) => d.op)]);
    for (const op of ops) expect(REFERENCE, op).toMatch(new RegExp(`"op": "${op}"|"op":"${op}"`));
    // The Phase O fields, each with an example.
    for (const s of [
      '"extent": "upToFace"',
      '"direction2": { "extent": "blind"',
      '"radius2": 4',
      '"angle": 30 }',
      '"kind": "counterbore"',
      '"type": "point", "at"',
      '"ref": { "edge":',
      '"line": "Y"',
      '"driven":true',
      '"name":"hole_d"',
      "=max(2, pitch_d * 0.05)",
      '"helix"',
      '"thin": {',
    ]) {
      expect(REFERENCE, s).toContain(s);
    }
  });
});

describe("worked examples", () => {
  for (const e of WORKED_EXAMPLES) {
    it(`${e.key} builds through the agent's batch tool, as its notes work it out`, async () => {
      const s = await AgentSession.open({ doc: { version: 1, units: "mm", name: e.key, features: [] } });
      try {
        for (const [name, value] of Object.entries(e.parameters ?? {})) expect((await s.call("setParameter", { name, value })).result.ok).toBe(true);
        const r = (await s.call("batch", { commands: e.steps })).result;
        expect(r.ok, JSON.stringify(r.error)).toBe(true);
        expect(r.errors).toBeUndefined();
        const sum = (await s.call("partSummary")).result as unknown as { measurements: { volume: number; holeCount: number; solids: number } };
        if (typeof e.volume === "number") expect(sum.measurements.volume).toBeCloseTo(e.volume, 2);
        else {
          expect(sum.measurements.volume).toBeGreaterThan(e.volume[0]);
          expect(sum.measurements.volume).toBeLessThan(e.volume[1]);
        }
        expect(sum.measurements.solids).toBe(1);
        if (e.holes !== undefined) expect(sum.measurements.holeCount - (e.key === "flanged-fitting" ? 1 : 0)).toBe(e.holes);
      } finally {
        s.close();
      }
    }, 60_000);
  }

  it("the hole dimensioned to model edges follows the plate when it grows", async () => {
    const e = WORKED_EXAMPLES.find((x) => x.key === "edge-dimensioned")!;
    const s = await AgentSession.open({ doc: { version: 1, units: "mm", name: e.key, features: [] } });
    try {
      await s.call("setParameter", { name: "plate_w", value: 100 });
      await s.call("batch", { commands: e.steps });
      expect((await s.call("setParameter", { name: "plate_w", value: 140 })).result.ok).toBe(true);
      const d = (await s.call("measureBetween", { a: { type: "cylindrical", radius: 4, pick: "all" }, b: { type: "planar", normal: [1, 0, 0], pick: "largest" } })).result;
      // The hole's axis stays 15 from the right-hand side, now at x = 70.
      expect(d.distance).toBeCloseTo(15 - 4, 6);
    } finally {
      s.close();
    }
  }, 60_000);
});

describe("every Phase O op through the agent's tools", () => {
  it("planes, axes, points, loft, scale, sketch-driven pattern, end conditions, variable fillets, angled chamfers, named and driven dimensions", async () => {
    const s = await AgentSession.open({ doc: bracket });
    const top = { type: "planar", normal: [0, 0, 1], pick: "largest" };
    try {
      expect((await s.call("setParameter", { name: "spire_w", value: "=max(10, 2 * 9)" })).result.ok).toBe(true);
      const steps = [
        { tool: "addFeature", feature: { id: "p20", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 20 } },
        { tool: "addFeature", feature: { id: "p50", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 50 } },
        { tool: "addFeature", feature: { id: "p70", op: "plane", mode: "parallelThroughPoint", refs: [{ datum: "Top" }, { point: [0, 0, 70] }] } },
        { tool: "addFeature", feature: { id: "ax_hole", op: "axis", mode: "cylinder", refs: [{ face: { type: "cylindrical", radius: 3.3, pick: "all" } }] } },
        { tool: "addFeature", feature: { id: "pt_hole", op: "point", mode: "center", refs: [{ edge: { type: "edge", kind: "circle", radius: 3.3, pick: "all", near: [30, 0, 6] } }] } },
        // A boss up to the plane 20 above Top, drafted.
        { tool: "sketchProfile", sketch: "sk_boss", plane: { type: "ref", ref: { face: top } }, shapes: [{ circle: { center: [-25, 0], diameter: 12 } }] },
        { tool: "addFeature", feature: { id: "boss", op: "extrude", sketch: "sk_boss", extent: "upToFace", upTo: { datum: "p20" }, draft: { angle: 2 } } },
        // A lofted spire as a body of its own, then scaled about its centroid.
        { tool: "sketchProfile", sketch: "sk_lo", plane: { type: "ref", ref: { datum: "p50" } }, shapes: [{ rect: { center: [0, 0], width: "=spire_w", height: 18 } }] },
        { tool: "sketchProfile", sketch: "sk_hi", plane: { type: "ref", ref: { datum: "p70" } }, shapes: [{ rect: { center: [0, 0], width: 8, height: 8 } }] },
        { tool: "addFeature", feature: { id: "spire", op: "loft", profiles: ["sk_lo", "sk_hi"], ruled: true, operation: "new", newBody: "spire" } },
        { tool: "addFeature", feature: { id: "shrink", op: "scale", bodies: ["spire"], factor: 0.5, about: "centroid" } },
        // hole_1 copied to two sketch points.
        { tool: "sketchProfile", sketch: "sk_pts", plane: { type: "ref", ref: { face: top } }, shapes: [{ point: [30, 0] }, { point: [10, 12] }, { point: [10, -12] }] },
        { tool: "addFeature", feature: { id: "copies", op: "sketchPattern", feature: "hole_1", sketch: "sk_pts" } },
        // Variable fillets on the plate's corners, an angled chamfer under it.
        { tool: "addFeature", feature: { id: "corners", op: "fillet", edges: { type: "edge", direction: [0, 0, 1], length: 6, pick: "all" }, radius: 1, radius2: 2 } },
        { tool: "addFeature", feature: { id: "under", op: "chamfer", faces: [{ type: "planar", normal: [0, 0, -1], pick: "largest", body: "main" }], distance: 0.5, angle: 30 } },
        // A named dimension, and a driven one.
        { tool: "renameDimension", sketch: "sk_boss", name: "d1", to: "boss_d" },
        { tool: "addConstraint", sketch: "sk_boss", constraint: { type: "radius", entity: "c1", value: 6, driven: true, name: "boss_r" } },
        { tool: "setDimension", sketch: "sk_boss", name: "boss_d", value: "=round(spire_w / 1.5)" },
      ];
      const r = (await s.call("batch", { commands: steps })).result;
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      expect(r.errors).toBeUndefined();
      const sum = (await s.call("partSummary")).result as unknown as { bodies: { name: string }[]; measurements: { holeCount: number } };
      expect(sum.bodies.map((b) => b.name)).toEqual(["main", "spire"]);
      expect(sum.measurements.holeCount).toBe(3);
      const datums = (await s.call("listDatums")).result as unknown as { features: Record<string, unknown>[] };
      expect(datums.features.map((d) => [d.id, d.kind])).toEqual([
        ["p20", "plane"],
        ["p50", "plane"],
        ["p70", "plane"],
        ["ax_hole", "axis"],
        ["pt_hole", "point"],
      ]);
      const sketch = (await s.call("getSketch", { id: "sk_boss" })).result as unknown as { constraints: Record<string, unknown>[] };
      expect(sketch.constraints).toContainEqual(expect.objectContaining({ name: "boss_d", value: "=round(spire_w / 1.5)", measured: 12 }));
      expect(sketch.constraints).toContainEqual(expect.objectContaining({ name: "boss_r", driven: true }));
    } finally {
      s.close();
    }
  }, 120_000);
});
