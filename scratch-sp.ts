import { sketchProfile } from "./src/ask/tools/sketchProfile";
import { apply } from "./src/doc/commands";

const doc = { version: 1, units: "mm", name: "t", parameters: { w: 80 }, features: [] as Record<string, unknown>[] };
const cases: unknown[] = [
  { sketch: "s1", shapes: [{ rect: { center: [0, 0], width: "=w", height: 40, fillet: 5 }, name: "plate" }, { circle: { center: [20, 0], diameter: 6.6 } }] },
  { sketch: "s2", shapes: [{ polyline: [[0, 0], [40, 0], { at: [40, 10], fillet: 3 }, [10, 10], { arcTo: [0, 20], center: [0, 10] }] }] },
  { sketch: "s3", shapes: [{ slot: { from: [-10, 0], to: [10, 5], width: 6 } }, { polygon: { center: [30, 0], sides: 6, acrossFlats: 10 } }, { line: { from: [0, -50], to: [0, 50] }, id: "axis", construction: true }, { point: [5, 5] }] },
  { sketch: "s4", shapes: [{ polyline: [[0, 0], [30, 0], { arcTo: [30, 20], through: [40, 10] }, { arcTo: [0, 20], tangent: true }], closed: true }] },
  { sketch: "s5", shapes: [{ rect: { corner: [0, 0], width: 30, height: 20 } }] },
];
for (const c of cases) {
  const r = sketchProfile(doc, c);
  if (typeof r === "string") {
    console.log("ERR", r);
    continue;
  }
  const a = apply(doc, r.command);
  console.log(r.sketch, "dof", r.dof, JSON.stringify(r.profile), r.added.length, a.ok ? "applied" : a.error);
}
