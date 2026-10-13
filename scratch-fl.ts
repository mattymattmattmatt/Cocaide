import { LocalKernel } from "./src/ask/kernel";
import { planBatch } from "./src/ask/tools/batch";
import { listFaces } from "./src/ask/tools/inspect";
import { getOC, loadOC } from "./src/kernel";
import { WORKED_EXAMPLES } from "./src/mcp/examples";
import type { RawDocument } from "./src/doc/commands";

await loadOC();
const k = new LocalKernel(getOC);
const e = WORKED_EXAMPLES[0];
const doc: RawDocument = { version: 1, units: "mm", name: e.key, parameters: { bolts: 6 }, features: [] };
const p = await planBatch(doc, k, e.steps.slice(0, 2));
if (!p.ok) throw new Error(p.error);
const f = await listFaces(p.doc, k, { normal: [0, 0, 1] });
console.log(JSON.stringify(f, null, 1).slice(0, 3000));
const p2 = await planBatch(p.doc, k, [{ tool: "addFeature", feature: { id: "h", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [0, 38], diameter: 9, depth: "through" } }]);
if (p2.ok) console.log((await k.check(p2.doc)).errors);
const p3 = await planBatch(p.doc, k, [{ tool: "addFeature", feature: { id: "h", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [0, 38], diameter: 9, depth: 12 } }]);
if (p3.ok) console.log((await k.check(p3.doc)).errors, (await k.check(p3.doc)).measurements?.volume);
const p4 = await planBatch(p.doc, k, [
  { tool: "sketchProfile", sketch: "skc", shapes: [{ circle: { center: [0, 38], diameter: 9 } }] },
  { tool: "addFeature", feature: { id: "c", op: "cut", sketch: "skc", extent: "throughAllBoth" } },
]);
console.log(p4.ok ? ["cut", (await k.check(p4.doc)).errors, (await k.check(p4.doc)).measurements?.volume] : p4.error);
const disc = await planBatch(doc, k, [
  { tool: "sketchProfile", sketch: "s", plane: { type: "ref", ref: { datum: "Front" } }, shapes: [{ rect: { corner: [0, 0], width: 50, height: 12 } }] },
  { tool: "addFeature", feature: { id: "b", op: "revolve", sketch: "s", axis: { datum: "Z" } } },
  { tool: "addFeature", feature: { id: "h", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [0, 38], diameter: 9, depth: "through" } },
]);
console.log(disc.ok ? ["disc", (await k.check(disc.doc)).errors] : disc.error);
