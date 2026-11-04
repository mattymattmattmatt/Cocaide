// Scratch: renders sheets for looking at (removed before commit).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { beforeAll, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { apply, type Command, type RawDocument } from "../src/doc/commands";
import { validateDocument } from "../src/doc/validate";
import { composeDrawing } from "../src/drafting/compose";
import { sheetDXF } from "../src/drafting/dxf";
import { listGeoRefs } from "../src/drafting/georef";
import { drawingPDF } from "../src/drafting/pdf";
import { DEFAULT_VIEWS, planDrawing } from "../src/drafting/plan";
import { viewSpecs } from "../src/drafting/specs";
import { sheetSVG } from "../src/drafting/svg";
import { getOC, loadOC } from "../src/kernel";

const OUT = "/tmp/claude-0/-home-user-Cocaide/e5e32f9c-9616-5fee-876d-a1f9e07d0fcd/scratchpad/q1a/shots";
const LOG = `${OUT}/log.txt`;
const log = (...a: unknown[]) => appendFileSync(LOG, `${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`);
const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));
let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(LOG, "");
});

const font = (f: string) => {
  const data = new Uint8Array(readFileSync(new URL(`../public/fonts/${f}`, import.meta.url)));
  return { data, deflated: new Uint8Array(deflateSync(data)) };
};

function run(doc: RawDocument, ...cmds: Command[]): RawDocument {
  for (const cmd of cmds) {
    const r = apply(doc, cmd);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  }
  return doc;
}

async function compose(d: RawDocument) {
  const c = await kernel.check(d);
  const v = validateDocument(d);
  if (!v.drawing) throw new Error(v.drawingErrors.join("; "));
  const t0 = Date.now();
  const geo = await kernel.project(d, viewSpecs(v.drawing));
  const t1 = Date.now();
  const composed = composeDrawing(d, { measurements: c.measurements, geometry: geo })!;
  return { composed, ms: [t1 - t0, Date.now() - t1] };
}

async function render(name: string, doc: RawDocument, extra?: (d: RawDocument, refs: (view: string) => ReturnType<typeof listGeoRefs>) => RawDocument) {
  const c = await kernel.check(doc);
  const g = await kernel.project(doc, DEFAULT_VIEWS);
  let d = run(doc, { type: "setDrawing", drawing: planDrawing(doc, c.measurements, g, { date: "2026-11-04" }) });
  if (extra) {
    const first = await compose(d);
    d = extra(d, (view) => listGeoRefs(first.composed, view));
  }
  const { composed, ms } = await compose(d);
  log(name, "project/compose ms", ms, composed.sheets.map((s) => [s.id, s.scaleText, s.problems]));
  composed.sheets.forEach((s, i) => {
    writeFileSync(`${OUT}/${name}-${i + 1}.svg`, sheetSVG(s));
    writeFileSync(`${OUT}/${name}-${i + 1}.dxf`, sheetDXF(s));
  });
  writeFileSync(`${OUT}/${name}.pdf`, drawingPDF(composed.sheets, { title: name, fonts: { regular: font("LiberationSans-Regular.ttf"), bold: font("LiberationSans-Bold.ttf") } }));
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(validateDocument(d).drawing, null, 1));
}

it("renders", async () => {
  await render("bracket", example("bracket"));
  await render("flange", example("flange"), (d, refs) => {
    // Sheet 2, ASME: an auxiliary view square to the chamfer, a detail of a bolt hole, a revision.
    const chamfer = refs("front").find((r) => r.what === "line" && r.feature === "rim_chamfer");
    log("flange chamfer ref", chamfer);
    return run(
      d,
      { type: "addSheet", id: "sheet2", sheet: { format: { size: "A3", template: "ansi" } } },
      { type: "setView", id: "front2", view: { look: "front", display: "hidden" }, sheet: "sheet2" },
      ...(chamfer ? [{ type: "setView", id: "aux", view: { kind: "auxiliary", parent: "front2", edge: chamfer.ref.replace("front:", "front2:") }, sheet: "sheet2" } as Command] : []),
      { type: "setView", id: "shade", view: { look: "iso", display: "shadedEdges" }, sheet: "sheet2" },
      { type: "setView", id: "det", view: { kind: "detail", parent: "front2", circle: { at: [70, 4], r: 9 }, style: "connected" }, sheet: "sheet2" },
      { type: "setDrawingOptions", patch: { revisions: [{ rev: "A", description: "First issue", date: "2026-11-04", by: "QA" }, { rev: "B", description: "Chamfer added to the rim", date: "2026-11-05", by: "QA", zone: "C3" }] } },
    );
  });
  await render("plate", example("mounting-plate"), (d) =>
    run(d, { type: "setView", id: "det", view: { kind: "detail", parent: "front", circle: { at: [100, 4], r: 8 } } }, { type: "setView", id: "bo", view: { look: "iso", brokenOut: [{ profile: [[30, -20], [70, -20], [70, 20], [30, 20]], depth: 4 }] }, sheet: undefined }),
  );
  await render("table", example("table-frame"), (d) =>
    run(
      d,
      { type: "addSheet", id: "sheet2" },
      { type: "setView", id: "f2", view: { look: "front", breaks: [{ axis: "x", from: 200, to: 1000 }] }, sheet: "sheet2" },
      { type: "setView", id: "legs", view: { kind: "section", parent: "f2", line: [[-50, 450], [1250, 450]] }, sheet: "sheet2" },
      { type: "setAnnotation", id: "d_f2", annotation: { type: "dimension", view: "f2", from: "@left", to: "@right" } },
    ),
  );
  await render("stand", example("stand"));
  await render("members", example("frame-members"), (d) =>
    run(d, { type: "setView", id: "cutm", view: { kind: "section", parent: "front", line: [[-100, 300], [2000, 300]], scale: "1:5" } }),
  );
}, 300000);
