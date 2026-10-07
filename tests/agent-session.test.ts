import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLog, replay } from "../src/agent/replay";
import { AgentSession } from "../src/agent/session";
import { stlVolume } from "../src/render/stl";

const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8"));
const mountingPlate = JSON.parse(readFileSync(new URL("../examples/mounting-plate.cocaide.json", import.meta.url), "utf8"));
const BRACKET_VOLUME = 18994.728336;

const hole2 = { id: "hole_2", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [-30, 0], diameter: 6.6, depth: "through" };

function tmp() {
  return mkdtempSync(join(tmpdir(), "cocaide-session-"));
}

describe("agent session", () => {
  it("commits a good edit as a new revision and saves the file", async () => {
    const dir = tmp();
    const docPath = join(dir, "bracket.cocaide.json");
    const s = await AgentSession.open({ doc: bracket, docPath, logPath: join(dir, "log.jsonl") });
    const { result } = await s.call("addFeature", { feature: hole2 });
    expect(result).toMatchObject({ ok: true, changed: true, revision: 1, id: "hole_2" });
    expect(result.volume).toBeCloseTo(BRACKET_VOLUME - Math.PI * 3.3 ** 2 * 6, 4);
    expect(JSON.parse(readFileSync(docPath, "utf8")).features.map((f: { id: string }) => f.id)).toEqual(["sketch_1", "ext_1", "hole_1", "hole_2"]);
    s.close();
  });

  it("a bad diameter returns the error and leaves the document unchanged", async () => {
    const s = await AgentSession.open({ doc: bracket });
    const before = s.text;
    const bad = await s.call("updateFeature", { id: "hole_1", patch: { diameter: -2 } });
    expect(bad.result).toEqual({
      ok: false,
      error: "updateFeature rejected: hole_1: diameter: must be greater than 0 (got -2)",
      revision: 0,
      hash: s.hash.slice(0, 12),
    });
    expect(s.text).toBe(before);
    s.close();
  });

  it("rolls back an edit that validates but breaks the rebuild", async () => {
    const s = await AgentSession.open({ doc: bracket });
    const before = s.text;
    // Valid by the schema, but a hole off the plate removes no material.
    const r = await s.call("updateFeature", { id: "hole_1", patch: { center: [300, 0] } });
    expect(r.result.ok).toBe(false);
    expect(r.result.error).toMatch(/^updateFeature rolled back: hole_1: /);
    expect(s.text).toBe(before);
    expect(s.revision).toBe(0);
    // The part is still the bracket.
    expect((await s.call("measure")).result.volume).toBeCloseTo(BRACKET_VOLUME, 4);
    s.close();
  });

  it("rejects a call outside the write scope without changing anything", async () => {
    const s = await AgentSession.open({ doc: bracket, writeScope: ["hole_1"] });
    const r = await s.call("updateFeature", { id: "ext_1", patch: { distance: 10 } });
    expect(r.result).toMatchObject({ ok: false, error: 'writeScope: updateFeature "ext_1" is outside the scope [hole_1]', revision: 0 });
    expect((await s.call("updateFeature", { id: "hole_1", patch: { diameter: 8 } })).result.ok).toBe(true);
    s.close();
  });

  it("features the agent adds become editable by it", async () => {
    const s = await AgentSession.open({ doc: bracket, writeScope: ["+"] });
    expect((await s.call("addFeature", { feature: hole2 })).result.ok).toBe(true);
    expect((await s.call("updateFeature", { id: "hole_2", patch: { diameter: 5 } })).result.ok).toBe(true);
    expect((await s.call("updateFeature", { id: "hole_1", patch: { diameter: 5 } })).result.ok).toBe(false);
    const list = (await s.call("listFeatures")).result;
    expect(list.writeScope).toEqual(["+", "hole_2"]);
    s.close();
  });

  it("undo and redo step through revisions", async () => {
    const s = await AgentSession.open({ doc: bracket });
    const start = s.hash;
    await s.call("updateFeature", { id: "ext_1", patch: { distance: 10 } });
    const ten = s.hash;
    expect((await s.call("undo")).result).toMatchObject({ ok: true, revision: 2 });
    expect(s.hash).toBe(start);
    expect((await s.call("measure")).result.volume).toBeCloseTo(BRACKET_VOLUME, 4);
    await s.call("redo");
    expect(s.hash).toBe(ten);
    expect((await s.call("redo")).result).toMatchObject({ ok: false, error: "redo: nothing to redo" });
    s.close();
  });

  it("names a feature when the agent leaves the id out", async () => {
    const s = await AgentSession.open({ doc: bracket });
    const { id: _, ...noId } = hole2;
    expect((await s.call("addFeature", { feature: noId })).result).toMatchObject({ ok: true, id: "hole_2" });
    s.close();
  });

  it("lists features with their status, and gets one", async () => {
    const s = await AgentSession.open({ doc: bracket });
    const list = (await s.call("listFeatures")).result as unknown as { features: Record<string, unknown>[] } & Record<string, unknown>;
    expect(list.name).toBe("bracket");
    expect(list.features[0]).toMatchObject({ id: "sketch_1", op: "sketch", ok: true, entities: "r1 rect", constraints: 1, dof: 3 });
    expect(list.features[2]).toMatchObject({ id: "hole_1", op: "hole", ok: true, fields: { diameter: 6.6, depth: "through" } });
    const one = (await s.call("getFeature", { id: "ext_1" })).result;
    expect(one).toMatchObject({ ok: true, feature: { id: "ext_1", distance: 6 }, status: { ok: true } });
    expect((await s.call("getFeature", { id: "nope" })).result.error).toBe('getFeature: no feature "nope" (features: sketch_1, ext_1, hole_1)');
    s.close();
  });

  it("measures the part, a face selector and an edge selector", async () => {
    const s = await AgentSession.open({ doc: bracket });
    const all = (await s.call("measure")).result;
    expect(all).toMatchObject({ ok: true, holeCount: 1, holeDiameters: [6.6], boundingBox: { size: [80, 40, 6] } });
    const top = (await s.call("measure", { selector: { type: "planar", normal: [0, 0, 1], pick: "largest" } })).result;
    expect(top).toMatchObject({ matched: 1, faces: [{ type: "plane", offset: 6 }] });
    expect((top.faces as { area: number }[])[0].area).toBeCloseTo(80 * 40 - Math.PI * 3.3 ** 2, 4);
    const rims = (await s.call("measure", { selector: { type: "edge", kind: "circle", radius: 3.3, pick: "all" } })).result;
    expect(rims.matched).toBe(2);
    const bad = (await s.call("measure", { selector: { type: "planar", normal: [0, 0, 1] } })).result;
    expect(bad).toMatchObject({ ok: false });
    expect(bad.error).toContain("selector.pick: must be one of");
    s.close();
  });

  it("validate reports schema, rebuild and selector health", async () => {
    const s = await AgentSession.open({ doc: bracket });
    expect((await s.call("validate")).result).toMatchObject({ ok: true, valid: true, schema: [], rebuild: [], selectors: { checked: 1, healthy: 1, issues: [] } });
    s.close();
    // A selector that only works by position is flagged as fragile.
    const doc = structuredClone(mountingPlate);
    const t = await AgentSession.open({ doc });
    const v = (await t.call("validate")).result as unknown as { selectors: { checked: number; issues: { note?: string }[] } };
    expect(v.selectors.checked).toBeGreaterThan(0);
    t.close();
  });

  it("exports STEP and STL to the output folder", async () => {
    const dir = tmp();
    const s = await AgentSession.open({ doc: bracket, outDir: dir });
    const step = (await s.call("exportSTEP")).result;
    expect(step).toMatchObject({ ok: true, file: join(dir, "bracket.step"), revision: 0 });
    expect(readFileSync(join(dir, "bracket.step"), "utf8")).toContain("ISO-10303-21");
    const stl = (await s.call("exportSTL", { file: "../../escape.stl" })).result;
    expect(stl.file).toBe(join(dir, "escape.stl"));
    expect(stlVolume(new Uint8Array(readFileSync(join(dir, "escape.stl"))))).toBeCloseTo(BRACKET_VOLUME, -1);
    s.close();
  });

  it("refuses to export a part that does not rebuild", async () => {
    const s = await AgentSession.open({ doc: { version: 1, units: "mm", name: "empty", features: [] } });
    expect((await s.call("exportSTEP")).result).toMatchObject({ ok: false, error: "exportSTEP: the part does not rebuild cleanly: document: no solid; add an extrude" });
    s.close();
  });

  it("screenshots a named view, a direction and a highlight", async () => {
    const dir = tmp();
    const s = await AgentSession.open({ doc: bracket, outDir: dir });
    const iso = await s.call("screenshot", { view: "iso" });
    expect(iso.result).toMatchObject({ ok: true, view: "iso", width: 800, height: 600 });
    expect(Buffer.from(iso.image!.subarray(0, 8)).toString("hex")).toBe("89504e470d0a1a0a");
    expect(existsSync(iso.result.file as string)).toBe(true);
    const custom = await s.call("screenshot", { direction: [0, 0, -1], width: 320, height: 240 });
    expect(custom.result).toMatchObject({ ok: true, width: 320, height: 240 });
    const hl = await s.call("screenshot", { view: "top", highlight: { type: "cylindrical", radius: 3.3, pick: "all" } });
    expect(hl.result).toMatchObject({ ok: true, highlighted: 1 });
    expect((await s.call("screenshot", { view: "sideways" })).result.error).toMatch(/^screenshot: unknown view "sideways" \(views: iso, front/);
    s.close();
  });

  it("logs every call next to its revision, and the log replays", async () => {
    const dir = tmp();
    const logPath = join(dir, "run.jsonl");
    const s = await AgentSession.open({ doc: bracket, logPath, writeScope: ["hole_1", "+", "param:t"] });
    await s.call("addFeature", { feature: hole2 });
    await s.call("updateFeature", { id: "ext_1", patch: { distance: 9 } }); // out of scope
    await s.call("updateFeature", { id: "hole_1", patch: { diameter: 5 } });
    await s.call("setParameter", { name: "t", value: 4 });
    await s.call("measure");
    await s.call("undo");
    await s.call("updateFeature", { id: "hole_2", patch: { diameter: 4 } });
    const final = s.text;
    s.close();

    const runs = parseLog(readFileSync(logPath, "utf8"));
    expect(runs).toHaveLength(1);
    expect(runs[0].session.document).toContain('"name": "bracket"');
    expect(runs[0].calls.map((c) => [c.seq, c.tool, c.ok, c.revision])).toEqual([
      [1, "addFeature", true, 1],
      [2, "updateFeature", false, 1],
      [3, "updateFeature", true, 2],
      [4, "setParameter", true, 3],
      [5, "measure", true, 3],
      [6, "undo", true, 4],
      [7, "updateFeature", true, 5],
    ]);
    expect(runs[0].calls[1].error).toContain("writeScope");

    const r = await replay(runs[0]);
    expect(r.divergedAt).toBeUndefined();
    expect(r.document).toBe(final);
    const mid = await replay(runs[0], { untilRevision: 2 });
    expect(mid.revision).toBe(2);
    expect(JSON.parse(mid.document).features[2].diameter).toBe(5);
  });
});
