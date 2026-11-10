// Phase Q wave Q4: a drawing's layout is stable. The sheet's scale is chosen
// once (New drawing, Fit views) and stored; moving a view moves only it (and
// the views lined up with it); a view off the sheet keeps its scale and the
// checks say so.

import { readFileSync } from "node:fs";
import { beforeAll, describe, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeDrawing, type ComposedDrawing } from "../src/drafting/compose";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { viewSpecs } from "../src/drafting/specs";
import { getOC, loadOC } from "../src/kernel";

const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

function run(doc: RawDocument, ...cmds: Command[]): RawDocument {
  for (const cmd of cmds) {
    const r = apply(doc, cmd);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  }
  return doc;
}

async function compose(doc: RawDocument): Promise<ComposedDrawing> {
  const v = validateDocument(doc);
  if (!v.drawing) throw new Error(v.drawingErrors.join("; "));
  const c = await kernel.check(doc);
  const geometry = await kernel.project(doc, viewSpecs(v.drawing));
  return composeDrawing(doc, { measurements: c.measurements, geometry })!;
}

async function planned(doc: RawDocument): Promise<RawDocument> {
  const c = await kernel.check(doc);
  return run(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, await kernel.project(doc, DEFAULT_VIEWS), { date: "2026-11-04" }) });
}

describe("repro", () => {
  it("bracket", async () => {
    for (const name of ["bracket", "flange", "mounting-plate", "table-frame"]) {
      let doc = await planned(example(name));
      const unscaled = JSON.parse(JSON.stringify(doc));
      for (const s of (unscaled.drawing as { sheets: { scale?: string }[] }).sheets) delete s.scale;
      doc = unscaled;
      const c0 = (await compose(doc)).sheets[0];
      const info = (c: typeof c0) => c.views.map((v) => `${v.id}@${v.scaleText} ${v.centre.map((x) => x.toFixed(0))}`).join(" | ");
      console.log(name, c0.scaleText, info(c0));
      const iso = c0.views.find((v) => v.id === "iso")!;
      const d1 = run(doc, { type: "moveView", id: "iso", at: [c0.frame.max[0], iso.centre[1]] });
      const c1 = (await compose(d1)).sheets[0];
      console.log(" iso off:", c1.scaleText, info(c1));
      const front = c0.views[0];
      const d2 = run(doc, { type: "moveView", id: front.id, at: [front.centre[0] + 20, front.centre[1]] });
      const c2 = (await compose(d2)).sheets[0];
      console.log(" first moved:", c2.scaleText, info(c2));
      let d3 = doc;
      for (const v of c0.views) d3 = run(d3, { type: "moveView", id: v.id, at: [v.centre[0] + 1, v.centre[1]] });
      const c3 = (await compose(d3)).sheets[0];
      console.log(" all moved:", c3.scaleText, info(c3));
    }
  }, 120000);
});
