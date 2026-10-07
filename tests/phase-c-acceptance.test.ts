// Phase C acceptance, through the real MCP server over stdio:
//   1. Scripted tool calls build the bracket with zero UI.
//   2. A bad diameter returns the error string and leaves the document unchanged.
//   3. A call aimed at ext_1 while the scope is hole_1 is rejected.
// Plus what the agent must be able to do: add a hole, change a parameter,
// export STEP (checked in FreeCAD when FREECAD_CMD is set), take an iso screenshot.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLog, replay } from "../src/agent/replay";
import { importSTEP, loadOC, scoped, volumeOf } from "../src/kernel";

const ROOT = resolve(__dirname, "..");
const EXAMPLE = readFileSync(join(ROOT, "examples/bracket.cocaide.json"), "utf8");
const spec = JSON.parse(EXAMPLE);
const BRACKET_VOLUME = 18994.728336;
const HOLE = Math.PI * 3.3 ** 2; // area of a 6.6 mm hole

interface Reply {
  ok: boolean;
  error?: string;
  isError: boolean;
  image?: { data: string; mimeType: string };
  [k: string]: unknown;
}

async function start(args: string[]) {
  const transport = new StdioClientTransport({
    command: join(ROOT, "node_modules/.bin/tsx"),
    args: [join(ROOT, "src/mcp/server.ts"), ...args],
    cwd: ROOT,
    stderr: "pipe",
  });
  const client = new Client({ name: "phase-c-acceptance", version: "1" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Reply> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
    const text = r.content.find((c) => c.type === "text")!.text!;
    const image = r.content.find((c) => c.type === "image");
    return { ...JSON.parse(text), isError: r.isError === true, ...(image ? { image: { data: image.data!, mimeType: image.mimeType! } } : {}) };
  };
  return { client, call };
}

describe("Phase C acceptance (MCP over stdio)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocaide-phase-c-"));
  const docPath = join(dir, "bracket.cocaide.json");
  const logPath = join(dir, "bracket.cocaide.log.jsonl");
  let agent: Awaited<ReturnType<typeof start>>;

  beforeAll(async () => {
    // A new document; the agent may add features and nothing else.
    agent = await start(["--doc", docPath, "--scope", "+"]);
  }, 60_000);
  afterAll(async () => {
    await agent?.client.close();
  });

  it("offers the section 4 commands as tools, plus the reference", async () => {
    const tools = (await agent.client.listTools()).tools.map((t) => t.name);
    for (const name of ["addFeature", "updateFeature", "deleteFeature", "reorderFeature", "setParameter", "rebuild", "measure", "exportSTEP", "exportSTL", "screenshot", "listFeatures", "validate", "undo"]) {
      expect(tools).toContain(name);
    }
    expect(agent.client.getInstructions()).toContain("transaction");
    const ref = await agent.client.readResource({ uri: "cocaide://reference" });
    expect((ref.contents[0] as { text: string }).text).toContain("## Face selectors");
  });

  it("1. scripted tool calls build the bracket with zero UI", async () => {
    const empty = await agent.call("listFeatures");
    expect(empty).toMatchObject({ ok: true, name: "bracket", revision: 0, features: [], writeScope: ["+"] });

    for (const feature of spec.features) {
      const r = await agent.call("addFeature", { feature });
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true, isError: false, id: feature.id });
    }
    const m = await agent.call("measure");
    expect(m.volume).toBeCloseTo(BRACKET_VOLUME, 6);
    expect(m).toMatchObject({ holeCount: 1, holeDiameters: [6.6], boundingBox: { size: [80, 40, 6] } });
    expect(await agent.call("validate")).toMatchObject({ ok: true, valid: true, schema: [], rebuild: [] });
    // The file the agent wrote is the spec's bracket, byte for byte.
    expect(readFileSync(docPath, "utf8")).toBe(EXAMPLE);
  });

  it("2. a bad diameter returns the error string and leaves the document unchanged", async () => {
    const before = readFileSync(docPath, "utf8");
    const { revision } = await agent.call("listFeatures");

    const negative = await agent.call("updateFeature", { id: "hole_1", patch: { diameter: -2 } });
    expect(negative).toMatchObject({ ok: false, isError: true, error: "updateFeature rejected: hole_1: diameter: must be greater than 0 (got -2)", revision });

    // Valid by the schema but wrong for the part: the rebuild fails, the transaction rolls back.
    const huge = await agent.call("updateFeature", { id: "hole_1", patch: { diameter: 500 } });
    expect(huge.isError).toBe(true);
    expect(huge.error).toMatch(/^updateFeature rolled back: hole_1: /);

    expect(readFileSync(docPath, "utf8")).toBe(before);
    expect((await agent.call("listFeatures")).revision).toBe(revision);
    expect((await agent.call("measure")).volume).toBeCloseTo(BRACKET_VOLUME, 6);
  });

  it("the agent adds a hole and changes a parameter", async () => {
    const hole = await agent.call("addFeature", {
      feature: { op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [-30, 0], diameter: 6.6, depth: "through" },
    });
    expect(hole).toMatchObject({ ok: true, id: "hole_2" });
    expect(hole.volume as number).toBeCloseTo(BRACKET_VOLUME - HOLE * 6, 6);

    expect(await agent.call("setParameter", { name: "plate_t", value: 6 })).toMatchObject({ ok: true });
    expect(await agent.call("updateFeature", { id: "ext_1", patch: { distance: "=plate_t" } })).toMatchObject({ ok: true });
    const thick = await agent.call("setParameter", { name: "plate_t", value: 10 });
    expect(thick.volume as number).toBeCloseTo((80 * 40 - 2 * HOLE) * 10, 6);
    const saved = JSON.parse(readFileSync(docPath, "utf8"));
    expect(saved.parameters).toEqual({ plate_t: 10 });
    expect(saved.features[1].distance).toBe("=plate_t");

    // Undo is the agent's too.
    const back = await agent.call("undo");
    expect(back.volume as number).toBeCloseTo((80 * 40 - 2 * HOLE) * 6, 6);
    await agent.call("redo");
  });

  it("the agent exports STEP, and the STEP holds the same solid", async () => {
    const r = await agent.call("exportSTEP");
    expect(r).toMatchObject({ ok: true, file: join(dir, "bracket.step") });
    const step = readFileSync(r.file as string, "utf8");
    expect(step).toContain("ISO-10303-21");
    const oc = await loadOC();
    const shape = importSTEP(oc, step);
    try {
      expect(scoped((s) => volumeOf(oc, s, shape))).toBeCloseTo((80 * 40 - 2 * HOLE) * 10, 4);
    } finally {
      shape.delete();
    }
    const stl = await agent.call("exportSTL");
    expect(stl).toMatchObject({ ok: true, file: join(dir, "bracket.stl") });

    const freecad = process.env.FREECAD_CMD;
    if (freecad && existsSync(freecad)) {
      const out = execFileSync(freecad, [join(ROOT, "scripts/freecad_check.py")], { env: { ...process.env, COCAIDE_STEP: r.file as string }, encoding: "utf8" });
      const fc = JSON.parse(out.split("\n").find((l) => l.startsWith("COCAIDE_FREECAD "))!.slice("COCAIDE_FREECAD ".length));
      expect(fc).toMatchObject({ importedObjects: ["bracket"], valid: true, solids: 1 });
      expect(fc.volume).toBeCloseTo((80 * 40 - 2 * HOLE) * 10, 4);
    }
  });

  it("the agent requests an iso screenshot: one view, one image", async () => {
    const r = await agent.call("screenshot", { view: "iso" });
    expect(r).toMatchObject({ ok: true, view: "iso", width: 800, height: 600 });
    expect(r.image!.mimeType).toBe("image/png");
    const png = Buffer.from(r.image!.data, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(800);
    expect(png.readUInt32BE(20)).toBe(600);
  });

  it("every call is logged next to its revision, and the run replays", async () => {
    const runs = parseLog(readFileSync(logPath, "utf8"));
    expect(runs).toHaveLength(1);
    const edits = runs[0].calls.filter((c) => c.changed);
    expect(edits.map((c) => c.revision)).toEqual(edits.map((_, i) => i + 1));
    const rejected = runs[0].calls.filter((c) => !c.ok);
    expect(rejected.map((c) => c.error)).toContain("updateFeature rejected: hole_1: diameter: must be greater than 0 (got -2)");
    const r = await replay(runs[0]);
    expect(r.divergedAt).toBeUndefined();
    expect(r.document).toBe(readFileSync(docPath, "utf8"));
  });

  it("3. a call aimed at ext_1 while the scope is hole_1 is rejected", async () => {
    const scoped = await start(["--doc", docPath, "--scope", "hole_1", "--log", join(dir, "scoped.log.jsonl")]);
    try {
      const before = readFileSync(docPath, "utf8");
      const r = await scoped.call("updateFeature", { id: "ext_1", patch: { distance: 12 } });
      expect(r).toMatchObject({ ok: false, isError: true, error: 'writeScope: updateFeature "ext_1" is outside the scope [hole_1]', revision: 0 });
      expect((await scoped.call("deleteFeature", { id: "ext_1" })).isError).toBe(true);
      expect((await scoped.call("setParameter", { name: "plate_t", value: 3 })).error).toBe('writeScope: setParameter "plate_t" is outside the scope [hole_1]');
      expect(readFileSync(docPath, "utf8")).toBe(before);
      // Inside the scope, edits go through.
      expect(await scoped.call("updateFeature", { id: "hole_1", patch: { diameter: 8 } })).toMatchObject({ ok: true, revision: 1 });
    } finally {
      await scoped.client.close();
    }
  }, 60_000);
});
