// Manual mode (a sheet's `manual`): the user drafts by hand. Turning it on
// holds everything where it is drawn (nothing visibly moves); after that a new
// view or annotation moves nothing that was there, and Fit views is off.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeDrawing, type ComposedSheet } from "../src/drafting/compose";
import { fitViews, keepScales, pinSheet, setManual, type PinAnnotation } from "../src/drafting/fit";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { viewSpecs } from "../src/drafting/specs";
import { getOC, loadOC } from "../src/kernel";
import { annotationKind } from "../src/ui/drawing/tools/kinds";
import "../src/ui/drawing/tools/annotationKindsQ3";

const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

function run(doc: RawDocument, ...cmds: Command[]): RawDocument {
  for (const cmd of cmds) {
    const r = apply(doc, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    doc = r.doc;
  }
  return doc;
}

async function compose(doc: RawDocument): Promise<ComposedSheet> {
  const v = validateDocument(doc);
  if (!v.drawing) throw new Error(v.drawingErrors.join("; "));
  const c = await kernel.check(doc);
  return composeDrawing(doc, { measurements: c.measurements, geometry: await kernel.project(doc, viewSpecs(v.drawing)) })!.sheets[0];
}

async function planned(name: string): Promise<RawDocument> {
  const doc = example(name);
  const c = await kernel.check(doc);
  return run(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS), { date: "2026-11-11" }) });
}

// The editor's: an annotation held as a drag of it by nothing stores it.
const pin: PinAnnotation = (a, said, composed) => annotationKind(a.type)?.move?.(a as never, [0, 0], { sheet: composed, said }) ?? null;

type Sheet = { id: string; manual?: boolean; scale?: string; views: { id: string; at?: number[] }[]; annotations: { id: string; type: string; at?: unknown; offset?: unknown }[] };
const sheetOf = (doc: RawDocument) => (doc.drawing as { sheets: Sheet[] }).sheets[0];
const r1 = (x: number) => Math.round(x * 2) / 2;
const placeOf = (s: ComposedSheet) => ({
  scale: s.scaleText,
  views: s.views.map((v) => [v.id, v.scaleText, v.centre.map(r1)]),
  notes: s.annotations.filter((a) => a.box && !a.problem).map((a) => [a.id, [a.box!.min[0], a.box!.min[1], a.box!.max[0], a.box!.max[1]].map(r1)]),
});

describe("manual mode", () => {
  it("turning it on holds everything where it is drawn: nothing moves", async () => {
    const doc = await planned("bracket");
    const c0 = await compose(doc);
    const on = run(doc, ...setManual(sheetOf(doc) as never, c0, true, pin));
    const s = sheetOf(on);
    expect(s.manual).toBe(true);
    expect(s.views.every((v) => Array.isArray(v.at))).toBe(true);
    const dims = s.annotations.filter((a) => a.type === "dimension");
    expect(dims.length).toBeGreaterThan(0);
    expect(dims.every((a) => a.at !== undefined || a.offset !== undefined)).toBe(true);
    const c1 = await compose(on);
    expect(placeOf(c1)).toEqual(placeOf(c0));
    // Held already: nothing more to hold.
    expect(pinSheet(s as never, c1, pin)).toEqual([]);
  }, 120000);

  it("a view added afterwards moves nothing that was there; Fit views is off", async () => {
    const doc = await planned("bracket");
    const c0 = await compose(doc);
    const on = run(doc, ...setManual(sheetOf(doc) as never, c0, true, pin));
    const before = placeOf(await compose(on));
    // A view with no place of its own (as the AI or Standard 3 View might add): the layout places it alone.
    const added = run(on, { type: "setView", id: "back", view: { kind: "model", look: "back" } });
    const after = placeOf(await compose(added));
    expect(after.scale).toBe(before.scale);
    for (const v of before.views) expect(after.views).toContainEqual(v);
    for (const n of before.notes) expect(after.notes).toContainEqual(n);
    const fit = fitViews(added, { measurements: null, geometry: null }, sheetOf(added) as never);
    expect(fit).toEqual({ error: expect.stringMatching(/manual mode/) });
  }, 120000);

  it("the AI's edits on a manual sheet hold what the layout placed too", async () => {
    const doc = await planned("flange");
    const c0 = await compose(doc);
    const on = run(doc, { type: "setSheet", patch: { manual: true } });
    const add: Command = { type: "setView", id: "back", view: { kind: "model", look: "back", at: [60, 60] } };
    const held = keepScales(on, [add], () => c0);
    expect(held.filter((c) => c.type === "setView").length).toBe(sheetOf(on).views.length);
    const after = await compose(run(on, ...held, add));
    for (const v of placeOf(c0).views) expect(placeOf(after).views).toContainEqual(v);
  }, 120000);

  it("turning it off takes the flag away and leaves things where they are", async () => {
    const doc = await planned("bracket");
    const c0 = await compose(doc);
    const on = run(doc, ...setManual(sheetOf(doc) as never, c0, true, pin));
    const off = run(on, ...setManual(sheetOf(on) as never, await compose(on), false, pin));
    expect("manual" in sheetOf(off)).toBe(false);
    expect(placeOf(await compose(off))).toEqual(placeOf(c0));
    expect(validateDocument(off).drawingErrors).toEqual([]);
  }, 120000);

  it("is checked: manual must be true or false", () => {
    const doc = structuredClone(example("bracket")) as RawDocument;
    (doc as { drawing?: unknown }).drawing = { sheets: [{ id: "sheet1", format: { size: "A3" }, projection: "third", views: [], annotations: [], manual: "yes" }] };
    expect(validateDocument(doc).drawingErrors.join(" ")).toMatch(/manual.*true or false/);
  });
});
