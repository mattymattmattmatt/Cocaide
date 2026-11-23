// What VR's Faces measure says about one face, or two: short lines for a card floating in the room. Built on the
// desktop Measure tool's arithmetic (src/ui/evaluate/measure.ts), with the closest points between two faces from the
// view's mesh (src/ui/evaluate/meshDistance.ts). Pure.

import type { Vec3 } from "../../doc/types";
import type { Closest } from "../../kernel/evaluate";
import type { FaceInfo } from "../../kernel/topology";
import { pairRows, type MeasureItem } from "../evaluate/measure";

export interface FaceCard {
  /** The number, big: "Ø100", "1,050 mm", "2.50 m²". */
  value: string;
  /** A few words under it: "hole · 100 mm deep", "gap", "closest · 90°". */
  caption: string;
  /** Both on one line, as said or listed: "Ø100 hole · 100 mm deep". */
  title: string;
  /** The dimension line to draw (model mm). */
  line?: { from: Vec3; to: Vec3 };
}

const card = (value: string, caption: string, line?: FaceCard["line"]): FaceCard => ({ value, caption, title: `${value} ${caption}`, ...(line ? { line } : {}) });

/** A length as VR shows it: tenths under 100 mm, whole millimetres under 10 m, then metres. */
export function mm(v: number): string {
  const a = Math.abs(v);
  if (a < 100) return `${Math.round(v * 10) / 10 + 0} mm`;
  if (a < 10_000) return `${Math.round(v).toLocaleString("en-AU")} mm`;
  return `${(v / 1000).toFixed(2)} m`;
}
const dia = (r: number) => `Ø${Math.round(r * 20) / 10 + 0}`;
const deg = (v: number) => `${Math.round(v * 10) / 10 + 0}°`;
function area(a: number): string {
  if (a >= 100_000) return `${(a / 1e6).toFixed(2)} m²`;
  if (a >= 1000) return `${Math.round(a / 10) / 10 + 0} cm²`;
  return `${Math.round(a)} mm²`;
}
const full = (f: FaceInfo) => !!f.cylinder && f.cylinder.span > 2 * Math.PI - 1e-3;

/** What a face is, short, with its size: "Ø100 hole", "Ø40 round", "R5 fillet", "flat face". */
export function faceName(f: FaceInfo): string {
  const c = f.cylinder;
  if (c) return full(f) ? `${dia(c.radius)} ${c.concave ? "hole" : "round"}` : `R${Math.round(c.radius * 10) / 10 + 0} ${c.concave ? "fillet" : "round edge"}`;
  return f.type === "plane" ? "flat face" : f.type === "cone" ? "cone" : "curved face";
}

/** How a flat face lies: level, plumb or its slope. */
function lie(n: Vec3): string {
  const up = n[2];
  if (Math.abs(up) > 0.999) return "level";
  if (Math.abs(up) < 0.001) return "plumb";
  return `${deg((Math.acos(Math.min(1, Math.abs(up))) * 180) / Math.PI)} slope`;
}

/** One face on its own: a hole's diameter and depth, a fillet's radius, a flat face's area and lie. */
export function faceCard(f: FaceInfo): FaceCard {
  const c = f.cylinder;
  if (c) {
    const len = mm(Math.abs(c.axial[1] - c.axial[0]));
    if (full(f)) return card(dia(c.radius), c.concave ? `hole · ${len} deep` : `round · ${len} long`);
    return card(`R${Math.round(c.radius * 10) / 10 + 0}`, c.concave ? "fillet" : "round edge");
  }
  if (f.type === "plane") return card(area(f.area), f.normal ? `flat · ${lie(f.normal)}` : "flat");
  return card(area(f.area), f.type === "cone" ? "cone" : "curved face");
}

/** Two faces: the gap square to them when they are parallel, the centres for round ones, else the closest points. */
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
  const drawn = line && { from: line.from, to: line.to };
  // Parallel flat faces: the gap square to them (a wall's thickness, a room's width).
  if (normal !== undefined) return card(mm(normal), min !== undefined && Math.abs(min - normal) > 0.05 ? `gap · offset, closest ${mm(min)}` : "gap", drawn);
  if (centre !== undefined && roundA && roundB) return card(mm(centre), min !== undefined ? `centres · ${mm(min)} wall to wall` : "centres", drawn);
  if (min === undefined || min < 1e-3) return card("0 mm", "touching");
  const extra: string[] = [];
  if (centre !== undefined) extra.push(`centre ${mm(centre)}`);
  // The angle between two flat faces that aren't parallel, or two round faces' axes.
  if (angle !== undefined && ((a.face.type === "plane" && b.face.type === "plane") || (roundA && roundB))) extra.push(deg(angle));
  return card(mm(min), ["closest", ...extra].join(" · "), closest ? { from: closest.a, to: closest.b } : undefined);
}
