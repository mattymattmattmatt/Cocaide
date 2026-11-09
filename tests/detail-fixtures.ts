// Parts the detailing tests (wave Q3B) read the design intent of: a bearing
// plate (four M6 clearance holes, two dowel holes, a bearing bore), and the
// example bracket, flange and table frame.

import { readFileSync } from "node:fs";
import type { RawDocument } from "../src/doc/commands";

export const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));

const top = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const hole = (id: string, center: [number, number], diameter: number, depth: number | "through", extra: Record<string, unknown> = {}) => ({ id, op: "hole", face: top, center, diameter, depth, ...extra });

/** A 120 × 80 × 12 bearing plate: 4× Ø6.6 (M6 clearance), 2× Ø6 blind dowel holes, a Ø35 bearing bore. */
export function bearingPlate(): RawDocument {
  return {
    version: 1,
    units: "mm",
    name: "bearing-plate",
    material: { name: "aluminium 6082-T6", densityKgPerM3: 2700 },
    features: [
      { id: "sketch_1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 120, h: 80 }], constraints: [] },
      { id: "plate", op: "extrude", sketch: "sketch_1", distance: 12, direction: [0, 0, 1] },
      hole("mount_1", [-45, -28], 6.6, "through"),
      hole("mount_2", [45, -28], 6.6, "through"),
      hole("mount_3", [-45, 28], 6.6, "through"),
      hole("mount_4", [45, 28], 6.6, "through"),
      hole("dowel_1", [-30, 0], 6, 10),
      hole("dowel_2", [30, 0], 6, 10),
      hole("bearing_seat", [0, 0], 35, "through"),
    ],
  } as unknown as RawDocument;
}
