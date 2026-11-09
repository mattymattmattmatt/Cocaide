// Scratch: auto-detail and render the example drawings (not committed).
import { readFileSync, writeFileSync } from "node:fs";
import { LocalKernel } from "../src/ask/kernel";
import type { RawDocument } from "../src/doc/commands";
import { getOC, loadOC } from "../src/kernel";
import { sheetRaster } from "../src/ask/detail/raster";
import { autoDetail } from "../src/ask/detail/auto";
import { planText } from "../src/ask/detail/plan";

const out = process.argv[2] ?? "/tmp";
await loadOC();
const kernel = new LocalKernel(getOC);
for (const name of process.argv.slice(3)) {
  const doc: RawDocument = name === "plate" ? (await import("../tests/detail-fixtures")).bearingPlate() : JSON.parse(readFileSync(`examples/${name}.cocaide.json`, "utf8"));
  const t0 = Date.now();
  const r = await autoDetail(doc, kernel, { date: "2026-11-05" });
  console.log(`== ${name} (${Date.now() - t0} ms)`);
  console.log(planText(r.plan));
  for (const x of r.execution.results) if (!x.ok) console.log("FAILED", x.item, x.error);
  for (const f of r.findings) console.log("FINDING", f.severity, f.rule, f.message);
  const sheet = r.execution.state.sheet!;
  for (const a of sheet.annotations) if (a.problem) console.log("PROBLEM", a.id, a.problem);
  writeFileSync(`${out}/${name}-detailed.png`, (await sheetRaster(sheet)).png);
}
