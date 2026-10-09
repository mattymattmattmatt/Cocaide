// The feature-op registry (Phase O, wave 0): ops that live in
// src/features/<op>/ and are listed in the index files. Each doc def has a
// kernel, the shared code reaches them through its hooks, and the doc-layer
// files never import a value from the document layer they plug into.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, references, type RawDocument } from "../src/doc/commands";
import { scopeProblem } from "../src/doc/scope";
import { FEATURE_OPS } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { DEF, defOf } from "../src/features/defs";
import { DOC_DEFS } from "../src/features/docIndex";
import { KERNEL_OPS, kernelOf, runKernelOp, type RebuildCtx } from "../src/features/kernelDefs";
import { KERNEL_DEFS } from "../src/features/kernelIndex";
import { PLUGIN_OPS } from "../src/features/types";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { OpError } from "../src/kernel/ops";
import { REFERENCE } from "../src/mcp/reference";
import { bodyFeatures } from "../src/ask/packet";

const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket");
const add = (doc: RawDocument, ...f: Record<string, unknown>[]): RawDocument => ({ ...doc, features: [...doc.features, ...f] });
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));
const SRC = new URL("../src/", import.meta.url).pathname;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

describe("the registry's lists", () => {
  it("every op has a doc def and a kernel, once each, and none shadows a built-in op", () => {
    const docOps = DOC_DEFS.map((d) => d.op);
    const kernelOps = KERNEL_DEFS.map((k) => k.op);
    expect(new Set(docOps).size).toBe(docOps.length);
    expect(new Set(kernelOps).size).toBe(kernelOps.length);
    expect([...kernelOps].sort()).toEqual([...docOps].sort());
    for (const op of docOps) {
      expect(DEF[op].op).toBe(op);
      expect(KERNEL_OPS[op].op).toBe(op);
    }
    const builtIn = FEATURE_OPS.slice(0, FEATURE_OPS.length - PLUGIN_OPS.length);
    expect(builtIn.filter((op) => docOps.includes(op as never))).toEqual([]);
    expect(FEATURE_OPS.slice(-PLUGIN_OPS.length)).toEqual(docOps);
  });

  it("looks ops up by own name only", () => {
    expect(defOf("scale")).toBe(DEF.scale);
    expect(defOf("toString")).toBeUndefined();
    expect(defOf("extrude")).toBeUndefined();
    expect(defOf(5)).toBeUndefined();
    expect(kernelOf("constructor")).toBeUndefined();
  });

  it("each op documents itself for the agents: its section is in the reference", () => {
    for (const d of DOC_DEFS) {
      expect(d.reference.startsWith(`## ${d.op}\n`)).toBe(true);
      expect(REFERENCE).toContain(d.reference.trim());
    }
    // Before the selectors' sections, after the built-in ops'.
    expect(REFERENCE.indexOf("## scale")).toBeGreaterThan(REFERENCE.indexOf("## multibody tools"));
    expect(REFERENCE.indexOf("## scale")).toBeLessThan(REFERENCE.indexOf("## Face selectors"));
  });

  it("index files are one line per op, so branches that each add an op merge by union", () => {
    for (const [file, list] of [["docIndex.ts", "DOC_DEFS"], ["kernelIndex.ts", "KERNEL_DEFS"]]) {
      const text = readFileSync(join(SRC, "features", file), "utf8");
      const imports = text.split("\n").filter((l) => l.startsWith("import "));
      const body = text.slice(text.indexOf(`export const ${list} = [`)).split("\n");
      const entries = body.slice(1, body.indexOf("];"));
      expect(imports.every((l) => /^import \{ (def|kernel) as \w+ \} from "\.\/\w+\/(doc|kernel)";$/.test(l))).toBe(true);
      expect(entries.every((l) => /^ {2}\w+,$/.test(l))).toBe(true);
      expect(entries.length).toBe(imports.length);
    }
  });

  it("the document-layer files of the registry import only types from src/doc, src/kernel, src/ui and src/ask", () => {
    // A value import there would be an import cycle through src/doc/types.ts.
    const files = [
      ...["defs.ts", "docIndex.ts", "types.ts", "datum.ts", "operation.ts"].map((f) => join(SRC, "features", f)),
      ...readdirSync(join(SRC, "features"))
        .filter((d) => statSync(join(SRC, "features", d)).isDirectory())
        .map((d) => join(SRC, "features", d, "doc.ts"))
        .filter((f) => existsSync(f)),
    ];
    const offending: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/^import (type )?[^;]*? from "([^"]+)";$/gms)) {
        if (!m[1] && /(^|\/)(doc|kernel|ui|ask)\//.test(m[2])) offending.push(`${file.slice(SRC.length)}: ${m[2]}`);
      }
    }
    expect(offending).toEqual([]);
  });
});

