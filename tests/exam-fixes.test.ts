// Fixes from an examination of every tool: a plain extrude joins the part's
// only body whatever its name; a member names its profile by family ("SHS"
// for "SHS (AS/NZS 1163)"); holes take a bare list of points; a detail of a
// turned view is turned with it.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeDrawing } from "../src/drafting/compose";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { viewSpecs } from "../src/drafting/specs";
import { getOC, loadOC } from "../src/kernel";

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
}, 120_000);

const empty = { version: 1, units: "mm", name: "exam", features: [] };
const open = () => AgentSession.open({ doc: empty, outDir: mkdtempSync(join(tmpdir(), "exam-fix-")) });

describe("found by examining every tool", () => {
  it("a boss extruded on a body named its own way joins that body (it used to start a body \"main\" beside it)", async () => {
    const s = await open();
    await s.call("sketchProfile", { sketch: "sk", plane: "Top", shapes: [{ rect: { center: [0, 0], width: 60, height: 40 } }] });
    expect((await s.call("addFeature", { feature: { id: "base", op: "extrude", sketch: "sk", distance: 10, newBody: "block" } })).result.ok).toBe(true);
    await s.call("sketchProfile", { sketch: "sk2", plane: { face: { type: "planar", normal: "+Z", pick: "largest" } }, shapes: [{ circle: { center: [0, 0], diameter: 20 } }] });
    expect((await s.call("addFeature", { feature: { id: "boss", op: "extrude", sketch: "sk2", distance: 15 } })).result.ok).toBe(true);
    const summary = JSON.stringify((await s.call("partSummary")).result);
    expect(summary).toContain('"block"');
    expect(summary).not.toContain('"main"');
    // Holes take a bare list of points.
    const h = (await s.call("holes", { face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, diameter: 4, depth: "through", at: [[-20, -12], [20, -12]] })).result;
    expect(h).toMatchObject({ ok: true, count: 2 });
    s.close();
  }, 120_000);

  it("a member names its profile by its family: SHS is the part's SHS (AS/NZS 1163)", async () => {
    const s = await open();
    expect((await s.call("addLibraryProfile", { query: "SHS", sizes: ["40x40x3"] })).result.ok).toBe(true);
    const r = (await s.call("addFeature", { feature: { id: "rail", op: "member", profile: "SHS", size: "SHS 40x40x3", from: [0, 0, 0], to: [500, 0, 0] } })).result;
    expect(r.ok).toBe(true);
    // Stored by the profile's own key, so everything reading the document finds it.
    const f = ((await s.call("getFeature", { id: "rail" })).result as unknown as { feature: { profile: string } }).feature;
    expect(f.profile).toBe("SHS");
    expect(validateDocument(JSON.parse(JSON.stringify((s as unknown as { doc: RawDocument }).doc))).features.find((x) => x.id === "rail")?.feature).toMatchObject({ profile: "SHS (AS/NZS 1163)" });
    s.close();
  }, 120_000);

  it("a detail of a turned view is turned with it (it shows its piece as the parent does)", async () => {
    const doc0 = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
    const c = await kernel.check(doc0);
    const r = apply(doc0, { type: "setDrawing", drawing: planDrawing(doc0, c.measurements, await kernel.project(doc0, DEFAULT_VIEWS), { date: "2026-11-18" }) });
    if (!r.ok) throw new Error(r.error);
    const raw = JSON.parse(JSON.stringify(r.doc));
    const views = raw.drawing.sheets[0].views;
    views.find((v: { id: string }) => v.id === "top").rotation = 30;
    views.push({ id: "det", kind: "detail", parent: "top", circle: { at: [30, 0], r: 8 }, at: [300, 80] });
    const geometry = await kernel.project(raw, viewSpecs(validateDocument(raw).drawing!));
    const sheet = composeDrawing(raw, { measurements: c.measurements, geometry })!.sheets[0];
    expect(sheet.views.find((v) => v.id === "det")!.rotation).toBe(30);
    // Its own turn wins, 0 included.
    views.find((v: { id: string }) => v.id === "det").rotation = 0;
    const own = composeDrawing(raw, { measurements: c.measurements, geometry: await kernel.project(raw, viewSpecs(validateDocument(raw).drawing!)) })!.sheets[0];
    expect(own.views.find((v) => v.id === "det")!.rotation).toBeUndefined();
  }, 120_000);
});
