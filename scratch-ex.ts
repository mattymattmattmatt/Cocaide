import { LocalKernel } from "./src/ask/kernel";
import { planBatch } from "./src/ask/tools/batch";
import { getOC, loadOC } from "./src/kernel";
import { WORKED_EXAMPLES } from "./src/mcp/examples";
import { apply, type RawDocument } from "./src/doc/commands";

await loadOC();
const k = new LocalKernel(getOC);
for (const e of WORKED_EXAMPLES) {
  let doc: RawDocument = { version: 1, units: "mm", name: e.key, features: [] };
  for (const [n, v] of Object.entries(e.parameters ?? {})) {
    const r = apply(doc, { type: "setParameter", name: n, value: v });
    if (r.ok) doc = r.doc;
  }
  const p = await planBatch(doc, k, e.steps);
  if (!p.ok) {
    console.log(e.key, "PLAN FAIL", p.error);
    continue;
  }
  const c = await k.check(p.doc);
  console.log(e.key, c.ok, c.errors, c.measurements?.volume, e.volume, c.measurements?.holeCount, c.measurements?.solids);
}
