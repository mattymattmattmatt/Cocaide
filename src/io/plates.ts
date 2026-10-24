// Plates for cutting: what "Export plates (DXF)" hands a fabricator. One
// clean DXF per plate (only the cut geometry, laid flat at the origin: what
// laser, plasma and waterjet nesting software imports, each part on its own
// with its thickness and quantity in the file name), an overview DXF with
// every plate side by side and labelled (name, quantity, thickness) on a
// LABELS layer that is not cut, and a CSV cutting list (thickness, quantity,
// size, area, cut length, mass) for quoting and ordering plate. Pure.

import type { FlatPlate } from "../kernel/flat";
import { writeDxf, type DxfEntity, type WriteOptions } from "./dxf";
import { translateAll } from "./dxfGeom";
import type { ZipEntry } from "./zip";

/** "10", "6.35": a thickness for a file name or a label. */
export function thicknessText(t: number): string {
  return String(Math.round(t * 100) / 100);
}

/** "BR-1001-gusset_1-10mm-x4.dxf". */
export function plateFileName(base: string, p: FlatPlate): string {
  return `${base}-${p.bodies[0]}-${thicknessText(p.thickness)}mm${p.bodies.length > 1 ? `-x${p.bodies.length}` : ""}.dxf`;
}

/** "gusset_1 x4, 10 mm". */
export function plateLabel(p: FlatPlate): string {
  return `${p.bodies[0]}${p.bodies.length > 1 ? ` x${p.bodies.length}` : ""}, ${thicknessText(p.thickness)} mm`;
}

const GAP = 25;
const ROW_WIDTH = 2400;
const LABEL = 6;

/** Every plate laid out side by side (thinnest first, rows about a sheet wide), each labelled underneath on LABELS. */
export function platesOverview(plates: FlatPlate[]): DxfEntity[] {
  const out: DxfEntity[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const p of plates) {
    if (x > 0 && x + p.size[0] > ROW_WIDTH) {
      x = 0;
      y -= rowHeight + GAP + 2 * LABEL;
      rowHeight = 0;
    }
    out.push(...translateAll(p.entities, [x, y]));
    out.push({ type: "text", at: [x, y - LABEL * 1.6], height: LABEL, text: plateLabel(p), layer: "LABELS" });
    x += Math.max(p.size[0], LABEL * 0.6 * plateLabel(p).length) + GAP;
    rowHeight = Math.max(rowHeight, p.size[1]);
  }
  return out;
}

/** The cutting list: one row per plate, alike plates counted. `density` kg/m³ (steel 7850). */
export function platesCsv(plates: FlatPlate[], density = 7850): string {
  const rows = [["Plate", "Bodies", "Thickness (mm)", "Qty", "Width (mm)", "Length (mm)", "Area each (m2)", "Cut length each (mm)", "Holes each", "kg each", "kg total"]];
  for (const p of plates) {
    const kg = (p.area * p.thickness * 1e-9) * density;
    rows.push([
      p.bodies[0],
      p.bodies.join(" "),
      thicknessText(p.thickness),
      String(p.bodies.length),
      p.size[0].toFixed(1),
      p.size[1].toFixed(1),
      (p.area / 1e6).toFixed(4),
      p.cutLength.toFixed(0),
      String(p.holes),
      kg.toFixed(3),
      (kg * p.bodies.length).toFixed(3),
    ]);
  }
  return rows.map((r) => r.map((f) => (/[",\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(",")).join("\r\n") + "\r\n";
}

/** The files of a plates export: one DXF per plate, the overview, the cutting list. */
export function plateFiles(plates: FlatPlate[], base: string, opts: WriteOptions & { density?: number } = {}): ZipEntry[] {
  const dxf = (entities: DxfEntity[]) => writeDxf({ entities, layers: [{ name: "CUT", color: 7 }, { name: "LABELS", color: 2 }] }, opts);
  return [
    ...plates.map((p) => ({ name: plateFileName(base, p), data: dxf(p.entities) })),
    { name: `${base}-plates-overview.dxf`, data: dxf(platesOverview(plates)) },
    { name: `${base}-plates.csv`, data: platesCsv(plates, opts.density) },
  ];
}

/** "3 plates (2 of 10 mm, 1 of 6 mm)". */
export function platesSummary(plates: FlatPlate[]): string {
  const count = plates.reduce((n, p) => n + p.bodies.length, 0);
  const byT = new Map<string, number>();
  for (const p of plates) byT.set(thicknessText(p.thickness), (byT.get(thicknessText(p.thickness)) ?? 0) + p.bodies.length);
  return `${count} plate${count === 1 ? "" : "s"} (${[...byT].map(([t, n]) => `${n} of ${t} mm`).join(", ")})`;
}
