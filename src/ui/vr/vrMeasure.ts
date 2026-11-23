// What VR's Faces measure says about one face, or two: short lines for a card floating in the room. Built on the
// desktop Measure tool's arithmetic (src/ui/evaluate/measure.ts), with the closest points between two faces from the
// view's mesh (src/ui/evaluate/meshDistance.ts). Pure.

import type { Vec3 } from "../../doc/types";
import type { Closest } from "../../kernel/evaluate";
import type { FaceInfo } from "../../kernel/topology";
import { pairRows, type MeasureItem } from "../evaluate/measure";

export interface FaceCard {
  /** The headline: "Hole Ø12", "Gap 245 mm". */
  title: string;
  /** What else is worth knowing, a line each. */
  lines: string[];
  /** The dimension line to draw (model mm), with its label. */
  line?: { from: Vec3; to: Vec3; label: string };
}

/** A length as VR shows it: to a tenth of a millimetre under 100, whole millimetres up to a metre, then metres too. */
export function mm(v: number): string {
  const a = Math.abs(v);
  if (a < 100) return `${Math.round(v * 10) / 10 + 0} mm`;
  const r = Math.round(v);
  return a >= 1000 ? `${r.toLocaleString("en-AU")} mm (${(r / 1000).toFixed(2)} m)` : `${r} mm`;
}
const dia = (r: number) => `Ø${Math.round(r * 20) / 10 + 0}`;
const deg = (v: number) => `${Math.round(v * 10) / 10 + 0}°`;
function area(a: number): string {
  if (a >= 100_000) return `${(a / 1e6).toFixed(2)} m²`;
  if (a >= 1000) return `${Math.round(a / 10) / 10 + 0} cm²`;
  return `${Math.round(a)} mm²`;
}

/** The face's kind in a word or two, with its size: "Hole Ø12", "Round Ø40", "Fillet R5", "Flat face". */
export function faceName(f: FaceInfo): string {
  const c = f.cylinder;
  if (c) {
    const full = c.span > 2 * Math.PI - 1e-3;
    if (!full) return `${c.concave ? "Fillet" : "Round edge"} R${Math.round(c.radius * 10) / 10 + 0}`;
    return `${c.concave ? "Hole" : "Round"} ${dia(c.radius)}`;
  }
  if (f.type === "plane") return "Flat face";
  if (f.type === "cone") return "Cone face";
  return "Curved face";
}

/** One face on its own. */
export function faceCard(f: FaceInfo): FaceCard {
  const c = f.cylinder;
  const lines: string[] = [];
  if (c) {
    const len = Math.abs(c.axial[1] - c.axial[0]);
    const full = c.span > 2 * Math.PI - 1e-3;
    if (full) {
      lines.push(`${c.concave ? "Depth" : "Length"} ${mm(len)} · radius ${mm(c.radius)}`);
    } else lines.push(`${dia(c.radius)} if it went all the way round · ${deg((c.span * 180) / Math.PI)} of it · ${mm(len)} long`);
  } else if (f.type === "plane") {
    lines.push(`Area ${area(f.area)}`);
    if (f.normal) {
      const n = f.normal;
      const up = n[2];
      lines.push(Math.abs(up) > 0.999 ? (up > 0 ? "Level, facing up" : "Level, facing down") : Math.abs(up) < 0.001 ? "Upright (plumb)" : `Sloping ${deg((Math.acos(Math.min(1, Math.abs(up))) * 180) / Math.PI)} from level`);
    }
  } else lines.push(`Area ${area(f.area)}`);
  return { title: faceName(f), lines };
}

/** Two faces: the gap square to them when they are parallel, the centres for round ones, the closest points, the angle. */
export function pairCard(a: { index: number; face: FaceInfo }, b: { index: number; face: FaceInfo }, closest: Closest | null): FaceCard {
  const ia: MeasureItem = { kind: "face", index: a.index, face: a.face };
  const ib: MeasureItem = { kind: "face", index: b.index, face: b.face };
  const { rows, line } = pairRows(ia, ib, closest);
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  const normal = v("normal");
  const centre = v("centre");
  const min = v("distance");
  const angle = v("angle");
  const roundA = !!a.face.cylinder;
  const roundB = !!b.face.cylinder;
  let title: string;
  let drawn: FaceCard["line"];
  const lines: string[] = [];
  if (normal !== undefined) {
    // Parallel flat faces: the gap square to them (a wall's thickness, a room's width).
    title = `Gap ${mm(normal)}`;
    drawn = line && { ...line, label: mm(normal) };
    if (min !== undefined && Math.abs(min - normal) > 0.05) lines.push(`Closest ${mm(min)} (offset, not face on)`);
  } else if (centre !== undefined && roundA && roundB) {
    title = `Centres ${mm(centre)}`;
    drawn = line && { ...line, label: `${mm(centre)} centres` };
    if (min !== undefined) lines.push(`Wall to wall ${mm(min)}`);
  } else if (min !== undefined) {
    title = `Closest ${mm(min)}`;
    drawn = closest && min > 1e-6 ? { from: closest.a, to: closest.b, label: mm(min) } : undefined;
    if (centre !== undefined) lines.push(`${roundA || roundB ? "Hole centre" : "Centre"} to the face ${mm(centre)}`);
  } else {
    title = "Touching";
  }
  if (min !== undefined && min < 1e-3 && normal === undefined) title = "Touching";
  // An angle between two flat faces that aren't parallel, or two round faces' axes (a hole's axis to a face reads oddly).
  if (angle !== undefined && normal === undefined && ((a.face.type === "plane" && b.face.type === "plane") || (roundA && roundB))) lines.push(`Angle ${deg(angle)}`);
  lines.push(`${faceName(a.face)} → ${faceName(b.face)}`);
  return { title, lines, ...(drawn ? { line: drawn } : {}) };
}
