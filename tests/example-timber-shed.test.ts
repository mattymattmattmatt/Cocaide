// The timber shed example (Examples → timber shed (assembly)): the document is valid, its frame and every part it
// carries build without errors, and the assembly places all 64 components.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { validateDocument } from "../src/doc/validate";
import { loadOC, rebuild } from "../src/kernel";

const SHED = JSON.parse(readFileSync(new URL("../examples/timber-shed.cocaide.json", import.meta.url), "utf8"));
let oc: Awaited<ReturnType<typeof loadOC>>;
beforeAll(async () => {
  oc = await loadOC();
}, 120_000);

describe("the timber shed example", () => {
  it("is a valid document with an assembly of 64 components from 22 parts", () => {
    const v = validateDocument(SHED);
    expect(v.headerErrors).toEqual([]);
    expect(v.features.filter((f) => "error" in f && f.error)).toEqual([]);
    expect(SHED.assembly.components).toHaveLength(64);
    expect(Object.keys(SHED.assembly.parts)).toHaveLength(22);
    const parts = new Set(Object.keys(SHED.assembly.parts));
    for (const k of SHED.assembly.components) expect(k.part === "self" || parts.has(k.part)).toBe(true);
  });
  it("builds its frame and every part without errors", () => {
    const docs: [string, unknown][] = [["frame", SHED], ...Object.entries(SHED.assembly.parts as Record<string, unknown>)];
    for (const [name, doc] of docs) {
      const b = rebuild(doc as never, oc);
      try {
        expect({ name, errors: b.errors }).toEqual({ name, errors: [] });
        expect(b.bodies.length, name).toBeGreaterThan(0);
      } finally {
        b.dispose();
      }
    }
  }, 300_000);
});
