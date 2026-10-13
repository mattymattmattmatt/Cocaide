import { LocalKernel } from "./src/ask/kernel";
import { planBatch } from "./src/ask/tools/batch";
import { getOC, loadOC, scoped } from "./src/kernel";
import { listFaces } from "./src/kernel/topology";
import type { RawDocument } from "./src/doc/commands";

await loadOC();
const oc = getOC();
const k = new LocalKernel(getOC);
const doc: RawDocument = { version: 1, units: "mm", name: "x", features: [] };
const p = await planBatch(doc, k, [
  { tool: "sketchProfile", sketch: "s", plane: { type: "ref", ref: { datum: "Front" } }, shapes: [{ polyline: [[18, 0], [50, 0], [50, 12], [18, 12]] }] },
  { tool: "addFeature", feature: { id: "b", op: "revolve", sketch: "s", axis: { datum: "Z" } } },
]);
if (!p.ok) throw new Error(p.error);
const r = k.built(p.doc);
scoped((s) => {
  for (const f of listFaces(oc, s, r.solid!)) {
    const ad = s.track(new oc.BRepAdaptor_Surface(f, true));
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) continue;
    const pl = s.track(ad.Plane());
    const pos = s.track(pl.Position());
    const d = s.track(pos.Direction());
    console.log("direct", pos.Direct(), "dir", d.Z(), "reversed", f.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED);
  }
});
