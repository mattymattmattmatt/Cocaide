// The cut list and the weld table (Phase J), from what the rebuild measured.
// Alike members are one line: same profile, size, length and end angles.

import type { Weld } from "../doc/types";
import type { MemberMeasurement } from "../kernel/measure";

export interface CutListItem {
  item: number;
  profile: string;
  designation: string;
  /** mm, long point to long point, to 0.1 mm. */
  length: number;
  /** Degrees from square at each end, to 0.1°, the larger first. */
  angles: [number, number];
  quantity: number;
  kgEach: number;
  kgTotal: number;
  /** The members on this line, in feature order. */
  members: string[];
}

const tenth = (x: number) => Math.round(x * 10) / 10 + 0;

export function cutList(members: MemberMeasurement[]): CutListItem[] {
  const lines = new Map<string, Omit<CutListItem, "item" | "kgEach">>();
  for (const m of members) {
    const length = tenth(m.length);
    const angles = [tenth(m.angles[0]), tenth(m.angles[1])].sort((a, b) => b - a) as [number, number];
    const key = JSON.stringify([m.profile, m.designation, length, angles]);
    const line = lines.get(key) ?? { profile: m.profile, designation: m.designation, length, angles, quantity: 0, kgTotal: 0, members: [] };
    line.quantity++;
    line.kgTotal += m.massKg;
    line.members.push(m.id);
    lines.set(key, line);
  }
  return [...lines.values()]
    .sort((a, b) => a.designation.localeCompare(b.designation, undefined, { numeric: true }) || b.length - a.length || b.angles[0] - a.angles[0])
    .map((l, i) => ({ ...l, item: i + 1, kgEach: l.kgTotal / l.quantity }));
}

/** "45° / 45°", "square", "45° / square". */
export function anglesText(angles: [number, number]): string {
  const one = (a: number) => (a === 0 ? "square" : `${a}°`);
  return angles[0] === 0 && angles[1] === 0 ? "square" : `${one(angles[0])} / ${one(angles[1])}`;
}

export function cutListCSV(items: CutListItem[]): string {
  const rows = [["Item", "Profile", "Size", "Length (mm)", "End 1 (deg)", "End 2 (deg)", "Qty", "kg each", "kg total", "Members"]];
  for (const i of items) {
    rows.push([
      String(i.item),
      i.profile,
      i.designation,
      i.length.toFixed(1),
      i.angles[0].toFixed(1),
      i.angles[1].toFixed(1),
      String(i.quantity),
      i.kgEach.toFixed(3),
      i.kgTotal.toFixed(3),
      i.members.join(" "),
    ]);
  }
  return csv(rows);
}

export function weldTableCSV(welds: Weld[]): string {
  const rows = [["Weld", "Between", "Type", "Size (mm)", "Length (mm)", "All round", "Note"]];
  for (const w of welds) rows.push([w.id, w.between.join(" + "), w.type, String(w.size), String(w.length), w.allRound ? "yes" : "", w.note ?? ""]);
  return csv(rows);
}

function csv(rows: string[][]): string {
  return rows.map((r) => r.map((f) => (/[",\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(",")).join("\r\n") + "\r\n";
}