describe("the shared code asks the registry", () => {
  it("validation hands a registry op to its def, and still refuses an unknown one", () => {
    expect(errorsOf(add(bracket, { id: "scale_1", op: "scale", factor: 2 }))).toEqual([]);
    expect(errorsOf(add(bracket, { id: "s", op: "scale", factor: 2, fator: 2 }))).toEqual(['s: unknown field "fator" (allowed: id, op, bodies, factor, about)']);
    // suppressed is common to every op.
    const v = validateDocument(add(bracket, { id: "s", op: "scale", factor: 2, suppressed: true }));
    expect(v.features[3].feature).toEqual({ id: "s", op: "scale", factor: 2, suppressed: true });
    expect(errorsOf(add(bracket, { id: "s", op: "scale", factor: 2, suppressed: "yes" }))).toEqual(['s: suppressed: must be true or false (got "yes")']);
  });

  it("a registry op's bodies are checked like any feature's: they must exist before it", () => {
    expect(errorsOf(add(bracket, { id: "s", op: "scale", factor: 2, bodies: ["base"] }))).toEqual(['s: bodies[0]: no body "base" before this feature (bodies so far: main)']);
  });

  it("a body: write scope covers a registry op that names only that body", () => {
    const doc = example("stand");
    const scope = ["body:upright"];
    expect(scopeProblem(doc, { type: "addFeature", feature: { id: "s", op: "scale", factor: 2, bodies: ["upright"] } }, scope)).toBeNull();
    expect(scopeProblem(doc, { type: "addFeature", feature: { id: "s", op: "scale", factor: 2 } }, scope)).toBe('writeScope: addFeature "s" is outside the scope [body:upright]');
    expect(scopeProblem(doc, { type: "addFeature", feature: { id: "s", op: "scale", factor: 2, bodies: ["upright", "base"] } }, scope)).not.toBeNull();
    // And the body's own features include it, for the packet.
    const scaled = add(doc, { id: "s", op: "scale", factor: 2, bodies: ["upright"] });
    expect(bodyFeatures(scaled, "upright")).toEqual(["ext_2", "s"]);
    expect(bodyFeatures(scaled, "base")).toEqual(["ext_1", "hole_1", "pattern_1"]);
  });

  it("renaming a body renames it in a registry op's body fields", () => {
    const doc = add(example("stand"), { id: "s", op: "scale", factor: 2, bodies: ["upright"] });
    const r = apply(doc, { type: "renameBody", from: "upright", to: "post" });
    expect(r.ok && r.doc.features.at(-1)).toEqual({ id: "s", op: "scale", factor: 2, bodies: ["post"] });
  });

  it("references(): what a registry op uses, and the plane, axis or point features any feature stands on", () => {
    expect(references({ id: "s", op: "scale", factor: 2 })).toEqual([]);
    expect(references({ id: "sk", op: "sketch", plane: { type: "ref", ref: { datum: "plane_1" } }, entities: [] })).toEqual(["plane_1"]);
    expect(references({ id: "sk", op: "sketch", plane: { type: "ref", ref: { datum: "Top" } }, entities: [] })).toEqual([]);
    expect(references({ id: "m", op: "mirror", plane: { type: "ref", ref: { datum: "p2" } }, feature: "hole_1" })).toEqual(["hole_1", "p2"]);
    expect(references({ id: "x", op: "split", body: "main", plane: { type: "ref", ref: { face: { type: "planar", normal: [1, 0, 0], pick: "largest" } } } })).toEqual([]);
  });

  it("an op that validates but has no kernel fails clearly instead of doing nothing", () => {
    const run = () => runKernelOp({} as RebuildCtx, { id: "ghost_1", op: "ghost" });
    expect(run).toThrow(OpError);
    expect(run).toThrow('op "ghost" has no kernel operation: the document accepts it, but nothing builds it yet (src/features/ghost/kernel.ts, listed in kernelIndex.ts)');
  });

  it("the rebuild runs a registry op in its turn, and reports its failure as the feature's", () => {
    const r = rebuild(add(bracket, { id: "s", op: "scale", factor: 2 }, { id: "s2", op: "scale", factor: 2, bodies: ["main"], suppressed: true }), oc);
    try {
      expect(r.features).toEqual([
        { id: "sketch_1", op: "sketch", ok: true },
        { id: "ext_1", op: "extrude", ok: true },
        { id: "hole_1", op: "hole", ok: true },
        { id: "s", op: "scale", ok: true },
        { id: "s2", op: "scale", ok: true, suppressed: true },
      ]);
    } finally {
      r.dispose();
    }
    // Nothing to scale yet: the op's own message, prefixed with its id.
    const early = rebuild({ ...bracket, features: [bracket.features[0], { id: "s", op: "scale", factor: 2 }] }, oc);
    try {
      expect(early.errors).toEqual(["s: nothing to scale: there is no solid before this feature"]);
    } finally {
      early.dispose();
    }
  });
});
