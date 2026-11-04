import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { beforeAll, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeDrawing } from "../src/drafting/compose";
import { viewSpecs } from "../src/drafting/specs";
import { getOC, loadOC } from "../src/kernel";

const LOG = "/tmp/claude-0/-home-user-Cocaide/e5e32f9c-9616-5fee-876d-a1f9e07d0fcd/scratchpad/q1a/dbg.txt";
const log = (...a: unknown[]) => appendFileSync(LOG, `${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`);
let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
  writeFileSync(LOG, "");
});

it("dbg", async () => {
  const doc: RawDocument = JSON.parse(readFileSync(new URL(`../examples/bracket.cocaide.json`, import.meta.url), "utf8"));
  const r = apply(doc, {
    type: "setDrawing",
    drawing: { sheets: [{ id: "s1", format: { size: "A3" }, projection: "third", views: [{ id: "front", look: "front" }, { id: "det", kind: "detail", parent: "front", circle: { at: [70, 3], r: 6 } }], annotations: [] }] },
  });
  if (!r.ok) throw new Error(r.error);
  const v = validateDocument(r.doc);
  log("errors", v.drawingErrors);
  const specs = viewSpecs(v.drawing!);
  log("specs", specs);
  const g = await kernel.project(r.doc, specs);
  log("views", g!.views.map((x) => [x.id, x.edges.length, x.problems]));
  const c = composeDrawing(r.doc, { measurements: (await kernel.check(r.doc)).measurements, geometry: g })!;
  log(c.sheets[0].views.map((x) => [x.id, x.outline, x.box, x.scale]), c.sheets[0].problems);
});
