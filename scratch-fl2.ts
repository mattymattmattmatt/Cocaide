import { LocalKernel } from "./src/ask/kernel";
import { planBatch } from "./src/ask/tools/batch";
import { getOC, loadOC } from "./src/kernel";
import type { RawDocument } from "./src/doc/commands";

await loadOC();
const k = new LocalKernel(getOC);
const doc: RawDocument = { version: 1, units: "mm", name: "x", features: [] };
for (const plane of ["Front", "Right"]) {
  const p = await planBatch(doc, k, [
    { tool: "sketchProfile", sketch: "s", plane: { type: "ref", ref: { datum: plane } }, shapes: [{ polyline: [[18, 0], [50, 0], [50, 12], [18, 12]] }] },
    { tool: "addFeature", feature: { id: "b", op: "revolve", sketch: "s", axis: { datum: "Z" } } },
  ]);
  if (!p.ok) throw new Error(p.error);
  const t = (await k.topology(p.doc))!;
  console.log(plane, t.faces.map((f) => `${f.type} n=${f.normal?.map((x) => Math.round(x * 100) / 100)} c=${f.centroid.map((x) => Math.round(x))} cyl=${f.cylinder?.concave}`));
}
